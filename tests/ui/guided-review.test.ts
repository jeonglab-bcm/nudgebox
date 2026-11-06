/**
 * SPEC 19. Guided review on the PR page, in a real browser: one step at a time, one key
 * per decision. The lab LLM is faked (see tests/acceptance/guided-review.test.ts).
 * Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP } from "../helpers/browser.ts";
import type { Prompt } from "../../src/llm.ts";

const LAB = "jeonglab-bcm/labbot";
const GUIDE = `#pr/${LAB}/4/guide`;
after(closeBrowser);

const lines = (f: (i: number) => string) => Array.from({ length: 30 }, (_, i) => f(i)).join("\n") + "\n";
const at = (row: number, a: number, b: number) => ({ from: { row, col: a }, to: { row, col: b } });
const ranges = { left: [[12, 18]] as [number, number][], right: [[12, 18]] as [number, number][] };
const file = (path: string) => ({ path, status: "modified" as const, additions: 1, deletions: 1, commentable: ranges });
const FILES = ["src/limit.ts", "src/limit.test.ts", "package-lock.json"];

const plan = { summary: "Raises the limit to 20.", steps: [
	{ title: "Raise the limit", summary: "The limit goes from 10 to 20.", files: ["src/limit.ts"] },
	{ title: "Test the limit", summary: "The test checks the new limit.", files: ["src/limit.test.ts"] },
] };
const DRAFTS = [
	{ path: "src/limit.ts", side: "RIGHT", line: 15, body: "First: is 20 safe?" },
	{ path: "src/limit.ts", side: "RIGHT", line: 16, body: "Second: the client still sends 10." },
	{ path: "src/limit.ts", side: "LEFT", line: 15, body: "Third: a nitpick." },
];
const model = (p: Prompt) =>
	p.system.startsWith("You plan") ? JSON.stringify(plan)
	: p.system.startsWith("You review") ? JSON.stringify({ summary: "s.", drafts: p.user.includes("=== src/limit.ts") ? DRAFTS : [] })
	: JSON.stringify({ real: true });

async function open() {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Raise the limit", headSha: "h1" });
	t.github.pages.set(`${LAB}#4`, { baseRef: "main", headRef: "feature", commits: 1, additions: 3, deletions: 3, changedFiles: 3, pendingReview: { id: "rv1", comments: 2 } });
	t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h1", files: FILES.map(file) });
	for (const f of FILES) {
		t.github.blobs.set(`${LAB}@b1:${f}`, lines((i) => (i === 14 ? `const limit = 10; // ${f}` : `line ${i + 1}`)));
		t.github.blobs.set(`${LAB}@h1:${f}`, lines((i) => (i === 14 ? `const limit = 20; // ${f}` : `line ${i + 1}`)));
	}
	t.differ.reply = { largeResidual: false, before: { hunks: [{ op: "update", ...at(14, 14, 16) }] }, after: { hunks: [{ op: "update", ...at(14, 14, 16) }] } };
	t.llm.answer = model;
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(DESKTOP);
	await ctx.route("https://github.com/**", (r) => r.fulfill({ body: "github" }));
	const page = await ctx.newPage();
	await page.goto(side.url + GUIDE);
	await page.waitForSelector(".guide-step");
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	const calls = (op: string) => t.github.calls.filter((c) => c.op === op);
	const state = async () => (await (await t.req(`/api/review?repo=${encodeURIComponent(LAB)}&number=4`, { as: "hyunhwanj" })).json());
	return { t, page, close, calls, state, url: side.url };
}

const text = async (page: Page, sel: string) => ((await page.locator(sel).first().textContent()) ?? "").replace(/\s+/g, " ");
async function until(f: () => Promise<boolean>, ms = 3000) {
	const end = Date.now() + ms;
	while (!(await f())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("19. the queue: one step at a time, and y k e x c s b each do one thing", async () => {
	const s = await open();
	try {
		assert.match(await text(s.page, ".guide-progress"), /Step 1 of 2/);
		assert.match(await text(s.page, ".guide-step"), /Raise the limit/);
		assert.match(await text(s.page, ".guide-step"), /The limit goes from 10 to 20\./);
		assert.match(await text(s.page, ".guide-noise"), /1 file hidden/);
		await s.page.waitForSelector(".guide-step .file-diff"); // the step's diff, by omnidiff

		// k keeps the first open draft, as it is
		await s.page.keyboard.press("k");
		await until(async () => s.calls("addReviewComment").length === 1);
		assert.deepEqual(s.calls("addReviewComment")[0].args, { mode: "review", path: "src/limit.ts", subject: "line", line: 15, side: "RIGHT", body: "First: is 20 safe?" });
		await s.page.waitForSelector(".draft.kept");

		// e edits the next one; Keep keeps it as edited
		await s.page.keyboard.press("e");
		const box = s.page.locator(".draft.editing textarea");
		await box.fill("Second, edited: the client still sends 10.");
		await s.page.locator(".draft.editing").getByRole("button", { name: "Keep", exact: true }).click();
		await until(async () => s.calls("addReviewComment").length === 2);
		assert.equal(s.calls("addReviewComment")[1].body, "Second, edited: the client still sends 10.");

		// x drops the next one
		await s.page.keyboard.press("x");
		await until(async () => (await s.state()).steps[0].drafts[2].state === "dropped");
		assert.equal(s.calls("addReviewComment").length, 2);

		// c opens a comment box of your own; Escape closes it
		await s.page.keyboard.press("c");
		await s.page.waitForSelector(".guide-step .comment-form textarea");
		await s.page.keyboard.press("Escape");
		await s.page.keyboard.press("Escape");
		await until(async () => (await s.page.locator(".guide-step .comment-form").count()) === 0);

		// y: looks good, next step
		await s.page.keyboard.press("y");
		await until(async () => /Step 2 of 2/.test(await text(s.page, ".guide-progress")));
		assert.deepEqual((await s.state()).steps.map((x: any) => x.reviewed), [true, false]);

		// b back, s skip (not marked)
		await s.page.keyboard.press("b");
		await until(async () => /Step 1 of 2/.test(await text(s.page, ".guide-progress")));
		await s.page.keyboard.press("s");
		await until(async () => /Step 2 of 2/.test(await text(s.page, ".guide-progress")));
		assert.deepEqual((await s.state()).steps.map((x: any) => x.reviewed), [true, false]);
	} finally {
		await s.close();
	}
});

test("19. at the end, Submit review opens the review form with the pending count and the drafted summary", async () => {
	const s = await open();
	try {
		await s.page.keyboard.press("y");
		await until(async () => /Step 2 of 2/.test(await text(s.page, ".guide-progress")));
		await s.page.keyboard.press("y");
		await s.page.waitForSelector(".guide-done");
		assert.match(await text(s.page, ".guide-done"), /All 2 steps reviewed/);
		await s.page.getByRole("button", { name: /Submit review/ }).first().click();
		await s.page.waitForSelector(".guide-done .review-form");
		assert.match(await text(s.page, ".guide-done"), /2 pending comments/);
		assert.equal(await s.page.locator(".review-form textarea").inputValue(), "Raises the limit to 20.");
		await s.page.locator(".review-form label", { hasText: "Approve" }).click();
		await s.page.locator(".review-form").getByRole("button", { name: "Submit review", exact: true }).click();
		await until(async () => s.calls("submitReview").length === 1);
		assert.equal(s.calls("submitReview")[0].body, "Raises the limit to 20.");
		assert.equal(s.calls("submitReview")[0].args.event, "APPROVE");
	} finally {
		await s.close();
	}
});

test("19. after a push, the queue says how many steps changed and starts at the first", async () => {
	const s = await open();
	try {
		const st = await s.state();
		for (const x of st.steps) await s.t.req("/api/review/step", { as: "hyunhwanj", method: "POST", body: JSON.stringify({ repo: LAB, number: 4, step: x.id, reviewed: true }) });
		// push: only the test changes
		s.t.github.prs.get(`${LAB}#4`)!.headSha = "h2";
		s.t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h2", files: FILES.map(file) });
		for (const f of FILES) s.t.github.blobs.set(`${LAB}@h2:${f}`, s.t.github.blobs.get(`${LAB}@h1:${f}`)!);
		s.t.github.blobs.set(`${LAB}@h2:src/limit.test.ts`, lines((i) => (i === 14 ? "const limit = 25;" : `line ${i + 1}`)));
		await s.t.app.sync();
		await s.page.reload();
		await s.page.waitForSelector(".guide-step");
		assert.match(await text(s.page, ".guide-changed"), /1 step changed since your review/);
		assert.match(await text(s.page, ".guide-progress"), /Step 2 of 2/);
		assert.match(await text(s.page, ".guide-step"), /Test the limit/);
	} finally {
		await s.close();
	}
});
