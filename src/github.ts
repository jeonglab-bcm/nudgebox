/**
 * Everything the app needs from GitHub, as one interface. The real adapter (Octokit,
 * the lab's GitHub App) implements it; tests use tests/helpers/fake-github.ts.
 * There is deliberately no close / delete / force-push / edit here (SPEC 6).
 */
import type { Readable } from "node:stream";

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
	// SPEC 16: lines GitHub takes a comment on (inside the patch's hunks), [first, last] inclusive;
	// absent for a file with no patch (binary or too large)
	commentable?: { left: [number, number][]; right: [number, number][] };
}

// -- SPEC 16: the PR page -----------------------------------------------------------

export type MergeMethod = "merge" | "squash" | "rebase";
export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface PrPage {
	repo: string;
	number: number;
	title: string;
	body: string; // Markdown, untrusted
	url: string;
	author: string;
	createdAt: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	draft: boolean;
	baseRef: string; // branch names
	headRef: string;
	headRepo: string; // "owner/name"; differs from repo for a fork
	headSha: string;
	commits: number;
	additions: number;
	deletions: number;
	changedFiles: number;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	mergeState: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
	mergeMethods: MergeMethod[]; // what the repo allows, in GitHub's order
	reviewDecision: ReviewDecision;
	reviewers: { login?: string; team?: string; state: "REQUESTED" | ReviewState }[];
	assignees: string[];
	labels: { name: string; color: string }[]; // color: 6 hex digits
	milestone: { number: number; title: string } | null;
	timeline: TimelineItem[]; // oldest first
	threads: ReviewThread[];
	checks: CheckRun[];
	viewed: Record<string, "VIEWED" | "UNVIEWED" | "DISMISSED">; // the reader's own ticks
	pendingReview: { id: string; comments: number } | null; // the reader's own
}

export type TimelineItem =
	| { type: "comment"; id: string; author: string; body: string; at: string }
	| { type: "review"; id: string; author: string; state: ReviewState; body: string; at: string }
	| { type: "commit"; sha: string; message: string; author: string; at: string }
	| {
		type: "event";
		event: "labeled" | "unlabeled" | "assigned" | "unassigned" | "review_requested" | "review_request_removed"
			| "ready_for_review" | "convert_to_draft" | "head_ref_force_pushed" | "merged" | "closed" | "reopened";
		actor: string;
		subject?: string; // the label, person or team
		at: string;
	};

export interface ReviewThread {
	id: string;
	path: string;
	line: number | null; // null when outdated past mapping
	startLine: number | null; // a multi-line comment's first line
	side: "LEFT" | "RIGHT"; // LEFT: the before version
	resolved: boolean;
	outdated: boolean;
	reviewId: string | null; // the review it was posted in
	diffHunk: string; // the code around it, as GitHub shows in Conversation
	comments: { id: string; author: string; body: string; at: string; pending: boolean }[];
}

export interface CheckRun {
	name: string;
	workflow?: string;
	state: "passed" | "failed" | "running" | "queued" | "skipped" | "cancelled" | "neutral";
	startedAt?: string;
	completedAt?: string;
	url?: string; // its log on GitHub
}

export interface RepoOptions {
	assignable: string[]; // logins
	labels: { name: string; color: string; description: string }[];
	milestones: { number: number; title: string }[]; // open ones
}

export interface NewReviewComment {
	mode: "single" | "review"; // posted now, or added to the person's pending review
	path: string;
	body: string;
	subject: "line" | "file";
	line?: number;
	side?: "LEFT" | "RIGHT";
	startLine?: number;
}

/** SPEC 16: what resolving conflicts needs, read with the App's token. */
export interface MergeInputs {
	headRepo: string;
	headRef: string;
	headSha: string;
	baseRef: string;
	baseSha: string; // the base branch's tip now
	mergeBase: string;
	headFiles: ChangedFile[]; // mergeBase...headSha
	baseFiles: ChangedFile[]; // mergeBase...baseSha
}

/** SPEC 16: one merge commit on a branch, made from the head commit's tree. */
export interface MergeCommit {
	message: string;
	parents: [string, string]; // [head, base tip]
	take: string[]; // paths whose version comes from the base tip as is
	remove: string[]; // paths deleted
	write: { path: string; text: string }[]; // merged or resolved content
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
	archive(repo: string, ref: string): Promise<Readable | null>; // SPEC 21: the commit as a gzip tarball; null when not there
	// SPEC 16: the PR page, read as the person (their pending review and Viewed ticks)
	prPage(token: string, repo: string, number: number): Promise<PrPage | null>;
	repoOptions(token: string, repo: string): Promise<RepoOptions>;
	mergeInputs(repo: string, number: number): Promise<MergeInputs | null>;
	// actions, as the person (errors carry GitHub's `status` and message)
	merge(token: string, repo: string, number: number, how?: { method: MergeMethod; title?: string; message?: string }): Promise<void>;
	approve(token: string, repo: string, number: number): Promise<void>;
	rerunFailedChecks(token: string, repo: string, number: number): Promise<void>;
	comment(token: string, repo: string, number: number, body: string): Promise<void>;
	// SPEC 16
	addReviewComment(token: string, repo: string, number: number, c: NewReviewComment): Promise<void>;
	replyToThread(token: string, repo: string, number: number, thread: string, body: string): Promise<void>;
	setThreadResolved(token: string, repo: string, number: number, thread: string, resolved: boolean): Promise<void>;
	submitReview(token: string, repo: string, number: number, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string): Promise<void>;
	cancelReview(token: string, repo: string, number: number): Promise<void>; // drops the person's pending review
	updateBranch(token: string, repo: string, number: number): Promise<void>;
	setDraft(token: string, repo: string, number: number, draft: boolean): Promise<void>;
	setViewed(token: string, repo: string, number: number, path: string, viewed: boolean): Promise<void>;
	requestReviewers(token: string, repo: string, number: number, add: string[], remove: string[]): Promise<void>;
	setAssignees(token: string, repo: string, number: number, logins: string[]): Promise<void>;
	setLabels(token: string, repo: string, number: number, names: string[]): Promise<void>;
	setMilestone(token: string, repo: string, number: number, milestone: number | null): Promise<void>;
	commitMerge(token: string, repo: string, branch: string, c: MergeCommit): Promise<string>; // the new commit's sha; never a force push
	setState(token: string, repo: string, number: number, state: "closed" | "open"): Promise<void>; // Close / Reopen
	// SPEC 16: the Commits tab, read with the App's token
	prCommits(repo: string, number: number): Promise<PrCommit[] | null>; // oldest first; null when no such PR
	commitFiles(repo: string, sha: string): Promise<PrFiles | null>; // against the first parent
}

export interface PrCommit {
	sha: string;
	message: string; // first line
	author: string; // GitHub login, or the git name when none
	at: string;
}
