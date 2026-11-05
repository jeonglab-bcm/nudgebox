/**
 * SPEC 15. Compare any two files: picked in Files views (one PR or two), compared through
 * the harness's stand-in for omnidiff. Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
const OTHER = "jeonglab-bcm/AURORA";
after(closeBrowser);

async function open() {
	const t = await start();
	t.github.grant("hwan", LAB, OTHER);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", requestedReviewers: ["hwan"] });
	t.github.addPr({ repo: OTHER, number: 9, author: "kelly", requestedReviewers: ["hwan"] });
	t.github.prFileSets.set(`${LAB}#4`, { base: "b4", head: "h4", files: [
		{ path: "src/rank.py", status: "modified", additions: 3, deletions: 1 },
		{ path: "src/old.py", status: "removed", additions: 0, deletions: 9 },
	] });
	t.github.prFileSets.set(`${OTHER}#9`, { base: "b9", head: "h9", files: [{ path: "lib/score.py", status: "added", additions: 5, deletions: 0 }] });
	t.github.blobs.set(`${LAB}@h4:src/rank.py`, "def rank():\n    return 1\n");
	t.github.blobs.set(`${LAB}@b4:src/old.py`, "def old():\n    return 0\n");
	t.github.blobs.set(`${OTHER}@h9:lib/score.py`, "def rank():\n    return 2\n");
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(DESKTOP);
	const page = await ctx.newPage();
	await page.goto(side.url);
	await page.waitForSelector(".row");
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	return { t, page, close };
}

const files = async (page: Page, repo: string, n: number) => {
	await page.evaluate((h) => (location.hash = h), `#files/${repo}/${n}`);
	await page.waitForSelector(".file");
};
const pick = (page: Page, path: string) => page.locator(".file", { hasText: path }).locator("button.pick").click();
const tray = async (page: Page) => (await page.locator("#tray .picked").allTextContents()).map((s) => s.replace("×", "").trim());

test("15. pick two files from two PRs and compare them", async () => {
	const s = await open();
	try {
		await files(s.page, LAB, 4);
		await pick(s.page, "src/rank.py");
		assert.equal(await s.page.locator(".file", { hasText: "src/rank.py" }).locator("button.pick").getAttribute("aria-pressed"), "true");
		await s.page.click("#back"); // the picks stay while moving around
		await s.page.waitForSelector(".row");
		assert.deepEqual(await tray(s.page), ["labbot#4 src/rank.py"]);
		await files(s.page, OTHER, 9);
		await pick(s.page, "lib/score.py");
		assert.deepEqual(await tray(s.page), ["labbot#4 src/rank.py", "AURORA#9 lib/score.py"]);
		await s.page.click("#tray button.compare");
		await s.page.waitForSelector(".pane.after");
		assert.match(s.page.url(), /#compare$/);
		assert.deepEqual(s.t.differ.calls.at(-1), [{ path: "src/rank.py", text: "def rank():\n    return 1\n" }, { path: "lib/score.py", text: "def rank():\n    return 2\n" }]);
		assert.match((await s.page.locator("#compare-page h2").textContent())!, /Compare/);
	} finally {
		await s.close();
	}
});

test("15. a removed file is picked at its last version; Compare needs two", async () => {
	const s = await open();
	try {
		await files(s.page, LAB, 4);
		await pick(s.page, "src/old.py");
		assert.equal(await s.page.locator("#tray button.compare").isDisabled(), true);
		await pick(s.page, "src/rank.py");
		await s.page.click("#tray button.compare");
		await s.page.waitForSelector(".pane.after");
		assert.deepEqual(s.t.differ.calls.at(-1)!.map((x) => x?.text), ["def old():\n    return 0\n", "def rank():\n    return 1\n"]);
	} finally {
		await s.close();
	}
});

test("15. a third pick replaces the oldest, and × drops one", async () => {
	const s = await open();
	try {
		await files(s.page, LAB, 4);
		await pick(s.page, "src/rank.py");
		await pick(s.page, "src/old.py");
		await files(s.page, OTHER, 9);
		await pick(s.page, "lib/score.py");
		assert.deepEqual(await tray(s.page), ["labbot#4 src/old.py", "AURORA#9 lib/score.py"]);
		await s.page.locator("#tray .picked", { hasText: "src/old.py" }).locator("button").click();
		assert.deepEqual(await tray(s.page), ["AURORA#9 lib/score.py"]);
	} finally {
		await s.close();
	}
});

test("15. Swap compares the other way round", async () => {
	const s = await open();
	try {
		await files(s.page, LAB, 4);
		await pick(s.page, "src/rank.py");
		await files(s.page, OTHER, 9);
		await pick(s.page, "lib/score.py");
		await s.page.click("#tray button.compare");
		await s.page.waitForSelector(".pane.after");
		await s.page.click("#compare-page >> text=Swap");
		await s.page.waitForFunction(() => document.querySelector(".pane.before h4")?.textContent?.includes("score.py"));
		assert.deepEqual(s.t.differ.calls.at(-1)!.map((x) => x?.path), ["lib/score.py", "src/rank.py"]);
	} finally {
		await s.close();
	}
});
