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
import { App, Octokit } from "octokit";
import type { Checks, GitHubPort, Issue, ItemContent, PrFiles, PullRequest, ReviewDecision, UserTokens } from "./github.ts";

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
	commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

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

export function toPullRequest(n: any): PullRequest {
	const reviewers: string[] = [];
	const teams: string[] = [];
	for (const r of n.reviewRequests?.nodes ?? []) {
		const who = r?.requestedReviewer;
		if (who?.login) reviewers.push(who.login);
		else if (who?.slug) teams.push(`${who.organization?.login}/${who.slug}`);
	}
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
				files: (cmp.files ?? []).map((f) => ({
					path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
					...(f.previous_filename ? { previous: f.previous_filename } : {}),
				})),
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

	async merge(token: string, repo: string, number: number) {
		const [owner, name] = repo.split("/");
		const u = this.user(token);
		const { data: r } = await u.request("GET /repos/{owner}/{repo}", { owner, repo: name });
		// the repo's default: merge commit if allowed, else squash, else rebase
		const merge_method = r.allow_merge_commit !== false ? "merge" : r.allow_squash_merge !== false ? "squash" : "rebase";
		await u.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", { owner, repo: name, pull_number: number, merge_method });
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
}
