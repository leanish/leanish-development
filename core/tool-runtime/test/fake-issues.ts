import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";

import type { GitHubIssue, GitHubIssueComment, GitHubIssueEvent, GitHubIssues, LatestClosing, RepositoryPermission } from "../src/github-issues.ts";

/** In-memory issues for one repository, as GitHub keeps them: issues, comments, events and permissions. */
export class FakeIssues implements GitHubIssues {
  readonly issues = new Map<number, GitHubIssue>();
  readonly comments = new Map<number, GitHubIssueComment[]>();
  readonly events = new Map<number, GitHubIssueEvent[]>();
  readonly permissions = new Map<string, RepositoryPermission>();
  readonly calls: string[] = [];
  /** Operations GitHub refuses as forbidden (a PAT without Issues write). */
  readonly forbidden = new Set<string>();
  /** The numbers each `latestClosings` call asked about. */
  readonly closingQueries: number[][] = [];
  /**
   * As GitHub's filtered listing does, list issues as they were at the previous listing: a write shows up one listing
   * late (a new issue missing, an edited one with its old body). Reading an issue by its number is never late.
   */
  lagging = false;
  /**
   * Labels the repository already has, by lowercase name, in the casing they were made with: as on GitHub, applying
   * one by any casing gives it that casing, and filters and removals match it ignoring case.
   */
  readonly repoLabels = new Map<string, string>();
  /** Issues whose latest closing wasn't a person's. Any other closing reads as one, as the tool's own does on GitHub. */
  #closedByNoPerson = new Set<number>();
  #listed = new Map<number, GitHubIssue>();
  #next = 1;
  #ids = 1000;

  readonly me: string;

  constructor(me = "leanish") {
    this.me = me;
  }

  async listIssues({ creator, label }: { repo: string; creator: string; label: string }): Promise<ReadonlyArray<GitHubIssue>> {
    const seen = this.lagging ? this.#listed : this.issues;
    this.#listed = new Map(this.issues);
    return [...seen.values()].filter((issue) => issue.author === creator && issue.labels.some((name) => sameLabel(name, label)));
  }

  async getIssue({ number }: { repo: string; number: number }): Promise<GitHubIssue> {
    const issue = this.issues.get(number);
    if (issue === undefined) throw new GitHubApiError("getIssue", "not found", 404);
    return issue;
  }

  async createIssue({ title, body, labels }: { repo: string; title: string; body: string; labels: ReadonlyArray<string> }): Promise<GitHubIssue> {
    this.#refuse("createIssue");
    const number = this.#next++;
    const issue: GitHubIssue = { number, url: `https://github.com/acme/widget/issues/${number}`, title, body, state: "open", stateReason: null, author: this.me, labels: labels.map((label) => this.#cased(label)) };
    this.issues.set(number, issue);
    this.calls.push(`createIssue #${number}`);
    return issue;
  }

  async updateIssue(args: { repo: string; number: number; body?: string; state?: "open" | "closed"; stateReason?: "completed" | "not_planned" | "reopened" }): Promise<GitHubIssue> {
    this.#refuse("updateIssue");
    const issue = await this.getIssue(args);
    const updated: GitHubIssue = {
      ...issue,
      ...(args.body === undefined ? {} : { body: args.body }),
      ...(args.state === undefined ? {} : { state: args.state, stateReason: args.stateReason ?? null }),
    };
    this.issues.set(args.number, updated);
    if (args.state !== undefined && args.state !== issue.state) this.#closedByNoPerson.delete(args.number);
    if (args.state === "closed" && issue.state === "open") this.#event(args.number, { event: "closed", actor: this.me });
    this.calls.push(`updateIssue #${args.number}${args.state === undefined ? "" : ` ${args.state}`}`);
    return updated;
  }

  async listComments({ number }: { repo: string; number: number }): Promise<ReadonlyArray<GitHubIssueComment>> {
    return this.comments.get(number) ?? [];
  }

  async createComment({ number, body }: { repo: string; number: number; body: string }): Promise<GitHubIssueComment> {
    this.#refuse("createComment");
    return this.comment(number, this.me, body);
  }

  async listEvents({ number }: { repo: string; number: number }): Promise<ReadonlyArray<GitHubIssueEvent>> {
    return this.events.get(number) ?? [];
  }

  async latestClosings({ numbers }: { repo: string; numbers: ReadonlyArray<number> }): Promise<ReadonlyMap<number, LatestClosing>> {
    this.#refuse("latestClosings");
    this.closingQueries.push([...numbers]);
    return new Map(numbers.map((number) => {
      const closed = (this.events.get(number) ?? []).filter((event) => event.event === "closed").at(-1);
      if (closed === undefined) throw new GitHubApiError("latestClosings", "malformed closing history");
      return [number, { id: `CE_${closed.id}`, byPerson: !this.#closedByNoPerson.has(number) }];
    }));
  }

  async removeLabel({ number, label }: { repo: string; number: number; label: string }): Promise<void> {
    this.#refuse("removeLabel");
    const issue = await this.getIssue({ repo: "", number });
    this.issues.set(number, { ...issue, labels: issue.labels.filter((name) => !sameLabel(name, label)) });
    this.#event(number, { event: "unlabeled", actor: this.me, label: this.#cased(label) });
  }

  async permission({ login }: { repo: string; login: string }): Promise<RepositoryPermission> {
    return this.permissions.get(login) ?? "none";
  }

  async login(): Promise<string> {
    return this.me;
  }

  /** A comment by `author`, as a person (or the tool) writes it. */
  comment(number: number, author: string, body: string, at = "2026-11-03T08:00:00Z"): GitHubIssueComment {
    const comment = { id: this.#ids++, author, body, createdAt: at, updatedAt: at };
    this.comments.set(number, [...this.comments.get(number) ?? [], comment]);
    this.calls.push(`createComment #${number}`);
    return comment;
  }

  /** A person adding a label. */
  label(number: number, actor: string, label: string, at = "2026-11-03T08:01:00Z"): void {
    const issue = this.issues.get(number)!;
    this.issues.set(number, { ...issue, labels: [...issue.labels, this.#cased(label)] });
    this.#event(number, { event: "labeled", actor, label: this.#cased(label), createdAt: at });
  }

  /** A person closing or reopening an issue. Only the latest closing counts: this one names no closer. */
  setState(number: number, state: "open" | "closed", actor = this.me, at?: string): void {
    const issue = this.issues.get(number)!;
    this.issues.set(number, { ...issue, state });
    this.#closedByNoPerson.delete(number);
    this.#event(number, { event: state === "open" ? "reopened" : "closed", actor, ...(at === undefined ? {} : { createdAt: at }) });
  }

  /** GitHub closing an issue because a PR or commit referenced it, which it records as that closing's closer. */
  closeByReference(number: number, actor = "owner", at?: string): void {
    this.setState(number, "closed", actor, at);
    this.#closedByNoPerson.add(number);
  }

  /** An automation closing an issue through its own bot identity, not a person's token. */
  closeByBot(number: number, at?: string): void {
    this.setState(number, "closed", "github-actions[bot]", at);
    this.#closedByNoPerson.add(number);
  }

  #event(number: number, event: { event: string; actor: string; label?: string; createdAt?: string }): void {
    const { createdAt, ...rest } = event;
    this.events.set(number, [...this.events.get(number) ?? [], { id: this.#ids++, createdAt: createdAt ?? "2026-11-03T09:00:00Z", ...rest }]);
  }

  #cased(label: string): string {
    return this.repoLabels.get(label.toLowerCase()) ?? label;
  }

  #refuse(operation: string): void {
    if (this.forbidden.has(operation)) throw new GitHubApiError(operation, "forbidden", 403);
  }
}

function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
