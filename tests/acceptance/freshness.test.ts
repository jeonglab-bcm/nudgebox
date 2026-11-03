/**
 * SPEC 8-9. Webhooks keep the inbox current (signature required); the periodic sync
 * catches missed events. The web app (PWA) shell is served for the phone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, ids } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB);
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	return t;
}

const opened = (n: number, action = "opened") => ({
	action,
	number: n,
	pull_request: { number: n, title: `PR ${n}`, html_url: `https://github.com/${LAB}/pull/${n}`, user: { login: "kelly" }, head: { sha: `s${n}` } },
	repository: { full_name: LAB },
});
const all = (x: Parameters<typeof ids>[0]) => Object.values(ids(x)).flat();

test("8. a webhook with a bad signature is rejected and changes nothing", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: LAB, number: 1, author: "kelly" });
		const r = await t.webhook("pull_request", opened(1), "wrong-secret");
		assert.equal(r.status, 401);
		await t.app.idle();
		assert.deepEqual(all(await t.inbox("hyunhwanj")), []);
	} finally {
		await t.close();
	}
});

test("8. opened / closed webhooks update the inbox without waiting for a sync", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: LAB, number: 2, author: "kelly" });
		assert.equal((await t.webhook("pull_request", opened(2))).status, 200);
		await t.app.idle();
		assert.deepEqual(all(await t.inbox("hyunhwanj")), [`${LAB}#2`]);

		t.github.prs.delete(`${LAB}#2`);
		await t.webhook("pull_request", opened(2, "closed"));
		await t.app.idle();
		assert.deepEqual(all(await t.inbox("hyunhwanj")), []);
	} finally {
		await t.close();
	}
});

test("8. webhooks from accounts outside config are ignored (the App is public)", async () => {
	const t = await setup();
	try {
		t.github.grant("hwan", "stranger/repo");
		t.github.addPr({ repo: "stranger/repo", number: 1, author: "x", requestedReviewers: ["hwan"] });
		await t.subscribe("hyunhwanj", "https://push.example/hwan");
		const payload = { action: "review_requested", requested_reviewer: { login: "hwan" }, pull_request: { number: 1 }, repository: { full_name: "stranger/repo" } };
		assert.equal((await t.webhook("pull_request", payload)).status, 200);
		await t.app.idle();
		assert.deepEqual(all(await t.inbox("hyunhwanj")), []);
		assert.equal(t.pushed.length, 0);
	} finally {
		await t.close();
	}
});

test("8. the periodic sync catches a missed webhook", async () => {
	const t = await setup();
	try {
		t.github.addPr({ repo: LAB, number: 3, author: "kelly" });
		await t.app.sync();
		assert.deepEqual(all(await t.inbox("hyunhwanj")), [`${LAB}#3`]);
		t.github.prs.delete(`${LAB}#3`); // merged on github.com, webhook lost
		await t.app.sync();
		assert.deepEqual(all(await t.inbox("hyunhwanj")), []);
	} finally {
		await t.close();
	}
});

test("9. the installable web app: page, manifest, service worker with push", async () => {
	const t = await setup();
	try {
		const page = await t.req("/", { as: "hyunhwanj" });
		assert.equal(page.status, 200);
		const html = await page.text();
		assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest"/);
		// the script URL changes with its content, so no cache can serve an old one
		const src = html.match(/src="(\/app\.js\?v=[0-9a-f]{12})"/)?.[1];
		assert.ok(src, "page must load /app.js?v=<content hash>");
		assert.equal((await t.req(src!, { as: "hyunhwanj" })).status, 200);
		const inboxVersion = (await (await t.req("/api/inbox", { as: "hyunhwanj" })).json()).version;
		assert.equal(`/app.js?v=${inboxVersion}`, src, "the inbox reports the same version the page loads");
		const m = await (await t.req("/manifest.webmanifest", { as: "hyunhwanj" })).json();
		assert.equal(m.display, "standalone");
		assert.ok(m.name && m.icons?.length);
		const sw = await t.req("/sw.js", { as: "hyunhwanj" });
		assert.equal(sw.status, 200);
		assert.match(await sw.text(), /addEventListener\(\s*["']push["']/);
		const key = await (await t.req("/api/push/key", { as: "hyunhwanj" })).json();
		assert.ok(typeof key.publicKey === "string" && key.publicKey.length > 20);
	} finally {
		await t.close();
	}
});
