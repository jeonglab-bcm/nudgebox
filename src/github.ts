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

/** SPEC 12: the text a summary reads. `files` only for PRs. */
export interface ItemContent {
	body: string;
	comments: { author: string; body: string }[]; // conversation, then review comments
	files?: { path: string; patch: string }[]; // patch "" for binary or too-large files
}

/** SPEC 15: a PR's changed files, against the merge base (as GitHub's "Files changed"). */
export interface PrFiles {
	base: string; // merge-base commit
	head: string; // head commit
	files: ChangedFile[];
}

export interface ChangedFile {
	path: string;
	previous?: string; // the old path of a renamed file
	status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
	additions: number;
	deletions: number;
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
	prContent(repo: string, number: number): Promise<ItemContent>; // SPEC 12
	issueContent(repo: string, number: number): Promise<ItemContent>; // SPEC 12
	prFiles(repo: string, number: number): Promise<PrFiles | null>; // SPEC 15; null when no such PR
	fileAt(repo: string, ref: string, path: string): Promise<Buffer | "too large" | null>; // SPEC 15; null when not there
	// actions, as the person (errors carry GitHub's `status` and message)
	merge(token: string, repo: string, number: number): Promise<void>;
	approve(token: string, repo: string, number: number): Promise<void>;
	rerunFailedChecks(token: string, repo: string, number: number): Promise<void>;
	comment(token: string, repo: string, number: number, body: string): Promise<void>;
}
