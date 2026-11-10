/**
 * SPEC 22. The dependency graph of a PR's changed files, drawn on Files changed and on
 * Guided review. The lab LLM is faked. Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";
import type { Prompt } from "../../src/llm.ts";

const LAB = "jeonglab-bcm/labbot";
after(closeBrowser);

const FILES: Record<string, string> = {
	"pipeline/common.py": "import os\n",
	"pipeline/model.py": "from common import load\n",
	"pipeline/fit.py": "import common\nimport model\n",
	"run.sh": "python pipeline/fit.py\n",
	"pipeline/alone.py": "x = 1\n",
	"README.md": "Start with run.sh; the fit is in fit.py.\n",
	"params/run.json": "{}\n",
};
const plan = { summary: "Fits the model.", steps: [
	{ title: "The model", summary: "The model is new.", files: ["pipeline/common.py", "pipeline/model.py"] },
	{ title: "Fit and run", summary: "The fit and how to run it.", files: ["pipeline/fit.py", "run.sh", "pipeline/alone.py", "README.md"] },
	{ title: "Parameters", summary: "The settings of the run.", files: ["params/run.json"] },
] };
const model = (p: Prompt) => (p.system.startsWith("You plan") ? JSON.stringify(plan) : JSON.stringify({ summary: "s.", notes: [], drafts: [] }));

async function open(o: { tab?: string; files?: Record<string, string>; phone?: boolean } = {}) {
	const t = await start();
	const set = o.files ?? FILES;
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Fit the model", headSha: "h1" });
	t.github.pages.set(`${LAB}#4`, { baseRef: "main", headRef: "feature", commits: 1, additions: 7, deletions: 0, changedFiles: Object.keys(set).length });
	t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h1", files: Object.keys(set).map((path) => ({ path, status: "added" as const, additions: 1, deletions: 0 })) });
	for (const [f, text] of Object.entries(set)) t.github.blobs.set(`${LAB}@h1:${f}`, text);
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
const node = (page: Page, path: string) => page.locator(`.dep-graph .dep-node[data-path="${path}"]`);
const top = async (page: Page, path: string) => (await node(page, path).boundingBox())!.y;
const dimmed = (page: Page) => page.locator(".dep-graph .dep-node.dim").evaluateAll((xs) => xs.map((x) => x.getAttribute("data-path")).sort());

test("22. Files changed draws the changed code: a file under the files it uses, an arrow per use", async () => {
	const s = await open();
	try {
		await s.page.waitForSelector(".dep-graph svg");
		assert.equal(await text(s.page, ".dep-head .dep-title"), "Dependency graph");
		assert.equal(await text(s.page, ".dep-head .hint"), "4 files, 4 links");
		assert.deepEqual(await s.page.locator(".dep-graph svg .dep-node").evaluateAll((xs) => xs.map((x) => x.getAttribute("data-path")).sort()),
			["pipeline/common.py", "pipeline/fit.py", "pipeline/model.py", "run.sh"]);
		assert.deepEqual(await s.page.locator(".dep-graph svg .dep-node text").allTextContents().then((xs) => xs.sort()), ["common.py", "fit.py", "model.py", "run.sh"]);
		// read from the top: what is used stands above what uses it
		assert.ok((await top(s.page, "pipeline/common.py")) < (await top(s.page, "pipeline/model.py")));
		assert.ok((await top(s.page, "pipeline/model.py")) < (await top(s.page, "pipeline/fit.py")));
		assert.ok((await top(s.page, "pipeline/fit.py")) < (await top(s.page, "run.sh")));
		assert.equal(await s.page.locator(".dep-graph svg path.dep-link").count(), 4);
		assert.equal(await s.page.locator(".dep-graph svg path.dep-link.mention").count(), 1); // run.sh names fit.py
		// code that is linked to nothing, and the documents, are named under the drawing
		assert.equal(await text(s.page, ".dep-alone"), "Not linked to the others: alone.py");
		assert.equal(await text(s.page, ".dep-docs"), "Documents: README.md names 2");
		assert.doesNotMatch(await text(s.page, ".dep-graph"), /run\.json/);
	} finally {
		await s.close();
	}
});

test("22. a tap on a file shows what it uses and what uses it, and opens its diff", async () => {
	const s = await open();
	try {
		await s.page.waitForSelector(".dep-graph svg");
		await node(s.page, "pipeline/model.py").click();
		assert.deepEqual(await dimmed(s.page), ["run.sh"]);
		assert.equal(await text(s.page, ".dep-pick .dep-pick-path"), "pipeline/model.py");
		assert.match(await text(s.page, ".dep-pick"), /Uses common\.py/);
		assert.match(await text(s.page, ".dep-pick"), /Used by fit\.py/);
		assert.equal(await s.page.locator(".dep-graph svg path.dep-link.on").count(), 2);

		await s.page.locator(".dep-pick button", { hasText: "Open file" }).click();
		await s.page.waitForSelector("li.file.open");
		assert.deepEqual(await s.page.locator("li.file.open .path").allTextContents(), ["pipeline/model.py"]);

		// a second tap lets go; a document shows the files it names
		await node(s.page, "pipeline/model.py").click();
		assert.equal(await s.page.locator(".dep-pick").count(), 0);
		assert.deepEqual(await dimmed(s.page), []);
		await s.page.locator(".dep-docs .dep-chip", { hasText: "README.md" }).click();
		assert.deepEqual(await dimmed(s.page), ["pipeline/common.py", "pipeline/model.py"]);
		assert.match(await text(s.page, ".dep-pick"), /Names fit\.py, run\.sh/);
	} finally {
		await s.close();
	}
});

test("22. Guided review: each file carries the number of its step, and opens that step", async () => {
	const s = await open({ tab: "guide" });
	try {
		await s.page.waitForSelector(".dep-graph svg");
		const steps = await s.page.locator(".dep-graph svg .dep-node").evaluateAll((xs) => Object.fromEntries(xs.map((x) => [x.getAttribute("data-path"), x.querySelector(".dep-step")?.textContent])));
		assert.deepEqual(steps, { "pipeline/common.py": "1", "pipeline/model.py": "1", "pipeline/fit.py": "2", "run.sh": "2" });
		await node(s.page, "pipeline/fit.py").click();
		await s.page.locator(".dep-pick button", { hasText: "Open step 2" }).click();
		await s.page.waitForSelector(".guide-step");
		assert.match(await text(s.page, ".guide-bar"), /Step 2 of 3/);
	} finally {
		await s.close();
	}
});

test("22. the graph folds, and stays folded", async () => {
	const s = await open();
	try {
		await s.page.waitForSelector(".dep-graph svg");
		assert.equal(await s.page.locator(".dep-head").getAttribute("aria-expanded"), "true");
		await s.page.locator(".dep-head").click();
		assert.equal(await s.page.locator(".dep-graph svg").count(), 0);
		await s.page.reload();
		await s.page.waitForSelector(".dep-head");
		assert.equal(await s.page.locator(".dep-head").getAttribute("aria-expanded"), "false");
		assert.equal(await s.page.locator(".dep-graph svg").count(), 0);
		await s.page.locator(".dep-head").click();
		await s.page.waitForSelector(".dep-graph svg");
	} finally {
		await s.close();
	}
});

test("22. on a phone the graph fits the screen and its names can be read", async () => {
	const s = await open({ phone: true });
	try {
		await s.page.waitForSelector(".dep-graph svg");
		const fit = await s.page.evaluate(() => ({
			page: document.documentElement.scrollWidth <= window.innerWidth,
			svg: document.querySelector(".dep-graph svg")!.getBoundingClientRect().right <= window.innerWidth,
			font: parseFloat(getComputedStyle(document.querySelector(".dep-node text")!).fontSize),
			tap: document.querySelector(".dep-node rect")!.getBoundingClientRect().height,
		}));
		assert.ok(fit.page && fit.svg, "nothing scrolls sideways");
		assert.ok(fit.font >= 12, `names of ${fit.font}px`);
		assert.ok(fit.tap >= 30, `a file a thumb can hit (${fit.tap}px)`);
		await node(s.page, "pipeline/fit.py").click();
		assert.match(await text(s.page, ".dep-pick"), /Uses common\.py, model\.py/);
	} finally {
		await s.close();
	}
});

test("22. no graph when no changed file uses another", async () => {
	const s = await open({ files: { "pipeline/a.py": "x = 1\n", "pipeline/b.py": "y = 2\n", "README.md": "Nothing here.\n" } });
	try {
		await s.t.app.sync();
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(await s.page.locator(".dep-graph").count(), 0);
	} finally {
		await s.close();
	}
});
