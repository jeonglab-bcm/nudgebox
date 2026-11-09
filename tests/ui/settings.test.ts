/**
 * SPEC 14. The settings page and the header bell, in a real browser. Push is faked in the
 * page (headless Chromium has no push service): `sub` is this device's subscription.
 * Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContextOptions, Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
after(closeBrowser);

/** A stand-in for the service worker and push manager. A string: tsx would wrap a function. */
const fakePush = (sub: string | null, permission = "default") => `
	sessionStorage.fakeSub ??= ${JSON.stringify(sub ?? "")};
	const wrap = (ep) => ep && { endpoint: ep, toJSON: () => ({ endpoint: ep, keys: { p256dh: "k", auth: "a" } }), unsubscribe: async () => { sessionStorage.fakeSub = ""; return true; } };
	const reg = { pushManager: {
		getSubscription: async () => wrap(sessionStorage.fakeSub),
		subscribe: async () => { sessionStorage.fakeSub = "https://web.push.apple.com/this-device"; return wrap(sessionStorage.fakeSub); },
	} };
	window.swListeners = [];
	Object.defineProperty(navigator, "serviceWorker", { value: { register: async () => reg, ready: Promise.resolve(reg), addEventListener: (type, fn) => type === "message" && window.swListeners.push(fn) } });
	window.pushCheckMs = 1500; // instead of 15 s
	window.PushManager ??= function () {};
	let perm = ${JSON.stringify(permission)};
	window.Notification = { get permission() { return perm; }, requestPermission: async () => (perm = "granted") };
`;

async function open(opts: { sub?: string | null; device?: BrowserContextOptions; init?: string; hash?: string } = {}) {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 1, author: "kelly", title: "Review me", requestedReviewers: ["hwan"] });
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(opts.device ?? DESKTOP);
	await ctx.addInitScript(opts.init ?? fakePush(opts.sub ?? null));
	const page = await ctx.newPage();
	await page.goto(side.url + (opts.hash ?? ""));
	await page.waitForSelector(opts.hash ? "#settings-page" : ".row");
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	return { t, page, close, url: side.url };
}

const text = async (page: Page, sel: string) => ((await page.locator(sel).textContent()) ?? "").replace(/\s+/g, " ");

test("14. the gear opens Settings; Back and Escape return to the list", async () => {
	const s = await open();
	try {
		await s.page.click("#settings-btn");
		await s.page.waitForSelector("#settings-page");
		assert.match(s.page.url(), /#settings$/);
		assert.equal(await s.page.locator(".row").count(), 0);
		await s.page.click("#back");
		await s.page.waitForSelector(".row");
		await s.page.click("#settings-btn");
		await s.page.keyboard.press("Escape");
		await s.page.waitForSelector(".row");
		assert.doesNotMatch(s.page.url(), /#settings/);
	} finally {
		await s.close();
	}
});

test("14. list keys do nothing on the settings page", async () => {
	const s = await open();
	try {
		await s.page.click("#settings-btn");
		await s.page.keyboard.press("a");
		await s.page.waitForTimeout(300);
		assert.equal(s.t.github.calls.filter((c) => c.op === "approve").length, 0);
	} finally {
		await s.close();
	}
});

test("14. the theme can be System, Dark or Light, is kept on this device, and changes the page", async () => {
	const s = await open({ device: { ...DESKTOP, colorScheme: "dark" } });
	try {
		const bg = () => s.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		const darkBg = await bg();
		await s.page.click("#settings-btn");
		await s.page.click('[data-theme-choice="light"]');
		assert.equal(await s.page.getAttribute("html", "data-theme"), "light");
		assert.notEqual(await bg(), darkBg);
		await s.page.reload(); // still on #settings
		await s.page.waitForSelector("#settings-page");
		assert.equal(await s.page.getAttribute("html", "data-theme"), "light"); // kept
		assert.equal(await s.page.getAttribute('[data-theme-choice="light"]', "aria-pressed"), "true");
		await s.page.click('[data-theme-choice="system"]');
		assert.equal(await s.page.getAttribute("html", "data-theme"), null);
		assert.equal(await bg(), darkBg); // the device is dark
	} finally {
		await s.close();
	}
});

test("14. the theme is set before the page draws (no flash)", async () => {
	const s = await open({ init: `localStorage.setItem("ghd-theme", "light");` + fakePush(null) });
	try {
		// the attribute is on <html> in the first paint: set by a script in <head>, not app.js
		const early = await s.page.evaluate(() => (document.querySelector("head script:not([src])")?.textContent ?? "").includes("ghd-theme"));
		assert.ok(early, "no theme script in <head>");
		assert.equal(await s.page.getAttribute("html", "data-theme"), "light");
	} finally {
		await s.close();
	}
});

test("14. bell off: crossed out with a dot; it opens the notifications part of Settings", async () => {
	const s = await open({ sub: null });
	try {
		assert.equal(await s.page.getAttribute("#bell", "aria-label"), "Notifications off");
		assert.equal(await s.page.getAttribute("#bell", "data-state"), "off");
		await s.page.click("#bell");
		await s.page.waitForSelector("#settings-page");
		assert.match(s.page.url(), /#settings$/);
		assert.match(await text(s.page, "#push-state"), /off on this device/i);
		assert.ok(await s.page.locator("#notifications >> text=Turn on notifications").isVisible());
	} finally {
		await s.close();
	}
});

test("14. Turn on subscribes this device and the bell turns on", async () => {
	const s = await open({ sub: null, hash: "#settings" });
	try {
		await s.page.click("text=Turn on notifications");
		await s.page.waitForSelector('#bell[data-state="on"]');
		assert.equal(await s.page.getAttribute("#bell", "aria-label"), "Notifications on");
		assert.match(await text(s.page, "#push-state"), /on for this device/i);
		const r = await s.t.req("/api/push/subscriptions", { as: "hyunhwanj" });
		assert.deepEqual((await r.json()).map((d: { endpoint: string }) => d.endpoint), ["https://web.push.apple.com/this-device"]);
	} finally {
		await s.close();
	}
});

test("14. Send a test sends to this device only", async () => {
	const s = await open({ sub: "https://web.push.apple.com/this-device" });
	try {
		await s.t.subscribe("hyunhwanj", "https://web.push.apple.com/this-device");
		await s.t.subscribe("hyunhwanj", "https://fcm.googleapis.com/other");
		await s.page.click("#bell");
		await s.page.click("text=Send a test");
		await s.page.waitForTimeout(400);
		assert.deepEqual(s.t.pushed.map((p) => p.endpoint), ["https://web.push.apple.com/this-device"]);
		assert.match(await text(s.page, "#push-check"), /sent/i);
	} finally {
		await s.close();
	}
});

test("14. Turn off asks first, then unsubscribes this device", async () => {
	const s = await open({ sub: "https://web.push.apple.com/this-device" });
	try {
		await s.t.subscribe("hyunhwanj", "https://web.push.apple.com/this-device");
		await s.page.click("#bell");
		s.page.once("dialog", (d) => d.dismiss());
		await s.page.click("#notifications >> text=Turn off");
		await s.page.waitForTimeout(300);
		assert.equal((await (await s.t.req("/api/push/subscriptions", { as: "hyunhwanj" })).json()).length, 1);
		s.page.once("dialog", (d) => d.accept());
		await s.page.click("#notifications >> text=Turn off");
		await s.page.waitForSelector('#bell[data-state="off"]');
		assert.equal((await (await s.t.req("/api/push/subscriptions", { as: "hyunhwanj" })).json()).length, 0);
	} finally {
		await s.close();
	}
});

test("14. your devices are listed by kind, this one marked, others removable", async () => {
	const s = await open({ sub: "https://web.push.apple.com/this-device" });
	try {
		await s.t.subscribe("hyunhwanj", "https://web.push.apple.com/this-device");
		await s.t.subscribe("hyunhwanj", "https://fcm.googleapis.com/fcm/send/other");
		await s.page.click("#settings-btn");
		await s.page.waitForSelector(".device >> nth=1");
		const rows = await s.page.locator(".device").allTextContents();
		assert.equal(rows.length, 2);
		assert.match(rows.find((r) => r.includes("This device"))!, /Apple/);
		assert.match(rows.find((r) => !r.includes("This device"))!, /Chrome/);
		await s.page.locator(".device", { hasText: "Chrome" }).locator("text=Remove").click();
		await s.page.waitForFunction(() => document.querySelectorAll(".device").length === 1);
		assert.deepEqual((await (await s.t.req("/api/push/subscriptions", { as: "hyunhwanj" })).json()).map((d: { endpoint: string }) => d.endpoint), ["https://web.push.apple.com/this-device"]);
	} finally {
		await s.close();
	}
});

test("14. on iPhone Safari (not the Home Screen app) it says how to get notifications", async () => {
	const s = await open({ device: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE_SAFARI }, init: "delete window.PushManager;" });
	try {
		assert.equal(await s.page.getAttribute("#bell", "data-state"), "unavailable");
		await s.page.tap("#bell");
		assert.match(await text(s.page, "#push-state"), /Add to Home Screen/);
	} finally {
		await s.close();
	}
});

test("14. blocked notifications say where to allow them", async () => {
	const s = await open({ init: fakePush(null, "denied") });
	try {
		await s.page.click("#bell");
		assert.match(await text(s.page, "#push-state"), /blocked/i);
		assert.equal(await s.page.locator("#notifications >> text=Turn on notifications").count(), 0);
		// #33.4: it names this site's own address, wherever Nudgebox runs
		const host = new URL(s.url).host;
		assert.ok((await text(s.page, "#push-state")).includes(host), `names ${host}`);
		assert.doesNotMatch(await text(s.page, "#push-state"), /bioinfolder/);
	} finally {
		await s.close();
	}
});

test("14. GitHub account: shows who you are; Disconnect asks first and is gone from the list", async () => {
	const s = await open();
	try {
		assert.equal(await s.page.locator("main >> text=Disconnect GitHub").count(), 0); // not under the list any more
		await s.page.click("#settings-btn");
		assert.match(await text(s.page, "#github"), /hwan/);
		assert.match(await text(s.page, "#github"), /hyunhwanj/);
		s.page.once("dialog", (d) => d.dismiss());
		await s.page.click("text=Disconnect GitHub");
		await s.page.waitForTimeout(300);
		assert.equal(s.t.github.calls.filter((c) => c.op === "revoke").length, 0);
		assert.equal((await s.t.req("/api/inbox", { as: "hyunhwanj" })).status, 200);
		s.page.once("dialog", (d) => d.accept());
		await s.page.click("text=Disconnect GitHub");
		await s.page.waitForSelector("text=Connect GitHub");
		assert.equal((await s.t.req("/api/inbox", { as: "hyunhwanj" })).status, 409);
	} finally {
		await s.close();
	}
});

test("14. Settings lists what notifies you", async () => {
	const s = await open({ hash: "#settings" });
	try {
		const t = await text(s.page, "#triggers");
		for (const w of [/review/i, /CI/, /9 AM/, /assigned/i, /mention/i]) assert.match(t, w);
	} finally {
		await s.close();
	}
});

/** As the service worker would: tell the page that the last test push arrived. */
const workerSays = (page: Page, msg: object) => page.evaluate((m) => (window as unknown as { swListeners: ((e: { data: object }) => void)[] }).swListeners.forEach((f) => f({ data: m })), msg);

test("14. Send a test: the browser got it and asked the system to show it", async () => {
	const s = await open({ sub: "https://fcm.googleapis.com/fcm/send/this-device" });
	try {
		await s.t.subscribe("hyunhwanj", "https://fcm.googleapis.com/fcm/send/this-device");
		await s.page.click("#bell");
		await s.page.click("text=Send a test");
		await s.page.waitForFunction(() => document.querySelector("#push-check")?.textContent?.includes("sent"));
		const id = (s.t.pushed.at(-1)!.payload as { test?: string }).test!;
		await workerSays(s.page, { type: "push-received", test: id, shown: true });
		await s.page.waitForFunction(() => /received/.test(document.querySelector("#push-check")?.textContent ?? ""));
		assert.match(await text(s.page, "#push-check"), /System Settings → Notifications/);
	} finally {
		await s.close();
	}
});

test("14. Send a test: the browser got it but could not show it", async () => {
	const s = await open({ sub: "https://fcm.googleapis.com/fcm/send/this-device" });
	try {
		await s.t.subscribe("hyunhwanj", "https://fcm.googleapis.com/fcm/send/this-device");
		await s.page.click("#bell");
		await s.page.click("text=Send a test");
		await s.page.waitForFunction(() => document.querySelector("#push-check")?.textContent?.includes("sent"));
		const id = (s.t.pushed.at(-1)!.payload as { test?: string }).test!;
		await workerSays(s.page, { type: "push-received", test: id, shown: false, error: "permission denied" });
		await s.page.waitForFunction(() => /could not show/.test(document.querySelector("#push-check")?.textContent ?? ""));
		assert.match(await text(s.page, "#push-check"), /permission denied/);
	} finally {
		await s.close();
	}
});

test("14. Send a test: the browser did not receive it in time", async () => {
	const s = await open({ sub: "https://fcm.googleapis.com/fcm/send/this-device" });
	try {
		await s.t.subscribe("hyunhwanj", "https://fcm.googleapis.com/fcm/send/this-device");
		await s.page.click("#bell");
		await s.page.click("text=Send a test");
		await s.page.waitForFunction(() => /did not receive/.test(document.querySelector("#push-check")?.textContent ?? ""), null, { timeout: 5000 });
	} finally {
		await s.close();
	}
});
