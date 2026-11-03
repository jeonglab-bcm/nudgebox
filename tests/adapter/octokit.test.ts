/**
 * The real GitHub adapter (src/octokit-github.ts) against a fake GitHub HTTP server:
 * right endpoints, right token (App installation vs the person), right mapping.
 * Response shapes follow GitHub's REST and GraphQL docs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHub, toPullRequest } from "../../src/octokit-github.ts";

type Seen = { method: string; path: string; auth: string; body: any };

const ISSUE = {
	number: 80, title: "ROI export breaks", url: "https://github.com/jeonglab-bcm/labbot/issues/80", updatedAt: "2026-11-03T10:00:00Z", state: "OPEN",
	author: { login: "kelly" }, repository: { nameWithOwner: "jeonglab-bcm/labbot" },
	assignees: { nodes: [{ login: "hwan" }] }, labels: { nodes: [{ name: "bug" }] }, comments: { totalCount: 3 },
};

const NODE = {
	number: 12, title: "Add email tools", url: "https://github.com/jeonglab-bcm/labbot/pull/12", isDraft: false,
	updatedAt: "2026-11-02T15:00:00Z", headRefOid: "abc123", state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
	author: { login: "kelly" }, repository: { nameWithOwner: "jeonglab-bcm/labbot" },
	reviewRequests: { nodes: [{ requestedReviewer: { login: "hwan" } }, { requestedReviewer: { slug: "core", organization: { login: "jeonglab-bcm" } } }] },
	commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
};

async function fakeGitHub(opts: { allowMergeCommit?: boolean; prState?: string; extraAccounts?: string[] } = {}) {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const url = new URL(req.url!, "http://x");
			const body = raw ? JSON.parse(raw) : undefined;
			seen.push({ method: req.method!, path: url.pathname + url.search, auth: String(req.headers.authorization ?? ""), body });
			const ok = (d: unknown, status = 200) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(d));
			};
			const route = `${req.method} ${url.pathname}`;
			switch (route) {
				case "GET /app/installations": return ok([{ id: 11, account: { login: "jeonglab-bcm" } }]);
				case "POST /app/installations/11/access_tokens": return ok({ token: "inst-tok", expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
				case "GET /users/jeonglab-bcm": return ok({ login: "jeonglab-bcm", type: "Organization" });
				case "POST /graphql":
					if (body.query.includes("search(") && body.variables.q.startsWith("is:issue")) return ok({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ISSUE] } } });
					if (body.query.includes("search(")) return ok({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [NODE, {}] } } });
					if (body.query.includes("issueOrPullRequest")) {
						const n = body.variables.n;
						return ok({ data: { repository: { issueOrPullRequest: n === 80 ? { __typename: "Issue", ...ISSUE, state: opts.prState === "MERGED" ? "CLOSED" : "OPEN" } : { __typename: "PullRequest" } } } });
					}
					return ok({ data: { repository: { pullRequest: { ...NODE, state: opts.prState ?? "OPEN" } } } });
				case "POST /login/oauth/access_token":
					if (body.code === "bad") return ok({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
					return ok({ access_token: "user-tok", refresh_token: "user-ref", expires_in: 28800, token_type: "bearer" });
				case "GET /user": return ok({ login: "hwan" });
				case "GET /user/installations": return ok({ total_count: 1, installations: [{ id: 11 }] });
				case "GET /user/installations/11/repositories": return ok({ total_count: 2, repositories: [{ full_name: "jeonglab-bcm/labbot" }, { full_name: "jeonglab-bcm/tailjobs" }] });
				case "GET /user/teams": return ok([{ slug: "core", organization: { login: "jeonglab-bcm" } }]);
				case "GET /repos/jeonglab-bcm/labbot": return ok({ allow_merge_commit: opts.allowMergeCommit ?? true, allow_squash_merge: true, allow_rebase_merge: true });
				case "PUT /repos/jeonglab-bcm/labbot/pulls/12/merge": return ok({ merged: true });
				case "POST /repos/jeonglab-bcm/labbot/pulls/12/reviews": return ok({ id: 1 });
				case "POST /repos/jeonglab-bcm/labbot/issues/12/comments": return ok({ id: 2 }, 201);
				case "GET /repos/jeonglab-bcm/labbot/pulls/12": return ok({ head: { sha: "abc123" }, body: "Adds outloud tools." });
				// SPEC 12: what a summary reads
				case "GET /repos/jeonglab-bcm/labbot/pulls/12/files": return ok([{ filename: "src/mail.ts", patch: "@@ -1 +1 @@\n+send()" }, { filename: "logo.png" }]);
				case "GET /repos/jeonglab-bcm/labbot/pulls/12/reviews": return ok([{ user: { login: "hwan" }, body: "Needs a test." }, { user: { login: "hwan" }, body: "" }]);
				case "GET /repos/jeonglab-bcm/labbot/pulls/12/comments": return ok([{ user: { login: "hwan" }, body: "Typo here.", path: "src/mail.ts" }]);
				case "GET /repos/jeonglab-bcm/labbot/issues/12/comments": return ok([{ user: { login: "kelly" }, body: "Ready for another look." }]);
				case "GET /repos/jeonglab-bcm/labbot/issues/80": return ok({ body: "Crashes on empty ROIs." });
				case "GET /repos/jeonglab-bcm/labbot/issues/80/comments": return ok([{ user: { login: "jorge" }, body: "Same here." }]);
				case "GET /repos/jeonglab-bcm/labbot/actions/runs":
					return ok({ total_count: 3, workflow_runs: [{ id: 101, conclusion: "failure" }, { id: 102, conclusion: "success" }, { id: 103, conclusion: "timed_out" }] });
				case "POST /repos/jeonglab-bcm/labbot/actions/runs/101/rerun-failed-jobs":
				case "POST /repos/jeonglab-bcm/labbot/actions/runs/103/rerun-failed-jobs": return ok({}, 201);
			}
			ok({ message: `fake GitHub has no ${route}` }, 404);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const gh = new OctokitGitHub({
		appId: "123", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
		clientId: "Iv1.x", clientSecret: "secret", accounts: ["jeonglab-bcm", ...(opts.extraAccounts ?? [])], apiUrl: url, webUrl: url,
	});
	return { gh, seen, close: () => server.close() };
}

test("open PRs are read with the App's installation token and mapped", async () => {
	const f = await fakeGitHub();
	try {
		const prs = await f.gh.openPullRequests();
		assert.deepEqual(prs, [{
			repo: "jeonglab-bcm/labbot", number: 12, title: "Add email tools", url: NODE.url, author: "kelly", draft: false,
			updatedAt: "2026-11-02T15:00:00.000Z", headSha: "abc123", requestedReviewers: ["hwan"], requestedTeams: ["jeonglab-bcm/core"],
			reviewDecision: "REVIEW_REQUIRED", checks: "failure", mergeable: "MERGEABLE",
		}]);
		const gql = f.seen.find((s) => s.path === "/graphql")!;
		assert.equal(gql.auth, "token inst-tok");
		assert.match(gql.body.variables.q, /is:pr is:open org:jeonglab-bcm/);
	} finally {
		f.close();
	}
});

test("open issues are read with the App's token and mapped; PR numbers are not issues", async () => {
	const f = await fakeGitHub();
	const closed = await fakeGitHub({ prState: "MERGED" });
	try {
		assert.deepEqual(await f.gh.openIssues(), [{
			repo: "jeonglab-bcm/labbot", number: 80, title: "ROI export breaks", url: ISSUE.url, author: "kelly",
			assignees: ["hwan"], labels: ["bug"], comments: 3, updatedAt: "2026-11-03T10:00:00.000Z",
		}]);
		assert.match(f.seen.find((s) => s.body?.variables?.q?.startsWith("is:issue"))!.body.variables.q, /is:issue is:open org:jeonglab-bcm/);
		assert.equal((await f.gh.issue("jeonglab-bcm/labbot", 80))?.number, 80);
		assert.equal(await f.gh.issue("jeonglab-bcm/labbot", 12), null); // #12 is a PR
		assert.equal(await closed.gh.issue("jeonglab-bcm/labbot", 80), null);
	} finally {
		f.close();
		closed.close();
	}
});

test("an account without the App is skipped, not fatal", async () => {
	const f = await fakeGitHub({ extraAccounts: ["hyunhwan-bcm"] });
	try {
		assert.deepEqual((await f.gh.openPullRequests()).map((p) => p.number), [12]);
	} finally {
		f.close();
	}
});

test("one PR: closed or merged counts as gone", async () => {
	const open = await fakeGitHub();
	const merged = await fakeGitHub({ prState: "MERGED" });
	try {
		assert.equal((await open.gh.pullRequest("jeonglab-bcm/labbot", 12))?.number, 12);
		assert.equal(await merged.gh.pullRequest("jeonglab-bcm/labbot", 12), null);
	} finally {
		open.close();
		merged.close();
	}
});

test("linking: the code becomes a user token with an expiry; a bad code is an error", async () => {
	const f = await fakeGitHub();
	try {
		const t = await f.gh.exchangeCode("good");
		assert.equal(t.login, "hwan");
		assert.equal(t.accessToken, "user-tok");
		assert.equal(t.refreshToken, "user-ref");
		assert.ok(Date.parse(t.expiresAt) > Date.now() + 7 * 3600e3);
		const ex = f.seen.find((s) => s.path === "/login/oauth/access_token")!;
		assert.deepEqual([ex.body.client_id, ex.body.code], ["Iv1.x", "good"]);
		await assert.rejects(f.gh.exchangeCode("bad"), /incorrect or expired/);
		await f.gh.refresh("user-ref");
		assert.equal(f.seen.filter((s) => s.path === "/login/oauth/access_token").at(-1)!.body.grant_type, "refresh_token");
	} finally {
		f.close();
	}
});

test("what a person can see comes from their own token", async () => {
	const f = await fakeGitHub();
	try {
		assert.deepEqual(await f.gh.reposForUser("user-tok"), ["jeonglab-bcm/labbot", "jeonglab-bcm/tailjobs"]);
		assert.deepEqual(await f.gh.teamsForUser("user-tok"), ["jeonglab-bcm/core"]);
		assert.ok(f.seen.filter((s) => s.path.startsWith("/user")).every((s) => s.auth === "token user-tok"));
	} finally {
		f.close();
	}
});

test("actions use the person's token; merge follows the repo's allowed method", async () => {
	const f = await fakeGitHub({ allowMergeCommit: false });
	try {
		await f.gh.merge("user-tok", "jeonglab-bcm/labbot", 12);
		await f.gh.approve("user-tok", "jeonglab-bcm/labbot", 12);
		await f.gh.comment("user-tok", "jeonglab-bcm/labbot", 12, "LGTM");
		await f.gh.rerunFailedChecks("user-tok", "jeonglab-bcm/labbot", 12);
		const writes = f.seen.filter((s) => s.method !== "GET");
		assert.ok(writes.every((s) => s.auth === "token user-tok"));
		assert.equal(writes.find((s) => s.path.endsWith("/merge"))!.body.merge_method, "squash");
		assert.equal(writes.find((s) => s.path.endsWith("/reviews"))!.body.event, "APPROVE");
		assert.equal(writes.find((s) => s.path.endsWith("/comments"))!.body.body, "LGTM");
		assert.deepEqual(writes.filter((s) => s.path.includes("rerun")).map((s) => s.path),
			["/repos/jeonglab-bcm/labbot/actions/runs/101/rerun-failed-jobs", "/repos/jeonglab-bcm/labbot/actions/runs/103/rerun-failed-jobs"]);
	} finally {
		f.close();
	}
});

test("12. summary content is read with the App's token: description, diffs, reviews, comments", async () => {
	const f = await fakeGitHub();
	try {
		const pr = await f.gh.prContent("jeonglab-bcm/labbot", 12);
		assert.equal(pr.body, "Adds outloud tools.");
		assert.deepEqual(pr.files, [{ path: "src/mail.ts", patch: "@@ -1 +1 @@\n+send()" }, { path: "logo.png", patch: "" }]);
		assert.deepEqual(pr.comments, [
			{ author: "kelly", body: "Ready for another look." },
			{ author: "hwan", body: "Needs a test." }, // empty review bodies are dropped
			{ author: "hwan", body: "src/mail.ts: Typo here." },
		]);
		assert.deepEqual(await f.gh.issueContent("jeonglab-bcm/labbot", 80), { body: "Crashes on empty ROIs.", comments: [{ author: "jorge", body: "Same here." }] });
		assert.ok(f.seen.filter((s) => s.path.startsWith("/repos/")).every((s) => s.auth === "token inst-tok"));
	} finally {
		f.close();
	}
});

test("statusCheckRollup states map to the four check states", () => {
	const with_ = (state: string | null) => toPullRequest({ ...NODE, commits: { nodes: [{ commit: { statusCheckRollup: state && { state } } }] } }).checks;
	assert.deepEqual(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED", null].map(with_), ["success", "failure", "failure", "pending", "pending", "none"]);
});
