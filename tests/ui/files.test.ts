/**
 * SPEC 15. The Files view and a diff, in a real browser. omnidiff is stood in for by the
 * harness's differ, whose answer each test sets. Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContextOptions } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
after(closeBrowser);

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";
const BEFORE = lines(30, (i) => (i === 14 ? "const limit = 10; // café" : `line ${i + 1}`));
const AFTER = lines(30, (i) => (i === 14 ? "const limit = 20; // café" : `line ${i + 1}`));
const at = (row: number, a: number, b: number) => ({ from: { row, col: a }, to: { row, col: b } });

async function open(device: BrowserContextOptions = DESKTOP) {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Raise the limit", requestedReviewers: ["hwan"] });
	t.github.prFileSets.set(`${LAB}#4`, {
		base: "base-sha", head: "head-sha",
		files: [
			{ path: "src/limit.ts", status: "modified", additions: 1, deletions: 1 },
			{ path: "assets/logo.png", status: "modified", additions: 0, deletions: 0 },
			{ path: "docs/new.md", status: "added", additions: 3, deletions: 0 },
		],
	});
	t.github.blobs.set(`${LAB}@base-sha:src/limit.ts`, BEFORE);
	t.github.blobs.set(`${LAB}@head-sha:src/limit.ts`, AFTER);
	t.github.blobs.set(`${LAB}@base-sha:assets/logo.png`, Buffer.from([0x89, 0x50, 0, 1]));
	t.github.blobs.set(`${LAB}@head-sha:assets/logo.png`, Buffer.from([0x89, 0x50, 0, 2]));
	t.github.blobs.set(`${LAB}@head-sha:docs/new.md`, "# New\n\nText.\n");
	t.differ.reply = { largeResidual: false, language: "TypeScript", before: { hunks: [{ op: "update", ...at(14, 14, 16) }] }, after: { hunks: [{ op: "update", ...at(14, 14, 16) }] } };
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(device);
	await ctx.route("https://github.com/**", (r) => r.fulfill({ body: "github" }));
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

test("15. f opens the Files view of the selected PR; Escape returns to the list", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("f");
		await s.page.waitForSelector(".file");
		assert.match(s.page.url(), /#files\/jeonglab-bcm\/labbot\/4$/);
		const rows = await s.page.locator(".file .path").allTextContents();
		assert.deepEqual(rows, ["src/limit.ts", "assets/logo.png", "docs/new.md"]);
		assert.match((await s.page.locator(".file").first().textContent())!, /\+1.*−1/);
		assert.match((await s.page.locator(".file").nth(2).locator(".status").getAttribute("title"))!, /added/);
		await s.page.keyboard.press("Escape");
		await s.page.waitForSelector(".row");
	} finally {
		await s.close();
	}
});

test("15. a file's diff marks only the changed part and folds unchanged lines", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("f");
		await s.page.click(".file >> nth=0");
		await s.page.waitForSelector(".diff .m-update");
		assert.deepEqual(await s.page.locator(".pane.before .m-update").allTextContents(), ["10"]);
		assert.deepEqual(await s.page.locator(".pane.after .m-update").allTextContents(), ["20"]);
		assert.equal(await s.page.locator(".pane.after .code-line").count(), 7); // the change and 3 lines on each side
		assert.match((await s.page.locator(".pane.after .fold").first().textContent())!, /11 unchanged lines/);
		assert.deepEqual(s.t.differ.calls.map((c) => c.map((x) => x?.path)), [["src/limit.ts", "src/limit.ts"]]);
	} finally {
		await s.close();
	}
});

test("15. before and after side by side on a computer, one above the other on a phone", async () => {
	for (const [device, sideBySide] of [[DESKTOP, true], [PHONE, false]] as const) {
		const s = await open(device);
		try {
			await s.page.keyboard.press("f").catch(() => {});
			if (!(await s.page.locator(".file").count())) await s.page.evaluate(() => (location.hash = "#files/jeonglab-bcm/labbot/4"));
			await s.page.locator(".file").first().click();
			await s.page.waitForSelector(".pane.after .m-update");
			const [b, a] = await Promise.all([".pane.before", ".pane.after"].map((p) => s.page.locator(p).boundingBox()));
			assert.equal(Math.abs(b!.y - a!.y) < 5, sideBySide, `before at ${b!.x},${b!.y}; after at ${a!.x},${a!.y}`);
			assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page scrolls sideways");
		} finally {
			await s.close();
		}
	}
});

test("15. moved code is marked as moved, with the line it moved to", async () => {
	const s = await open();
	try {
		s.t.differ.reply = {
			largeResidual: false, summary: "refactor_moved_only",
			before: { hunks: [{ op: "move", ...at(14, 0, 5), target: at(20, 0, 5) }] },
			after: { hunks: [{ op: "move", ...at(20, 0, 5), target: at(14, 0, 5) }] },
		};
		await s.page.keyboard.press("f");
		await s.page.click(".file >> nth=0");
		await s.page.waitForSelector(".pane.before .m-move");
		assert.match((await s.page.locator(".pane.before .m-move").getAttribute("title"))!, /moved to line 21/);
		assert.match((await s.page.locator(".pane.after .m-move").getAttribute("title"))!, /moved from line 15/);
		assert.match((await s.page.locator(".diff .note").textContent())!, /only moved/i);
	} finally {
		await s.close();
	}
});

test("15. a binary file omnidiff cannot read says so and links to GitHub", async () => {
	const s = await open();
	try {
		s.t.differ.reply = { largeResidual: false, binary: true, before: { hunks: [] }, after: { hunks: [] } } as never;
		await s.page.keyboard.press("f");
		await s.page.click(".file >> nth=1");
		await s.page.waitForSelector(".diff .note");
		assert.match((await s.page.locator(".diff .note").textContent())!, /no content diff/i);
		assert.match((await s.page.locator(".diff .note a").getAttribute("href"))!, /github\.com\/jeonglab-bcm\/labbot\/pull\/4\/files/);
	} finally {
		await s.close();
	}
});

test("15. an added file shows only its new version", async () => {
	const s = await open();
	try {
		s.t.differ.reply = { largeResidual: false, summary: "new_file", before: { hunks: [] }, after: { hunks: [{ op: "insert", from: { row: 0, col: 0 }, to: { row: 3, col: 0 } }] } };
		await s.page.keyboard.press("f");
		await s.page.click(".file >> nth=2");
		await s.page.waitForSelector(".md-pane.after .md-added"); // a Markdown file, so rendered
		assert.equal(await s.page.locator(".md-pane.before, .pane.before").count(), 0);
		assert.match((await s.page.locator(".diff .note").textContent())!, /new file/i);
	} finally {
		await s.close();
	}
});

// -- Markdown (SPEC 15) ------------------------------------------------------------------

const MD_BEFORE = "# Guide\n\nIntro text.\n\n## Install\n\nRun `make`.\n\n## Use\n\nOld usage.\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n";
const MD_AFTER = "# Guide\n\nIntro text.\n\n## Install\n\nRun `make`.\n\n## Use\n\nNew **usage** with [docs](https://example.org).\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n";

async function openMd(md = { before: MD_BEFORE, after: MD_AFTER }, reply?: object) {
	const s = await open();
	s.t.github.prFileSets.set(`${LAB}#4`, { base: "base-sha", head: "head-sha", files: [{ path: "docs/guide.md", status: "modified", additions: 1, deletions: 1 }] });
	s.t.github.blobs.set(`${LAB}@base-sha:docs/guide.md`, md.before);
	s.t.github.blobs.set(`${LAB}@head-sha:docs/guide.md`, md.after);
	s.t.differ.reply = (reply as typeof s.t.differ.reply) ?? { largeResidual: false, before: { hunks: [{ op: "update", ...at(10, 0, 10) }] }, after: { hunks: [{ op: "update", ...at(10, 0, 40) }] } };
	await s.page.keyboard.press("f");
	await s.page.click(".file >> nth=0");
	return s;
}

test("15. a Markdown file opens rendered, with the changed block marked on each side", async () => {
	const s = await openMd();
	try {
		await s.page.waitForSelector(".md-pane.after .md-block.changed");
		assert.ok((await s.page.locator(".md-pane.after h2").allTextContents()).includes("Use"), "the heading next to the change is shown");
		assert.equal(await s.page.locator(".md-pane.after .md-block.changed strong").textContent(), "usage");
		assert.equal(await s.page.locator(".md-pane.after .md-block.changed a").getAttribute("target"), "_blank");
		assert.match((await s.page.locator(".md-pane.before .md-block.changed").textContent())!, /Old usage/);
		assert.doesNotMatch((await s.page.locator(".md-pane.after").textContent())!, /\*\*|##/); // not raw
	} finally {
		await s.close();
	}
});

test("15. unchanged Markdown blocks fold, and the switch shows the plain diff", async () => {
	const s = await openMd();
	try {
		await s.page.waitForSelector(".md-pane.after .md-block.changed");
		assert.match((await s.page.locator(".md-pane.after .fold").last().textContent())!, /5 unchanged blocks/);
		await s.page.click(".diff >> text=Plain diff");
		await s.page.waitForSelector(".pane.after .code-line");
		assert.equal(await s.page.locator(".md-pane").count(), 0);
		await s.page.click(".diff >> text=Rendered");
		await s.page.waitForSelector(".md-pane.after");
	} finally {
		await s.close();
	}
});

test("15. rendered Markdown runs nothing from the file", async () => {
	const evil = "# Hi\n\n<img src=x onerror=\"window.pwned=1\">\n\n<script>window.pwned=2</script>\n\n<iframe src=\"https://example.org\"></iframe>\n\n[x](javascript:window.pwned=3)\n";
	const s = await openMd({ before: "# Hi\n", after: evil });
	try {
		await s.page.waitForSelector(".md-pane.after h1");
		await s.page.waitForTimeout(300);
		assert.equal(await s.page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined);
		assert.equal(await s.page.locator(".md-pane script, .md-pane iframe, .md-pane [onerror]").count(), 0);
		const href = await s.page.locator(".md-pane.after a").first().getAttribute("href").catch(() => null);
		assert.ok(!href || !href.startsWith("javascript:"), href ?? "");
	} finally {
		await s.close();
	}
});

test("15. in a list, only the changed item is marked", async () => {
	const before = "# List\n\n- one\n- two\n- three\n";
	const after = "# List\n\n- one\n- TWO, changed\n- three\n";
	const s = await openMd({ before, after }, { largeResidual: false, before: { hunks: [{ op: "update", ...at(3, 2, 5) }] }, after: { hunks: [{ op: "update", ...at(3, 2, 14) }] } });
	try {
		await s.page.waitForSelector(".md-pane.after .md-block.changed");
		assert.deepEqual((await s.page.locator(".md-pane.after .md-block.changed").allTextContents()).map((x) => x.trim()), ["TWO, changed"]);
		assert.deepEqual(await s.page.locator(".md-pane.after li").allTextContents(), ["one", "TWO, changed", "three"]);
	} finally {
		await s.close();
	}
});
