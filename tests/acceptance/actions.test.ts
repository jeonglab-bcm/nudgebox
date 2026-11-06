/**
 * SPEC 6. Merge (confirmed), approve, re-run failed checks, comment: always with the
 * clicking person's own GitHub token, never destructive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, ORIGIN } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 3, author: "hwan", reviewDecision: "APPROVED", checks: "success" });
	t.github.addPr({ repo: "hyunhwan-bcm/tailjobs", number: 7, author: "hwan" });
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	const post = (as: string, action: string, body: object, headers: Record<string, string> = {}) =>
		t.req(`/api/prs/${action}`, { as, method: "POST", body: JSON.stringify(body), headers });
	return { t, post };
}

test("6. merge needs an explicit confirmation", async () => {
	const { t, post } = await setup();
	try {
		assert.equal((await post("hyunhwanj", "merge", { repo: LAB, number: 3 })).status, 400);
		assert.equal(t.github.calls.filter((c) => c.op === "merge").length, 0);
		assert.equal((await post("hyunhwanj", "merge", { repo: LAB, number: 3, confirm: true })).status, 200);
		const [m] = t.github.calls.filter((c) => c.op === "merge");
		assert.deepEqual({ repo: m.repo, number: m.number }, { repo: LAB, number: 3 });
	} finally {
		await t.close();
	}
});

test("6. actions run with the clicking person's token", async () => {
	const { t, post } = await setup();
	try {
		assert.equal((await post("kellyl", "approve", { repo: LAB, number: 3 })).status, 200);
		assert.equal((await post("kellyl", "rerun", { repo: LAB, number: 3 })).status, 200);
		assert.equal((await post("kellyl", "comment", { repo: LAB, number: 3, body: "LGTM" })).status, 200);
		const acts = t.github.calls.filter((c) => c.token);
		assert.deepEqual(acts.map((c) => c.op), ["approve", "rerunFailedChecks", "comment"]);
		assert.ok(acts.every((c) => c.token!.endsWith(":kelly")), "an action ran with someone else's token");
		assert.equal(acts[2].body, "LGTM");
	} finally {
		await t.close();
	}
});

test("6. an empty comment is refused", async () => {
	const { t, post } = await setup();
	try {
		assert.equal((await post("kellyl", "comment", { repo: LAB, number: 3, body: "  " })).status, 400);
	} finally {
		await t.close();
	}
});

test("6. no acting on a PR you cannot see", async () => {
	const { t, post } = await setup();
	try {
		assert.equal((await post("kellyl", "approve", { repo: "hyunhwan-bcm/tailjobs", number: 7 })).status, 404);
		assert.equal(t.github.calls.filter((c) => c.token).length, 0);
	} finally {
		await t.close();
	}
});

test("6. GitHub's refusal is shown, not hidden", async () => {
	const { t, post } = await setup();
	try {
		t.github.failNext = { status: 405, message: "Pull Request is not mergeable" };
		const r = await post("hyunhwanj", "merge", { repo: LAB, number: 3, confirm: true });
		assert.equal(r.status, 409);
		assert.match((await r.json()).error, /not mergeable/);
	} finally {
		await t.close();
	}
});

test("6. nothing destructive exists", async () => {
	const { t, post } = await setup();
	try {
		for (const a of ["delete-branch", "force-push", "edit"]) { // Close and Reopen exist since SPEC 16
			assert.equal((await post("hyunhwanj", a, { repo: LAB, number: 3, confirm: true })).status, 404, a);
		}
		assert.equal(t.github.calls.filter((c) => c.token).length, 0);
	} finally {
		await t.close();
	}
});

test("6. a POST from another site is refused", async () => {
	const { t, post } = await setup();
	try {
		const r = await post("hyunhwanj", "merge", { repo: LAB, number: 3, confirm: true }, { origin: "https://evil.example" });
		assert.equal(r.status, 403);
		assert.equal(t.github.calls.filter((c) => c.op === "merge").length, 0);
		assert.ok(ORIGIN.startsWith("https://"));
	} finally {
		await t.close();
	}
});

test("3.2 an expired GitHub token is refreshed before acting", async () => {
	const t = await start();
	try {
		t.github.grant("hwan", LAB);
		t.github.addPr({ repo: LAB, number: 3, author: "kelly" });
		t.github.tokenTtlMs = -60_000; // issued already expired
		await t.link("hyunhwanj", "hwan");
		t.github.tokenTtlMs = 8 * 3600_000;
		await t.app.sync();
		const r = await t.req("/api/prs/approve", { as: "hyunhwanj", method: "POST", body: JSON.stringify({ repo: LAB, number: 3 }) });
		assert.equal(r.status, 200);
		const ops = t.github.calls.map((c) => c.op);
		assert.ok(ops.indexOf("refresh") >= 0 && ops.indexOf("refresh") < ops.indexOf("approve"), ops.join(","));
		assert.equal(t.github.calls.find((c) => c.op === "approve")!.token, "tok2:hwan");
	} finally {
		await t.close();
	}
});
