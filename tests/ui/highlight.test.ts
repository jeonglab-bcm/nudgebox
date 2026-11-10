/**
 * SPEC 15, syntax highlighting (issue 44). Code in a diff is coloured by its language,
 * under omnidiff's change marks, in a real browser. The highlighter is served by Nudgebox.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContextOptions } from "playwright-core";
import { start } from "../helpers/harness.ts";
import type { DiffResult } from "../../src/omnidiff.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
after(closeBrowser);

const at = (row: number, a: number, b: number) => ({ from: { row, col: a }, to: { row, col: b } });
const one = (row: number, a: number, b: number): DiffResult => ({ largeResidual: false, before: { hunks: [{ op: "update", ...at(row, a, b) }] }, after: { hunks: [{ op: "update", ...at(row, a, b) }] } });

// each file: both versions, and the one change omnidiff reports in it
const BIG = Array.from({ length: 6000 }, (_, i) => `value_${i} = "text ${i}"  # a comment`).join("\n") + "\n";
const FILES: Record<string, { before: string; after: string; diff: DiffResult }> = {
	"src/limit.ts": {
		before: 'export const limit = 10; // per minute\nconst name = "hello world";\n',
		after: 'export const limit = 20; // per minute\nconst name = "hello there";\n',
		// the number, and the second word inside the string
		diff: { largeResidual: false,
			before: { hunks: [{ op: "update", ...at(0, 21, 23) }, { op: "update", ...at(1, 20, 25) }] },
			after: { hunks: [{ op: "update", ...at(0, 21, 23) }, { op: "update", ...at(1, 20, 25) }] } },
	},
	"scripts/run.py": {
		before: 'def main():\n    return "x"  # done\n',
		after: 'def main():\n    return "y"  # done\n',
		diff: one(1, 11, 14),
	},
	"R/plot.R": {
		before: "draw <- function(x) {\n  # the plot\n  TRUE\n}\n",
		after: "draw <- function(x) {\n  # the plot\n  FALSE\n}\n",
		diff: one(2, 2, 6),
	},
	"data/notes.xyz": {
		before: "const limit = 10; // not code\n",
		after: "const limit = 20; // not code\n",
		diff: one(0, 14, 16),
	},
	"big/table.py": { before: BIG, after: BIG.replace("text 3000", "text 3001"), diff: one(3000, 14, 23) },
};

async function open(o: { device?: BrowserContextOptions; theme?: "dark"; hash?: string } = {}) {
	const t = await start({ diff: async (a, b) => FILES[(b ?? a)!.path].diff });
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Raise the limit", headSha: "head-sha" });
	t.github.pages.set(`${LAB}#4`, { baseRef: "main", headRef: "feature", commits: 1, additions: 5, deletions: 5, changedFiles: 5,
		timeline: [{ type: "review", id: "r1", author: "jlee", state: "COMMENTED", body: "One note.", at: "2026-11-02T11:00:00Z" }],
		threads: [{
			id: "t1", path: "src/limit.ts", line: 1, startLine: null, side: "RIGHT", resolved: false, outdated: false, reviewId: "r1",
			diffHunk: "@@ -1,2 +1,2 @@\n-export const limit = 10; // per minute\n+export const limit = 20; // per minute",
			comments: [{ id: "tc1", author: "jlee", body: "Make it a setting.", at: "2026-11-02T11:00:00Z", pending: false }],
		}] });
	t.github.prFileSets.set(`${LAB}#4`, { base: "base-sha", head: "head-sha", files: Object.keys(FILES).map((path) => ({ path, status: "modified" as const, additions: 1, deletions: 1 })) });
	for (const [path, f] of Object.entries(FILES)) {
		t.github.blobs.set(`${LAB}@base-sha:${path}`, f.before);
		t.github.blobs.set(`${LAB}@head-sha:${path}`, f.after);
	}
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext({ ...(o.device ?? DESKTOP), ...(o.theme ? { colorScheme: o.theme } : {}) });
	const page = await ctx.newPage();
	const asked: string[] = [];
	page.on("request", (r) => asked.push(r.url()));
	await page.goto(`${side.url}#pr/${LAB}/4${o.hash ?? "/files"}`);
	await page.waitForSelector(o.hash === "" ? "#pr-page .pr-head" : ".file");
	/** Open one file's diff and give back its box. */
	const diffOf = async (path: string) => {
		await page.locator(".file", { hasText: path }).locator(".path").click();
		const box = page.locator(".file-diff").last();
		await box.locator(".m-update").first().waitFor();
		return box;
	};
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	return { t, page, side, asked, diffOf, close };
}

/** The text of every token of one kind in a diff, e.g. keyword. */
const tokens = (box: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["diffOf"]>>, kind: string) => box.locator(`.code .hljs-${kind}`).allTextContents();

test("15. TypeScript, Python and R are coloured by their language; nothing is asked of another site", async () => {
	const s = await open();
	try {
		const ts = await s.diffOf("src/limit.ts");
		await ts.locator(".code .hljs-keyword").first().waitFor();
		assert.deepEqual([...new Set(await tokens(ts, "keyword"))].sort(), ["const", "export"]);
		assert.ok((await tokens(ts, "comment")).includes("// per minute"));
		assert.ok((await tokens(ts, "number")).includes("20"));
		// the text is what it was: colours add no characters and drop none
		assert.deepEqual(await ts.locator(".pane.after .code").allTextContents(), ['export const limit = 20; // per minute', 'const name = "hello there";']);
		await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").click();

		const py = await s.diffOf("scripts/run.py");
		await py.locator(".code .hljs-keyword").first().waitFor();
		assert.ok((await tokens(py, "keyword")).includes("def") && (await tokens(py, "keyword")).includes("return"));
		assert.ok((await tokens(py, "comment")).includes("# done"));
		assert.ok((await tokens(py, "string")).some((x) => x.includes("y")));
		await s.page.locator(".file", { hasText: "scripts/run.py" }).locator(".path").click();

		const r = await s.diffOf("R/plot.R");
		await r.locator(".code .hljs-keyword").first().waitFor();
		assert.ok((await tokens(r, "keyword")).includes("function"));
		assert.ok((await tokens(r, "comment")).includes("# the plot"));

		assert.ok(s.asked.some((u) => u.includes("/vendor/highlight")), "the highlighter was not loaded");
		assert.deepEqual(s.asked.filter((u) => !u.startsWith(s.side.url)), [], "a request left Nudgebox");
	} finally {
		await s.close();
	}
});

test("15. a change mark stays on top of the colours, also when it starts inside a token", async () => {
	const s = await open();
	try {
		const ts = await s.diffOf("src/limit.ts");
		await ts.locator(".code .hljs-keyword").first().waitFor();
		const marks = ts.locator(".pane.after .m-update");
		assert.deepEqual(await marks.allTextContents(), ["20", "there"]);
		assert.equal(await marks.nth(0).locator(".hljs-number").textContent(), "20", "the changed number is not coloured as a number");
		assert.equal(await marks.nth(1).locator(".hljs-string").textContent(), "there", "the changed part of the string is not coloured as a string");
		const look = await marks.nth(1).evaluate((m) => ({ mark: getComputedStyle(m).backgroundColor, token: getComputedStyle(m.firstElementChild!).backgroundColor }));
		assert.notEqual(look.mark, "rgba(0, 0, 0, 0)", "the mark has no background");
		assert.equal(look.token, "rgba(0, 0, 0, 0)", "a token paints over the mark");
	} finally {
		await s.close();
	}
});

for (const theme of ["light", "dark"] as const) {
	test(`15. keywords, strings and comments each have their own colour in the ${theme} theme`, async () => {
		const s = await open(theme === "dark" ? { theme } : {});
		try {
			const ts = await s.diffOf("src/limit.ts");
			await ts.locator(".code .hljs-keyword").first().waitFor();
			const colour = (sel: string) => ts.locator(sel).first().evaluate((e) => getComputedStyle(e).color);
			const [plain, keyword, string, comment, number] = await Promise.all([".pane.after .code", ".code .hljs-keyword", ".code .hljs-string", ".code .hljs-comment", ".code .hljs-number"].map(colour));
			assert.equal(new Set([plain, keyword, string, comment, number]).size, 5, `colours repeat: ${[plain, keyword, string, comment, number].join(" | ")}`);
		} finally {
			await s.close();
		}
	});
}

test("15. on a phone the one column is coloured too", async () => {
	const s = await open({ device: PHONE });
	try {
		const py = await s.diffOf("scripts/run.py");
		await py.locator(".unified .code .hljs-keyword").first().waitFor();
		assert.ok((await tokens(py, "keyword")).includes("def"));
		assert.equal(await py.locator(".u-add .m-update .hljs-string").textContent(), '"y"');
		assert.deepEqual(await py.locator(".u-add .code").allTextContents(), ['    return "y"  # done']);
	} finally {
		await s.close();
	}
});

test("15. a file of an unknown kind and a very large file stay plain", async () => {
	const s = await open();
	try {
		// a known file first, so the highlighter is loaded when the others are drawn
		const ts = await s.diffOf("src/limit.ts");
		await ts.locator(".code .hljs-keyword").first().waitFor();
		await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").click();

		const xyz = await s.diffOf("data/notes.xyz");
		assert.equal(await xyz.locator(".code [class*=hljs-]").count(), 0);
		assert.deepEqual(await xyz.locator(".pane.after .code").allTextContents(), ["const limit = 20; // not code"]);
		await s.page.locator(".file", { hasText: "data/notes.xyz" }).locator(".path").click();

		const big = await s.diffOf("big/table.py");
		assert.equal(await big.locator(".pane.after .m-update").textContent(), "text 3001");
		assert.equal(await big.locator(".code [class*=hljs-]").count(), 0);
	} finally {
		await s.close();
	}
});

test("15. the code above a review thread is coloured, with its + and − in front", async () => {
	const s = await open({ hash: "" });
	try {
		const hunk = s.page.locator(".thread .hunk");
		await hunk.locator(".hljs-keyword").first().waitFor();
		assert.deepEqual(await hunk.locator("div").allTextContents(), ["-export const limit = 10; // per minute", "+export const limit = 20; // per minute"]);
		assert.deepEqual(await hunk.locator(".h-add .hljs-number").allTextContents(), ["20"]);
		assert.deepEqual(await hunk.locator(".h-add .hljs-comment").allTextContents(), ["// per minute"]);
	} finally {
		await s.close();
	}
});
