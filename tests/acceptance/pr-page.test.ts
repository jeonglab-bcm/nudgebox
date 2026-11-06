/**
 * SPEC 16. The PR page: read as the person, and every button on it acting as the person.
 * Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
const MINE = "hyunhwan-bcm/tailjobs";

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Raise the limit", requestedReviewers: ["hwan"] });
	t.github.addPr({ repo: MINE, number: 7, author: "hwan" });
	t.github.pages.set(`${LAB}#4`, {
		body: "Raises the limit to 20.",
		timeline: [
			{ type: "comment", id: "c1", author: "hwan", body: "Why 20?", at: "2026-11-02T10:00:00Z" },
			{ type: "review", id: "r1", author: "hwan", state: "CHANGES_REQUESTED", body: "See the line comment.", at: "2026-11-02T11:00:00Z" },
		],
		threads: [{
			id: "t1", path: "src/limit.ts", line: 15, startLine: null, side: "RIGHT", resolved: false, outdated: false, reviewId: "r1",
			diffHunk: "@@ -15 +15 @@\n-const limit = 10;\n+const limit = 20;",
			comments: [{ id: "tc1", author: "hwan", body: "Make it a setting.", at: "2026-11-02T11:00:00Z", pending: false }],
		}],
		checks: [{ name: "test", workflow: "CI", state: "failed", url: "https://github.com/jeonglab-bcm/labbot/actions/runs/1" }],
		viewed: { "src/limit.ts": "VIEWED" },
	});
	t.github.options.set(LAB, {
		assignable: ["hwan", "kelly", "jlee"],
		labels: [{ name: "bug", color: "d73a4a", description: "Something is broken" }],
		milestones: [{ number: 2, title: "v1.0" }],
	});
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	const page = (as: string, repo: string, n: number) => t.req(`/api/pr?repo=${encodeURIComponent(repo)}&number=${n}`, { as });
	const post = (as: string, action: string, body: object) => t.req(`/api/prs/${action}`, { as, method: "POST", body: JSON.stringify(body) });
	const acts = () => t.github.calls.filter((c) => c.token && c.op !== "prPage");
	return { t, page, post, acts };
}

test("16. the PR page is read with the reader's own token, and has what GitHub's page has", async () => {
	const { t, page } = await setup();
	try {
		const r = await page("hyunhwanj", LAB, 4);
		assert.equal(r.status, 200);
		const p = await r.json();
		assert.equal(p.page.title, "Raise the limit");
		assert.equal(p.page.body, "Raises the limit to 20.");
		assert.deepEqual(p.page.timeline.map((x: { type: string }) => x.type), ["comment", "review"]);
		assert.equal(p.page.threads[0].comments[0].body, "Make it a setting.");
		assert.equal(p.page.checks[0].state, "failed");
		assert.deepEqual(p.page.viewed, { "src/limit.ts": "VIEWED" });
		assert.equal(p.login, "hwan");
		const read = t.github.calls.find((c) => c.op === "prPage")!;
		assert.ok(read.token!.endsWith(":hwan"), "read with someone else's token");
	} finally {
		await t.close();
	}
});

test("16. the PR page only for repos you can see", async () => {
	const { t, page } = await setup();
	try {
		assert.equal((await page("kellyl", MINE, 7)).status, 404);
		assert.equal(t.github.calls.filter((c) => c.op === "prPage").length, 0);
		assert.equal((await page("hyunhwanj", LAB, 999)).status, 404);
	} finally {
		await t.close();
	}
});

test("16. the sidebar's choices: the repo's assignable people, labels and open milestones", async () => {
	const { t } = await setup();
	try {
		const r = await t.req(`/api/repo/options?repo=${encodeURIComponent(LAB)}`, { as: "hyunhwanj" });
		assert.equal(r.status, 200);
		const o = await r.json();
		assert.deepEqual(o.assignable, ["hwan", "kelly", "jlee"]);
		assert.equal(o.labels[0].color, "d73a4a");
		assert.deepEqual(o.milestones, [{ number: 2, title: "v1.0" }]);
		assert.equal((await t.req(`/api/repo/options?repo=${encodeURIComponent(MINE)}`, { as: "kellyl" })).status, 404);
	} finally {
		await t.close();
	}
});

test("16. merge with a chosen method, title and message; still only when confirmed", async () => {
	const { t, post, acts } = await setup();
	try {
		assert.equal((await post("hyunhwanj", "merge", { repo: LAB, number: 4, method: "squash" })).status, 400);
		assert.equal((await post("hyunhwanj", "merge", { repo: LAB, number: 4, confirm: true, method: "octopus" })).status, 400);
		const r = await post("hyunhwanj", "merge", { repo: LAB, number: 4, confirm: true, method: "squash", title: "Raise the limit (#4)", message: "To 20." });
		assert.equal(r.status, 200);
		assert.deepEqual(acts().map((c) => [c.op, c.args]), [["merge", { method: "squash", title: "Raise the limit (#4)", message: "To 20." }]]);
	} finally {
		await t.close();
	}
});

test("16. a line comment: posted now, or added to the pending review", async () => {
	const { t, post, acts } = await setup();
	try {
		const line = { repo: LAB, number: 4, path: "src/limit.ts", line: 15, side: "RIGHT", body: "Typo?" };
		assert.equal((await post("kellyl", "review-comment", { ...line, mode: "single" })).status, 200);
		assert.equal((await post("kellyl", "review-comment", { ...line, mode: "review", side: "LEFT", line: 14 })).status, 200);
		assert.equal((await post("kellyl", "review-comment", { repo: LAB, number: 4, path: "src/limit.ts", subject: "file", mode: "single", body: "Whole file" })).status, 200);
		const got = acts().map((c) => c.args);
		assert.deepEqual(got[0], { mode: "single", subject: "line", path: "src/limit.ts", line: 15, side: "RIGHT", body: "Typo?" });
		assert.deepEqual(got[1], { mode: "review", subject: "line", path: "src/limit.ts", line: 14, side: "LEFT", body: "Typo?" });
		assert.deepEqual(got[2], { mode: "single", subject: "file", path: "src/limit.ts", body: "Whole file" });
		assert.ok(acts().every((c) => c.token!.endsWith(":kelly")));
	} finally {
		await t.close();
	}
});

test("16. a line comment needs text, a path, a side and a line", async () => {
	const { t, post, acts } = await setup();
	try {
		const ok = { repo: LAB, number: 4, path: "src/limit.ts", line: 15, side: "RIGHT", body: "x", mode: "single" };
		for (const bad of [{ body: "  " }, { path: "" }, { side: "MIDDLE" }, { line: 0 }, { line: "15" }, { mode: "later" }]) {
			assert.equal((await post("kellyl", "review-comment", { ...ok, ...bad })).status, 400, JSON.stringify(bad));
		}
		assert.equal(acts().length, 0);
	} finally {
		await t.close();
	}
});

test("16. reply to a thread, resolve and unresolve it", async () => {
	const { t, post, acts } = await setup();
	try {
		assert.equal((await post("kellyl", "reply", { repo: LAB, number: 4, thread: "t1", body: "Done." })).status, 200);
		assert.equal((await post("kellyl", "reply", { repo: LAB, number: 4, thread: "t1", body: " " })).status, 400);
		assert.equal((await post("kellyl", "resolve-thread", { repo: LAB, number: 4, thread: "t1", resolved: true })).status, 200);
		assert.equal((await post("kellyl", "resolve-thread", { repo: LAB, number: 4, thread: "t1", resolved: false })).status, 200);
		assert.deepEqual(acts().map((c) => [c.op, c.body ?? null, c.args]), [
			["replyToThread", "Done.", { thread: "t1" }],
			["setThreadResolved", null, { thread: "t1", resolved: true }],
			["setThreadResolved", null, { thread: "t1", resolved: false }],
		]);
	} finally {
		await t.close();
	}
});

test("16. submit a review as Comment, Approve or Request changes; cancel a pending one", async () => {
	const { t, post, acts } = await setup();
	try {
		for (const event of ["COMMENT", "APPROVE", "REQUEST_CHANGES"]) {
			assert.equal((await post("hyunhwanj", "submit-review", { repo: LAB, number: 4, event, body: `as ${event}` })).status, 200, event);
		}
		assert.equal((await post("hyunhwanj", "submit-review", { repo: LAB, number: 4, event: "MERGE", body: "" })).status, 400);
		assert.equal((await post("hyunhwanj", "cancel-review", { repo: LAB, number: 4 })).status, 200);
		assert.deepEqual(acts().map((c) => [c.op, c.args?.event ?? null, c.body ?? null]), [
			["submitReview", "COMMENT", "as COMMENT"], ["submitReview", "APPROVE", "as APPROVE"],
			["submitReview", "REQUEST_CHANGES", "as REQUEST_CHANGES"], ["cancelReview", null, null],
		]);
	} finally {
		await t.close();
	}
});

test("16. Update branch, Ready for review, Convert to draft and Viewed", async () => {
	const { t, post, acts } = await setup();
	try {
		assert.equal((await post("kellyl", "update-branch", { repo: LAB, number: 4 })).status, 200);
		assert.equal((await post("kellyl", "draft", { repo: LAB, number: 4, draft: false })).status, 200);
		assert.equal((await post("kellyl", "draft", { repo: LAB, number: 4, draft: true })).status, 200);
		assert.equal((await post("kellyl", "draft", { repo: LAB, number: 4 })).status, 400);
		assert.equal((await post("kellyl", "viewed", { repo: LAB, number: 4, path: "src/limit.ts", viewed: true })).status, 200);
		assert.equal((await post("kellyl", "viewed", { repo: LAB, number: 4, path: "", viewed: true })).status, 400);
		assert.deepEqual(acts().map((c) => [c.op, c.args ?? null]), [
			["updateBranch", null], ["setDraft", { draft: false }], ["setDraft", { draft: true }],
			["setViewed", { path: "src/limit.ts", viewed: true }],
		]);
	} finally {
		await t.close();
	}
});

test("16. reviewers, assignees, labels and milestone from the sidebar", async () => {
	const { t, post, acts } = await setup();
	try {
		assert.equal((await post("hyunhwanj", "reviewers", { repo: LAB, number: 4, add: ["jlee"], remove: ["hwan"] })).status, 200);
		assert.equal((await post("hyunhwanj", "assignees", { repo: LAB, number: 4, logins: ["hwan"] })).status, 200);
		assert.equal((await post("hyunhwanj", "labels", { repo: LAB, number: 4, names: ["bug"] })).status, 200);
		assert.equal((await post("hyunhwanj", "milestone", { repo: LAB, number: 4, milestone: 2 })).status, 200);
		assert.equal((await post("hyunhwanj", "milestone", { repo: LAB, number: 4, milestone: null })).status, 200);
		for (const [a, b] of [["reviewers", { add: "jlee" }], ["assignees", { logins: [1] }], ["labels", {}], ["milestone", { milestone: "v1" }]] as const) {
			assert.equal((await post("hyunhwanj", a, { repo: LAB, number: 4, ...b })).status, 400, a);
		}
		assert.deepEqual(acts().map((c) => [c.op, c.args]), [
			["requestReviewers", { add: ["jlee"], remove: ["hwan"] }], ["setAssignees", { logins: ["hwan"] }],
			["setLabels", { names: ["bug"] }], ["setMilestone", { milestone: 2 }], ["setMilestone", { milestone: null }],
		]);
	} finally {
		await t.close();
	}
});

test("16. no PR page button acts on a PR you cannot see", async () => {
	const { t, post, acts } = await setup();
	try {
		const base = { repo: MINE, number: 7 };
		const tries: [string, object][] = [
			["review-comment", { path: "a", line: 1, side: "RIGHT", body: "x", mode: "single" }], ["reply", { thread: "t", body: "x" }],
			["resolve-thread", { thread: "t", resolved: true }], ["submit-review", { event: "COMMENT", body: "x" }], ["cancel-review", {}],
			["update-branch", {}], ["draft", { draft: true }], ["viewed", { path: "a", viewed: true }], ["reviewers", { add: [], remove: [] }],
			["assignees", { logins: [] }], ["labels", { names: [] }], ["milestone", { milestone: null }], ["close", { confirm: true }],
			["reopen", {}],
		];
		for (const [a, b] of tries) assert.equal((await post("kellyl", a, { ...base, ...b })).status, 404, a);
		assert.equal(acts().length, 0);
	} finally {
		await t.close();
	}
});

test("16. GitHub's refusal of a review is shown", async () => {
	const { t, post } = await setup();
	try {
		t.github.failNext = { status: 422, message: "Can not approve your own pull request" };
		const r = await post("kellyl", "submit-review", { repo: LAB, number: 4, event: "APPROVE", body: "" });
		assert.equal(r.status, 409);
		assert.match((await r.json()).error, /approve your own/);
	} finally {
		await t.close();
	}
});

test("16. Close asks first and goes as the person; Reopen a closed PR", async () => {
	const { t, post, acts } = await setup();
	try {
		t.github.pages.set(`${LAB}#5`, { state: "CLOSED", author: "kelly" }); // closed: on GitHub, not in the inbox
		assert.equal((await post("kellyl", "close", { repo: LAB, number: 4 })).status, 400);
		assert.equal((await post("kellyl", "close", { repo: LAB, number: 4, confirm: true })).status, 200);
		assert.equal((await post("kellyl", "reopen", { repo: LAB, number: 5 })).status, 200);
		assert.equal((await post("kellyl", "reopen", { repo: LAB, number: 4 })).status, 409); // open already
		assert.deepEqual(acts().map((c) => [c.op, c.number, c.args, c.token!.split(":")[1]]), [
			["setState", 4, { state: "closed" }, "kelly"], ["setState", 5, { state: "open" }, "kelly"],
		]);
	} finally {
		await t.close();
	}
});

test("16. the Commits tab: the PR's commits, and a commit's files against its parent", async () => {
	const { t } = await setup();
	try {
		t.github.commits.set(`${LAB}#4`, [{ sha: "c1", message: "Raise the limit", author: "kelly", at: "2026-11-02T09:00:00Z" }]);
		t.github.commitFileSets.set(`${LAB}@c1`, { base: "p1", head: "c1", files: [{ path: "src/limit.ts", status: "modified", additions: 1, deletions: 1 }] });
		const list = await t.req(`/api/prs/commits?repo=${encodeURIComponent(LAB)}&number=4`, { as: "hyunhwanj" });
		assert.equal(list.status, 200);
		assert.deepEqual((await list.json()).map((c: { sha: string }) => c.sha), ["c1"]);
		const files = await t.req(`/api/commit/files?repo=${encodeURIComponent(LAB)}&sha=c1`, { as: "hyunhwanj" });
		assert.equal(files.status, 200);
		assert.deepEqual(await files.json(), { base: "p1", head: "c1", files: [{ path: "src/limit.ts", status: "modified", additions: 1, deletions: 1 }] });
		assert.equal((await t.req(`/api/commit/files?repo=${encodeURIComponent(LAB)}&sha=nope`, { as: "hyunhwanj" })).status, 404);
		t.github.commits.set(`${MINE}#7`, []);
		assert.equal((await t.req(`/api/prs/commits?repo=${encodeURIComponent(MINE)}&number=7`, { as: "kellyl" })).status, 404);
		assert.equal((await t.req(`/api/commit/files?repo=${encodeURIComponent(MINE)}&sha=c1`, { as: "kellyl" })).status, 404);
	} finally {
		await t.close();
	}
});
