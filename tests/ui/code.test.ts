/**
 * SPEC 21, go to definition (issue 45), in a real browser with the real language servers.
 * A click on a name in the new code opens the code panel: what the name is, the file where
 * it is defined at that line, and where it is used; names in the panel lead further.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContextOptions, Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import type { DiffResult } from "../../src/omnidiff.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
after(closeBrowser);

const CODE: Record<string, string> = {
	"pkg/__init__.py": "",
	"pkg/doi.py": 'PREFIX = "doi:"\n\ndef strip(s):\n    return s.strip()\n\ndef normalize_doi(s):\n    """Lower-case a DOI and drop its prefix."""\n    return strip(s).lower().removeprefix(PREFIX)\n',
	"pkg/cli.py": "from pkg.doi import normalize_doi\n\ndef main(argv):\n    # normalize_doi cleans each one\n    print(len(argv))\n    return [normalize_doi(a) for a in argv]\n",
	"tests/test_doi.py": 'from pkg.doi import normalize_doi\n\ndef test_it():\n    assert normalize_doi("DOI:X") == "x"\n',
	"R/plot.R": "draw <- function(x) {\n  normalize_doi(x)\n}\n",
};
const BEFORE: Record<string, string> = {
	"pkg/cli.py": "from pkg.doi import normalize_doi\n\ndef main(argv):\n    # normalize_doi cleans each one\n    print(len(argv))\n    return [normalize_doi(a) for a in argv[1:]]\n",
	"R/plot.R": "draw <- function(x) {\n  normalize_doi(y)\n}\n",
};
const at = (row: number, a: number, b: number) => ({ from: { row, col: a }, to: { row, col: b } });
const DIFFS: Record<string, DiffResult> = {
	"pkg/cli.py": { largeResidual: false, before: { hunks: [{ op: "update", ...at(5, 38, 46) }] }, after: { hunks: [{ op: "update", ...at(5, 38, 42) }] } },
	"R/plot.R": { largeResidual: false, before: { hunks: [{ op: "update", ...at(1, 16, 17) }] }, after: { hunks: [{ op: "update", ...at(1, 16, 17) }] } },
};

async function open(o: { device?: BrowserContextOptions; code?: false } = {}) {
	const t = await start({ diff: async (a, b) => DIFFS[(b ?? a)!.path], code: o.code });
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Clean every DOI", headSha: "head-sha" });
	t.github.pages.set(`${LAB}#4`, { baseRef: "main", headRef: "feature", commits: 1, additions: 2, deletions: 2, changedFiles: 2 });
	t.github.prFileSets.set(`${LAB}#4`, { base: "base-sha", head: "head-sha", files: Object.keys(BEFORE).map((path) => ({ path, status: "modified" as const, additions: 1, deletions: 1 })) });
	for (const [path, text] of Object.entries(CODE)) t.github.blobs.set(`${LAB}@head-sha:${path}`, text);
	for (const [path, text] of Object.entries(BEFORE)) t.github.blobs.set(`${LAB}@base-sha:${path}`, text);
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(o.device ?? DESKTOP);
	const page = await ctx.newPage();
	const asked: string[] = [];
	page.on("request", (r) => asked.push(new URL(r.url()).pathname));
	await page.goto(`${side.url}#pr/${LAB}/4/files`);
	await page.waitForSelector(".file");
	const openFile = async (path: string) => {
		await page.locator(".file", { hasText: path }).locator(".path").click();
		await page.waitForSelector(".file-diff .code");
		await page.waitForFunction(() => !document.querySelector(".file-diff .pending"));
	};
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	return { t, page, asked, openFile, close };
}

/** The middle of the `nth` `name` in the code line under `scope` that has `line` in it. */
async function pointOf(page: Page, scope: string, line: string, name: string, nth = 0) {
	const p = await page.evaluate(([scope, line, name, nth]) => {
		const code = [...document.querySelectorAll(`${scope} .code`)].find((c) => c.textContent!.includes(line as string));
		if (!code) return null;
		code.scrollIntoView({ block: "center" });
		let at = -1;
		for (let k = 0; k <= (nth as number); k++) at = code.textContent!.indexOf(name as string, at + 1);
		const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
		for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
			if (at < n.data.length) {
				const r = document.createRange();
				r.setStart(n, at);
				r.setEnd(n, Math.min(n.data.length, at + (name as string).length));
				const b = r.getBoundingClientRect();
				return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
			}
			at -= n.data.length;
		}
		return null;
	}, [scope, line, name, nth] as const);
	assert.ok(p, `no "${name}" in a line with "${line}" under ${scope}`);
	return p;
}
const clickName = async (page: Page, scope: string, line: string, name: string, nth = 0) => {
	const p = await pointOf(page, scope, line, name, nth);
	await page.mouse.click(p.x, p.y);
};
const panel = (page: Page) => page.locator("#code-panel");
const target = (page: Page) => panel(page).locator(".code-line.target");
const lookups = (asked: string[]) => asked.filter((u) => u === "/api/code/lookup").length;

test("21. a click on a call opens the code panel on the file that defines it, at that line", async () => {
	const { page, asked, openFile, close } = await open();
	try {
		await openFile("pkg/cli.py");
		await clickName(page, ".pane.after", "return [normalize_doi", "normalize_doi");
		await panel(page).waitFor();
		await target(page).waitFor();
		assert.equal(await panel(page).locator(".nav-name").textContent(), "normalize_doi");
		assert.match((await panel(page).locator(".nav-sig").textContent())!, /def normalize_doi\(s/);
		assert.match((await panel(page).locator(".nav-doc").textContent())!, /Lower-case a DOI/);
		assert.equal(await panel(page).locator(".nav-where").textContent(), "pkg/doi.py:6");
		assert.equal(await target(page).locator(".code").textContent(), "def normalize_doi(s):");
		assert.equal(await target(page).locator(".ln").textContent(), "6");
		// the whole file is there, coloured, and the line is in view
		assert.equal(await panel(page).locator(".code-line").count(), 8);
		assert.ok(await panel(page).locator(".code-line .hljs-keyword").count() > 0);
		const box = await target(page).boundingBox(), pane = await panel(page).boundingBox();
		assert.ok(box && pane && box.y >= pane.y && box.y + box.height <= pane.y + pane.height, "the definition line is not in view");
		// the page under the panel is still the PR's files, and nothing left Nudgebox
		assert.match(page.url(), /#pr\/jeonglab-bcm\/labbot\/4\/files$/);
		assert.equal(lookups(asked), 1);
	} finally {
		await close();
	}
});

test("21. the panel lists where the name is used; a use opens its file at that line", async () => {
	const { page, openFile, close } = await open();
	try {
		await openFile("pkg/cli.py");
		await clickName(page, ".pane.after", "return [normalize_doi", "normalize_doi");
		await target(page).waitFor();
		const uses = panel(page).locator(".nav-modes button", { hasText: "Used in" });
		assert.equal((await uses.textContent())!.trim(), "Used in 4 places");
		await uses.click();
		assert.deepEqual(await panel(page).locator(".use-file").allTextContents(), ["pkg/cli.py", "tests/test_doi.py"]);
		assert.deepEqual(await panel(page).locator(".use").allTextContents(), ["1from pkg.doi import normalize_doi", "6return [normalize_doi(a) for a in argv]", "1from pkg.doi import normalize_doi", '4assert normalize_doi("DOI:X") == "x"']);
		await panel(page).locator(".use", { hasText: "assert normalize_doi" }).click();
		await target(page).waitFor();
		assert.equal(await panel(page).locator(".nav-where").textContent(), "tests/test_doi.py:4");
		assert.equal(await target(page).locator(".code").textContent(), '    assert normalize_doi("DOI:X") == "x"');
		// and back to the definition
		await panel(page).locator(".nav-modes button", { hasText: "Definition" }).click();
		await page.waitForFunction(() => document.querySelector("#code-panel .nav-where")?.textContent === "pkg/doi.py:6");
	} finally {
		await close();
	}
});

test("21. a name in the panel leads further, Back returns, Escape closes", async () => {
	const { page, asked, openFile, close } = await open();
	try {
		await openFile("pkg/cli.py");
		await clickName(page, ".pane.after", "return [normalize_doi", "normalize_doi");
		await target(page).waitFor();
		assert.equal(await panel(page).locator(".nav-back").count(), 0);
		// inside doi.py: the call to strip
		await clickName(page, "#code-panel", "return strip(s)", "strip");
		await page.waitForFunction(() => document.querySelector("#code-panel .nav-name")?.textContent === "strip");
		await page.waitForFunction(() => document.querySelector("#code-panel .nav-where")?.textContent === "pkg/doi.py:3");
		assert.equal(await target(page).locator(".code").textContent(), "def strip(s):");
		await panel(page).locator(".nav-back").click();
		assert.equal(await panel(page).locator(".nav-name").textContent(), "normalize_doi");
		assert.equal(await panel(page).locator(".nav-where").textContent(), "pkg/doi.py:6");
		assert.equal(lookups(asked), 2); // Back asks nothing again
		await page.keyboard.press("Escape");
		await panel(page).waitFor({ state: "detached" });
		assert.match(page.url(), /#pr\/jeonglab-bcm\/labbot\/4\/files$/);
		assert.equal(await page.locator(".file-diff").count(), 1); // the diff is as it was
	} finally {
		await close();
	}
});

test("21. no panel for a comment, a keyword, the old side, a double click, or a language without a server", async () => {
	const { page, asked, openFile, close } = await open();
	try {
		await openFile("pkg/cli.py");
		await clickName(page, ".pane.after", "# normalize_doi cleans", "normalize_doi"); // in a comment
		await clickName(page, ".pane.after", "return [normalize_doi", "return"); // a keyword
		await clickName(page, ".pane.before", "return [normalize_doi", "normalize_doi"); // the old version
		const p = await pointOf(page, ".pane.after", "return [normalize_doi", "normalize_doi");
		await page.mouse.dblclick(p.x, p.y); // selects the word
		assert.equal(await page.evaluate(() => String(getSelection())), "normalize_doi");
		await openFile("R/plot.R");
		await clickName(page, ".file-diff:last-child .pane.after", "normalize_doi(x)", "normalize_doi");
		await page.waitForTimeout(600);
		assert.equal(await panel(page).count(), 0);
		assert.equal(lookups(asked), 0);
	} finally {
		await close();
	}
});

test("21. without language servers the code is as before: nothing to click", async () => {
	const { page, asked, openFile, close } = await open({ code: false });
	try {
		await openFile("pkg/cli.py");
		await clickName(page, ".pane.after", "return [normalize_doi", "normalize_doi");
		await page.waitForTimeout(500);
		assert.equal(await panel(page).count(), 0);
		assert.equal(lookups(asked), 0);
	} finally {
		await close();
	}
});

test("21. a name of the language itself: the panel says it is defined outside the repo, and lists its uses", async () => {
	const { page, openFile, close } = await open();
	try {
		await openFile("pkg/cli.py");
		await clickName(page, ".pane.after", "print(len(argv))", "len");
		await panel(page).locator(".nav-outside").waitFor();
		assert.equal(await panel(page).locator(".nav-name").textContent(), "len");
		assert.match((await panel(page).locator(".nav-outside").textContent())!, /outside this repository/);
		assert.match((await panel(page).locator(".nav-sig").textContent())!, /len\(/);
		assert.deepEqual(await panel(page).locator(".use").allTextContents(), ["5print(len(argv))"]);
		assert.equal(await panel(page).locator(".nav-modes button", { hasText: "Definition" }).isDisabled(), true);
		await panel(page).locator(".nav-close").click();
		await panel(page).waitFor({ state: "detached" });
	} finally {
		await close();
	}
});

test("21. on a phone a tap opens the panel over the whole screen; the browser's Back closes it", async () => {
	const { page, openFile, close } = await open({ device: PHONE });
	try {
		await openFile("pkg/cli.py");
		const p = await pointOf(page, ".unified .u-add", "return [normalize_doi", "normalize_doi");
		await page.touchscreen.tap(p.x, p.y);
		await target(page).waitFor();
		const box = (await panel(page).boundingBox())!;
		assert.ok(box.x === 0 && box.width === 390 && box.height >= 800, `the panel is ${JSON.stringify(box)}`);
		assert.equal(await panel(page).locator(".nav-where").textContent(), "pkg/doi.py:6");
		assert.equal(await target(page).locator(".code").textContent(), "def normalize_doi(s):");
		// nothing is wider than the screen
		assert.equal(await page.evaluate(() => document.querySelector("#code-panel")!.scrollWidth), 390);
		await page.goBack();
		await panel(page).waitFor({ state: "detached" });
		assert.match(page.url(), /#pr\/jeonglab-bcm\/labbot\/4\/files$/);
		assert.equal(await page.locator(".unified").count(), 1);
	} finally {
		await close();
	}
});
