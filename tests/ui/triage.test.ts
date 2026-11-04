/**
 * SPEC 13. The triage list, in a real browser: one line per item, labelled symbols, one
 * selected row that opens in place, and keyboard actions that run as you.
 * Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
after(closeBrowser);

/** Inbox for hwan, newest first: Needs you = #3 (review asked, failing), #2 (review asked, 5 days), #1 (own, ready). */
async function open(device = DESKTOP) {
	const t = await start({ staleDays: 3 });
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 1, author: "hwan", title: "Own ready PR", checks: "success", updatedAt: ago(1.5) });
	t.github.addPr({ repo: LAB, number: 2, author: "kelly", title: "Old review", requestedReviewers: ["hwan"], reviewDecision: "REVIEW_REQUIRED", checks: "success", updatedAt: ago(5) });
	t.github.addPr({ repo: LAB, number: 3, author: "kelly", title: "Failing review", requestedReviewers: ["hwan"], reviewDecision: "REVIEW_REQUIRED", checks: "failure", updatedAt: ago(0.1) });
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Someone else's approved PR", reviewDecision: "APPROVED", checks: "success", updatedAt: ago(0.5) });
	t.github.addIssue({ repo: LAB, number: 9, author: "kelly", title: "An issue", labels: ["bug"], comments: 2 });
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(device);
	await ctx.route("https://github.com/**", (r) => r.fulfill({ body: "github" }));
	const page = await ctx.newPage();
	const requests: string[] = [];
	page.on("request", (r) => requests.push(r.url()));
	await page.goto(side.url);
	await page.waitForSelector(".row");
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	return { t, page, ctx, requests, close, base: side.url };
}

const rows = (page: Page) => page.locator("main .list").first().locator(".row");
const selectedKey = (page: Page) => page.locator(".row[aria-selected=true]").getAttribute("data-key");
const calls = (t: Awaited<ReturnType<typeof open>>["t"], op: string) => t.github.calls.filter((c) => c.op === op);
const settle = (page: Page) => page.waitForTimeout(300);

test("13. one line per item on a computer", async () => {
	const s = await open();
	try {
		const heights = await rows(s.page).locator(".line").evaluateAll((ls) => ls.map((l) => l.getBoundingClientRect().height));
		assert.equal(heights.length, 3);
		assert.ok(heights.every((h) => h <= 44), `rows are ${heights} px tall`);
	} finally {
		await s.close();
	}
});

test("13. two lines per item on a phone, and no sideways scroll", async () => {
	const s = await open(PHONE);
	try {
		const heights = await rows(s.page).locator(".line").evaluateAll((ls) => ls.map((l) => l.getBoundingClientRect().height));
		assert.ok(heights.every((h) => h <= 72), `rows are ${heights} px tall`);
		await rows(s.page).nth(0).tap();
		assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page scrolls sideways");
	} finally {
		await s.close();
	}
});

test("13. checks and review are symbols with labels", async () => {
	const s = await open();
	try {
		const failing = s.page.locator('.row[data-key="pr:jeonglab-bcm/labbot#3"]');
		assert.equal(await failing.locator(".ci").getAttribute("aria-label"), "checks failed");
		assert.equal(await failing.locator(".ci").textContent(), "✗");
		assert.equal(await failing.locator(".rv").getAttribute("aria-label"), "review required");
	} finally {
		await s.close();
	}
});

test("13. an item idle for staleDays shows a stale age", async () => {
	const s = await open();
	try {
		assert.match((await s.page.locator('.row[data-key="pr:jeonglab-bcm/labbot#2"]').getAttribute("class"))!, /\bstale\b/);
		assert.doesNotMatch((await s.page.locator('.row[data-key="pr:jeonglab-bcm/labbot#1"]').getAttribute("class"))!, /\bstale\b/);
	} finally {
		await s.close();
	}
});

test("13. no buttons until a row is opened; a click opens and closes it", async () => {
	const s = await open();
	try {
		assert.equal(await s.page.locator("main .list button").count(), 0);
		await rows(s.page).nth(2).click();
		assert.equal(await selectedKey(s.page), "pr:jeonglab-bcm/labbot#2");
		assert.ok(await s.page.locator(".row.open .actions >> text=Approve").isVisible());
		await rows(s.page).nth(2).locator(".ref").click();
		assert.equal(await s.page.locator("main .list button").count(), 0);
	} finally {
		await s.close();
	}
});

test("13. j and k move the selection; x opens the row", async () => {
	const s = await open();
	try {
		assert.equal(await selectedKey(s.page), "pr:jeonglab-bcm/labbot#3"); // first row to start
		await s.page.keyboard.press("j");
		assert.equal(await selectedKey(s.page), "pr:jeonglab-bcm/labbot#1");
		await s.page.keyboard.press("ArrowDown");
		await s.page.keyboard.press("j"); // stays on the last row
		assert.equal(await selectedKey(s.page), "pr:jeonglab-bcm/labbot#2");
		await s.page.keyboard.press("k");
		assert.equal(await selectedKey(s.page), "pr:jeonglab-bcm/labbot#1");
		await s.page.keyboard.press("x");
		assert.equal(await s.page.locator(".row.open").getAttribute("data-key"), "pr:jeonglab-bcm/labbot#1");
		await s.page.keyboard.press("Escape");
		assert.equal(await s.page.locator(".row.open").count(), 0);
	} finally {
		await s.close();
	}
});

test("13. a approves the selected PR as you", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("j");
		await s.page.keyboard.press("j"); // #2
		await s.page.keyboard.press("a");
		await settle(s.page);
		const [c] = calls(s.t, "approve");
		assert.deepEqual({ repo: c.repo, number: c.number }, { repo: LAB, number: 2 });
		assert.ok(c.token!.endsWith(":hwan"));
	} finally {
		await s.close();
	}
});

test("13. a on your own PR does nothing and says why", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("j"); // #1, own
		await s.page.keyboard.press("a");
		await settle(s.page);
		assert.equal(calls(s.t, "approve").length, 0);
		assert.match((await s.page.locator("#toast").textContent())!, /own PR/);
	} finally {
		await s.close();
	}
});

test("13. r with no failed checks does nothing and says why", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("j"); // #1, checks passed
		await s.page.keyboard.press("r");
		await settle(s.page);
		assert.equal(calls(s.t, "rerunFailedChecks").length, 0);
		assert.match((await s.page.locator("#toast").textContent())!, /No failed checks/);
		await s.page.keyboard.press("k"); // #3, failing
		await s.page.keyboard.press("r");
		await settle(s.page);
		assert.equal(calls(s.t, "rerunFailedChecks").length, 1);
	} finally {
		await s.close();
	}
});

test("13. m asks first and merges only when confirmed", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("j"); // #1
		s.page.once("dialog", (d) => d.dismiss());
		await s.page.keyboard.press("m");
		await settle(s.page);
		assert.equal(calls(s.t, "merge").length, 0);
		s.page.once("dialog", (d) => d.accept());
		await s.page.keyboard.press("m");
		await settle(s.page);
		const [m] = calls(s.t, "merge");
		assert.deepEqual({ repo: m.repo, number: m.number }, { repo: LAB, number: 1 });
	} finally {
		await s.close();
	}
});

test("13. h hides the selected PR; it moves to Hidden", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("h"); // #3
		await s.page.waitForSelector('.fold >> text=Hidden');
		assert.deepEqual(await rows(s.page).evaluateAll((rs) => rs.map((r) => r.getAttribute("data-key"))), ["pr:jeonglab-bcm/labbot#1", "pr:jeonglab-bcm/labbot#2"]);
		assert.equal(await selectedKey(s.page), "pr:jeonglab-bcm/labbot#1"); // the next row takes its place
	} finally {
		await s.close();
	}
});

test("13. keys do nothing while typing in a field or with Ctrl held", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("j");
		await s.page.keyboard.press("j"); // #2
		await s.page.keyboard.press("Control+a");
		await s.page.focus("#repo");
		await s.page.keyboard.press("a");
		await s.page.keyboard.press("j");
		await settle(s.page);
		assert.equal(calls(s.t, "approve").length, 0);
		assert.equal(await selectedKey(s.page), "pr:jeonglab-bcm/labbot#2");
	} finally {
		await s.close();
	}
});

test("13. Enter opens the selected PR on GitHub", async () => {
	const s = await open();
	try {
		const [popup] = await Promise.all([s.ctx.waitForEvent("page"), s.page.keyboard.press("Enter")]);
		assert.equal(popup.url(), `https://github.com/${LAB}/pull/3`);
	} finally {
		await s.close();
	}
});

test("13. number keys switch tabs, i and p switch lists, ? lists the keys", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("4");
		assert.equal(await rows(s.page).count(), 4);
		assert.equal(await s.page.locator(".tabs button.on").textContent(), "All4");
		assert.equal(await s.page.locator(".row.tone-you").count(), 3); // the needs-you rows are marked on All
		await s.page.keyboard.press("i");
		assert.deepEqual(await rows(s.page).evaluateAll((rs) => rs.map((r) => r.getAttribute("data-key"))), ["issue:jeonglab-bcm/labbot#9"]);
		await s.page.keyboard.press("p");
		assert.equal(await rows(s.page).count(), 4);
		await s.page.keyboard.press("?");
		assert.ok(await s.page.locator("#help").isVisible());
		await s.page.keyboard.press("Escape");
		assert.ok(!(await s.page.locator("#help").isVisible()));
	} finally {
		await s.close();
	}
});

test("13. key hints on a computer, none on a phone", async () => {
	const desk = await open();
	try {
		assert.ok(await desk.page.locator("footer.keys").isVisible());
	} finally {
		await desk.close();
	}
	const phone = await open(PHONE);
	try {
		assert.ok(!(await phone.page.locator("footer.keys").isVisible()));
		await rows(phone.page).nth(0).tap();
		assert.ok(!(await phone.page.locator(".row.open .actions kbd").first().isVisible()));
	} finally {
		await phone.close();
	}
});

test("13. everything, fonts included, comes from Nudgebox itself", async () => {
	const s = await open();
	try {
		await s.page.evaluate(() => document.fonts.ready);
		const own = new URL(s.base).host;
		const others = s.requests.filter((u) => new URL(u).host !== own);
		assert.deepEqual(others, []);
		assert.ok(await s.page.evaluate(() => document.fonts.check('16px "Outfit"')), "Outfit did not load");
	} finally {
		await s.close();
	}
});

test("12. a summary shows as three labelled rows; an older bullet one as a list", async () => {
	const s = await open();
	try {
		s.t.llm.reply = "What: Fixes the `liftover` off-by-one.\nStatus: Checks pass; waiting for review.\nNext: @hwan to review.";
		await s.page.keyboard.press("s");
		await s.page.waitForSelector(".summary dt");
		assert.deepEqual(await s.page.locator(".summary dt").allTextContents(), ["What", "Status", "Next"]);
		assert.equal(await s.page.locator(".summary dd code").textContent(), "liftover");
		assert.match((await s.page.locator(".summary dd").nth(2).textContent())!, /@hwan to review/);
		const size = await s.page.locator(".summary dd").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
		assert.ok(size >= 14.5, `summary text is ${size}px`);
		s.t.llm.reply = "- an older bullet\n- another";
		await s.page.keyboard.press("j");
		await s.page.keyboard.press("s");
		await s.page.waitForSelector(".summary li");
		assert.deepEqual(await s.page.locator(".summary li").allTextContents(), ["an older bullet", "another"]);
	} finally {
		await s.close();
	}
});
