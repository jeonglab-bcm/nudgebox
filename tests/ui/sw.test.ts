/**
 * SPEC 7. The service worker puts the unread count on the app icon; opening the page
 * clears it and tells the server. sw.js runs here with a stand-in for the worker scope.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser } from "../helpers/browser.ts";

after(closeBrowser);

function worker() {
	const listeners: Record<string, (e: unknown) => void> = {};
	const shown: { title: string }[] = [];
	const badge: (number | null)[] = [];
	const self = {
		addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
		registration: { showNotification: async (title: string) => void shown.push({ title }) },
		navigator: { setAppBadge: async (n: number) => void badge.push(n), clearAppBadge: async () => void badge.push(null) },
		clients: { openWindow: async () => null },
	};
	runInNewContext(readFileSync("public/sw.js", "utf8"), { self });
	const push = async (payload: object) => {
		const waits: Promise<unknown>[] = [];
		listeners.push({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
		await Promise.all(waits);
	};
	return { push, shown, badge, self };
}

test("7. a notification sets the icon's count from the push", async () => {
	const w = worker();
	await w.push({ title: "Review requested", body: "labbot#4", badge: 3 });
	assert.deepEqual(w.shown.map((s) => s.title), ["Review requested"]);
	assert.deepEqual(w.badge, [3]);
});

test("7. a notification without a count, or a browser without badges, still shows", async () => {
	const w = worker();
	await w.push({ title: "Old server push", body: "" });
	assert.deepEqual(w.badge, []);
	const bare = worker();
	(bare.self.navigator as { setAppBadge?: unknown }).setAppBadge = undefined;
	await bare.push({ title: "No badge API", body: "", badge: 2 });
	assert.deepEqual(bare.shown.map((s) => s.title), ["No badge API"]);
});

test("7. opening the page clears the icon and resets the count on the server", async () => {
	const t = await start();
	t.github.grant("hwan", "jeonglab-bcm/labbot");
	t.github.addPr({ repo: "jeonglab-bcm/labbot", number: 1, author: "kelly", requestedReviewers: ["hwan"] });
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext();
	// a string, not a function: tsx would wrap a function in helpers the page does not have
	await ctx.addInitScript(`window.cleared = 0; Object.defineProperty(navigator, "clearAppBadge", { value: async () => { window.cleared++; } });`);
	const page = await ctx.newPage();
	try {
		const seen = page.waitForRequest((r) => r.url().endsWith("/api/push/seen") && r.method() === "POST");
		await page.goto(side.url);
		await seen;
		await page.waitForSelector(".row");
		assert.ok((await page.evaluate(() => (window as unknown as { cleared: number }).cleared)) >= 1);
	} finally {
		await ctx.close();
		side.server.close();
		await t.close();
	}
});
