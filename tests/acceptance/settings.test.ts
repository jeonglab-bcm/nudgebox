/**
 * SPEC 14. Settings, server side: a test notification to one of your own devices, and
 * who you are. Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.grant("kelly", LAB);
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.subscribe("hyunhwanj", "https://web.push.apple.com/hwan-iphone");
	await t.subscribe("hyunhwanj", "https://fcm.googleapis.com/hwan-mac");
	await t.subscribe("kellyl", "https://web.push.apple.com/kelly-iphone");
	return t;
}

const sendTest = (t: Awaited<ReturnType<typeof setup>>, as: string, endpoint: string) =>
	t.req("/api/push/test", { as, method: "POST", body: JSON.stringify({ endpoint }) });

test("14. Send a test reaches that one device of yours and nothing else", async () => {
	const t = await setup();
	try {
		assert.equal((await sendTest(t, "hyunhwanj", "https://web.push.apple.com/hwan-iphone")).status, 200);
		assert.deepEqual(t.pushed.map((p) => p.endpoint), ["https://web.push.apple.com/hwan-iphone"]);
		assert.match(t.pushed[0].payload.title, /test/i);
	} finally {
		await t.close();
	}
});

test("14. Send a test refuses a device that is not yours", async () => {
	const t = await setup();
	try {
		assert.equal((await sendTest(t, "hyunhwanj", "https://web.push.apple.com/kelly-iphone")).status, 404);
		assert.equal((await sendTest(t, "hyunhwanj", "https://web.push.apple.com/unknown")).status, 404);
		assert.equal(t.pushed.length, 0);
	} finally {
		await t.close();
	}
});

test("14. a test notification does not count as unread", async () => {
	const t = await setup();
	try {
		await sendTest(t, "hyunhwanj", "https://web.push.apple.com/hwan-iphone");
		assert.equal(t.pushed[0].payload.badge, undefined);
		t.github.addPr({ repo: LAB, number: 1, author: "kelly", requestedReviewers: ["hwan"] });
		await t.webhook("pull_request", {
			action: "review_requested", number: 1, requested_reviewer: { login: "hwan" }, repository: { full_name: LAB },
			pull_request: { number: 1, title: "PR 1", html_url: `https://github.com/${LAB}/pull/1`, user: { login: "kelly" }, head: { sha: "sha-1" } },
		});
		await t.app.idle();
		assert.equal(t.pushed.at(-1)!.payload.badge, 1);
	} finally {
		await t.close();
	}
});

test("14. the inbox says which lab login and GitHub login you are", async () => {
	const t = await setup();
	try {
		const me = await (await t.req("/api/inbox", { as: "kellyl" })).json();
		assert.deepEqual({ user: me.user, login: me.login }, { user: "kellyl", login: "kelly" });
	} finally {
		await t.close();
	}
});
