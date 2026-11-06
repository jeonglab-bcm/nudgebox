/**
 * In-memory stand-in for GitHub (the GitHubPort the app talks to). Tests set up
 * users, repo access, teams and PRs here, and read back what the app asked GitHub
 * to do. No network.
 */
import type { PrCommit, GitHubPort, Issue, ItemContent, MergeCommit, MergeInputs, MergeMethod, NewReviewComment, PrFiles, PrPage, PullRequest, RepoOptions, UserTokens } from "../../src/github.ts";

export type Call = { op: string; token?: string; repo?: string; number?: number; body?: string; args?: any };

export class FakeGitHub implements GitHubPort {
	prs = new Map<string, PullRequest>(); // key "owner/repo#n"
	issues = new Map<string, Issue>(); // key "owner/repo#n"
	access = new Map<string, Set<string>>(); // github login -> repos it can see
	teams = new Map<string, string[]>(); // github login -> "org/team" slugs
	codes = new Map<string, string>(); // oauth code -> github login
	content = new Map<string, ItemContent>(); // "owner/repo#n" -> text a summary reads (SPEC 12)
	prFileSets = new Map<string, PrFiles>(); // "owner/repo#n" -> changed files (SPEC 15)
	blobs = new Map<string, string | Buffer>(); // "owner/repo@ref:path" -> file content (SPEC 15)
	pages = new Map<string, Partial<PrPage>>(); // "owner/repo#n" -> the PR page's own parts (SPEC 16)
	options = new Map<string, RepoOptions>(); // repo -> assignable people, labels, milestones (SPEC 16)
	mergeSets = new Map<string, MergeInputs>(); // "owner/repo#n" -> what resolving conflicts reads (SPEC 16)
	commits = new Map<string, PrCommit[]>(); // "owner/repo#n" -> the PR's commits (SPEC 16)
	commitFileSets = new Map<string, PrFiles>(); // "owner/repo@sha" -> a commit's files (SPEC 16)
	calls: Call[] = [];
	failNext: { status: number; message: string } | null = null;
	tokenTtlMs = 8 * 3600_000;
	private issued = 0;

	addPr(pr: Partial<PullRequest> & Pick<PullRequest, "repo" | "number" | "author">): PullRequest {
		const full: PullRequest = {
			title: `PR ${pr.number}`,
			url: `https://github.com/${pr.repo}/pull/${pr.number}`,
			draft: false,
			updatedAt: new Date().toISOString(),
			headSha: `sha-${pr.repo}-${pr.number}`,
			requestedReviewers: [],
			requestedTeams: [],
			reviewDecision: null,
			checks: "none",
			mergeable: "MERGEABLE",
			...pr,
		};
		this.prs.set(`${full.repo}#${full.number}`, full);
		return full;
	}

	addIssue(i: Partial<Issue> & Pick<Issue, "repo" | "number" | "author">): Issue {
		const full: Issue = {
			title: `Issue ${i.number}`,
			url: `https://github.com/${i.repo}/issues/${i.number}`,
			assignees: [],
			labels: [],
			comments: 0,
			updatedAt: new Date().toISOString(),
			...i,
		};
		this.issues.set(`${full.repo}#${full.number}`, full);
		return full;
	}

	grant(login: string, ...repos: string[]) {
		const s = this.access.get(login) ?? new Set();
		repos.forEach((r) => s.add(r));
		this.access.set(login, s);
	}

	private loginOf(token: string): string {
		const login = token.split(":")[1];
		if (!login || token.startsWith("expired:")) throw Object.assign(new Error("Bad credentials"), { status: 401 });
		return login;
	}

	private mint(login: string): UserTokens {
		this.issued++;
		return {
			login,
			accessToken: `tok${this.issued}:${login}`,
			refreshToken: `ref${this.issued}:${login}`,
			expiresAt: new Date(Date.now() + this.tokenTtlMs).toISOString(),
		};
	}

	async exchangeCode(code: string): Promise<UserTokens> {
		const login = this.codes.get(code);
		if (!login) throw Object.assign(new Error("bad_verification_code"), { status: 400 });
		this.calls.push({ op: "exchangeCode" });
		return this.mint(login);
	}

	async refresh(refreshToken: string): Promise<UserTokens> {
		this.calls.push({ op: "refresh" });
		return this.mint(refreshToken.split(":")[1]);
	}

	async reposForUser(token: string): Promise<string[]> {
		return [...(this.access.get(this.loginOf(token)) ?? [])];
	}

	async teamsForUser(token: string): Promise<string[]> {
		return this.teams.get(this.loginOf(token)) ?? [];
	}

	async openPullRequests(): Promise<PullRequest[]> {
		return [...this.prs.values()].map((p) => ({ ...p }));
	}

	async pullRequest(repo: string, number: number): Promise<PullRequest | null> {
		const p = this.prs.get(`${repo}#${number}`);
		return p ? { ...p } : null;
	}

	async openIssues(): Promise<Issue[]> {
		return [...this.issues.values()].map((i) => ({ ...i }));
	}

	async issue(repo: string, number: number): Promise<Issue | null> {
		const i = this.issues.get(`${repo}#${number}`);
		return i ? { ...i } : null;
	}

	async prContent(repo: string, number: number): Promise<ItemContent> {
		this.calls.push({ op: "prContent", repo, number });
		return this.content.get(`${repo}#${number}`) ?? { body: "", comments: [], files: [] };
	}

	async prFiles(repo: string, number: number): Promise<PrFiles | null> {
		const f = this.prFileSets.get(`${repo}#${number}`);
		return f ? structuredClone(f) : null;
	}

	async fileAt(repo: string, ref: string, path: string): Promise<Buffer | null> {
		const b = this.blobs.get(`${repo}@${ref}:${path}`);
		return b === undefined ? null : Buffer.from(b);
	}

	async issueContent(repo: string, number: number): Promise<ItemContent> {
		this.calls.push({ op: "issueContent", repo, number });
		return this.content.get(`${repo}#${number}`) ?? { body: "", comments: [] };
	}

	/** SPEC 16: the page of an open PR in `prs`, its own parts from `pages`. Who reads it is recorded. */
	async prPage(token: string, repo: string, number: number): Promise<PrPage | null> {
		this.loginOf(token);
		this.calls.push({ op: "prPage", token, repo, number });
		const p = this.prs.get(`${repo}#${number}`);
		const own = this.pages.get(`${repo}#${number}`);
		if (!p && !own) return null;
		return structuredClone({
			repo, number, title: p?.title ?? `PR ${number}`, body: "", url: p?.url ?? `https://github.com/${repo}/pull/${number}`,
			author: p?.author ?? "ghost", createdAt: "2026-11-01T15:00:00Z", state: "OPEN", draft: p?.draft ?? false,
			baseRef: "main", headRef: "feature", headRepo: repo, headSha: p?.headSha ?? "head-sha",
			commits: 1, additions: 0, deletions: 0, changedFiles: 0,
			mergeable: p?.mergeable ?? "MERGEABLE", mergeState: "CLEAN", mergeMethods: ["merge", "squash", "rebase"],
			reviewDecision: p?.reviewDecision ?? null,
			reviewers: (p?.requestedReviewers ?? []).map((login) => ({ login, state: "REQUESTED" as const })),
			assignees: [], labels: [], milestone: null, timeline: [], threads: [], checks: [], viewed: {}, pendingReview: null,
			...own,
		} as PrPage);
	}

	async repoOptions(token: string, repo: string): Promise<RepoOptions> {
		this.loginOf(token);
		return structuredClone(this.options.get(repo) ?? { assignable: [], labels: [], milestones: [] });
	}

	async mergeInputs(repo: string, number: number): Promise<MergeInputs | null> {
		const m = this.mergeSets.get(`${repo}#${number}`);
		return m ? structuredClone(m) : null;
	}

	private act(op: string, token: string, repo: string, number: number, body?: string, args?: unknown) {
		this.loginOf(token);
		this.calls.push({ op, token, repo, number, body, ...(args === undefined ? {} : { args }) });
		if (this.failNext) {
			const f = this.failNext;
			this.failNext = null;
			throw Object.assign(new Error(f.message), { status: f.status });
		}
	}

	async merge(token: string, repo: string, number: number, how?: { method: MergeMethod; title?: string; message?: string }) {
		this.act("merge", token, repo, number, undefined, how);
	}
	async approve(token: string, repo: string, number: number) {
		this.act("approve", token, repo, number);
	}
	async rerunFailedChecks(token: string, repo: string, number: number) {
		this.act("rerunFailedChecks", token, repo, number);
	}
	async comment(token: string, repo: string, number: number, body: string) {
		this.act("comment", token, repo, number, body);
	}

	// SPEC 16
	async addReviewComment(token: string, repo: string, number: number, c: NewReviewComment) {
		this.act("addReviewComment", token, repo, number, c.body, c);
	}
	async replyToThread(token: string, repo: string, number: number, thread: string, body: string) {
		this.act("replyToThread", token, repo, number, body, { thread });
	}
	async setThreadResolved(token: string, repo: string, number: number, thread: string, resolved: boolean) {
		this.act("setThreadResolved", token, repo, number, undefined, { thread, resolved });
	}
	async submitReview(token: string, repo: string, number: number, event: string, body: string) {
		this.act("submitReview", token, repo, number, body, { event });
	}
	async cancelReview(token: string, repo: string, number: number) {
		this.act("cancelReview", token, repo, number);
	}
	async updateBranch(token: string, repo: string, number: number) {
		this.act("updateBranch", token, repo, number);
	}
	async setDraft(token: string, repo: string, number: number, draft: boolean) {
		this.act("setDraft", token, repo, number, undefined, { draft });
	}
	async setViewed(token: string, repo: string, number: number, path: string, viewed: boolean) {
		this.act("setViewed", token, repo, number, undefined, { path, viewed });
	}
	async requestReviewers(token: string, repo: string, number: number, add: string[], remove: string[]) {
		this.act("requestReviewers", token, repo, number, undefined, { add, remove });
	}
	async setAssignees(token: string, repo: string, number: number, logins: string[]) {
		this.act("setAssignees", token, repo, number, undefined, { logins });
	}
	async setLabels(token: string, repo: string, number: number, names: string[]) {
		this.act("setLabels", token, repo, number, undefined, { names });
	}
	async setMilestone(token: string, repo: string, number: number, milestone: number | null) {
		this.act("setMilestone", token, repo, number, undefined, { milestone });
	}
	/** Records the commit; `repo` here is the branch's repo and `number` is 0. */
	async commitMerge(token: string, repo: string, branch: string, c: MergeCommit) {
		this.act("commitMerge", token, repo, 0, undefined, { branch, ...c });
		return "merge-sha";
	}
	async setState(token: string, repo: string, number: number, state: "closed" | "open") {
		this.act("setState", token, repo, number, undefined, { state });
	}
	async prCommits(repo: string, number: number) {
		const c = this.commits.get(`${repo}#${number}`);
		return c ? structuredClone(c) : null;
	}
	async commitFiles(repo: string, sha: string) {
		const f = this.commitFileSets.get(`${repo}@${sha}`);
		return f ? structuredClone(f) : null;
	}
}
