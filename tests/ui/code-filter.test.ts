/**
 * SPEC 15 and 19. The switch that leaves only code and docs on Files changed and in the
 * list of guided review steps. The lab LLM is faked. Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";
import type { Prompt } from "../../src/llm.ts";

const LAB = "jeonglab-bcm/labbot";
after(closeBrowser);

const FILES = ["pipeline/fit.py", "README.md", "params/run.json", "params/grid.json", "config.yml", "results/table.tsv"];
const plan = { summary: "Fits the model.", steps: [
	{ title: "Fit the model", summary: "The fit is new.", files: ["pipeline/fit.py", "README.md"] },
	{ title: "Parameters", summary: "The settings of the run.", files: ["params/run.json", "params/grid.json", "config.yml"] },
] };
const model = (p: Prompt) => (p.system.startsWith("You plan") ? JSON.stringify(plan) : JSON.stringify({ summary: "s.", notes: [], drafts: [] }));

async function open(o: { tab?: string; files?: string[]; phone?: boolean } = {}) {
	const t = await start();
	const paths = o.files ?? FILES;
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Fit the model", headSha: "h1" });
	t.github.pages.set(`${LAB}#4`, { baseRef: "main", headRef: "feature", commits: 1, additions: 6, deletions: 0, changedFiles: paths.length });
	t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h1", files: paths.map((path) => ({ path, status: "added" as const, additions: 1, deletions: 0 })) });
	for (const f of paths) t.github.blobs.set(`${LAB}@h1:${f}`, `content of ${f}\n`);
	t.differ.reply = { largeResidual: false, before: { hunks: [] }, after: { hunks: [] } };
	t.llm.answer = model;
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(o.phone ? PHONE : DESKTOP);
	await ctx.route("https://github.com/**", (r) => r.fulfill({ body: "github" }));
	const page = await ctx.newPage();
	await page.goto(`${side.url}#pr/${LAB}/4/${o.tab ?? "files"}`);
	await page.waitForSelector(o.tab === "guide" ? ".guide-steps" : "ul.files");
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	return { t, page, close };
}

const text = async (page: Page, sel: string) => ((await page.locator(sel).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
const listed = (page: Page) => page.locator("ul.files > li.file .path").allTextContents();
const choice = (page: Page, name: RegExp) => page.locator(".kind-switch button", { hasText: name });
const pressed = (page: Page) => page.locator(".kind-switch button[aria-pressed=true]").allTextContents();

test("15. Files changed: a switch leaves only code and docs, and says what it hid", async () => {
	const s = await open();
	try {
		assert.deepEqual(await s.page.locator(".kind-switch button").allTextContents(), ["All files6", "Code and docs2"]);
		assert.deepEqual(await pressed(s.page), ["All files6"]); // nothing is hidden until the switch is used
		assert.deepEqual(await listed(s.page), FILES);
		assert.equal(await s.page.locator(".kind-hidden").count(), 0);

		await choice(s.page, /Code and docs/).click();
		assert.deepEqual(await listed(s.page), ["pipeline/fit.py", "README.md"]);
		assert.deepEqual(await pressed(s.page), ["Code and docs2"]);
		assert.match(await text(s.page, ".kind-hidden"), /^4 files hidden: 2 \.json, 1 \.tsv, 1 \.yml\s*Show all$/);

		await s.page.locator(".kind-hidden button", { hasText: "Show all" }).click();
		assert.deepEqual(await listed(s.page), FILES);
		assert.equal(await s.page.locator(".kind-hidden").count(), 0);
	} finally {
		await s.close();
	}
});

test("15. the choice is kept in the browser, for every pull request", async () => {
	const s = await open();
	try {
		await choice(s.page, /Code and docs/).click();
		await s.page.reload();
		await s.page.waitForSelector("ul.files");
		assert.deepEqual(await listed(s.page), ["pipeline/fit.py", "README.md"]);
		await choice(s.page, /All files/).click();
		await s.page.reload();
		await s.page.waitForSelector("ul.files");
		assert.deepEqual(await listed(s.page), FILES);
	} finally {
		await s.close();
	}
});

test("15. no switch when it would hide nothing, or everything", async () => {
	const code = await open({ files: ["pipeline/fit.py", "README.md"] });
	try {
		assert.equal(await code.page.locator(".kind-switch").count(), 0);
	} finally {
		await code.close();
	}
	const data = await open({ files: ["params/run.json", "results/table.tsv"] });
	try {
		assert.equal(await data.page.locator(".kind-switch").count(), 0);
		await data.page.evaluate(() => localStorage.setItem("ghd-code-only", "1"));
		await data.page.reload();
		await data.page.waitForSelector("ul.files");
		assert.deepEqual(await listed(data.page), ["params/run.json", "results/table.tsv"]); // never an empty list
	} finally {
		await data.close();
	}
});

test("19. Guided review: the switch moves the steps without code or docs under one folded line", async () => {
	const s = await open({ tab: "guide" });
	try {
		const rows = () => s.page.locator(".guide > .guide-steps > li .guide-row-title").allTextContents();
		assert.deepEqual((await rows()).map((x) => x.replace(/skim$/i, "").trim()), ["Fit the model", "Parameters", "Data and figures in results/"]);
		assert.equal(await s.page.locator(".guide-nocode").count(), 0);

		await choice(s.page, /Code and docs/).click();
		assert.deepEqual(await rows(), ["Fit the model"]);
		assert.equal(await text(s.page, ".guide-nocode > summary"), "2 steps without code or docs");
		assert.equal(await s.page.locator(".guide-nocode[open]").count(), 0);
		await s.page.locator(".guide-nocode > summary").click();
		assert.deepEqual((await s.page.locator(".guide-nocode .guide-row-title").allTextContents()).map((x) => x.replace(/skim$/i, "").trim()), ["Parameters", "Data and figures in results/"]);
		// a hidden step keeps its number and still opens
		await s.page.locator(".guide-nocode .guide-row").first().click();
		await s.page.waitForSelector(".guide-step");
		assert.match(await text(s.page, ".guide-bar"), /Step 2 of 3/);
	} finally {
		await s.close();
	}
});

test("15. on a phone the switch and its line fit the screen", async () => {
	const s = await open({ phone: true });
	try {
		await choice(s.page, /Code and docs/).click();
		const fits = await s.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
		assert.ok(fits, "the page does not scroll sideways");
		const h = await s.page.locator(".kind-switch button").first().evaluate((b) => b.getBoundingClientRect().height);
		assert.ok(h >= 36, `a button a thumb can hit (${h}px)`);
	} finally {
		await s.close();
	}
});
