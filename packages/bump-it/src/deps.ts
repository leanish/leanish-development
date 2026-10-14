/** The external boundaries bump-it reaches; tests replace each without networking or agents. */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { bumpCandidates, type BumpCandidates } from "../../ci/src/candidates.ts";
import type { GateEnvironment, GradleInputs } from "../../ci/src/gate.ts";
import { namingFailures } from "../../ci/src/http.ts";
import { FileRepositoryAdvisoryCache } from "../../remediation/src/repository-advisory-cache.ts";
import { runProcess } from "../../ci/src/process.ts";
import { gitTree, type Tree, workingTree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { candidateTree, changedBetween, exportCommit, git, snapshotCandidate, symlinkedChanges } from "../../remediation/src/git-copies.ts";
import { type GradleInventories, sandboxedGradleInventories } from "../../remediation/src/inventories.ts";
import { FileJournal, type PublicationJournal } from "../../remediation/src/journal.ts";
import { ensureOsvScanner, verifyingRun } from "../../remediation/src/osv-scanner.ts";
import { revertToBase } from "../../remediation/src/reconcile.ts";

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
  /** The paths `sha` made symbolic links relative to `base` (`symlinkedChanges`). */
  readonly symlinkedChanges: (workingCopy: WorkingCopy, base: string, sha: string) => Promise<string[]>;
  /** The wrapper files and jar hash as committed in `sha`, the verification snapshot. */
  readonly wrapperAt: (workingCopy: WorkingCopy, sha: string) => Promise<{ readonly files: ReadonlyArray<WrapperArtifact>; readonly jarSha256: string | undefined }>;
  readonly journal: (context: ToolRunContext) => PublicationJournal;
  readonly priority: (context: ToolRunContext) => MajorPriority;
  readonly writeFile: (workingCopy: WorkingCopy, path: string, content: string) => Promise<void>;
  readonly removeFile: (workingCopy: WorkingCopy, path: string) => Promise<void>;
  readonly revert: (workingCopy: WorkingCopy, baseSha: string) => Promise<ReadonlyArray<string>>;
}

export function defaultDeps(): BumpItDeps {
  return {
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
      const writable = [context.config.dirs.cache, context.workingCopy.path, tmpdir(), "/tmp", ...(context.isolation.buildCacheRoot === undefined ? [] : [context.isolation.buildCacheRoot])];
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
    symlinkedChanges: (workingCopy, base, sha) => symlinkedChanges(workingCopy, base, sha),
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
