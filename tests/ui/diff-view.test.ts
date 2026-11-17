/**
 * SPEC 15 and 17. How a diff reads: one column with the new line under the old line, no
 * colour without a name, and functions that fold and that the model can explain.
 * Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContextOptions, Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import type { DiffResult } from "../../src/omnidiff.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
after(closeBrowser);

/** A Python file: `mean` and `Report.render` each have one changed line, deep in the body. */
const py = (div: string, sep: string) => `import math

def mean(xs):
    """The mean of xs."""
    total = 0
    count = 0
    for x in xs:
        total += x
        count += 1
    result = total ${div} count
    return result

class Report:
    def title(self):
        name = "Report"
        return name

    def render(
        self,
        rows,
    ):
        out = []
        for r in rows:
            out.append(str(r))
        text = "${sep}".join(out)
        return text

def unused():
    a = 1
    b = 2
    return a + b

LIMIT = 10
`;
const r = (scale: string) => `library(ggplot2)

draw <- function(df) {
  p <- ggplot(df)
  p <- p + geom_point()
  p <- p + theme_minimal()
  p <- p + labs(title = "A")
  p <- p + scale_x_${scale}()
  p
}

other <- 1
`;
const at = (row: number, a: number, b: number) => ({ from: { row, col: a }, to: { row, col: b } });
const PY_DIFF: DiffResult = {
	largeResidual: false, language: "Python",
	before: { hunks: [{ op: "update", ...at(9, 19, 21) }, { op: "update", ...at(24, 16, 18) }] },
	after: { hunks: [{ op: "update", ...at(9, 19, 20) }, { op: "update", ...at(24, 16, 18) }] },
};
const R_DIFF: DiffResult = { largeResidual: false, language: "R", before: { hunks: [{ op: "update", ...at(7, 19, 25) }] }, after: { hunks: [{ op: "update", ...at(7, 19, 24) }] } };

async function open(o: { device?: BrowserContextOptions; file?: "stats.py" | "plot.R"; moved?: boolean } = {}) {
	const file = o.file ?? "stats.py";
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "True division", requestedReviewers: ["hwan"] });
	t.github.prFileSets.set(`${LAB}#4`, { base: "base-sha", head: "head-sha", files: [{ path: file, status: "modified", additions: 2, deletions: 2 }] });
	t.github.blobs.set(`${LAB}@base-sha:stats.py`, py("//", ", "));
	t.github.blobs.set(`${LAB}@head-sha:stats.py`, py("/", "\\n"));
	t.github.blobs.set(`${LAB}@base-sha:plot.R`, r("log10"));
	t.github.blobs.set(`${LAB}@head-sha:plot.R`, r("sqrt"));
	t.differ.reply = structuredClone(file === "stats.py" ? PY_DIFF : R_DIFF);
	if (o.moved) for (const side of [t.differ.reply.before, t.differ.reply.after]) side!.hunks.push({ op: "move", ...at(28, 4, 9) });
	t.llm.reply = "`mean` divides the sum of `xs` by the count. The pull request changes `//` to `/`.";
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(o.device ?? DESKTOP);
	await ctx.route("https://github.com/**", (x) => x.fulfill({ body: "github" }));
	const page = await ctx.newPage();
	const diff = async () => {
		await page.goto("about:blank"); // so that the next line loads the page, and does not only change the hash
		await page.goto(`${side.url}#pr/jeonglab-bcm/labbot/4/files`);
		await page.locator(".file .path").first().click();
		await page.waitForSelector(".file-diff .m-update");
	};
	await diff();
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	return { t, page, diff, close };
}
const code = (page: Page, sel: string) => page.locator(`${sel} .code`).evaluateAll((xs) => xs.map((x) => x.textContent!.trim()));
/** The colour behind an element, without its strength: a mark on a tinted line is a little stronger. */
const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((x) => getComputedStyle(x).backgroundColor.replace(/\s*\/.*\)$/, ")"));

test("15. on a computer a diff opens as one column: the new line just under the old line", async () => {
	const s = await open();
	try {
		assert.equal(await s.page.locator(".file-diff .pane").count(), 0);
		assert.deepEqual(await code(s.page, ".unified .u-del + .u-add"), ["result = total / count", 'text = "\\n".join(out)']);
		assert.deepEqual(await code(s.page, ".unified .u-del"), ["result = total // count", 'text = ", ".join(out)']);
		assert.equal(await s.page.getByRole("button", { name: "One column" }).getAttribute("aria-pressed"), "true");
		assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page scrolls sideways");
	} finally {
		await s.close();
	}
});

test("15. Side by side shows the two panes, and the choice is kept", async () => {
	const s = await open();
	try {
		await s.page.getByRole("button", { name: "Side by side" }).click();
		await s.page.waitForSelector(".pane.after .m-update");
		assert.equal(await s.page.locator(".file-diff .unified").count(), 0);
		const [b, a] = await Promise.all([".pane.before", ".pane.after"].map((p) => s.page.locator(p).boundingBox()));
		assert.ok(Math.abs(b!.y - a!.y) < 5 && a!.x > b!.x, "the panes are not side by side");
		await s.diff(); // the page, loaded again
		assert.equal(await s.page.locator(".file-diff .pane").count(), 2);
		await s.page.getByRole("button", { name: "One column" }).click();
		await s.page.waitForSelector(".unified .u-add");
		assert.equal(await s.page.locator(".file-diff .pane").count(), 0);
	} finally {
		await s.close();
	}
});

test("15. a phone has one column and no layout switch", async () => {
	const s = await open({ device: PHONE });
	try {
		assert.equal(await s.page.locator(".unified .u-add").count(), 2);
		assert.equal(await s.page.locator(".layout-switch").count(), 0);
		assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page scrolls sideways");
	} finally {
		await s.close();
	}
});

test("15. rewritten text is red on the old side and green on the new side, and a key names the colours", async () => {
	const s = await open();
	try {
		assert.match(await s.page.locator(".diff-key").innerText(), /removed\s+added/);
		const [red, green] = [await bg(s.page, ".diff-key .m-delete"), await bg(s.page, ".diff-key .m-insert")];
		assert.notEqual(red, green);
		assert.equal(await bg(s.page, ".unified .u-del .m-update"), red);
		assert.equal(await bg(s.page, ".unified .u-add .m-update"), green);
		assert.equal(await s.page.locator(".unified .u-del .m-update").first().getAttribute("title"), "removed");
		assert.equal(await s.page.locator(".unified .u-add .m-update").first().getAttribute("title"), "added");
		await s.page.getByRole("button", { name: "Side by side" }).click();
		await s.page.waitForSelector(".pane.after .m-update");
		assert.equal(await bg(s.page, ".pane.before .m-update"), red);
		assert.equal(await bg(s.page, ".pane.after .m-update"), green);
		assert.equal(await s.page.locator(".diff-key .m-move").count(), 0); // nothing moved in this diff
	} finally {
		await s.close();
	}
});

test("15. text that only moved is blue, and the key says that it did not change", async () => {
	const s = await open({ moved: true });
	try {
		assert.match(await s.page.locator(".diff-key .m-move").innerText(), /moved, not changed/);
		assert.equal(await s.page.locator(".unified .u-moved .m-move").first().getAttribute("title"), "moved, not changed");
	} finally {
		await s.close();
	}
});

test("15. the first line of each function around a change is shown, and the function folds", async () => {
	const s = await open();
	try {
		// `def mean(xs):` is 7 lines above its change, and `def render(` is 7 lines above its change
		assert.deepEqual(await code(s.page, ".unified .fn-head"), ["def mean(xs):", "class Report:", "def render(", "def unused():"]);
		await s.page.locator('button[aria-label="Fold function mean"]').click();
		assert.match(await s.page.locator(".fn-folded").innerText(), /8 lines folded · changes inside/);
		assert.deepEqual(await code(s.page, ".unified .u-del"), ['text = ", ".join(out)']); // the change in `mean` is folded away
		assert.equal(await s.page.locator('button[aria-label="Unfold function mean"]').getAttribute("aria-expanded"), "false");
		// the fold holds side by side, in both panes
		await s.page.getByRole("button", { name: "Side by side" }).click();
		await s.page.waitForSelector(".pane.after .fn-folded");
		assert.equal(await s.page.locator(".pane.before .fn-folded").count(), 1);
		assert.ok(!(await code(s.page, ".pane.after .code-line")).includes("result = total / count"));
		// the folded bar opens it again
		await s.page.locator(".pane.after .fn-folded").click();
		assert.equal(await s.page.locator(".fn-folded").count(), 0);
		assert.ok((await code(s.page, ".pane.after .code-line")).includes("result = total / count"));
	} finally {
		await s.close();
	}
});

test("15. Fold all folds every function, a class stays open, and Unfold all opens them", async () => {
	const s = await open();
	try {
		await s.page.locator(".fold-all").click();
		assert.deepEqual(await code(s.page, ".unified .u-line"), ["def mean(xs):", "", "class Report:", "def render(", "", "def unused():"]);
		assert.equal(await s.page.locator(".fn-folded").count(), 2);
		assert.match(await s.page.locator(".fold-all").innerText(), /Unfold all/);
		await s.page.locator(".fold-all").click();
		assert.equal(await s.page.locator(".fn-folded").count(), 0);
		assert.equal(await s.page.locator(".unified .u-add").count(), 2);
	} finally {
		await s.close();
	}
});

test("15. a function in an R file folds", async () => {
	const s = await open({ file: "plot.R" });
	try {
		assert.deepEqual(await code(s.page, ".unified .fn-head"), ["draw <- function(df) {"]);
		await s.page.locator('button[aria-label="Fold function draw"]').click();
		assert.match(await s.page.locator(".fn-folded").innerText(), /7 lines folded · changes inside/);
		assert.equal(await s.page.locator(".unified .u-add").count(), 0);
	} finally {
		await s.close();
	}
});

test("17. Explain on a function: the model reads only that function, and the answer shows under its first line", async () => {
	const s = await open();
	try {
		await s.page.locator('button[aria-label="Explain function mean (AI)"]').click();
		await s.page.waitForSelector(".fn-explained code");
		assert.match(await s.page.locator(".fn-explained").innerText(), /mean divides the sum of xs by the count\. The pull request changes \/\/ to \/\./);
		// right under `def mean(xs):`
		assert.ok(await s.page.locator(".unified .fn-head").first().evaluate((x) => x.nextElementSibling!.classList.contains("fn-explained")));
		const [call] = s.t.llm.calls;
		for (const want of ["File: stats.py", "Pull request: True division", "  def mean(xs):", "-     result = total // count", "+     result = total / count", "      return result"]) {
			assert.ok(call.user.includes(want), `prompt lacks ${JSON.stringify(want)}`);
		}
		for (const not of ["class Report", "import math", "render"]) assert.ok(!call.user.includes(not), `prompt has ${not}, which is not in the function`);
		assert.match(call.system, /one function/);
		// ✕ puts it away; the next Explain does not ask the model again
		await s.page.locator(".fn-explained-close").click();
		assert.equal(await s.page.locator(".fn-explained").count(), 0);
		await s.page.locator('button[aria-label="Explain function mean (AI)"]').click();
		await s.page.waitForSelector(".fn-explained code");
		assert.equal(s.t.llm.calls.length, 1);
	} finally {
		await s.close();
	}
});

test("17. on a phone the function buttons are icons, and the explanation fits", async () => {
	const s = await open({ device: PHONE });
	try {
		const b = s.page.locator('button[aria-label="Explain function mean (AI)"]');
		assert.equal(await b.locator(".word").evaluate((x) => getComputedStyle(x).display), "none");
		await b.click();
		await s.page.waitForSelector(".fn-explained code");
		assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page scrolls sideways");
	} finally {
		await s.close();
	}
});
