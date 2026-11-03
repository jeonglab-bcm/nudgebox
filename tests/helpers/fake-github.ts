/**
 * In-memory stand-in for GitHub (the GitHubPort the app talks to). Tests set up
 * users, repo access, teams and PRs here, and read back what the app asked GitHub
 * to do. No network.
 */
import type { GitHubPort, Issue, PullRequest, UserTokens } from "../../src/github.ts";

export type Call = { op: string; token?: string; repo?: string; number?: number; body?: string };

export class FakeGitHub implements GitHubPort {
	prs = new Map<string, PullRequest>(); // key "owner/repo#n"
	issues = new Map<string, Issue>(); // key "owner/repo#n"
	access = new Map<string, Set<string>>(); // github login -> repos it can see
	teams = new Map<string, string[]>(); // github login -> "org/team" slugs
	codes = new Map<string, string>(); // oauth code -> github login
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

	private act(op: string, token: string, repo: string, number: number, body?: string) {
		this.loginOf(token);
		this.calls.push({ op, token, repo, number, body });
		if (this.failNext) {
			const f = this.failNext;
			this.failNext = null;
			throw Object.assign(new Error(f.message), { status: f.status });
		}
	}

	async merge(token: string, repo: string, number: number) {
		this.act("merge", token, repo, number);
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
}
