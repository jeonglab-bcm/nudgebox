/**
 * SPEC 7. iPhone/Mac push: review requested, your PR's CI finished (once per commit),
 * a daily stale digest. Devices the push service calls gone are dropped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
const DAY = 24 * 3600_000;

async function setup(opts: Parameters<typeof start>[0] = {}) {
	const t = await start(opts);
	t.github.grant("hwan", LAB);
	t.github.grant("kelly", LAB);
	t.github.teams.set("hwan", ["jeonglab-bcm/core"]);
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.subscribe("hyunhwanj", "https://push.example/hwan-iphone");
	await t.subscribe("hyunhwanj", "https://push.example/hwan-mac");
	await t.subscribe("kellyl", "https://push.example/kelly-iphone");
	return t;
}

const prEvent = (action: string, n: number, extra: object = {}) => ({
	action,
	number: n,
	pull_request: { number: n, title: `PR ${n}`, html_url: `https://github.com/${LAB}/pull/${n}`, user: { login: "kelly" }, head: { sha: `sha-${n}` } },
	repository: { full_name: LAB },
	...extra,
});

test("7.1 review requested: every device of the requested person, nobody else", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: LAB, number: 4, author: "kelly", requestedReviewers: ["hwan"] });
		const r = await t.webhook("pull_request", prEvent("review_requested", 4, { requested_reviewer: { login: "hwan" } }));
		assert.equal(r.status, 200);
		await t.app.idle();
		assert.deepEqual(t.pushed.map((p) => p.endpoint).sort(), ["https://push.example/hwan-iphone", "https://push.example/hwan-mac"]);
		assert.match(t.pushed[0].payload.title, /review/i);
		assert.match(t.pushed[0].payload.body, /labbot#4/);
	} finally {
		await t.close();
	}
});

test("7.1 review requested from a team reaches its members", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: LAB, number: 5, author: "kelly", requestedTeams: ["jeonglab-bcm/core"] });
		await t.webhook("pull_request", prEvent("review_requested", 5, { requested_team: { slug: "core" }, organization: { login: "jeonglab-bcm" } }));
		await t.app.idle();
		assert.ok(t.pushed.length > 0 && t.pushed.every((p) => p.endpoint.includes("hwan")));
	} finally {
		await t.close();
	}
});

test("7.2 CI finished: one push to the author per commit, passed or failed", async () => {
	const t = await setup();
	try {
		const pr = t.github.addPr({ repo: LAB, number: 6, author: "kelly", headSha: "aaa", checks: "pending" });
		const suite = (sha: string) => ({ action: "completed", check_suite: { head_sha: sha, pull_requests: [{ number: 6 }] }, repository: { full_name: LAB } });

		await t.webhook("check_suite", suite("aaa")); // one suite done, others still running
		await t.app.idle();
		assert.equal(t.pushed.length, 0);

		pr.checks = "success";
		await t.webhook("check_suite", suite("aaa"));
		await t.webhook("check_suite", suite("aaa")); // duplicate delivery
		await t.app.idle();
		assert.deepEqual(t.pushed.map((p) => p.endpoint), ["https://push.example/kelly-iphone"]);
		assert.match(t.pushed[0].payload.body, /passed/i);

		pr.headSha = "bbb";
		pr.checks = "failure";
		await t.webhook("check_suite", suite("bbb"));
		await t.app.idle();
		assert.equal(t.pushed.length, 2);
		assert.match(t.pushed[1].payload.body, /failed/i);
	} finally {
		await t.close();
	}
});

test("7.3 stale digest: once a day, authors and requested reviewers, after staleDays", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: LAB, number: 7, author: "hwan", requestedReviewers: ["kelly"], updatedAt: new Date(Date.now() - 4 * DAY).toISOString() });
		t.github.addPr({ repo: LAB, number: 8, author: "hwan", updatedAt: new Date(Date.now() - 2 * DAY).toISOString() });
		await t.app.sync();
		await t.app.runStaleDigest();
		await t.app.runStaleDigest(); // same day again: nothing new
		const by = (who: string) => t.pushed.filter((p) => p.endpoint.includes(who));
		assert.equal(by("hwan-iphone").length, 1);
		assert.equal(by("kelly-iphone").length, 1);
		assert.match(by("hwan-iphone")[0].payload.body, /labbot#7/);
		assert.doesNotMatch(by("hwan-iphone")[0].payload.body, /labbot#8/);
	} finally {
		await t.close();
	}
});

test("7.3 staleDays comes from config", async () => {
	const t = await setup({ staleDays: 5 });
	try {
		t.github.addPr({ repo: LAB, number: 7, author: "hwan", updatedAt: new Date(Date.now() - 4 * DAY).toISOString() });
		await t.app.sync();
		await t.app.runStaleDigest();
		assert.equal(t.pushed.length, 0);
	} finally {
		await t.close();
	}
});

test("7. a device the push service calls gone is removed; the list shows what is on", async () => {
	const t = await setup();
	try {
		const list = async () => (await (await t.req("/api/push/subscriptions", { as: "hyunhwanj" })).json()).map((s: { endpoint: string }) => s.endpoint).sort();
		assert.deepEqual(await list(), ["https://push.example/hwan-iphone", "https://push.example/hwan-mac"]);
		t.gone.add("https://push.example/hwan-mac");
		t.github.addPr({ repo: LAB, number: 9, author: "kelly", requestedReviewers: ["hwan"] });
		await t.webhook("pull_request", prEvent("review_requested", 9, { requested_reviewer: { login: "hwan" } }));
		await t.app.idle();
		assert.deepEqual(await list(), ["https://push.example/hwan-iphone"]);
	} finally {
		await t.close();
	}
});

test("7. people without GitHub linked or without devices get nothing, and nothing breaks", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: LAB, number: 10, author: "kelly", requestedReviewers: ["jorge"] });
		const r = await t.webhook("pull_request", prEvent("review_requested", 10, { requested_reviewer: { login: "jorge" } }));
		assert.equal(r.status, 200);
		await t.app.idle();
		assert.equal(t.pushed.length, 0);
	} finally {
		await t.close();
	}
});
