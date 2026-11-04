/**
 * SPEC 7. Unread count on the app icon, high urgency for review requests, and a log line
 * per push. Lab users: hyunhwanj (GitHub "hwan", two devices), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, ORIGIN } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.grant("kelly", LAB);
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.subscribe("hyunhwanj", "https://push.example/hwan-iphone");
	await t.subscribe("hyunhwanj", "https://push.example/hwan-mac");
	await t.subscribe("kellyl", "https://push.example/kelly-iphone");
	return t;
}

/** Asks hwan to review PR n (one notification to hwan). */
async function askHwan(t: Awaited<ReturnType<typeof setup>>, n: number) {
	t.github.addPr({ repo: LAB, number: n, author: "kelly", requestedReviewers: ["hwan"] });
	await t.webhook("pull_request", {
		action: "review_requested", number: n, requested_reviewer: { login: "hwan" }, repository: { full_name: LAB },
		pull_request: { number: n, title: `PR ${n}`, html_url: `https://github.com/${LAB}/pull/${n}`, user: { login: "kelly" }, head: { sha: `sha-${n}` } },
	});
	await t.app.idle();
}

const badges = (t: Awaited<ReturnType<typeof setup>>, endpoint: string) => t.pushed.filter((p) => p.endpoint === endpoint).map((p) => p.payload.badge);

test("7. each notification carries your unread count, one more each time, the same on every device", async () => {
	const t = await setup();
	try {
		await askHwan(t, 1);
		await askHwan(t, 2);
		await askHwan(t, 3);
		assert.deepEqual(badges(t, "https://push.example/hwan-iphone"), [1, 2, 3]);
		assert.deepEqual(badges(t, "https://push.example/hwan-mac"), [1, 2, 3]);
	} finally {
		await t.close();
	}
});

test("7. opening Nudgebox resets your unread count, and only yours", async () => {
	const t = await setup();
	try {
		await askHwan(t, 1);
		await askHwan(t, 2);
		t.github.addPr({ repo: LAB, number: 9, author: "hwan", requestedReviewers: ["kelly"] });
		await t.webhook("pull_request", {
			action: "review_requested", number: 9, requested_reviewer: { login: "kelly" }, repository: { full_name: LAB },
			pull_request: { number: 9, title: "PR 9", html_url: `https://github.com/${LAB}/pull/9`, user: { login: "hwan" }, head: { sha: "sha-9" } },
		});
		await t.app.idle();
		assert.equal((await t.seen("hyunhwanj")).status, 200);
		await askHwan(t, 3);
		assert.deepEqual(badges(t, "https://push.example/hwan-iphone"), [1, 2, 1]);
		assert.deepEqual(badges(t, "https://push.example/kelly-iphone"), [1]); // kelly's count is untouched
	} finally {
		await t.close();
	}
});

test("7. resetting the count needs sign-in and the site's own origin", async () => {
	const t = await setup();
	try {
		assert.equal((await t.req("/api/push/seen", { method: "POST", body: "{}" })).status, 401);
		assert.equal((await t.req("/api/push/seen", { as: "hyunhwanj", method: "POST", body: "{}", headers: { origin: "https://evil.example" } })).status, 403);
		assert.ok(ORIGIN);
	} finally {
		await t.close();
	}
});

test("7. review requests are sent with high urgency", async () => {
	const t = await setup();
	try {
		await askHwan(t, 1);
		assert.ok(t.pushed.length > 0 && t.pushed.every((p) => p.urgency === "high"));
	} finally {
		await t.close();
	}
});

test("7. every push is logged with its push service and answer, never the device address", async () => {
	const t = await setup();
	try {
		t.gone.add("https://push.example/hwan-mac");
		await askHwan(t, 1);
		const lines = t.logs.filter((l) => l.startsWith("push "));
		assert.equal(lines.length, 2, lines.join("\n"));
		assert.ok(lines.some((l) => /push\.example.*\bsent\b/.test(l)));
		assert.ok(lines.some((l) => /push\.example.*\b410\b.*removed/.test(l)));
		assert.ok(lines.every((l) => !l.includes("hwan-iphone") && !l.includes("hwan-mac")), "a device address was logged");
	} finally {
		await t.close();
	}
});
