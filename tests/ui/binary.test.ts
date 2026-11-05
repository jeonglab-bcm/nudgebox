/**
 * SPEC 15. Binary files in a real browser, diffed by the real omnidiff (bin/omnidiff) from
 * the fixtures in tests/fixtures/binary: pictures, an archive, a PDF.
 * Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BrowserContextOptions } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";
import { createOmnidiff } from "../../src/omnidiff.ts";

const LAB = "jeonglab-bcm/labbot";
const fx = (n: string) => readFileSync(`tests/fixtures/binary/${n}`);
after(closeBrowser);

async function open(device: BrowserContextOptions = DESKTOP) {
	const t = await start({ diff: createOmnidiff("bin/omnidiff") });
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", requestedReviewers: ["hwan"] });
	t.github.prFileSets.set(`${LAB}#4`, { base: "b", head: "h", files: [
		{ path: "figs/fig1.png", status: "modified", additions: 0, deletions: 0 },
		{ path: "data/bundle.zip", status: "modified", additions: 0, deletions: 0 },
		{ path: "paper/draft.pdf", status: "modified", additions: 0, deletions: 0 },
		{ path: "figs/new.png", status: "added", additions: 0, deletions: 0 },
	] });
	for (const [path, name] of [["figs/fig1.png", "png"], ["data/bundle.zip", "zip"], ["paper/draft.pdf", "pdf"]]) {
		t.github.blobs.set(`${LAB}@b:${path}`, fx(`before.${name}`));
		t.github.blobs.set(`${LAB}@h:${path}`, fx(`after.${name}`));
	}
	t.github.blobs.set(`${LAB}@h:figs/new.png`, fx("after.png"));
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(device);
	const page = await ctx.newPage();
	await page.goto(`${side.url}#files/${LAB}/4`);
	await page.waitForSelector(".file");
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	const openFile = async (path: string) => page.locator(".file", { hasText: path }).click();
	return { t, page, close, openFile };
}

test("15. two pictures side by side with the changed areas outlined on both", async () => {
	const s = await open();
	try {
		await s.openFile("figs/fig1.png");
		await s.page.waitForSelector(".pic-pane.after img");
		await s.page.waitForFunction(() => [...document.querySelectorAll(".pic-pane img")].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));
		assert.equal(await s.page.locator(".pic-pane.before .area").count(), 2);
		assert.equal(await s.page.locator(".pic-pane.after .area").count(), 2);
		const info = (await s.page.locator(".pic-info").textContent())!;
		assert.match(info, /PNG 400×300/);
		assert.match(info, /12\.5% of pixels changed in 2 areas/);
		assert.match((await s.page.locator(".pic-pane.after img").getAttribute("src"))!, /\/api\/file\?repo=jeonglab-bcm%2Flabbot&ref=h&path=figs%2Ffig1\.png/);
	} finally {
		await s.close();
	}
});

test("15. Difference lights up the changed pixels; Slider wipes from before to after", async () => {
	const s = await open();
	try {
		await s.openFile("figs/fig1.png");
		await s.page.waitForSelector(".pic-pane.after img");
		await s.page.click(".pic-modes >> text=Difference");
		await s.page.waitForSelector("canvas.pic-diff");
		const lit = await s.page.locator("canvas.pic-diff").evaluate((c: HTMLCanvasElement) => {
			const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
			let n = 0;
			for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 120) n++; // the accent: red, little green
			return { n, w: c.width };
		});
		assert.equal(lit.w, 400);
		assert.ok(lit.n > 14_000 && lit.n < 16_000, `${lit.n} lit pixels`); // omnidiff counts 14,946 changed
		await s.page.click(".pic-modes >> text=Slider");
		await s.page.waitForSelector(".pic-slider input[type=range]");
		await s.page.locator(".pic-slider input[type=range]").fill("25");
		assert.match((await s.page.locator(".pic-slider .top").getAttribute("style"))!, /25%/);
	} finally {
		await s.close();
	}
});

test("15. an added picture shows alone", async () => {
	const s = await open();
	try {
		await s.openFile("figs/new.png");
		await s.page.waitForSelector(".pic-pane.after img");
		assert.equal(await s.page.locator(".pic-pane.before").count(), 0);
		assert.match((await s.page.locator(".pic-info").textContent())!, /added/i);
	} finally {
		await s.close();
	}
});

test("15. an archive lists the files inside that changed, with how", async () => {
	const s = await open();
	try {
		await s.openFile("data/bundle.zip");
		await s.page.waitForSelector(".members .member");
		const rows = (await s.page.locator(".members .member").allTextContents()).map((r) => r.replace(/\s+/g, " ").trim());
		assert.ok(rows.some((r) => /README\.txt.*changed.*−1 \+1 lines/.test(r)), rows.join(" | "));
		assert.ok(rows.some((r) => /data\/new\.csv.*added/.test(r)), rows.join(" | "));
		assert.ok(rows.some((r) => /fig\.png.*12\.5% of pixels.*2 areas/.test(r)), rows.join(" | "));
		assert.match((await s.page.locator(".members-head").textContent())!, /ZIP.*3 → 4 files.*1 unchanged/);
	} finally {
		await s.close();
	}
});

test("15. a PDF lists its changed pages and draws them before and after, changed areas outlined", async () => {
	const s = await open();
	try {
		await s.openFile("paper/draft.pdf");
		await s.page.waitForSelector(".members .member");
		assert.ok((await s.page.locator(".members .member").allTextContents()).some((r) => /page 1/.test(r)));
		await s.page.waitForSelector(".pdf-page .pic-pane.after canvas", { timeout: 15_000 });
		await s.page.waitForFunction(() => document.querySelectorAll(".pdf-page canvas[data-drawn]").length === 2, null, { timeout: 15_000 });
		const drawn = await s.page.locator(".pdf-page .pic-pane.after canvas").evaluate((c: HTMLCanvasElement) => {
			const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
			let ink = 0;
			for (let i = 0; i < d.length; i += 16) if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink++;
			return { w: c.width, ink };
		});
		assert.ok(drawn.w > 100 && drawn.ink > 500, JSON.stringify(drawn)); // a real page, not blank
		assert.ok(await s.page.locator(".pdf-page .pic-pane.after .area").count() >= 2);
		assert.match((await s.page.locator(".pdf-page h5").first().textContent())!, /page 1/i);
	} finally {
		await s.close();
	}
});

test("15. pictures fit a phone: one above the other, no sideways scroll", async () => {
	const s = await open(PHONE);
	try {
		await s.openFile("figs/fig1.png");
		await s.page.waitForSelector(".pic-pane.after img");
		const [b, a] = await Promise.all([".pic-pane.before", ".pic-pane.after"].map((p) => s.page.locator(p).boundingBox()));
		assert.ok(a!.y > b!.y + 20, "after is below before");
		assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page scrolls sideways");
	} finally {
		await s.close();
	}
});
