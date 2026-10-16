/** The external boundaries bump-it reaches; tests replace each without networking or agents. */
import { createHash } from "node:crypto";

import type { WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { bumpCandidates, type BumpCandidates } from "@leanish/gate/candidates";
import type { GateEnvironment, GradleInputs } from "@leanish/gate/gate";
import { namingFailures } from "@leanish/gate/http";
import { FileRepositoryAdvisoryCache } from "@leanish/tool-runtime/repository-advisory-cache";
import { runProcess } from "@leanish/gate/process";
import { gitTree, type Tree, workingTree } from "@leanish/gate/tree";
import type { ToolRunContext } from "@leanish/tool-runtime/command";
import { candidateTree, changedBetween, fileState, exportCommit, git, linkProblems, snapshotCandidate } from "@leanish/tool-runtime/git-copies";
import { type GradleInventories, sandboxedGradleInventories } from "@leanish/tool-runtime/inventories";
import { FileJournal, type PublicationJournal } from "@leanish/tool-runtime/journal";
import { ensureOsvScanner, verifyingRun } from "@leanish/tool-runtime/osv-scanner";
import { sandboxWritable } from "@leanish/tool-runtime/sandboxed";
import { publicationParent, revertToBase } from "@leanish/tool-runtime/reconcile";

import { generateWrapper, readWrapperFiles, writeWrapperFiles, type WrapperArtifact } from "./wrapper-generation.ts";
import type { DirectMove } from "./units.ts";
import { gradleWrapperPlanner, type WrapperPlanner, WRAPPER_JAR, WRAPPER_FILES } from "./gradle-wrapper.ts";
import { removeLocalFile, writeLocalFile } from "./files.ts";
import type { NpmResult } from "./npm-compute.ts";
import { computeOnBase } from "./npm-runtime.ts";
import { filePriority, type MajorPriority } from "./priority.ts";
import type { Unit } from "./units.ts";
import { verifyPlan, type VerifyInputs } from "./verify.ts";

export interface BumpItDeps {
  readonly publicationParent: typeof publicationParent;
  readonly fileState: typeof fileState;
  readonly generateWrapper: (context: ToolRunContext, baseSha: string, move: DirectMove) => Promise<ReadonlyArray<WrapperArtifact>>;
  readonly readWrapperFiles: (workingCopy: WorkingCopy) => Promise<ReadonlyArray<WrapperArtifact>>;
  readonly writeWrapperFiles: (workingCopy: WorkingCopy, files: ReadonlyArray<WrapperArtifact>) => Promise<void>;
  readonly wrapper: (env: GateEnvironment, releaseAgeDays: number) => WrapperPlanner;
  readonly restoreWrapperFile: (workingCopy: WorkingCopy, baseSha: string, path: string) => Promise<void>;
  readonly gate: (context: ToolRunContext) => Promise<GateEnvironment>;
  readonly gradle: (context: ToolRunContext) => GradleInventories;
  readonly trees: { readonly commit: (workingCopy: WorkingCopy, sha: string) => Promise<Tree>; readonly working: (workingCopy: WorkingCopy) => Tree };
  readonly candidates: (tree: Tree, env: GateEnvironment, gradle: GradleInputs) => Promise<BumpCandidates>;
  readonly npm: (context: ToolRunContext, unit: Unit, base: Tree, env: GateEnvironment, gradle: GradleInputs["head"]) => Promise<NpmResult>;
  readonly verify: (inputs: VerifyInputs) => Promise<string[]>;
  /** Records the working tree as the verification snapshot (`snapshotCandidate`), returning its commit. */
  readonly snapshot: (workingCopy: WorkingCopy) => Promise<string>;
  /** The tree of the last snapshot, which publication must stage (`candidateTree`). */
  readonly candidateTree: (workingCopy: WorkingCopy) => Promise<string | undefined>;
  /** Every path `sha` changed relative to `base` (`changedBetween`). */
  readonly changedBetween: (workingCopy: WorkingCopy, base: string, sha: string) => Promise<string[]>;
  /** What the edit from `base` to `sha` did with links and submodules, as verification problems (`linkProblems`). */
  readonly linkProblems: (workingCopy: WorkingCopy, base: string, sha: string) => Promise<string[]>;
  /** The wrapper files and jar hash as committed in `sha`, the verification snapshot. */
  readonly wrapperAt: (workingCopy: WorkingCopy, sha: string) => Promise<{ readonly files: ReadonlyArray<WrapperArtifact>; readonly jarSha256: string | undefined }>;
  readonly journal: (context: ToolRunContext) => PublicationJournal;
  readonly priority: (context: ToolRunContext) => MajorPriority;
  readonly writeFile: (workingCopy: WorkingCopy, path: string, content: string) => Promise<void>;
  readonly removeFile: (workingCopy: WorkingCopy, path: string) => Promise<void>;
  /** Starts a redo detached at the base, dropping the previous plan's edits. */
  readonly revert: (workingCopy: WorkingCopy, baseSha: string) => Promise<ReadonlyArray<string>>;
}

export function defaultDeps(): BumpItDeps {
  return {
    publicationParent,
    fileState,
    wrapper: gradleWrapperPlanner,
    generateWrapper,
    readWrapperFiles,
    writeWrapperFiles,
    async restoreWrapperFile(workingCopy, baseSha, path) {
      if (!WRAPPER_FILES.includes(path) || !/^[a-f0-9]{40}$/i.test(baseSha)) throw new Error("invalid wrapper restore");
      const restored = await git(workingCopy, ["restore", `--source=${baseSha}`, "--worktree", "--", path], runProcess);
      if (restored.code !== 0) throw new Error(`restoring ${path} from base failed: ${restored.stderr.trim()}`);
    },
    async gate(context) {
      const writable = sandboxWritable(context);
      const osv = await ensureOsvScanner(context.config.dirs.state, writable);
      return { run: verifyingRun(runProcess, osv), fetch: namingFailures(context.fetch), now: () => new Date(), osvScanner: osv.path, githubToken: context.readToken, repositoryAdvisoryCache: new FileRepositoryAdvisoryCache(context.config.dirs.state, writable, context.readToken) };
    },
    gradle: (context) => sandboxedGradleInventories(context.isolation, context.workingCopy),
    trees: { commit: (workingCopy, sha) => gitTree(workingCopy.path, sha, runProcess, workingCopy.gitDir), working: (workingCopy) => workingTree(workingCopy.path) },
    candidates: bumpCandidates,
    npm: computeOnBase,
    verify: verifyPlan,
    snapshot: (workingCopy) => snapshotCandidate(workingCopy),
    candidateTree: (workingCopy) => candidateTree(workingCopy),
    changedBetween: (workingCopy, base, sha) => changedBetween(workingCopy, base, sha),
    linkProblems: (workingCopy, base, sha) => linkProblems(workingCopy, base, sha),
    async wrapperAt(workingCopy, sha) {
      const copy = await exportCommit(workingCopy, sha);
      try {
        const files = await readWrapperFiles({ ...workingCopy, path: copy.dir });
        const jar = files.find((file) => file.path === WRAPPER_JAR);
        return { files, jarSha256: jar === undefined ? undefined : createHash("sha256").update(jar.bytes).digest("hex") };
      } finally {
        await copy.remove();
      }
    },
    journal: (context) => new FileJournal(context.config.dirs.state),
    priority: (context) => filePriority(context.config.dirs.state, context.repo.repo),
    writeFile: (workingCopy, path, content) => writeLocalFile(workingCopy.path, path, content),
    removeFile: (workingCopy, path) => removeLocalFile(workingCopy.path, path),
    revert: revertToBase,
  };
}
