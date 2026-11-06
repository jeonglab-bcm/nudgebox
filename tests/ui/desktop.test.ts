/**
 * SPEC 18. The page inside the Nudgebox desktop app (Tauri). The app's bridge is faked:
 * `window.__TAURI__.core.invoke` records each call in `window.tauriCalls`; `notify`
 * fails when `window.notifyFails` is set. Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
after(closeBrowser);

// A string: tsx would wrap a function.
const fakeTauri = `
	window.tauriCalls = [];
	window.__TAURI__ = { core: { invoke: async (cmd, args) => {
		window.tauriCalls.push([cmd, args ?? null]);
		if (cmd === "notify" && window.notifyFails) throw "notifications are not allowed for Nudgebox";
		return null;
	} } };
	window.pushCheckMs = 1500;
`;

async function open(hash = "") {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 1, author: "kelly", title: "Review me", requestedReviewers: ["hwan"] });
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(DESKTOP);
	await ctx.addInitScript(fakeTauri);
	const page = await ctx.newPage();
	await page.goto(side.url + hash);
	await page.waitForSelector(hash ? "#settings-page" : ".row");
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	return { t, page, close };
}

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).tauriCalls.filter(([n]: [string]) => n === c).map(([, a]: [string, unknown]) => a), cmd);
const text = async (page: Page, sel: string) => ((await page.locator(sel).textContent()) ?? "").replace(/\s+/g, " ");

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await f();
		if (ok(v) || Date.now() > end) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("18. in the app, Settings says notifications are on in the app, with no browser push buttons", async () => {
	const s = await open("#settings");
	try {
		const state = await until(() => text(s.page, "#push-state"), (v) => /app/i.test(v));
		assert.match(state, /on/i);
		assert.match(state, /desktop app/i);
		assert.equal(await s.page.locator("text=Turn on notifications").count(), 0);
		assert.equal(await s.page.locator("text=Turn off").count(), 0);
		assert.equal(await s.page.locator("text=Send a test").count(), 1);
		assert.equal(await s.page.locator("#bell").getAttribute("data-state"), "on");
	} finally {
		await s.close();
	}
});

test("18. a notification shows natively and sets the Dock badge; opening Nudgebox clears it", async () => {
	const s = await open();
	try {
		const cleared = await until(() => calls(s.page, "set_badge"), (v) => v.some((a: any) => a.count === 0));
		assert.ok(cleared.some((a: any) => a.count === 0), "opening clears the badge");
		await until(() => s.page.evaluate(() => (window as any).nudgeboxStream?.readyState), (v) => v === 1);
		s.t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "PR 4", requestedReviewers: ["hwan"] });
		await s.t.webhook("pull_request", {
			action: "review_requested", number: 4, requested_reviewer: { login: "hwan" }, repository: { full_name: LAB },
			pull_request: { number: 4, title: "PR 4", html_url: `https://github.com/${LAB}/pull/4`, user: { login: "kelly" }, head: { sha: "s4" } },
		});
		const shown = await until(() => calls(s.page, "notify"), (v) => v.length > 0);
		assert.equal(shown.length, 1);
		assert.match(shown[0].title, /review/i);
		assert.match(shown[0].body, /labbot#4/);
		assert.equal(shown[0].url, `https://github.com/${LAB}/pull/4`);
		const badges = await until(() => calls(s.page, "set_badge"), (v) => v.some((a: any) => a.count === 1));
		assert.ok(badges.some((a: any) => a.count === 1));
	} finally {
		await s.close();
	}
});

test("14 + 18. Send a test in the app: shown by the system", async () => {
	const s = await open("#settings");
	try {
		await until(() => s.page.evaluate(() => (window as any).nudgeboxStream?.readyState), (v) => v === 1);
		await s.page.click("text=Send a test");
		const said = await until(() => text(s.page, "#push-check"), (v) => /received/i.test(v));
		assert.match(said, /app received the test/i);
		const shown = await calls(s.page, "notify");
		assert.equal(shown.length, 1);
		assert.match(shown[0].title, /test/i);
	} finally {
		await s.close();
	}
});

test("14 + 18. Send a test in the app: the system refused to show it, and why", async () => {
	const s = await open("#settings");
	try {
		await until(() => s.page.evaluate(() => (window as any).nudgeboxStream?.readyState), (v) => v === 1);
		await s.page.evaluate(() => ((window as any).notifyFails = true));
		await s.page.click("text=Send a test");
		const said = await until(() => text(s.page, "#push-check"), (v) => /could not show/i.test(v));
		assert.match(said, /could not show/i);
		assert.match(said, /not allowed for Nudgebox/);
	} finally {
		await s.close();
	}
});
