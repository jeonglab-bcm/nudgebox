/**
 * SPEC 16. The real adapter's PR page parts against a fake GitHub HTTP server: right
 * endpoints and mutations, the person's token (or the App's where noted), right mapping.
 * Shapes follow GitHub's REST and GraphQL docs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHub, commentableLines } from "../../src/octokit-github.ts";

type Seen = { method: string; path: string; auth: string; body: any };
const R = "/repos/jeonglab-bcm/labbot";

const PAGE = {
	mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true,
	pullRequest: {
		id: "PR_12", number: 12, title: "Add email tools", body: "Adds **outloud**.", url: "https://github.com/jeonglab-bcm/labbot/pull/12",
		createdAt: "2026-11-01T15:00:00Z", state: "OPEN", isDraft: true, author: { login: "kelly" },
		baseRefName: "main", headRefName: "feat/mail", headRefOid: "abc123", headRepository: { nameWithOwner: "jeonglab-bcm/labbot" },
		commits: { totalCount: 3 }, additions: 40, deletions: 2, changedFiles: 2,
		mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "CHANGES_REQUESTED",
		reviewRequests: { nodes: [{ requestedReviewer: { login: "jlee" } }, { requestedReviewer: { slug: "core", organization: { login: "jeonglab-bcm" } } }] },
		latestReviews: { nodes: [{ author: { login: "hwan" }, state: "CHANGES_REQUESTED" }] },
		assignees: { nodes: [{ login: "kelly" }] },
		labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
		milestone: { number: 2, title: "v1.0" },
		timelineItems: { nodes: [
			{ __typename: "PullRequestCommit", commit: { oid: "c0ffee1", messageHeadline: "Add send()", committedDate: "2026-11-01T15:01:00Z", author: { user: { login: "kelly" }, name: "Kelly" } } },
			{ __typename: "IssueComment", id: "IC_1", author: { login: "hwan" }, body: "Why?", createdAt: "2026-11-01T16:00:00Z" },
			{ __typename: "PullRequestReview", id: "PRR_1", author: { login: "hwan" }, state: "CHANGES_REQUESTED", body: "See inline.", submittedAt: "2026-11-01T17:00:00Z", createdAt: "2026-11-01T16:59:00Z" },
			{ __typename: "PullRequestReview", id: "PRR_2", author: { login: "me" }, state: "PENDING", body: "", submittedAt: null, createdAt: "2026-11-02T09:00:00Z" },
			{ __typename: "LabeledEvent", actor: { login: "kelly" }, label: { name: "bug" }, createdAt: "2026-11-01T18:00:00Z" },
			{ __typename: "ReviewRequestedEvent", actor: { login: "kelly" }, requestedReviewer: { login: "jlee" }, createdAt: "2026-11-01T18:01:00Z" },
		] },
		reviewThreads: { nodes: [{
			id: "RT_1", path: "src/mail.ts", line: 3, startLine: null, diffSide: "RIGHT", isResolved: false, isOutdated: false,
			comments: { nodes: [
				{ id: "RC_1", author: { login: "hwan" }, body: "Rename.", createdAt: "2026-11-01T17:00:00Z", state: "SUBMITTED", diffHunk: "@@ -1,2 +1,3 @@\n a\n+b", pullRequestReview: { id: "PRR_1" } },
				{ id: "RC_2", author: { login: "me" }, body: "Agreed.", createdAt: "2026-11-02T09:00:00Z", state: "PENDING", diffHunk: "@@ -1,2 +1,3 @@\n a\n+b", pullRequestReview: { id: "PRR_2" } },
			] },
		}] },
		reviews: { nodes: [{ id: "PRR_2", comments: { totalCount: 1 } }] },
		files: { nodes: [{ path: "src/mail.ts", viewerViewedState: "VIEWED" }, { path: "README.md", viewerViewedState: "UNVIEWED" }] },
		lastCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
			{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-01T15:02:00Z", completedAt: "2026-11-01T15:04:00Z", detailsUrl: "https://github.com/x/1", checkSuite: { workflowRun: { workflow: { name: "CI" } } } },
			{ __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-11-01T15:02:00Z", completedAt: null, detailsUrl: "https://github.com/x/2", checkSuite: { workflowRun: null } },
			{ __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://ci.example/3", createdAt: "2026-11-01T15:03:00Z" },
		] } } } }] },
	},
};

async function fakeGitHub(opts: { pending?: boolean } = {}) {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const url = new URL(req.url!, "http://x");
			const body = raw ? JSON.parse(raw) : undefined;
			seen.push({ method: req.method!, path: url.pathname, auth: String(req.headers.authorization ?? ""), body });
			const ok = (d: unknown, status = 200) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(d));
			};
			const route = `${req.method} ${url.pathname}`;
			if (route === "POST /graphql") {
				const q: string = body.query;
				if (q.includes("timelineItems")) return ok({ data: { repository: PAGE } });
				if (q.includes("mutation")) return ok({ data: { done: { clientMutationId: null, pullRequestReview: { id: "PRR_NEW" } } } });
				// the pull request's id and the person's pending review, before a review mutation
				return ok({ data: { repository: { pullRequest: { id: "PR_12", reviews: { nodes: opts.pending ? [{ id: "PRR_2" }] : [] } } } } });
			}
			switch (route) {
				case "GET /app/installations": return ok([{ id: 11, account: { login: "jeonglab-bcm" } }]);
				case "POST /app/installations/11/access_tokens": return ok({ token: "inst-tok", expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
				case `GET ${R}/pulls/12`: return ok({ head: { sha: "abc123", ref: "feat/mail", repo: { full_name: "jeonglab-bcm/labbot" } }, base: { ref: "main", sha: "old-base" } });
				case `PUT ${R}/pulls/12/merge`: return ok({ merged: true });
				case `POST ${R}/pulls/12/comments`: return ok({ id: 5 }, 201);
				case `POST ${R}/pulls/12/reviews`: return ok({ id: 6 });
				case `PUT ${R}/pulls/12/update-branch`: return ok({ message: "Updating pull request branch." }, 202);
				case `POST ${R}/pulls/12/requested_reviewers`: return ok({}, 201);
				case `DELETE ${R}/pulls/12/requested_reviewers`: return ok({});
				case `PATCH ${R}/issues/12`: return ok({});
				case `PATCH ${R}/pulls/12`: return ok({});
				case `GET ${R}/pulls/12/commits`: return ok([
					{ sha: "c1", commit: { message: "Add send()\n\nLong text.", author: { name: "Kelly L", date: "2026-11-01T15:01:00Z" } }, author: { login: "kelly" } },
					{ sha: "c2", commit: { message: "Fix typo", author: { name: "Someone", date: "2026-11-01T16:00:00Z" } }, author: null },
				]);
				case `GET ${R}/commits/c1`: return ok({ sha: "c1", parents: [{ sha: "p1" }], files: [{ filename: "src/mail.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" }] });
				case `PUT ${R}/issues/12/labels`: return ok([]);
				case `GET ${R}/assignees`: return ok([{ login: "hwan" }, { login: "kelly" }]);
				case `GET ${R}/labels`: return ok([{ name: "bug", color: "d73a4a", description: "Broken" }, { name: "docs", color: "0075ca", description: null }]);
				case `GET ${R}/milestones`: return ok([{ number: 2, title: "v1.0" }]);
				case `GET ${R}/git/ref/heads/main`: return ok({ object: { sha: "base-tip" } });
				case `GET ${R}/compare/base-tip...abc123`: return ok({ merge_base_commit: { sha: "mb" }, files: [{ filename: "src/mail.ts", status: "modified", additions: 1, deletions: 0 }] });
				case `GET ${R}/compare/abc123...base-tip`: return ok({ merge_base_commit: { sha: "mb" }, files: [{ filename: "docs/b.md", previous_filename: "docs/a.md", status: "renamed", additions: 0, deletions: 0 }] });
				// commitMerge
				case `GET ${R}/git/commits/abc123`: return ok({ sha: "abc123", tree: { sha: "head-tree" } });
				case `GET ${R}/git/commits/base-tip`: return ok({ sha: "base-tip", tree: { sha: "base-tree" } });
				case `GET ${R}/git/trees/base-tree`: return ok({ truncated: false, tree: [{ path: "docs/b.md", mode: "100644", type: "blob", sha: "blob-b" }, { path: "run.sh", mode: "100755", type: "blob", sha: "blob-run" }] });
				case `GET ${R}/git/trees/head-tree`: return ok({ truncated: false, tree: [{ path: "run.sh", mode: "100755", type: "blob", sha: "blob-run-old" }] });
				case `POST ${R}/git/blobs`: return ok({ sha: "blob-new" }, 201);
				case `POST ${R}/git/trees`: return ok({ sha: "tree-new" }, 201);
				case `POST ${R}/git/commits`: return ok({ sha: "commit-new" }, 201);
				case `PATCH ${R}/git/refs/heads/feat/mail`: return ok({ object: { sha: "commit-new" } });
			}
			ok({ message: `fake GitHub has no ${route}` }, 404);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const gh = new OctokitGitHub({
		appId: "123", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
		clientId: "Iv1.x", clientSecret: "secret", accounts: ["jeonglab-bcm"], apiUrl: url, webUrl: url,
	});
	const writes = () => seen.filter((s) => s.method !== "GET" && !(s.path === "/graphql" && !s.body.query.includes("mutation")));
	return { gh, seen, writes, close: () => server.close() };
}

test("16. lines GitHub takes a comment on come from the patch's hunks", () => {
	const patch = "@@ -10,3 +10,4 @@ fn\n a\n-b\n+B\n+C\n c\n@@ -40 +41,0 @@\n-gone";
	assert.deepEqual(commentableLines(patch), { left: [[10, 12], [40, 40]], right: [[10, 13]] });
	assert.equal(commentableLines(undefined), undefined);
});

test("16. the PR page is read with the person's token and mapped", async () => {
	const f = await fakeGitHub();
	try {
		const p = (await f.gh.prPage("user-tok", "jeonglab-bcm/labbot", 12))!;
		assert.equal(f.seen.find((s) => s.path === "/graphql")!.auth, "token user-tok");
		assert.deepEqual(
			{ state: p.state, draft: p.draft, baseRef: p.baseRef, headRef: p.headRef, headSha: p.headSha, commits: p.commits, mergeState: p.mergeState, mergeable: p.mergeable },
			{ state: "OPEN", draft: true, baseRef: "main", headRef: "feat/mail", headSha: "abc123", commits: 3, mergeState: "DIRTY", mergeable: "CONFLICTING" });
		assert.deepEqual(p.mergeMethods, ["squash", "rebase"]);
		assert.deepEqual(p.reviewers, [
			{ login: "jlee", state: "REQUESTED" }, { team: "jeonglab-bcm/core", state: "REQUESTED" }, { login: "hwan", state: "CHANGES_REQUESTED" },
		]);
		assert.deepEqual(p.labels, [{ name: "bug", color: "d73a4a" }]);
		assert.deepEqual(p.milestone, { number: 2, title: "v1.0" });
		// the pending review is the reader's own: in pendingReview, not the timeline
		assert.deepEqual(p.timeline.map((x) => (x.type === "event" ? `${x.event}:${x.subject}` : x.type)), ["commit", "comment", "review", "labeled:bug", "review_requested:jlee"]);
		assert.deepEqual(p.timeline[2], { type: "review", id: "PRR_1", author: "hwan", state: "CHANGES_REQUESTED", body: "See inline.", at: "2026-11-01T17:00:00Z" });
		assert.deepEqual(p.pendingReview, { id: "PRR_2", comments: 1 });
		assert.equal(p.threads[0].reviewId, "PRR_1");
		assert.deepEqual(p.threads[0].comments.map((c) => c.pending), [false, true]);
		assert.equal(p.threads[0].diffHunk, "@@ -1,2 +1,3 @@\n a\n+b");
		assert.deepEqual(p.checks.map((c) => [c.name, c.workflow ?? null, c.state, c.url]), [
			["test", "CI", "failed", "https://github.com/x/1"], ["lint", null, "running", "https://github.com/x/2"], ["ci/legacy", null, "passed", "https://ci.example/3"],
		]);
		assert.deepEqual(p.viewed, { "src/mail.ts": "VIEWED", "README.md": "UNVIEWED" });
	} finally {
		f.close();
	}
});

test("16. merge sends the chosen method, title and message", async () => {
	const f = await fakeGitHub();
	try {
		await f.gh.merge("user-tok", "jeonglab-bcm/labbot", 12, { method: "squash", title: "Add email tools (#12)", message: "Body" });
		const m = f.seen.find((s) => s.method === "PUT")!;
		assert.equal(m.auth, "token user-tok");
		assert.deepEqual(m.body, { merge_method: "squash", commit_title: "Add email tools (#12)", commit_message: "Body" });
	} finally {
		f.close();
	}
});

test("16. a single line comment goes to the head commit, on the chosen side", async () => {
	const f = await fakeGitHub();
	try {
		await f.gh.addReviewComment("user-tok", "jeonglab-bcm/labbot", 12, { mode: "single", subject: "line", path: "src/mail.ts", line: 3, side: "LEFT", body: "Hm" });
		await f.gh.addReviewComment("user-tok", "jeonglab-bcm/labbot", 12, { mode: "single", subject: "file", path: "src/mail.ts", body: "File" });
		const posts = f.seen.filter((s) => s.path === `${R}/pulls/12/comments`);
		assert.deepEqual(posts.map((p) => p.body), [
			{ commit_id: "abc123", path: "src/mail.ts", body: "Hm", line: 3, side: "LEFT" },
			{ commit_id: "abc123", path: "src/mail.ts", body: "File", subject_type: "file" },
		]);
		assert.ok(posts.every((p) => p.auth === "token user-tok"));
	} finally {
		f.close();
	}
});

test("16. Start a review makes a pending review, then adds the comment to it", async () => {
	const f = await fakeGitHub({ pending: false });
	try {
		await f.gh.addReviewComment("user-tok", "jeonglab-bcm/labbot", 12, { mode: "review", subject: "line", path: "src/mail.ts", line: 3, side: "RIGHT", body: "Later" });
		const [create, add] = f.writes();
		assert.match(create.body.query, /addPullRequestReview\(/);
		assert.deepEqual(create.body.variables.input, { pullRequestId: "PR_12" }); // no event: stays pending
		assert.match(add.body.query, /addPullRequestReviewThread\(/);
		assert.deepEqual(add.body.variables.input, { pullRequestReviewId: "PRR_NEW", path: "src/mail.ts", body: "Later", line: 3, side: "RIGHT", subjectType: "LINE" });
	} finally {
		f.close();
	}
});

test("16. submitting with a pending review submits that review; without one, posts a review", async () => {
	const withPending = await fakeGitHub({ pending: true });
	const without = await fakeGitHub({ pending: false });
	try {
		await withPending.gh.submitReview("user-tok", "jeonglab-bcm/labbot", 12, "REQUEST_CHANGES", "Fix it");
		const [s] = withPending.writes();
		assert.match(s.body.query, /submitPullRequestReview\(/);
		assert.deepEqual(s.body.variables.input, { pullRequestReviewId: "PRR_2", event: "REQUEST_CHANGES", body: "Fix it" });
		await without.gh.submitReview("user-tok", "jeonglab-bcm/labbot", 12, "APPROVE", "");
		assert.deepEqual(without.writes().map((w) => [w.method, w.path, w.body]), [["POST", `${R}/pulls/12/reviews`, { event: "APPROVE", body: "" }]]);
		await withPending.gh.cancelReview("user-tok", "jeonglab-bcm/labbot", 12);
		assert.match(withPending.writes()[1].body.query, /deletePullRequestReview\(/);
	} finally {
		withPending.close();
		without.close();
	}
});

test("16. threads, draft and Viewed are GraphQL mutations as the person", async () => {
	const f = await fakeGitHub();
	try {
		const r = "jeonglab-bcm/labbot";
		await f.gh.replyToThread("user-tok", r, 12, "RT_1", "Done");
		await f.gh.setThreadResolved("user-tok", r, 12, "RT_1", true);
		await f.gh.setThreadResolved("user-tok", r, 12, "RT_1", false);
		await f.gh.setDraft("user-tok", r, 12, false);
		await f.gh.setDraft("user-tok", r, 12, true);
		await f.gh.setViewed("user-tok", r, 12, "src/mail.ts", true);
		await f.gh.setViewed("user-tok", r, 12, "src/mail.ts", false);
		const names = f.writes().map((w) => w.body.query.match(/mutation[^{]*\{\s*done:\s*(\w+)/)?.[1]);
		assert.deepEqual(names, ["addPullRequestReviewThreadReply", "resolveReviewThread", "unresolveReviewThread", "markPullRequestReadyForReview",
			"convertPullRequestToDraft", "markFileAsViewed", "unmarkFileAsViewed"]);
		assert.deepEqual(f.writes()[0].body.variables.input, { pullRequestReviewThreadId: "RT_1", body: "Done" });
		assert.deepEqual(f.writes()[5].body.variables.input, { pullRequestId: "PR_12", path: "src/mail.ts" });
		assert.ok(f.writes().every((w) => w.auth === "token user-tok"));
	} finally {
		f.close();
	}
});

test("16. Update branch, reviewers, assignees, labels and milestone are REST calls as the person", async () => {
	const f = await fakeGitHub();
	try {
		const r = "jeonglab-bcm/labbot";
		await f.gh.updateBranch("user-tok", r, 12);
		await f.gh.requestReviewers("user-tok", r, 12, ["jlee"], ["hwan"]);
		await f.gh.setAssignees("user-tok", r, 12, ["kelly"]);
		await f.gh.setLabels("user-tok", r, 12, ["bug"]);
		await f.gh.setMilestone("user-tok", r, 12, null);
		assert.deepEqual(f.writes().map((w) => [w.method, w.path.replace(R, ""), w.body]), [
			["PUT", "/pulls/12/update-branch", undefined],
			["POST", "/pulls/12/requested_reviewers", { reviewers: ["jlee"] }],
			["DELETE", "/pulls/12/requested_reviewers", { reviewers: ["hwan"] }],
			["PATCH", "/issues/12", { assignees: ["kelly"] }],
			["PUT", "/issues/12/labels", { labels: ["bug"] }],
			["PATCH", "/issues/12", { milestone: null }],
		]);
	} finally {
		f.close();
	}
});

test("16. the sidebar's choices come from the repo, read as the person", async () => {
	const f = await fakeGitHub();
	try {
		const o = await f.gh.repoOptions("user-tok", "jeonglab-bcm/labbot");
		assert.deepEqual(o, {
			assignable: ["hwan", "kelly"],
			labels: [{ name: "bug", color: "d73a4a", description: "Broken" }, { name: "docs", color: "0075ca", description: "" }],
			milestones: [{ number: 2, title: "v1.0" }],
		});
		assert.ok(f.seen.filter((s) => s.method === "GET").every((s) => s.auth === "token user-tok"));
	} finally {
		f.close();
	}
});

test("16. what resolving conflicts reads: both sides since the merge base, with the App's token", async () => {
	const f = await fakeGitHub();
	try {
		const m = (await f.gh.mergeInputs("jeonglab-bcm/labbot", 12))!;
		assert.deepEqual({ ...m, headFiles: m.headFiles.map((x) => x.path), baseFiles: m.baseFiles.map((x) => `${x.previous}>${x.path}`) }, {
			headRepo: "jeonglab-bcm/labbot", headRef: "feat/mail", headSha: "abc123", baseRef: "main", baseSha: "base-tip", mergeBase: "mb",
			headFiles: ["src/mail.ts"], baseFiles: ["docs/a.md>docs/b.md"],
		});
		assert.ok(f.seen.filter((s) => !s.path.startsWith("/app/")).every((s) => s.auth === "token inst-tok"));
	} finally {
		f.close();
	}
});

test("16. a merge commit: the head's tree plus the changes, two parents, ref moved without force", async () => {
	const f = await fakeGitHub();
	try {
		const sha = await f.gh.commitMerge("user-tok", "jeonglab-bcm/labbot", "feat/mail", {
			message: "Merge branch 'main' into feat/mail", parents: ["abc123", "base-tip"],
			take: ["docs/b.md"], remove: ["docs/a.md"], write: [{ path: "run.sh", text: "echo hi\n" }],
		});
		assert.equal(sha, "commit-new");
		const w = f.writes();
		assert.deepEqual(w.map((x) => `${x.method} ${x.path.replace(R, "")}`), ["POST /git/blobs", "POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/feat/mail"]);
		assert.deepEqual(w[0].body, { content: "echo hi\n", encoding: "utf-8" });
		assert.deepEqual(w[1].body, { base_tree: "head-tree", tree: [
			{ path: "docs/b.md", mode: "100644", type: "blob", sha: "blob-b" },
			{ path: "docs/a.md", mode: "100644", type: "blob", sha: null },
			{ path: "run.sh", mode: "100755", type: "blob", sha: "blob-new" }, // keeps its mode
		] });
		assert.deepEqual(w[2].body, { message: "Merge branch 'main' into feat/mail", tree: "tree-new", parents: ["abc123", "base-tip"] });
		assert.deepEqual(w[3].body, { sha: "commit-new", force: false });
		assert.ok(f.seen.filter((s) => !s.path.startsWith("/app/")).every((s) => s.auth === "token user-tok"));
	} finally {
		f.close();
	}
});

test("16. Close and Reopen set the PR's state, as the person", async () => {
	const f = await fakeGitHub();
	try {
		await f.gh.setState("user-tok", "jeonglab-bcm/labbot", 12, "closed");
		await f.gh.setState("user-tok", "jeonglab-bcm/labbot", 12, "open");
		assert.deepEqual(f.writes().map((w) => [w.method, w.path.replace(R, ""), w.body, w.auth]), [
			["PATCH", "/pulls/12", { state: "closed" }, "token user-tok"], ["PATCH", "/pulls/12", { state: "open" }, "token user-tok"],
		]);
	} finally {
		f.close();
	}
});

test("16. the Commits tab: commits with their first line, and a commit's files against its first parent", async () => {
	const f = await fakeGitHub();
	try {
		assert.deepEqual(await f.gh.prCommits("jeonglab-bcm/labbot", 12), [
			{ sha: "c1", message: "Add send()", author: "kelly", at: "2026-11-01T15:01:00Z" },
			{ sha: "c2", message: "Fix typo", author: "Someone", at: "2026-11-01T16:00:00Z" },
		]);
		assert.deepEqual(await f.gh.commitFiles("jeonglab-bcm/labbot", "c1"), {
			base: "p1", head: "c1",
			files: [{ path: "src/mail.ts", status: "modified", additions: 2, deletions: 1, commentable: { left: [[1, 1]], right: [[1, 2]] } }],
		});
		assert.equal(await f.gh.commitFiles("jeonglab-bcm/labbot", "missing"), null);
		assert.ok(f.seen.filter((s) => !s.path.startsWith("/app/")).every((s) => s.auth === "token inst-tok"));
	} finally {
		f.close();
	}
});
