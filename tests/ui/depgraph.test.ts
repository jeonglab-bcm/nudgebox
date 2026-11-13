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
const model = (steps: typeof plan) => (p: Prompt) => (p.system.startsWith("You plan") ? JSON.stringify(steps) : JSON.stringify({ summary: "s.", notes: [], drafts: [] }));

async function open(o: { tab?: string; files?: Record<string, string>; phone?: boolean; plan?: typeof plan } = {}) {
	const t = await start();
	const set = o.files ?? FILES;
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Fit the model", headSha: "h1" });
	t.github.pages.set(`${LAB}#4`, { baseRef: "main", headRef: "feature", commits: 1, additions: 7, deletions: 0, changedFiles: Object.keys(set).length });
	t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h1", files: Object.keys(set).map((path) => ({ path, status: "added" as const, additions: 1, deletions: 0 })) });
	for (const [f, text] of Object.entries(set)) t.github.blobs.set(`${LAB}@h1:${f}`, text);
	t.differ.reply = { largeResidual: false, before: { hunks: [] }, after: { hunks: [] } };
	t.llm.answer = model(o.plan ?? plan);
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
		// under the code stand the documents, each with the files it names folded under it
		assert.deepEqual(await lines(s.page), ["0 run.sh ▾", "1 ~fit.py ▾", "2 common.py", "2 model.py ▾", "3 common.py", "0 README.md ▸ 2"]);
		// a branch is drawn to the right of its file
		const left = async (path: string) => (await node(s.page, path).first().boundingBox())!.x;
		assert.ok((await left("run.sh")) < (await left("pipeline/fit.py")));
		assert.ok((await left("pipeline/fit.py")) < (await left("pipeline/model.py")));
		assert.equal(await text(s.page, ".dep-tree .dep-sep"), "Documents, and the files they name");
		assert.equal(await s.page.locator(".dep-tree > li").nth(5).getAttribute("class"), "dep-sep");
		await s.page.locator('.dep-row[data-row="own:README.md"] .dep-caret').click();
		assert.deepEqual((await lines(s.page)).slice(5), ["0 README.md ▾", "1 ~fit.py ↑ + ~run.sh ↑"]);
		await s.page.locator('.dep-row[data-row="own:README.md"] .dep-caret').click();
		assert.equal((await lines(s.page)).length, 6);
		// code that is linked to nothing is named under the tree
		assert.equal(await text(s.page, ".dep-alone"), "Not linked to the others: alone.py");
		assert.equal(await s.page.locator(".dep-docs").count(), 0);
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
		// on a computer the tap has opened its diff beside the tree
		await s.page.waitForSelector("li.file.open");
		assert.deepEqual(await s.page.locator("li.file.open .path").allTextContents(), ["pipeline/model.py"]);
		assert.equal(await s.page.locator(".dep-pick button", { hasText: "Open file" }).count(), 0);

		// beside the code a second tap does not let go: the file stays marked and open
		await node(s.page, "pipeline/model.py").click();
		assert.deepEqual(await marked(s.page, "picked"), ["pipeline/model.py"]);
		assert.deepEqual(await s.page.locator("li.file.open .path").allTextContents(), ["pipeline/model.py"]);

		// a document shows the files it names, right under its line, and opens as well
		await node(s.page, "README.md").click();
		assert.deepEqual(await marked(s.page, "picked"), ["README.md"]);
		assert.deepEqual(await marked(s.page, "near"), ["run.sh", "pipeline/fit.py"]);
		assert.match(await text(s.page, ".dep-pick"), /Names fit\.py, run\.sh/);
		assert.equal(await s.page.locator('.dep-row[data-row="own:README.md"] + li').getAttribute("class"), "dep-pick-row");
		await s.page.waitForSelector('li.file.open[data-path="README.md"]');

		// code under the tree: what it says stands under the names, not between the tree and them
		const chip = s.page.locator(".dep-alone .dep-chip", { hasText: "alone.py" });
		await chip.click();
		await s.page.waitForSelector('li.file.open[data-path="pipeline/alone.py"] + li.file-diff .panes');
		assert.equal(await chip.getAttribute("aria-pressed"), "true");
		assert.ok((await s.page.locator(".dep-graph > .dep-pick").boundingBox())!.y > (await chip.boundingBox())!.y, "what it says is under it");
	} finally {
		await s.close();
	}
});

test("22. on a computer the tree stands beside the files and stays in view; folded, the files have the full width", async () => {
	const s = await open();
	try {
		await s.page.waitForSelector(".dep-tree");
		const box = async (sel: string) => (await s.page.locator(sel).first().boundingBox())!;
		const [side, main] = [await box(".files-changed.beside .files-side"), await box(".files-changed.beside .files-main")];
		assert.ok(side.x + side.width <= main.x, "the tree is left of the files");
		assert.ok(Math.abs(side.y - main.y) < 2, "both start at one height");
		assert.ok(main.width >= 2 * side.width, `the files have most of the width (${side.width} and ${main.width})`);
		assert.equal(await s.page.locator(".files-side").evaluate((x) => getComputedStyle(x).position), "sticky");
		assert.equal(await s.page.locator(".files-main ul.files").count(), 1);
		assert.equal(await s.page.locator(".files-main .kind-switch").count(), 1);
		assert.match(await text(s.page, ".dep-how"), /Tap a file to open it/);
		assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "nothing scrolls sideways");

		// a document opens as well
		await node(s.page, "README.md").click();
		await s.page.waitForSelector("li.file.open");
		assert.deepEqual(await s.page.locator("li.file.open .path").allTextContents(), ["README.md"]);

		// its name is under the page's bar, not behind it
		const bar = await box(".chrome");
		assert.ok((await box("li.file.open")).y >= bar.y + bar.height - 1, "the opened file's row is in view");

		await s.page.locator(".dep-head").click();
		assert.equal(await s.page.locator(".files-changed.beside").count(), 0);
		assert.ok((await box("ul.files")).width > main.width);
	} finally {
		await s.close();
	}
});

test("22. beside the files a long tree scrolls on its own, and keeps its place when a file is opened", async () => {
	const tall: Record<string, string> = { "main.py": "" };
	for (let i = 0; i < 14; i++) {
		tall["main.py"] += `import mod_${i}\n`;
		tall[`mod_${i}.py`] = `import leaf_${i}\n`;
		tall[`leaf_${i}.py`] = "x = 1\n";
	}
	const s = await open({ files: tall });
	try {
		await s.page.waitForSelector(".dep-tree");
		const side = s.page.locator(".files-side");
		const room = await side.evaluate((x) => ({ all: x.scrollHeight, seen: x.clientHeight, screen: window.innerHeight }));
		assert.ok(room.seen <= room.screen && room.all > room.seen + 200, `the tree is longer than its column (${room.all} in ${room.seen})`);
		await side.evaluate((x) => { x.scrollTop = 300; });
		await node(s.page, "mod_6.py").scrollIntoViewIfNeeded();
		const was = (await node(s.page, "mod_6.py").boundingBox())!.y;
		await node(s.page, "mod_6.py").click();
		await s.page.waitForSelector("li.file.open");
		assert.deepEqual(await s.page.locator("li.file.open .path").allTextContents(), ["mod_6.py"]);
		await s.page.waitForTimeout(100);
		// the page went to the file and took the column up with it: the tapped name is still where it was on the screen
		const now = (await node(s.page, "mod_6.py").boundingBox())!.y;
		assert.ok(Math.abs(now - was) < 3, `the tapped file did not move (${was} to ${now})`);
		// the tree is still on the screen after the page went to the file
		const box = (await side.boundingBox())!;
		assert.ok(box.y >= 0 && box.y + box.height <= room.screen + 1, "the tree is in view");
		assert.ok(await node(s.page, "mod_6.py").isVisible());
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
		await node(s.page, "b.py").nth(1).click(); // a second tap keeps it
		assert.equal(await s.page.locator(".dep-pick").count(), 1);

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

test("22. Guided review on a computer: the tree stands beside the steps and beside the code of a step", async () => {
	const s = await open({ tab: "guide" });
	try {
		await s.page.waitForSelector(".guide.beside .files-side .dep-tree");
		const box = async (sel: string) => (await s.page.locator(sel).first().boundingBox())!;
		const bar = () => text(s.page, ".guide-bar");
		const steps = await s.page.locator(".dep-tree .dep-node").evaluateAll((xs) => Object.fromEntries(xs.map((x) => [x.getAttribute("data-path"), x.querySelector(".dep-step")?.textContent])));
		assert.deepEqual(steps, { "pipeline/common.py": "1", "pipeline/model.py": "1", "pipeline/fit.py": "2", "run.sh": "2", "README.md": "2" });
		let [tree, right] = [await box(".files-side"), await box(".guide-steps")];
		assert.ok(tree.x + tree.width <= right.x, "the tree is left of the steps");
		assert.ok(tree.y <= right.y, "and starts no lower than they do");

		// a tap opens the file in its step, and only that file
		await node(s.page, "pipeline/fit.py").first().click();
		await s.page.waitForSelector('.guide-files .file.open[data-path="pipeline/fit.py"]');
		await s.page.waitForSelector(".guide-files .file-diff .panes");
		assert.match(await bar(), /Step 2 of 3/);
		assert.deepEqual(await s.page.locator(".guide-files .file.open").evaluateAll((xs) => xs.map((x) => x.getAttribute("data-path"))), ["pipeline/fit.py"]);
		// the tree is still there, beside the code, between the two bars, with this step's files marked
		[tree, right] = [await box(".files-side"), await box(".guide-step")];
		assert.ok(tree.x + tree.width <= right.x, "the tree is left of the code");
		const [top, foot] = [await box(".guide-bar"), await box(".guide-foot")];
		assert.ok(tree.y >= top.y + top.height && tree.y + tree.height <= foot.y + 1, "the tree is not under a bar");
		assert.deepEqual([...new Set(await marked(s.page, "here"))].sort(), ["README.md", "pipeline/fit.py", "run.sh"]);
		assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "nothing sticks out at the side");

		// a file of another step: the tap goes there
		await node(s.page, "pipeline/model.py").first().click();
		await s.page.waitForSelector('.guide-files .file.open[data-path="pipeline/model.py"]');
		assert.match(await bar(), /Step 1 of 3/);
		assert.deepEqual([...new Set(await marked(s.page, "here"))].sort(), ["pipeline/common.py", "pipeline/model.py"]);
		// a file of this step: the step stays and the file opens
		await node(s.page, "pipeline/common.py").first().click();
		await s.page.waitForSelector('.guide-files .file.open[data-path="pipeline/common.py"]');
		assert.match(await bar(), /Step 1 of 3/);

		// folded, the code has the full width again and the heading stays in reach
		await s.page.locator(".dep-head").click();
		assert.equal(await s.page.locator(".guide.beside").count(), 0);
		assert.equal(await s.page.locator(".guide-step .dep-graph.folded .dep-head").count(), 1);
		await s.page.locator(".dep-head").click();
		await s.page.waitForSelector(".guide.beside .files-side .dep-tree");

		// with the code panel open there is no room for three columns on this screen
		await s.page.evaluate(() => document.body.classList.add("code-open"));
		assert.equal(await s.page.locator(".files-side").isVisible(), false);
	} finally {
		await s.close();
	}
});

// issue 68: a tree longer than its column, with documents at its end; the last one is long
const LONG: Record<string, string> = (() => {
	const set: Record<string, string> = { "main.py": "" };
	for (let i = 0; i < 14; i++) {
		set["main.py"] += `import mod_${i}\n`;
		set[`mod_${i}.py`] = `import leaf_${i}\n`;
		set[`leaf_${i}.py`] = "x = 1\n";
	}
	set["docs/guide.md"] = "Run main.py first.\n";
	set["notes.md"] = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} about main.py.\n`).join("\n");
	return set;
})();
const longPlan = { summary: "A long one.", steps: [
	{ title: "The code", summary: "All of the code.", files: Object.keys(LONG).filter((f) => f.endsWith(".py")) },
	{ title: "The documents", summary: "What is written about it.", files: ["docs/guide.md", "notes.md"] },
] };

test("22. beside the files a tapped document stays where it is in the tree, and is at the top once it is loaded", async () => {
	const s = await open({ files: LONG });
	try {
		await s.page.waitForSelector(".dep-tree");
		const side = s.page.locator(".files-side");
		await side.evaluate((x) => { x.scrollTop = x.scrollHeight; });
		const doc = node(s.page, "notes.md");
		await doc.scrollIntoViewIfNeeded();
		const was = (await doc.boundingBox())!.y;
		await doc.click();
		await s.page.waitForSelector('li.file.open[data-path="notes.md"]');
		await s.page.waitForSelector("li.file-diff .md-pane, li.file-diff .panes");
		await s.page.waitForTimeout(200);
		// the last line of the column: it gives way only as far as what the tap says needs
		const col = (await side.boundingBox())!;
		const says = (await s.page.locator(".files-side .dep-pick").boundingBox())!;
		const now = (await doc.boundingBox())!.y;
		assert.ok(says.y >= col.y && says.y + says.height <= col.y + col.height + 1, "what the tap says is in view");
		assert.ok(now >= col.y && now <= was + 3 && now >= was - says.height - 24, `the document moved from ${was} to ${now}`);
		// the last file of the list: its row is right under the page's bar once its text is there
		const bar = (await s.page.locator(".chrome").boundingBox())!;
		const row = (await s.page.locator('li.file.open[data-path="notes.md"]').boundingBox())!;
		assert.ok(Math.abs(row.y - (bar.y + bar.height)) < 6, `the opened file is at ${row.y}, the bar ends at ${bar.y + bar.height}`);
		const body = (await s.page.locator('li.file.open[data-path="notes.md"] + li.file-diff').boundingBox())!;
		assert.ok(Math.abs(body.y - (row.y + row.height)) < 6, "its text starts right under it");
		assert.match(await text(s.page, 'li.file.open[data-path="notes.md"] + li.file-diff'), /Paragraph 0 about main\.py/);

		// a file far above, while the page is down at another one: the page goes up to it
		await node(s.page, "main.py").click();
		await s.page.waitForSelector('li.file.open[data-path="main.py"] + li.file-diff .panes');
		await s.page.waitForTimeout(200);
		const up = (await s.page.locator('li.file.open[data-path="main.py"]').boundingBox())!;
		const code = (await s.page.locator('li.file.open[data-path="main.py"] + li.file-diff').boundingBox())!;
		assert.ok(Math.abs(up.y - (bar.y + bar.height)) < 6 && Math.abs(code.y - (up.y + up.height)) < 6, `main.py is at ${up.y}, its code at ${code.y}`);
	} finally {
		await s.close();
	}
});

test("22. Guided review: a tapped document opens in its step at the top, stays in place in the tree, and opens again on a second tap", async () => {
	const s = await open({ tab: "guide", files: LONG, plan: longPlan });
	try {
		await s.page.waitForSelector(".guide.beside .files-side .dep-tree");
		const side = s.page.locator(".files-side");
		await side.evaluate((x) => { x.scrollTop = x.scrollHeight; });
		const doc = node(s.page, "notes.md");
		await doc.scrollIntoViewIfNeeded();
		const was = (await doc.boundingBox())!.y;
		await doc.click();
		await s.page.waitForSelector('.guide-files .file.open[data-path="notes.md"]');
		await s.page.waitForSelector(".file-diff .md-pane, .file-diff .panes");
		await s.page.waitForTimeout(200);
		assert.match(await text(s.page, ".guide-bar"), /Step 2 of 2/);
		const col = (await side.boundingBox())!;
		const now = (await doc.boundingBox())!;
		assert.ok(now.y >= col.y && now.y + now.height <= col.y + col.height + 1, "the tapped document is in view");
		assert.ok(Math.abs(now.y - was) < 80, `the document moved from ${was} to ${now.y}`);
		// the last file of the step: its row is right under the step's bar once its text is there
		const bar = (await s.page.locator(".guide-bar").boundingBox())!;
		const row = (await s.page.locator('.guide-files .file[data-path="notes.md"]').boundingBox())!;
		assert.ok(Math.abs(row.y - (bar.y + bar.height)) < 6, `the opened file is at ${row.y}, the bar ends at ${bar.y + bar.height}`);

		// back at the steps the document is still marked: a tap opens it again
		await s.page.locator(".guide-bar button", { hasText: "Steps" }).click();
		await s.page.waitForSelector(".guide-steps");
		assert.deepEqual(await marked(s.page, "picked"), ["notes.md"]);
		await node(s.page, "notes.md").click();
		await s.page.waitForSelector('.guide-files .file.open[data-path="notes.md"]');
		assert.match(await text(s.page, ".guide-bar"), /Step 2 of 2/);
		assert.deepEqual(await marked(s.page, "picked"), ["notes.md"]);
	} finally {
		await s.close();
	}
});

test("22. Guided review on a phone: the tree stands above the steps, and opens a file's step", async () => {
	const s = await open({ tab: "guide", phone: true });
	try {
		await s.page.waitForSelector(".dep-tree");
		assert.equal(await s.page.locator(".guide.beside").count(), 0);
		const [tree, list] = [(await s.page.locator(".dep-graph").boundingBox())!, (await s.page.locator(".guide-steps").first().boundingBox())!];
		assert.ok(tree.y + tree.height <= list.y, "the tree is above the steps");
		// above the steps a tap only marks, and a second tap lets go
		await node(s.page, "README.md").click();
		assert.match(await text(s.page, ".dep-pick"), /Names fit\.py, run\.sh/);
		assert.equal(await s.page.locator(".dep-pick button", { hasText: "Open step 2" }).count(), 1);
		await node(s.page, "README.md").click();
		assert.equal(await s.page.locator(".dep-pick").count(), 0);
		assert.deepEqual(await marked(s.page, "picked"), []);
		await node(s.page, "pipeline/fit.py").first().click();
		await s.page.locator(".dep-pick button", { hasText: "Open step 2" }).click();
		await s.page.waitForSelector(".guide-step");
		assert.match(await text(s.page, ".guide-bar"), /Step 2 of 3/);
		assert.equal(await s.page.locator(".dep-graph").count(), 0, "a step on a phone is the code alone");
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
		// no room for two columns: the tree is above the files, and a button opens the tapped file
		assert.equal(await s.page.locator(".files-changed.beside").count(), 0);
		await node(s.page, "pipeline/a_rather_long_file_name_3.py").click();
		assert.match(await text(s.page, ".dep-pick"), /Uses a_rather_long_file_name_2\.py/);
		assert.equal(await s.page.locator("li.file.open").count(), 0);
		await s.page.locator(".dep-pick button", { hasText: "Open file" }).click();
		await s.page.waitForSelector("li.file.open");
		assert.deepEqual(await s.page.locator("li.file.open .path").allTextContents(), ["pipeline/a_rather_long_file_name_3.py"]);
	} finally {
		await s.close();
	}
});

test("22. code files that do not use each other: one line says so, and there is no tree", async () => {
	const s = await open({ files: { "pipeline/a.py": "x = 1\n", "pipeline/b.py": "y = 2\n", "README.md": "Nothing here.\n" } });
	try {
		await s.page.waitForSelector(".dep-none");
		assert.equal(await text(s.page, ".dep-none"), "Dependency graph: none of the 2 changed code files uses another.");
		assert.equal(await s.page.locator(".dep-graph").count(), 0);
		assert.equal(await s.page.locator(".files-changed.beside").count(), 0);
	} finally {
		await s.close();
	}
});

test("22. one code file alone: nothing is said about a graph", async () => {
	const s = await open({ files: { "pipeline/a.py": "x = 1\n", "README.md": "Nothing here.\n" } });
	try {
		await s.t.app.sync();
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(await s.page.locator(".dep-graph, .dep-none").count(), 0);
	} finally {
		await s.close();
	}
});
