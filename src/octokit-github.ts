/**
 * The real GitHubPort: the lab's GitHub App through Octokit (GitHub's official SDK).
 *
 * - Data (open PRs) is read with the App's installation tokens, one installation per
 *   account in config.orgs, through GraphQL so a PR's reviews and checks come in one
 *   request.
 * - Linking and actions use the person's own user token (GitHub App user
 *   authorization), so GitHub attributes them to that person and enforces their
 *   permissions.
 */
import { Readable } from "node:stream";
import { App, Octokit } from "octokit";
import { fileKind } from "./filekind.ts";
import type {
	ChangedFile, CheckRun, Checks, GitHubPort, Issue, ItemContent, MergeCommit, MergeInputs, MergeMethod, NewReviewComment, PrCommit, PrFiles, PrPage,
	PrSize, PullRequest, RepoOptions, ReviewDecision, ReviewThread, TimelineItem, UserTokens,
} from "./github.ts";

export interface OctokitGitHubOptions {
	appId: string;
	privateKey: string;
	clientId: string;
	clientSecret: string;
	accounts: string[]; // installation accounts to read, e.g. ["jeonglab-bcm", "hyunhwan-bcm"]
	apiUrl?: string; // default https://api.github.com (tests point this at a fake)
	webUrl?: string; // default https://github.com (OAuth token endpoint)
	log?: (msg: string) => void;
}

const PR_FIELDS = `
	number title url isDraft updatedAt headRefOid state mergeable reviewDecision
	author { login }
	repository { nameWithOwner }
	reviewRequests(first: 30) { nodes { requestedReviewer {
		... on User { login }
		... on Team { slug organization { login } }
	} } }
	commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
	additions deletions changedFiles files(first: 100) { nodes { path additions deletions } }`;

const ISSUE_FIELDS = `
	number title url updatedAt state
	author { login }
	repository { nameWithOwner }
	assignees(first: 20) { nodes { login } }
	labels(first: 20) { nodes { name } }
	comments { totalCount }`;

export function toIssue(n: any): Issue {
	return {
		repo: n.repository.nameWithOwner,
		number: n.number,
		title: n.title,
		url: n.url,
		author: n.author?.login ?? "ghost",
		assignees: (n.assignees?.nodes ?? []).map((a: { login: string }) => a.login),
		labels: (n.labels?.nodes ?? []).map((l: { name: string }) => l.name),
		comments: n.comments?.totalCount ?? 0,
		updatedAt: new Date(n.updatedAt).toISOString(),
	};
}

function checksOf(state: string | undefined | null): Checks {
	if (state === "SUCCESS") return "success";
	if (state === "FAILURE" || state === "ERROR") return "failure";
	if (state === "PENDING" || state === "EXPECTED") return "pending";
	return "none";
}

/**
 * SPEC 5: how much of a PR a reviewer reads. Settings, tables, pictures and lock files are
 * changed lines too, but nobody reads them line by line. Files past the first hundred are
 * not listed; their lines count as lines to read, so a huge PR is never called easy.
 */
function sizeOf(n: any): PrSize | undefined {
	if (typeof n.additions !== "number" || typeof n.deletions !== "number") return undefined;
	const lines = n.additions + n.deletions;
	let listed = 0;
	let read = 0;
	for (const f of n.files?.nodes ?? []) {
		if (!f?.path) continue;
		const changed = (f.additions ?? 0) + (f.deletions ?? 0);
		listed += changed;
		if (fileKind(f.path) !== "other") read += changed;
	}
	return { files: n.changedFiles ?? n.files?.nodes?.length ?? 0, lines, read: read + Math.max(0, lines - listed) };
}

export function toPullRequest(n: any): PullRequest {
	const reviewers: string[] = [];
	const teams: string[] = [];
	for (const r of n.reviewRequests?.nodes ?? []) {
		const who = r?.requestedReviewer;
		if (who?.login) reviewers.push(who.login);
		else if (who?.slug) teams.push(`${who.organization?.login}/${who.slug}`);
	}
	const size = sizeOf(n);
	return {
		repo: n.repository.nameWithOwner,
		number: n.number,
		title: n.title,
		url: n.url,
		author: n.author?.login ?? "ghost",
		draft: Boolean(n.isDraft),
		updatedAt: new Date(n.updatedAt).toISOString(),
		headSha: n.headRefOid,
		requestedReviewers: reviewers,
		requestedTeams: teams,
		reviewDecision: (n.reviewDecision ?? null) as ReviewDecision,
		checks: checksOf(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
		mergeable: n.mergeable === "MERGEABLE" || n.mergeable === "CONFLICTING" ? n.mergeable : "UNKNOWN",
		...(size ? { size } : {}),
	};
}

/** Every open PR or issue in one account (org or user), through GraphQL search. */
async function searchOpen<T>(o: Octokit, account: string, kind: "pr" | "issue", map: (n: any) => T): Promise<T[]> {
	const { data: acct } = await o.request("GET /users/{username}", { username: account });
	const q = `is:${kind} is:open ${acct.type === "Organization" ? "org" : "user"}:${account} archived:false`;
	const fragment = kind === "pr" ? `... on PullRequest { ${PR_FIELDS} }` : `... on Issue { ${ISSUE_FIELDS} }`;
	const out: T[] = [];
	let after: string | null = null;
	do {
		const r: any = await o.graphql(
			`query($q: String!, $after: String) { search(type: ISSUE, query: $q, first: 50, after: $after) {
				pageInfo { hasNextPage endCursor } nodes { ${fragment} } } }`,
			{ q, after },
		);
		out.push(...r.search.nodes.filter((n: any) => n?.number).map(map));
		after = r.search.pageInfo.hasNextPage ? r.search.pageInfo.endCursor : null;
	} while (after);
	return out;
}

export const searchOpenPullRequests = (o: Octokit, account: string) => searchOpen(o, account, "pr", toPullRequest);
export const searchOpenIssues = (o: Octokit, account: string) => searchOpen(o, account, "issue", toIssue);

function fail(status: number, message: string): never {
	throw Object.assign(new Error(message), { status });
}

/**
 * SPEC 16: the lines GitHub takes a review comment on: those inside the patch's hunks,
 * per side, as [first, last] (1-based). No patch (binary, too large): undefined.
 */
export function commentableLines(patch: string | undefined | null): ChangedFile["commentable"] {
	if (patch == null) return undefined;
	const out = { left: [] as [number, number][], right: [] as [number, number][] };
	for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
		const [a, b, c, d] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
		if (b > 0) out.left.push([a, a + b - 1]);
		if (d > 0) out.right.push([c, c + d - 1]);
	}
	return out;
}

type RestFile = { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string };
function toChangedFile(f: RestFile): ChangedFile {
	const commentable = commentableLines(f.patch);
	return {
		path: f.filename, status: f.status as ChangedFile["status"], additions: f.additions, deletions: f.deletions,
		...(f.previous_filename ? { previous: f.previous_filename } : {}),
		...(commentable ? { commentable } : {}),
	};
}

// -- SPEC 16: the PR page -------------------------------------------------------------

const ACTOR = "actor { login } createdAt";
const PAGE_QUERY = `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) {
	mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
	pullRequest(number: $n) {
		id number title body url createdAt state isDraft
		author { login }
		baseRefName headRefName headRefOid headRepository { nameWithOwner }
		commits { totalCount }
		additions deletions changedFiles mergeable mergeStateStatus reviewDecision
		reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } ... on Team { slug organization { login } } } } }
		latestReviews(first: 30) { nodes { author { login } state } }
		assignees(first: 20) { nodes { login } }
		labels(first: 30) { nodes { name color } }
		milestone { number title }
		timelineItems(first: 100, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, LABELED_EVENT, UNLABELED_EVENT,
			ASSIGNED_EVENT, UNASSIGNED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, READY_FOR_REVIEW_EVENT,
			CONVERT_TO_DRAFT_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT]) { nodes {
			__typename
			... on IssueComment { id author { login } body createdAt }
			... on PullRequestReview { id author { login } state body submittedAt createdAt }
			... on PullRequestCommit { commit { oid messageHeadline committedDate author { user { login } name } } }
			... on LabeledEvent { ${ACTOR} label { name } }
			... on UnlabeledEvent { ${ACTOR} label { name } }
			... on AssignedEvent { ${ACTOR} assignee { ... on User { login } } }
			... on UnassignedEvent { ${ACTOR} assignee { ... on User { login } } }
			... on ReviewRequestedEvent { ${ACTOR} requestedReviewer { ... on User { login } ... on Team { slug } } }
			... on ReviewRequestRemovedEvent { ${ACTOR} requestedReviewer { ... on User { login } ... on Team { slug } } }
			... on ReadyForReviewEvent { ${ACTOR} }
			... on ConvertToDraftEvent { ${ACTOR} }
			... on HeadRefForcePushedEvent { ${ACTOR} }
			... on MergedEvent { ${ACTOR} }
			... on ClosedEvent { ${ACTOR} }
			... on ReopenedEvent { ${ACTOR} }
		} }
		reviewThreads(first: 100) { nodes { id path line startLine diffSide isResolved isOutdated
			comments(first: 50) { nodes { id author { login } body createdAt state diffHunk pullRequestReview { id } } } } }
		reviews(states: PENDING, first: 1) { nodes { id comments { totalCount } } }
		files(first: 100) { nodes { path viewerViewedState } }
		lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
			__typename
			... on CheckRun { name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
			... on StatusContext { context state targetUrl createdAt }
		} } } } } }
	}
} }`;

const EVENTS: Record<string, Extract<TimelineItem, { type: "event" }>["event"]> = {
	LabeledEvent: "labeled", UnlabeledEvent: "unlabeled", AssignedEvent: "assigned", UnassignedEvent: "unassigned",
	ReviewRequestedEvent: "review_requested", ReviewRequestRemovedEvent: "review_request_removed", ReadyForReviewEvent: "ready_for_review",
	ConvertToDraftEvent: "convert_to_draft", HeadRefForcePushedEvent: "head_ref_force_pushed", MergedEvent: "merged", ClosedEvent: "closed",
	ReopenedEvent: "reopened",
};

/** "heads/<branch>" for a ref URL, each part encoded but the slashes kept (Octokit would encode them). */
const refPath = (branch: string) => `heads/${branch.split("/").map(encodeURIComponent).join("/")}`;

const iso = (s: string) => new Date(s).toISOString().replace(".000Z", "Z");

function toTimeline(n: any): TimelineItem | null {
	const who = (x: any) => x?.login ?? "ghost";
	switch (n.__typename) {
		case "IssueComment": return { type: "comment", id: n.id, author: who(n.author), body: n.body ?? "", at: iso(n.createdAt) };
		case "PullRequestReview":
			if (n.state === "PENDING") return null; // the reader's own draft: pendingReview
			return { type: "review", id: n.id, author: who(n.author), state: n.state, body: n.body ?? "", at: iso(n.submittedAt ?? n.createdAt) };
		case "PullRequestCommit": {
			const c = n.commit;
			return { type: "commit", sha: c.oid, message: c.messageHeadline, author: c.author?.user?.login ?? c.author?.name ?? "ghost", at: iso(c.committedDate) };
		}
	}
	const event = EVENTS[n.__typename];
	if (!event) return null;
	const subject = n.label?.name ?? n.assignee?.login ?? n.requestedReviewer?.login ?? n.requestedReviewer?.slug;
	return { type: "event", event, actor: who(n.actor), ...(subject ? { subject } : {}), at: iso(n.createdAt) };
}

function toCheck(n: any): CheckRun | null {
	if (n.__typename === "StatusContext") {
		const state = ({ SUCCESS: "passed", FAILURE: "failed", ERROR: "failed", PENDING: "running", EXPECTED: "queued" } as const)[n.state as "SUCCESS"] ?? "neutral";
		return { name: n.context, state, startedAt: n.createdAt ?? undefined, url: n.targetUrl ?? undefined };
	}
	if (n.__typename !== "CheckRun") return null;
	let state: CheckRun["state"];
	if (n.status !== "COMPLETED") state = n.status === "IN_PROGRESS" ? "running" : "queued";
	else state = ({ SUCCESS: "passed", FAILURE: "failed", TIMED_OUT: "failed", STARTUP_FAILURE: "failed", ACTION_REQUIRED: "failed", CANCELLED: "cancelled", SKIPPED: "skipped" } as Record<string, CheckRun["state"]>)[n.conclusion] ?? "neutral";
	const workflow = n.checkSuite?.workflowRun?.workflow?.name;
	return {
		name: n.name, ...(workflow ? { workflow } : {}), state,
		...(n.startedAt ? { startedAt: n.startedAt } : {}), ...(n.completedAt ? { completedAt: n.completedAt } : {}),
		...(n.detailsUrl ? { url: n.detailsUrl } : {}),
	};
}

export function toPrPage(repo: string, r: any): PrPage {
	const p = r.pullRequest;
	const reviewers: PrPage["reviewers"] = [];
	for (const q of p.reviewRequests?.nodes ?? []) {
		const who = q?.requestedReviewer;
		if (who?.login) reviewers.push({ login: who.login, state: "REQUESTED" });
		else if (who?.slug) reviewers.push({ team: `${who.organization?.login}/${who.slug}`, state: "REQUESTED" });
	}
	for (const v of p.latestReviews?.nodes ?? []) {
		const login = v.author?.login;
		if (login && !reviewers.some((x) => x.login === login)) reviewers.push({ login, state: v.state });
	}
	const methods: MergeMethod[] = [];
	if (r.mergeCommitAllowed) methods.push("merge");
	if (r.squashMergeAllowed) methods.push("squash");
	if (r.rebaseMergeAllowed) methods.push("rebase");
	const threads: ReviewThread[] = (p.reviewThreads?.nodes ?? []).map((t: any) => {
		const cs = t.comments?.nodes ?? [];
		return {
			id: t.id, path: t.path, line: t.line ?? null, startLine: t.startLine ?? null, side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT",
			resolved: Boolean(t.isResolved), outdated: Boolean(t.isOutdated), reviewId: cs[0]?.pullRequestReview?.id ?? null, diffHunk: cs[0]?.diffHunk ?? "",
			comments: cs.map((c: any) => ({ id: c.id, author: c.author?.login ?? "ghost", body: c.body ?? "", at: iso(c.createdAt), pending: c.state === "PENDING" })),
		};
	});
	const pending = p.reviews?.nodes?.[0];
	return {
		repo, number: p.number, title: p.title, body: p.body ?? "", url: p.url, author: p.author?.login ?? "ghost", createdAt: iso(p.createdAt),
		state: p.state, draft: Boolean(p.isDraft), baseRef: p.baseRefName, headRef: p.headRefName,
		headRepo: p.headRepository?.nameWithOwner ?? repo, headSha: p.headRefOid,
		commits: p.commits?.totalCount ?? 0, additions: p.additions ?? 0, deletions: p.deletions ?? 0, changedFiles: p.changedFiles ?? 0,
		mergeable: p.mergeable === "MERGEABLE" || p.mergeable === "CONFLICTING" ? p.mergeable : "UNKNOWN",
		mergeState: p.mergeStateStatus ?? "UNKNOWN", mergeMethods: methods, reviewDecision: (p.reviewDecision ?? null) as ReviewDecision,
		reviewers,
		assignees: (p.assignees?.nodes ?? []).map((a: any) => a.login),
		labels: (p.labels?.nodes ?? []).map((l: any) => ({ name: l.name, color: l.color })),
		milestone: p.milestone ? { number: p.milestone.number, title: p.milestone.title } : null,
		timeline: (p.timelineItems?.nodes ?? []).map(toTimeline).filter(Boolean),
		threads,
		checks: (p.lastCommit?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map(toCheck).filter(Boolean),
		viewed: Object.fromEntries((p.files?.nodes ?? []).map((f: any) => [f.path, f.viewerViewedState])),
		pendingReview: pending ? { id: pending.id, comments: pending.comments?.totalCount ?? 0 } : null,
	};
}

/** SPEC 15: the largest file Nudgebox fetches (binary files; text stops at 1 MB in the app). */
export const MAX_FILE_BYTES = 10_000_000;

export class OctokitGitHub implements GitHubPort {
	private app: App;
	private apiUrl: string;
	private webUrl: string;
	private installations = new Map<string, number>(); // account login (lowercase) -> installation id
	private opts: OctokitGitHubOptions;

	constructor(opts: OctokitGitHubOptions) {
		this.opts = opts;
		this.apiUrl = opts.apiUrl ?? "https://api.github.com";
		this.webUrl = opts.webUrl ?? "https://github.com";
		this.app = new App({
			appId: opts.appId,
			privateKey: opts.privateKey,
			Octokit: Octokit.defaults({ baseUrl: this.apiUrl }),
		});
	}

	// -- installations -------------------------------------------------------

	private async installationFor(account: string): Promise<Octokit> {
		const key = account.toLowerCase();
		if (!this.installations.has(key)) {
			for await (const { installation } of this.app.eachInstallation.iterator()) {
				const login = (installation.account as { login?: string } | null)?.login;
				if (login) this.installations.set(login.toLowerCase(), installation.id);
			}
		}
		const id = this.installations.get(key);
		if (!id) this.installations.clear(); // re-list next time: it may have been installed since
		if (!id) fail(404, `the GitHub App is not installed on ${account}`);
		return (await this.app.getInstallationOctokit(id)) as unknown as Octokit;
	}

	private user(token: string): Octokit {
		return new Octokit({ auth: token, baseUrl: this.apiUrl });
	}

	// -- linking a person ----------------------------------------------------

	private async oauthToken(params: Record<string, string>): Promise<UserTokens> {
		const r = await fetch(`${this.webUrl}/login/oauth/access_token`, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ client_id: this.opts.clientId, client_secret: this.opts.clientSecret, ...params }),
		});
		const d = (await r.json().catch(() => ({}))) as Record<string, any>;
		if (!r.ok || d.error || !d.access_token) fail(r.ok ? 400 : r.status, d.error_description || d.error || "GitHub token request failed");
		const { data: me } = await this.user(d.access_token).request("GET /user");
		// expires_in is absent when the App has token expiry turned off; treat as 8 h
		const ttl = Number(d.expires_in ?? 8 * 3600) * 1000;
		return { login: me.login, accessToken: d.access_token, refreshToken: d.refresh_token ?? "", expiresAt: new Date(Date.now() + ttl).toISOString() };
	}

	exchangeCode(code: string) {
		return this.oauthToken({ code });
	}

	refresh(refreshToken: string) {
		if (!refreshToken) fail(401, "no refresh token");
		return this.oauthToken({ grant_type: "refresh_token", refresh_token: refreshToken });
	}

	// -- what a person can see -----------------------------------------------

	async reposForUser(token: string): Promise<string[]> {
		const u = this.user(token);
		const installs = await u.paginate("GET /user/installations", { per_page: 100 }, (r) => r.data as unknown as { id: number }[]);
		const repos: string[] = [];
		for (const i of installs) {
			const rs = await u.paginate("GET /user/installations/{installation_id}/repositories", { installation_id: i.id, per_page: 100 },
				(r) => r.data as unknown as { full_name: string }[]);
			repos.push(...rs.map((x) => x.full_name));
		}
		return repos;
	}

	async teamsForUser(token: string): Promise<string[]> {
		try {
			const teams = await this.user(token).paginate("GET /user/teams", { per_page: 100 });
			return teams.map((t) => `${t.organization.login}/${t.slug}`);
		} catch (e) {
			if ((e as { status?: number }).status === 403) return []; // App lacks "Members: read" on that org
			throw e;
		}
	}

	// -- data (installation tokens) ------------------------------------------

	openPullRequests(): Promise<PullRequest[]> {
		return this.eachAccount(searchOpenPullRequests);
	}

	openIssues(): Promise<Issue[]> {
		return this.eachAccount(searchOpenIssues);
	}

	private async eachAccount<T>(read: (o: Octokit, account: string) => Promise<T[]>): Promise<T[]> {
		const out: T[] = [];
		for (const account of this.opts.accounts) {
			let o: Octokit;
			try {
				o = await this.installationFor(account);
			} catch (e) {
				// one account without the App must not hide every other account's PRs
				if ((e as { status?: number }).status !== 404) throw e;
				this.opts.log?.(`skipping ${account}: ${(e as Error).message}`);
				continue;
			}
			out.push(...(await read(o, account)));
		}
		return out;
	}

	async pullRequest(repo: string, number: number): Promise<PullRequest | null> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		const r: any = await o.graphql(
			`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { ${PR_FIELDS} } } }`,
			{ owner, name, n: number },
		);
		const p = r.repository?.pullRequest;
		return p && p.state === "OPEN" ? toPullRequest(p) : null;
	}

	async issue(repo: string, number: number): Promise<Issue | null> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		const r: any = await o.graphql(
			`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) {
				issueOrPullRequest(number: $n) { __typename ... on Issue { ${ISSUE_FIELDS} } } } }`,
			{ owner, name, n: number },
		);
		const i = r.repository?.issueOrPullRequest;
		return i && i.__typename === "Issue" && i.state === "OPEN" ? toIssue(i) : null;
	}

	/** SPEC 12: what a PR summary reads. Conversation comments, then reviews, then line comments. */
	async prContent(repo: string, number: number): Promise<ItemContent> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		const q = { owner, repo: name, per_page: 100 };
		const [{ data: pr }, files, comments, reviews, lines] = await Promise.all([
			o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number }),
			o.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { ...q, pull_number: number }),
			o.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...q, issue_number: number }),
			o.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { ...q, pull_number: number }),
			o.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", { ...q, pull_number: number }),
		]);
		const who = (c: { user?: { login: string } | null }) => c.user?.login ?? "ghost";
		return {
			body: pr.body ?? "",
			files: files.map((f) => ({ path: f.filename, patch: f.patch ?? "" })),
			comments: [
				...comments.map((c) => ({ author: who(c), body: c.body ?? "" })),
				...reviews.filter((r) => r.body).map((r) => ({ author: who(r), body: r.body })),
				...lines.map((c) => ({ author: who(c), body: `${c.path}: ${c.body}` })),
			],
		};
	}

	/** SPEC 15: changed files against the merge base, like GitHub's "Files changed" (max 300). */
	async prFiles(repo: string, number: number): Promise<PrFiles | null> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		try {
			const { data: pr } = await o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number });
			const { data: cmp } = await o.request("GET /repos/{owner}/{repo}/compare/{basehead}", { owner, repo: name, basehead: `${pr.base.sha}...${pr.head.sha}`, per_page: 300 });
			return {
				base: cmp.merge_base_commit.sha,
				head: pr.head.sha,
				files: (cmp.files ?? []).map(toChangedFile),
			};
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
	}

	/**
	 * SPEC 15: one file's bytes at a commit, up to 10 MB; null when not there. The contents
	 * API sends files up to 1 MB inline; bigger ones come from the git blob API by their sha.
	 */
	async fileAt(repo: string, ref: string, path: string): Promise<Buffer | "too large" | null> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		try {
			const { data } = await o.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo: name, path, ref });
			if (Array.isArray(data) || data.type !== "file") return null;
			if (data.size > MAX_FILE_BYTES) return "too large";
			if (data.encoding === "base64" && data.content) return Buffer.from(data.content, "base64");
			const { data: blob } = await o.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { owner, repo: name, file_sha: data.sha });
			return Buffer.from(blob.content, "base64");
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
	}

	/** SPEC 21: the commit's files as GitHub's gzip tarball, streamed; null when not there. */
	async archive(repo: string, ref: string): Promise<Readable | null> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		try {
			const { data } = await o.request("GET /repos/{owner}/{repo}/tarball/{ref}", { owner, repo: name, ref, request: { parseSuccessResponseBody: false } });
			return Readable.fromWeb(data as unknown as import("node:stream/web").ReadableStream);
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
	}

	async issueContent(repo: string, number: number): Promise<ItemContent> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		const [{ data: issue }, comments] = await Promise.all([
			o.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo: name, issue_number: number }),
			o.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo: name, issue_number: number, per_page: 100 }),
		]);
		return { body: issue.body ?? "", comments: comments.map((c) => ({ author: c.user?.login ?? "ghost", body: c.body ?? "" })) };
	}

	// -- actions as the person -----------------------------------------------

	async merge(token: string, repo: string, number: number, how?: { method: MergeMethod; title?: string; message?: string }) {
		const [owner, name] = repo.split("/");
		const u = this.user(token);
		let merge_method = how?.method;
		if (!merge_method) {
			const { data: r } = await u.request("GET /repos/{owner}/{repo}", { owner, repo: name });
			// the repo's default: merge commit if allowed, else squash, else rebase
			merge_method = r.allow_merge_commit !== false ? "merge" : r.allow_squash_merge !== false ? "squash" : "rebase";
		}
		await u.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
			owner, repo: name, pull_number: number, merge_method,
			...(how?.title !== undefined ? { commit_title: how.title } : {}), ...(how?.message !== undefined ? { commit_message: how.message } : {}),
		});
	}

	async approve(token: string, repo: string, number: number) {
		const [owner, name] = repo.split("/");
		await this.user(token).request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo: name, pull_number: number, event: "APPROVE" });
	}

	async rerunFailedChecks(token: string, repo: string, number: number) {
		const [owner, name] = repo.split("/");
		const u = this.user(token);
		const { data: pr } = await u.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number });
		const { data } = await u.request("GET /repos/{owner}/{repo}/actions/runs", { owner, repo: name, head_sha: pr.head.sha, per_page: 100 });
		const failed = data.workflow_runs.filter((w) => ["failure", "cancelled", "timed_out", "startup_failure"].includes(w.conclusion ?? ""));
		if (!failed.length) fail(422, "no failed GitHub Actions runs on the head commit");
		for (const w of failed) {
			await u.request("POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs", { owner, repo: name, run_id: Number(w.id) });
		}
	}

	async comment(token: string, repo: string, number: number, body: string) {
		const [owner, name] = repo.split("/");
		await this.user(token).request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo: name, issue_number: number, body });
	}

	// -- SPEC 16: the PR page ------------------------------------------------

	async prPage(token: string, repo: string, number: number): Promise<PrPage | null> {
		const [owner, name] = repo.split("/");
		const r: any = await this.user(token).graphql(PAGE_QUERY, { owner, name, n: number });
		return r.repository?.pullRequest ? toPrPage(repo, r.repository) : null;
	}

	async repoOptions(token: string, repo: string): Promise<RepoOptions> {
		const [owner, name] = repo.split("/");
		const u = this.user(token);
		const q = { owner, repo: name, per_page: 100 };
		const [people, labels, milestones] = await Promise.all([
			u.paginate("GET /repos/{owner}/{repo}/assignees", q),
			u.paginate("GET /repos/{owner}/{repo}/labels", q),
			u.paginate("GET /repos/{owner}/{repo}/milestones", { ...q, state: "open" }),
		]);
		return {
			assignable: people.map((p) => p.login),
			labels: labels.map((l) => ({ name: l.name, color: l.color, description: l.description ?? "" })),
			milestones: milestones.map((m) => ({ number: m.number, title: m.title })),
		};
	}

	async mergeInputs(repo: string, number: number): Promise<MergeInputs | null> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		try {
			const { data: pr } = await o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number });
			const { data: ref } = await o.request(`GET /repos/{owner}/{repo}/git/ref/${refPath(pr.base.ref)}`, { owner, repo: name });
			const baseSha = ref.object.sha;
			const compare = (basehead: string) => o.request("GET /repos/{owner}/{repo}/compare/{basehead}", { owner, repo: name, basehead, per_page: 300 });
			const [{ data: head }, { data: base }] = await Promise.all([compare(`${baseSha}...${pr.head.sha}`), compare(`${pr.head.sha}...${baseSha}`)]);
			return {
				headRepo: pr.head.repo?.full_name ?? repo, headRef: pr.head.ref, headSha: pr.head.sha, baseRef: pr.base.ref, baseSha,
				mergeBase: head.merge_base_commit.sha,
				headFiles: (head.files ?? []).map((f) => toChangedFile({ ...f, patch: undefined })),
				baseFiles: (base.files ?? []).map((f) => toChangedFile({ ...f, patch: undefined })),
			};
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
	}

	async prCommits(repo: string, number: number): Promise<PrCommit[] | null> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		try {
			const cs = await o.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", { owner, repo: name, pull_number: number, per_page: 100 });
			return cs.map((c) => ({
				sha: c.sha, message: (c.commit.message ?? "").split("\n")[0], author: c.author?.login ?? c.commit.author?.name ?? "ghost",
				at: iso(c.commit.author?.date ?? c.commit.committer?.date ?? new Date().toISOString()),
			}));
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
	}

	async commitFiles(repo: string, sha: string): Promise<PrFiles | null> {
		const [owner, name] = repo.split("/");
		const o = await this.installationFor(owner);
		try {
			const { data: c } = await o.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo: name, ref: sha });
			return { base: c.parents[0]?.sha ?? "", head: c.sha, files: (c.files ?? []).map((f) => toChangedFile(f as RestFile)) };
		} catch (e) {
			if ([404, 422].includes((e as { status?: number }).status ?? 0)) return null;
			throw e;
		}
	}

	/** One GraphQL mutation, as the person: `mutation { done: name(input) { ... } }`. */
	private async mutate(token: string, name: string, input: object, returns = "clientMutationId"): Promise<any> {
		const type = name[0].toUpperCase() + name.slice(1);
		const r: any = await this.user(token).graphql(`mutation($input: ${type}Input!) { done: ${name}(input: $input) { ${returns} } }`, { input });
		return r.done;
	}

	/** The PR's node id and the person's pending review, if any. */
	private async reviewState(token: string, repo: string, number: number): Promise<{ id: string; pending: string | null }> {
		const [owner, name] = repo.split("/");
		const r: any = await this.user(token).graphql(
			`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) {
				id reviews(states: PENDING, first: 1) { nodes { id } } } } }`,
			{ owner, name, n: number },
		);
		const p = r.repository?.pullRequest;
		if (!p) fail(404, "no such pull request");
		return { id: p.id, pending: p.reviews?.nodes?.[0]?.id ?? null };
	}

	async addReviewComment(token: string, repo: string, number: number, c: NewReviewComment) {
		const [owner, name] = repo.split("/");
		const where = c.subject === "file" ? {} : { line: c.line, side: c.side, ...(c.startLine ? { start_line: c.startLine, start_side: c.side } : {}) };
		if (c.mode === "single") {
			const u = this.user(token);
			const { data: pr } = await u.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number });
			await u.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
				owner, repo: name, pull_number: number, commit_id: pr.head.sha, path: c.path, body: c.body,
				...(c.subject === "file" ? { subject_type: "file" } : where),
			} as never);
			return;
		}
		const s = await this.reviewState(token, repo, number);
		const review = s.pending ?? (await this.mutate(token, "addPullRequestReview", { pullRequestId: s.id }, "pullRequestReview { id }")).pullRequestReview.id;
		await this.mutate(token, "addPullRequestReviewThread", {
			pullRequestReviewId: review, path: c.path, body: c.body,
			...(c.subject === "file" ? {} : { line: c.line, side: c.side, ...(c.startLine ? { startLine: c.startLine, startSide: c.side } : {}) }),
			subjectType: c.subject === "file" ? "FILE" : "LINE",
		});
	}

	async replyToThread(token: string, _repo: string, _number: number, thread: string, body: string) {
		await this.mutate(token, "addPullRequestReviewThreadReply", { pullRequestReviewThreadId: thread, body });
	}

	async setThreadResolved(token: string, _repo: string, _number: number, thread: string, resolved: boolean) {
		await this.mutate(token, resolved ? "resolveReviewThread" : "unresolveReviewThread", { threadId: thread });
	}

	async submitReview(token: string, repo: string, number: number, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) {
		const s = await this.reviewState(token, repo, number);
		if (s.pending) return void (await this.mutate(token, "submitPullRequestReview", { pullRequestReviewId: s.pending, event, body }));
		const [owner, name] = repo.split("/");
		await this.user(token).request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo: name, pull_number: number, event, body });
	}

	async cancelReview(token: string, repo: string, number: number) {
		const s = await this.reviewState(token, repo, number);
		if (!s.pending) fail(422, "you have no pending review");
		await this.mutate(token, "deletePullRequestReview", { pullRequestReviewId: s.pending });
	}

	async updateBranch(token: string, repo: string, number: number) {
		const [owner, name] = repo.split("/");
		await this.user(token).request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch", { owner, repo: name, pull_number: number });
	}

	async setDraft(token: string, repo: string, number: number, draft: boolean) {
		const { id } = await this.reviewState(token, repo, number);
		await this.mutate(token, draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview", { pullRequestId: id });
	}

	async setViewed(token: string, repo: string, number: number, path: string, viewed: boolean) {
		const { id } = await this.reviewState(token, repo, number);
		await this.mutate(token, viewed ? "markFileAsViewed" : "unmarkFileAsViewed", { pullRequestId: id, path });
	}

	async requestReviewers(token: string, repo: string, number: number, add: string[], remove: string[]) {
		const [owner, name] = repo.split("/");
		const u = this.user(token);
		const q = { owner, repo: name, pull_number: number };
		if (add.length) await u.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { ...q, reviewers: add });
		if (remove.length) await u.request("DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { ...q, reviewers: remove });
	}

	async setAssignees(token: string, repo: string, number: number, logins: string[]) {
		const [owner, name] = repo.split("/");
		await this.user(token).request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo: name, issue_number: number, assignees: logins });
	}

	async setLabels(token: string, repo: string, number: number, names: string[]) {
		const [owner, name] = repo.split("/");
		await this.user(token).request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels", { owner, repo: name, issue_number: number, labels: names });
	}

	async setMilestone(token: string, repo: string, number: number, milestone: number | null) {
		const [owner, name] = repo.split("/");
		await this.user(token).request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo: name, issue_number: number, milestone });
	}

	async setState(token: string, repo: string, number: number, state: "closed" | "open") {
		const [owner, name] = repo.split("/");
		await this.user(token).request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number, state });
	}

	/**
	 * SPEC 16: one merge commit. The tree is the head commit's tree with the base's versions
	 * of `take`, `remove` deleted and `write` as new blobs (keeping each file's mode); the
	 * branch then moves to it only if that is a fast-forward (force: false).
	 */
	async commitMerge(token: string, repo: string, branch: string, c: MergeCommit): Promise<string> {
		const [owner, name] = repo.split("/");
		const u = this.user(token);
		const q = { owner, repo: name };
		type Entry = { path: string; mode: string; type: string; sha: string };
		const commit = (sha: string) => u.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { ...q, commit_sha: sha }).then((r) => r.data);
		const tree = async (sha: string) => {
			const { data } = await u.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { ...q, tree_sha: sha, recursive: "1" });
			if (data.truncated) fail(422, "this repository is too large to merge here; resolve on the command line");
			return new Map((data.tree as Entry[]).map((e) => [e.path, e]));
		};
		const [head, base] = await Promise.all([commit(c.parents[0]), commit(c.parents[1])]);
		const [headTree, baseTree] = await Promise.all([tree(head.tree.sha), tree(base.tree.sha)]);
		const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
		for (const path of c.take) {
			const e = baseTree.get(path);
			if (!e) fail(422, `${path} is not on the base branch`);
			entries.push({ path, mode: e.mode, type: "blob", sha: e.sha });
		}
		for (const path of c.remove) entries.push({ path, mode: headTree.get(path)?.mode ?? "100644", type: "blob", sha: null });
		for (const w of c.write) {
			const { data: blob } = await u.request("POST /repos/{owner}/{repo}/git/blobs", { ...q, content: w.text, encoding: "utf-8" });
			entries.push({ path: w.path, mode: headTree.get(w.path)?.mode ?? baseTree.get(w.path)?.mode ?? "100644", type: "blob", sha: blob.sha });
		}
		const { data: t } = await u.request("POST /repos/{owner}/{repo}/git/trees", { ...q, base_tree: head.tree.sha, tree: entries as never });
		const { data: m } = await u.request("POST /repos/{owner}/{repo}/git/commits", { ...q, message: c.message, tree: t.sha, parents: c.parents });
		try {
			await u.request(`PATCH /repos/{owner}/{repo}/git/refs/${refPath(branch)}`, { ...q, sha: m.sha, force: false });
		} catch (e) {
			if ((e as { status?: number }).status === 422) fail(409, "the branch has changed since you started; reload and resolve again");
			throw e;
		}
		return m.sha;
	}
}
