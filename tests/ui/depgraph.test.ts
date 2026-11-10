/**
 * SPEC 22. The dependency graph of a PR's changed files, a tree on Files changed and on
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
/** The tree as lines: "depth file + file [caret]"; a file is "[~]name [mark]", ~ for one used by its name (dashed). */
const lines = (page: Page) => page.locator(".dep-tree .dep-row").evaluateAll((xs) => xs.map((x) =>
	[x.getAttribute("data-depth"),
		[...x.querySelectorAll(".dep-node")].map((n) => `${n.classList.contains("named") ? "~" : ""}${n.querySelector(".dep-name")!.textContent}${n.querySelector(".dep-again") ? ` ${n.querySelector(".dep-again")!.textContent}` : ""}`).join(" + "),
		x.querySelector(".dep-caret")?.textContent]
		.filter(Boolean).join(" ")));
const marked = (page: Page, cls: string) => page.locator(`.dep-tree .dep-node.${cls}`).evaluateAll((xs) => xs.map((x) => x.getAttribute("data-path")));

test("22. Files changed shows the changed code as a tree: under each file the files it uses", async () => {
	const s = await open();
	try {
		await s.page.waitForSelector(".dep-tree");
		assert.equal(await text(s.page, ".dep-head .dep-title"), "Dependency graph");
		assert.equal(await text(s.page, ".dep-head .hint"), "4 files, 4 links");
		// run.sh runs fit.py, which imports common.py and model.py; model.py imports common.py
		assert.deepEqual(await lines(s.page), ["0 run.sh ▾", "1 ~fit.py ▾", "2 common.py", "2 model.py ▾", "3 common.py"]);
		// a branch is drawn to the right of its file
		const left = async (path: string) => (await node(s.page, path).first().boundingBox())!.x;
		assert.ok((await left("run.sh")) < (await left("pipeline/fit.py")));
		assert.ok((await left("pipeline/fit.py")) < (await left("pipeline/model.py")));
		// code that is linked to nothing, and the documents, are named under the tree
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
		await s.page.waitForSelector(".dep-tree");
		await node(s.page, "pipeline/model.py").click();
		assert.deepEqual(await marked(s.page, "picked"), ["pipeline/model.py"]);
		// its branch shows what it uses; the mark is on what uses it
		assert.deepEqual(await marked(s.page, "near"), ["pipeline/fit.py"]);
		assert.equal(await text(s.page, ".dep-pick .dep-pick-path"), "pipeline/model.py");
		assert.match(await text(s.page, ".dep-pick"), /Uses common\.py/);
		assert.match(await text(s.page, ".dep-pick"), /Used by fit\.py/);
		// what it says stands right under the tapped line
		assert.equal(await s.page.locator(".dep-tree > li").nth(4).getAttribute("class"), "dep-pick-row");

		await s.page.locator(".dep-pick button", { hasText: "Open file" }).click();
		await s.page.waitForSelector("li.file.open");
		assert.deepEqual(await s.page.locator("li.file.open .path").allTextContents(), ["pipeline/model.py"]);

		// a second tap lets go; a document shows the files it names
		await node(s.page, "pipeline/model.py").click();
		assert.equal(await s.page.locator(".dep-pick").count(), 0);
		assert.deepEqual(await marked(s.page, "picked"), []);
		await s.page.locator(".dep-docs .dep-chip", { hasText: "README.md" }).click();
		assert.deepEqual(await marked(s.page, "near"), ["run.sh", "pipeline/fit.py"]);
		assert.match(await text(s.page, ".dep-pick"), /Names fit\.py, run\.sh/);
	} finally {
		await s.close();
	}
});

test("22. a file used in two places has its own files listed once; a branch folds", async () => {
	const s = await open({ files: {
		"main.py": "import a\nimport b\n",
		"a.py": "import b\n",
		"b.py": "import c\n",
		"c.py": "x = 1\n",
		"other.py": "import c\n",
	} });
	try {
		await s.page.waitForSelector(".dep-tree");
		// main.py has the most under it and goes first; b.py's own line is the one nearest to the top
		assert.deepEqual(await lines(s.page), ["0 main.py ▾", "1 a.py ▾", "2 b.py ↓", "1 b.py ▾", "2 c.py", "0 other.py ▾", "1 c.py"]);
		// where it is only named, a tap offers the way to its own line
		await node(s.page, "b.py").first().click();
		assert.equal(await s.page.locator(".dep-tree > li").nth(3).getAttribute("class"), "dep-pick-row");
		await s.page.locator(".dep-pick button", { hasText: "Go to its branch" }).click();
		assert.equal(await s.page.locator(".dep-tree > li").nth(4).getAttribute("class"), "dep-pick-row");
		assert.match(await text(s.page, ".dep-pick"), /Uses c\.py\s*Used by main\.py, a\.py/);
		assert.equal(await s.page.locator(".dep-pick button", { hasText: "Go to its branch" }).count(), 0);
		await node(s.page, "b.py").nth(1).click();
		assert.equal(await s.page.locator(".dep-pick").count(), 0);

		await s.page.locator('.dep-caret[aria-label="Fold b.py"]').click();
		assert.deepEqual(await lines(s.page), ["0 main.py ▾", "1 a.py ▾", "2 b.py ↓", "1 b.py ▸ 1", "0 other.py ▾", "1 c.py"]);
		await s.page.locator('.dep-caret[aria-label="Fold main.py"]').click();
		assert.deepEqual(await lines(s.page), ["0 main.py ▸ 2", "0 other.py ▾", "1 c.py"]);
		await s.page.locator('.dep-caret[aria-label="Unfold main.py"]').click();
		assert.equal((await lines(s.page)).length, 6);
	} finally {
		await s.close();
	}
});

test("22. files that only use each other still show, each once", async () => {
	const s = await open({ files: { "x.py": "import y\n", "y.py": "import x\n" } });
	try {
		await s.page.waitForSelector(".dep-tree");
		assert.deepEqual(await lines(s.page), ["0 x.py ▾", "1 y.py ▾", "2 x.py ↑"]);
	} finally {
		await s.close();
	}
});

test("22. Guided review: each file carries the number of its step, and opens that step", async () => {
	const s = await open({ tab: "guide" });
	try {
		await s.page.waitForSelector(".dep-tree");
		const steps = await s.page.locator(".dep-tree .dep-node").evaluateAll((xs) => Object.fromEntries(xs.map((x) => [x.getAttribute("data-path"), x.querySelector(".dep-step")?.textContent])));
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
		await s.page.waitForSelector(".dep-tree");
		assert.equal(await s.page.locator(".dep-head").getAttribute("aria-expanded"), "true");
		await s.page.locator(".dep-head").click();
		assert.equal(await s.page.locator(".dep-tree").count(), 0);
		await s.page.reload();
		await s.page.waitForSelector(".dep-head");
		assert.equal(await s.page.locator(".dep-head").getAttribute("aria-expanded"), "false");
		assert.equal(await s.page.locator(".dep-tree").count(), 0);
		await s.page.locator(".dep-head").click();
		await s.page.waitForSelector(".dep-tree");
	} finally {
		await s.close();
	}
});

test("22. on a phone the tree fits the screen and its names can be read", async () => {
	const deep: Record<string, string> = { "pipeline/a_rather_long_file_name_0.py": "x = 1\n" };
	for (let i = 1; i < 9; i++) deep[`pipeline/a_rather_long_file_name_${i}.py`] = `import a_rather_long_file_name_${i - 1}\n`;
	const s = await open({ phone: true, files: deep });
	try {
		await s.page.waitForSelector(".dep-tree");
		assert.equal(await s.page.locator(".dep-row").count(), 9);
		const fit = await s.page.evaluate(() => ({
			page: document.documentElement.scrollWidth <= window.innerWidth,
			rows: [...document.querySelectorAll(".dep-row")].every((r) => r.getBoundingClientRect().right <= window.innerWidth && [...r.children].every((c) => c.getBoundingClientRect().right <= window.innerWidth)),
			font: parseFloat(getComputedStyle(document.querySelector(".dep-node")!).fontSize),
			tap: Math.min(...[...document.querySelectorAll(".dep-node")].map((n) => n.getBoundingClientRect().height)),
			name: Math.min(...[...document.querySelectorAll(".dep-name")].map((n) => n.getBoundingClientRect().width)),
		}));
		assert.ok(fit.page && fit.rows, "nothing scrolls sideways or is cut off");
		assert.ok(fit.font >= 12, `names of ${fit.font}px`);
		assert.ok(fit.tap >= 30, `a file a thumb can hit (${fit.tap}px)`);
		assert.ok(fit.name >= 60, `the deepest name still shows (${fit.name}px)`);
		await node(s.page, "pipeline/a_rather_long_file_name_3.py").click();
		assert.match(await text(s.page, ".dep-pick"), /Uses a_rather_long_file_name_2\.py/);
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
