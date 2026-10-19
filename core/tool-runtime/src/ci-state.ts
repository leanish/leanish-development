// Copied from leanish/leanish-development agents/bump-it/src/ci-state.ts at c6282df; see PROVENANCE.md.
// Local changes: unreportedRequired names required checks the head never reported; `CiConclusion` defined here instead of bump-it's handler type; failingCheckNames supplies both failed Actions jobs and commit status contexts to adaptations; onlyCooldownHolds tells the gate's cooldown hold (its job's hold step, or the `failure` cooldown status older gates' daily rescan posted) from a failure.
import type { GitHubCheckRun, GitHubCommitStatus, GitHubHeadChecks, GitHubRequiredCheck } from "@leanish/agent-runtime/types/clients";

/** What a PR head's CI says. */
export type CiConclusion = "success" | "failure" | "pending" | "none";

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);
const FAILED_STATUSES: ReadonlySet<string> = new Set(["failure", "error"]);
const RUNNING_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/**
 * The CI state of a PR head from its latest check runs and commit statuses,
 * in this order:
 *
 *   - `failure` — any check concluded failed (or any status failed), even
 *     while others still run: a known failure needs the agent now;
 *   - `pending` — anything still queued, waiting or running;
 *   - `success` — everything completed with success / neutral / skipped
 *     (statuses: success), and at least one check or status really succeeded;
 *   - `none` — nothing to go on: no checks, all skipped or neutral, or a
 *     value this function doesn't know (never read as success).
 *
 * "All observed checks passed", not "all required checks passed": a required
 * check that never started is invisible here — the same blind spot as
 * `gh pr checks`. `unreportedRequired` names such checks when a draft is marked ready.
 */
export function classifyCi(checks: GitHubHeadChecks): CiConclusion {
  const { checkRuns, statuses } = checks;
  const failed =
    checkRuns.some((run) => run.status === "completed" && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) ||
    statuses.some((status) => FAILED_STATUSES.has(status.state));
  if (failed) return "failure";

  // An unknown run status is ambiguous even next to a running check: never wait it out.
  if (checkRuns.some((run) => run.status !== "completed" && !RUNNING_RUN_STATUSES.has(run.status))) return "none";

  const running =
    checkRuns.some((run) => RUNNING_RUN_STATUSES.has(run.status)) || statuses.some((status) => status.state === "pending");
  if (running) return "pending";

  const allPassing =
    checkRuns.every((run) => run.status === "completed" && run.conclusion !== null && PASSING_CONCLUSIONS.has(run.conclusion)) &&
    statuses.every((status) => status.state === "success");
  const anySucceeded =
    checkRuns.some((run) => run.conclusion === "success") || statuses.some((status) => status.state === "success");
  return allPassing && anySucceeded ? "success" : "none";
}

/** GitHub Actions' app: a required check bound to it is an Actions job, which `headChecks` reads. */
export const ACTIONS_APP_ID = 15368;

/**
 * The required checks the head hasn't reported. `missing`: bound to Actions, whose jobs `headChecks` reads, so one
 * that hasn't started is known not to have run on the head. `unobservable`: bound to another app or to any source,
 * which another app's check run can satisfy and `headChecks` can't read without the Checks permission. A commit
 * status of that name still counts as reported.
 */
export function unreportedRequired(checks: GitHubHeadChecks, required: ReadonlyArray<GitHubRequiredCheck>): { readonly missing: string[]; readonly unobservable: string[] } {
  const reported = new Set([...checks.checkRuns.map((run) => run.name), ...checks.statuses.map((status) => status.context)]);
  const unreported = required.filter((check) => !reported.has(check.context));
  const observable = (check: GitHubRequiredCheck) => check.integrationId === ACTIONS_APP_ID;
  return {
    missing: [...new Set(unreported.filter(observable).map((check) => check.context))].sort(),
    unobservable: [...new Set(unreported.filter((check) => !observable(check)).map((check) => check.context))].sort(),
  };
}

/** Failure names from the same jobs and statuses used to classify CI. */
export function failingCheckNames(checks: GitHubHeadChecks): string[] {
  const jobs = checks.checkRuns
    .filter((run) => run.status === "completed" && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion))
    .map((run) => run.name);
  const statuses = checks.statuses.filter((status) => FAILED_STATUSES.has(status.state)).map((status) => status.context);
  return [...new Set([...jobs, ...statuses])].sort();
}

/** The steps of the gate's `cooldown` job (`.github/workflows/supply-chain.yml`); a hold fails the second after the first passed. */
export const COOLDOWN_STEPS = { evaluate: "Evaluate the cooldown", hold: "Hold the young versions" } as const;

/** A gate job, as the caller names it: `<job>` or `<calling job> / <job>`. */
const isGateJob = (run: GitHubCheckRun, job: string) => run.name === job || run.name.endsWith(` / ${job}`);

/**
 * Whether the head's only failures are the gate's cooldown holding young
 * versions after a passing comparison: waiting, not broken. That's the
 * cooldown job failing its hold step, or a `failure` status under the
 * cooldown check's name: gates before 0.4.0 rescanned open PRs daily and posted
 * these, and they stay on a head nothing pushed to since (a cooldown that
 * rescan couldn't evaluate was an `error`). A cooldown that failed any other way (no evaluation, a missing
 * report, cancelled) is an ordinary failure, and so is a hold next to any
 * other failure.
 */
export function onlyCooldownHolds(checks: GitHubHeadChecks): boolean {
  const failedStatuses = checks.statuses.filter((status) => FAILED_STATUSES.has(status.state));
  const failed = checks.checkRuns.filter((run) => run.status === "completed" && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion));
  if (failed.length + failedStatuses.length === 0 || !failed.every(heldByCooldown) || !failedStatuses.every(heldByRescan)) return false;
  return checks.checkRuns.some((run) => isGateJob(run, "supply-chain") && run.status === "completed" && run.conclusion === "success");
}

function heldByRescan(status: GitHubCommitStatus): boolean {
  return status.state === "failure" && (status.context === "cooldown" || status.context.endsWith(" / cooldown"));
}

function heldByCooldown(run: GitHubCheckRun): boolean {
  if (!isGateJob(run, "cooldown") || run.conclusion !== "failure") return false;
  const step = (name: string) => run.steps?.find((candidate) => candidate.name === name);
  return step(COOLDOWN_STEPS.evaluate)?.conclusion === "success" && step(COOLDOWN_STEPS.hold)?.conclusion === "failure";
}
