/**
 * SPEC 5 (2026-11-03): old PRs fold away, Hide until something changes, both quiet.
 * Tabs and the repo filter are client-side over the same /api/inbox data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, ids } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
const DAY = 24 * 3600_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const key = (xs: { repo: string; number: number }[]) => xs.map((x) => `${x.repo}#${x.number}`);

async function setup(opts: Parameters<typeof start>[0] = {}) {
	const t = await start(opts);
	t.github.grant("hwan", LAB);
	t.github.grant("kelly", LAB);
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	return t;
}

test("5. a PR with no activity for oldDays moves from the tabs to Old", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: LAB, number: 1, author: "kelly", updatedAt: ago(31) });
		t.github.addPr({ repo: LAB, number: 2, author: "kelly", updatedAt: ago(29) });
		await t.app.sync();
		const x = await t.inbox("hyunhwanj");
		assert.deepEqual(Object.values(ids(x)).flat(), [`${LAB}#2`]);
		assert.deepEqual(key(x.old), [`${LAB}#1`]);
	} finally {
		await t.close();
	}
});

test("5. oldDays comes from config", async () => {
	const t = await setup({ oldDays: 10 });
	try {
		t.github.addPr({ repo: LAB, number: 1, author: "kelly", updatedAt: ago(11) });
		await t.app.sync();
		assert.deepEqual(key((await t.inbox("hyunhwanj")).old), [`${LAB}#1`]);
	} finally {
		await t.close();
	}
});

test("5. Hide is per person, listed under Hidden, and Unhide brings it back", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: LAB, number: 3, author: "kelly", updatedAt: ago(1) });
		await t.app.sync();
		assert.equal((await t.hide("hyunhwanj", "pr", LAB, 3)).status, 200);
		const mine = await t.inbox("hyunhwanj");
		assert.deepEqual(Object.values(ids(mine)).flat(), []);
		assert.deepEqual(key(mine.hidden), [`${LAB}#3`]);
		assert.deepEqual(Object.values(ids(await t.inbox("kellyl"))).flat(), [`${LAB}#3`], "hidden for kelly too");
		await t.hide("hyunhwanj", "pr", LAB, 3, true);
		assert.deepEqual(Object.values(ids(await t.inbox("hyunhwanj"))).flat(), [`${LAB}#3`]);
	} finally {
		await t.close();
	}
});

test("5. a hidden PR comes back by itself when something new happens on it", async () => {
	const t = await setup();
	try {
		const pr = t.github.addPr({ repo: LAB, number: 4, author: "kelly", updatedAt: ago(1) });
		await t.app.sync();
		await t.hide("hyunhwanj", "pr", LAB, 4);
		pr.updatedAt = new Date(Date.now() + 1000).toISOString(); // a new comment / push / review
		await t.webhook("pull_request", { action: "synchronize", number: 4, pull_request: { number: 4 }, repository: { full_name: LAB } });
		await t.app.idle();
		const x = await t.inbox("hyunhwanj");
		assert.deepEqual(Object.values(ids(x)).flat(), [`${LAB}#4`]);
		assert.deepEqual(x.hidden, []);
	} finally {
		await t.close();
	}
});

test("5. hide only what you can see; unknown kinds are refused", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: "hyunhwan-bcm/tailjobs", number: 7, author: "hwan" });
		await t.app.sync();
		assert.equal((await t.hide("kellyl", "pr", "hyunhwan-bcm/tailjobs", 7)).status, 404);
		const r = await t.req("/api/hide", { as: "kellyl", method: "POST", body: JSON.stringify({ kind: "repo", repo: LAB, number: 1 }) });
		assert.equal(r.status, 400);
	} finally {
		await t.close();
	}
});

test("7. hidden and old PRs send no push and skip the stale digest", async () => {
	const t = await setup();
	try {
		await t.subscribe("hyunhwanj", "https://push.example/hwan");
		const hidden = t.github.addPr({ repo: LAB, number: 5, author: "hwan", headSha: "h5", checks: "pending", updatedAt: ago(4) });
		t.github.addPr({ repo: LAB, number: 6, author: "hwan", updatedAt: ago(40) }); // old and stale
		await t.app.sync();
		await t.hide("hyunhwanj", "pr", LAB, 5);

		hidden.checks = "success"; // CI finishing does not bump the PR's activity time
		await t.webhook("check_suite", { action: "completed", check_suite: { head_sha: "h5", pull_requests: [{ number: 5 }] }, repository: { full_name: LAB } });
		await t.app.idle();
		await t.app.runStaleDigest(); // #5 (4 days, hidden) and #6 (40 days, old) are both stale
		assert.deepEqual(t.pushed, []);
	} finally {
		await t.close();
	}
});
