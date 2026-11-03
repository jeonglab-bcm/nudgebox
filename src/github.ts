/**
 * Everything the app needs from GitHub, as one interface. The real adapter (Octokit,
 * the lab's GitHub App) implements it; tests use tests/helpers/fake-github.ts.
 * There is deliberately no close / delete / force-push / edit here (SPEC 6).
 */

export type Checks = "success" | "failure" | "pending" | "none";
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export interface PullRequest {
	repo: string; // "owner/name"
	number: number;
	title: string;
	url: string;
	author: string; // GitHub login
	draft: boolean;
	updatedAt: string; // ISO time of the last activity
	headSha: string;
	requestedReviewers: string[]; // GitHub logins
	requestedTeams: string[]; // "org/team-slug"
	reviewDecision: ReviewDecision; // null: no review required
	checks: Checks; // combined state of the head commit's checks
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

export interface Issue {
	repo: string; // "owner/name"
	number: number;
	title: string;
	url: string;
	author: string; // GitHub login
	assignees: string[]; // GitHub logins
	labels: string[];
	comments: number;
	updatedAt: string; // ISO time of the last activity
}

export interface UserTokens {
	login: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: string; // ISO
}

export interface GitHubPort {
	// linking a person (GitHub App user authorization)
	exchangeCode(code: string): Promise<UserTokens>;
	refresh(refreshToken: string): Promise<UserTokens>;
	// what a person can see, using their own token
	reposForUser(token: string): Promise<string[]>;
	teamsForUser(token: string): Promise<string[]>;
	// data, using the App's installation tokens
	openPullRequests(): Promise<PullRequest[]>;
	pullRequest(repo: string, number: number): Promise<PullRequest | null>;
	openIssues(): Promise<Issue[]>; // open issues only, never PRs (SPEC 11)
	issue(repo: string, number: number): Promise<Issue | null>; // null when closed, gone or a PR
	// actions, as the person (errors carry GitHub's `status` and message)
	merge(token: string, repo: string, number: number): Promise<void>;
	approve(token: string, repo: string, number: number): Promise<void>;
	rerunFailedChecks(token: string, repo: string, number: number): Promise<void>;
	comment(token: string, repo: string, number: number, body: string): Promise<void>;
}
