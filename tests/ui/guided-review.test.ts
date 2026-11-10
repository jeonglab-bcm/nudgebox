/**
 * SPEC 19. Guided review on the PR page, in a real browser: the steps as a list, then one
 * step alone, one key per decision, and questions to the AI about a step. The lab LLM is faked (see
 * tests/acceptance/guided-review.test.ts). Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";
import type { Prompt } from "../../src/llm.ts";

const LAB = "jeonglab-bcm/labbot";
const GUIDE = `#pr/${LAB}/4/guide`;
after(closeBrowser);

const lines = (f: (i: number) => string) => Array.from({ length: 30 }, (_, i) => f(i)).join("\n") + "\n";
const at = (row: number, a: number, b: number) => ({ from: { row, col: a }, to: { row, col: b } });
const ranges = { left: [[12, 18]] as [number, number][], right: [[12, 18]] as [number, number][] };
const file = (path: string) => ({ path, status: "modified" as const, additions: 1, deletions: 1, commentable: ranges });
const FILES = ["src/limit.ts", "src/client.ts", "src/limit.test.ts", "package-lock.json"];

const plan = { summary: "Raises the limit to 20.", steps: [
	{ title: "Raise the limit", summary: "The limit goes from 10 to 20.", files: ["src/limit.ts", "src/client.ts"] },
	{ title: "Test the limit", summary: "The test checks the new limit.", files: ["src/limit.test.ts"] },
] };
const DRAFTS = [
	{ path: "src/limit.ts", side: "RIGHT", line: 15, body: "First: is 20 safe?" },
	{ path: "src/limit.ts", side: "RIGHT", line: 16, body: "Second: the client still sends 10." },
	{ path: "src/limit.ts", side: "LEFT", line: 15, body: "Third: a nitpick." },
];
const NOTES = [{ path: "src/limit.ts", note: "The limit constant goes up." }, { path: "src/client.ts", note: "The client asks for more." }];
const model = (p: Prompt) =>
	p.system.startsWith("You plan") ? JSON.stringify(plan)
	: p.system.startsWith("You review") ? JSON.stringify(p.user.includes("=== src/limit.ts") ? { summary: "s.", notes: NOTES, drafts: DRAFTS } : { summary: "s.", notes: [], drafts: [] })
	: p.system.startsWith("You answer") ? `Because \`limit\` is the cap. (${p.user.split("The reviewer asks:").pop()!.trim()})`
	: JSON.stringify({ real: true });

/** Opens the guided review of labbot#4: at its list of steps, or at step `step`. */
async function open(o: { slowMs?: number; step?: number; phone?: boolean } = {}) {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Raise the limit", headSha: "h1" });
	t.github.pages.set(`${LAB}#4`, { baseRef: "main", headRef: "feature", commits: 1, additions: 4, deletions: 4, changedFiles: 4, pendingReview: { id: "rv1", comments: 2 } });
	t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h1", files: FILES.map(file) });
	for (const f of FILES) {
		t.github.blobs.set(`${LAB}@b1:${f}`, lines((i) => (i === 14 ? `const limit = 10; // ${f}` : `line ${i + 1}`)));
		t.github.blobs.set(`${LAB}@h1:${f}`, lines((i) => (i === 14 ? `const limit = 20; // ${f}` : `line ${i + 1}`)));
	}
	t.differ.reply = { largeResidual: false, before: { hunks: [{ op: "update", ...at(14, 14, 16) }] }, after: { hunks: [{ op: "update", ...at(14, 14, 16) }] } };
	t.llm.answer = o.slowMs ? async (p) => { await new Promise((r) => setTimeout(r, o.slowMs)); return model(p); } : model;
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(o.phone ? PHONE : DESKTOP);
	await ctx.route("https://github.com/**", (r) => r.fulfill({ body: "github" }));
	const page = await ctx.newPage();
	await page.goto(side.url + GUIDE + (o.step ? `/${o.step}` : ""));
	if (!o.slowMs) await page.waitForSelector(o.step ? ".guide-step" : ".guide-steps");
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
const hash = (page: Page) => page.evaluate(() => decodeURIComponent(location.hash));
async function until(f: () => Promise<boolean>, ms = 3000) {
	const end = Date.now() + ms;
	while (!(await f())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}
const onStep = (page: Page, k: number) => until(async () => (await page.locator(".guide-bar").count()) === 1 && new RegExp(`Step ${k} of 2`).test(await text(page, ".guide-bar")));

test("19. while the AI works, the page says which step it is on, with a bar, and since when", async () => {
	const s = await open({ slowMs: 1500 });
	try {
		await s.page.waitForSelector(".guide-preparing");
		await until(async () => /reviewing step 1 of 2: Raise the limit/.test(await text(s.page, ".guide-preparing")), 8000);
		assert.match(await text(s.page, ".guide-preparing"), /^Preparing the guided review: the AI is reviewing step 1 of 2: Raise the limit…\s*Working for \d+ s$/);
		assert.equal(await s.page.locator(".guide-preparing .meter").count(), 1);
		await until(async () => /step 2 of 2: Test the limit/.test(await text(s.page, ".guide-preparing")), 8000);
		await s.page.waitForSelector(".guide-steps", { timeout: 15000 });
		assert.equal(await s.page.locator(".guide-preparing").count(), 0);
	} finally {
		await s.close();
	}
});

test("19. the page keeps waiting for the review: a request that fails, or a look at another tab, does not stop it", async () => {
	const lost = await open({ slowMs: 700 });
	try {
		await lost.page.waitForSelector(".guide-preparing");
		// the phone sleeps, the network drops: the questions about the progress fail for a while
		await lost.page.route("**/api/review?**", (r) => r.abort());
		await new Promise((r) => setTimeout(r, 2500));
		await lost.page.unroute("**/api/review?**");
		await lost.page.waitForSelector(".guide-steps", { timeout: 20000 });
	} finally {
		await lost.close();
	}
	const away = await open({ slowMs: 700 });
	try {
		await away.page.waitForSelector(".guide-preparing");
		await away.page.locator(".pr-tabs a", { hasText: "Commits" }).click();
		await new Promise((r) => setTimeout(r, 2500));
		await away.page.locator(".pr-tabs a", { hasText: "Guided review" }).click();
		await away.page.waitForSelector(".guide-steps", { timeout: 20000 });
	} finally {
		await away.close();
	}
});

test("19. the tab lists the steps; a step opens alone, and Escape or Back returns to the list", async () => {
	const s = await open();
	try {
		assert.match(await text(s.page, ".guide-summary"), /Raises the limit to 20\./);
		assert.match(await text(s.page, ".guide-progress"), /0 of 2 steps reviewed/);
		assert.match(await text(s.page, ".guide-noise"), /1 file hidden/);
		assert.equal(await s.page.locator(".guide-row").count(), 2);
		const first = await text(s.page, ".guide-row");
		for (const want of [/Raise the limit/, /The limit goes from 10 to 20\./, /2 files/, /\+2 −2/, /3 AI comments/]) assert.match(first, want);
		assert.equal(await s.page.locator(".pr-tabs").count(), 1);

		// the button starts at the first step that is not reviewed: that step alone, without the PR's header and tabs
		await s.page.getByRole("button", { name: /Start review/ }).click();
		await onStep(s.page, 1);
		assert.equal(await hash(s.page), `${GUIDE}/1`);
		assert.equal(await s.page.locator(".pr-tabs, .pr-head").count(), 0);
		assert.match(await text(s.page, ".guide-step h2"), /Raise the limit/);
		assert.match(await text(s.page, ".guide-step"), /The limit goes from 10 to 20\./);

		await s.page.keyboard.press("Escape");
		await s.page.waitForSelector(".guide-steps");
		assert.equal(await hash(s.page), GUIDE);
		assert.equal(await s.page.locator(".pr-tabs").count(), 1);

		await s.page.keyboard.press("Enter"); // the same as the button
		await onStep(s.page, 1);
		await s.page.goBack();
		await s.page.waitForSelector(".guide-steps");

		await s.page.locator(".guide-row").nth(1).click(); // any step, from the list
		await onStep(s.page, 2);
		assert.match(await text(s.page, ".guide-step h2"), /Test the limit/);
		await s.page.getByRole("button", { name: /Steps/ }).click();
		await s.page.waitForSelector(".guide-steps");
		assert.equal(await hash(s.page), GUIDE);
	} finally {
		await s.close();
	}
});

test("19. in a step, y k e x c s b each do one thing, and a draft shows the code it is about", async () => {
	const s = await open({ step: 1 });
	try {
		await onStep(s.page, 1);
		await s.page.waitForSelector(".guide-step .file-diff .panes"); // the step's diffs, by omnidiff
		assert.match(await text(s.page, ".guide-ai"), /read 2 files and flagged 3 lines/);
		const code = s.page.locator(".draft").first().locator(".draft-code");
		assert.match((await code.locator(".dc.hit").textContent()) ?? "", /15\+const limit = 20; \/\/ src\/limit\.ts/);
		assert.equal(await code.locator(".dc-del").count(), 1);

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
		assert.match(await text(s.page, ".guide-ai"), /All decided/);

		// c opens a comment box of your own; Escape closes it (and stays in the step)
		await s.page.keyboard.press("c");
		await s.page.waitForSelector(".guide-step .comment-form textarea");
		await s.page.keyboard.press("Escape");
		await s.page.keyboard.press("Escape");
		await until(async () => (await s.page.locator(".guide-step .comment-form").count()) === 0);
		assert.equal(await hash(s.page), `${GUIDE}/1`);

		// y: looks good, next step
		await s.page.keyboard.press("y");
		await onStep(s.page, 2);
		assert.deepEqual((await s.state()).steps.map((x: any) => x.reviewed), [true, false]);

		// b back, s skip (not marked); s on the last step ends at the list
		await s.page.keyboard.press("b");
		await onStep(s.page, 1);
		await s.page.keyboard.press("s");
		await onStep(s.page, 2);
		assert.deepEqual((await s.state()).steps.map((x: any) => x.reviewed), [true, false]);
		await s.page.keyboard.press("s");
		await s.page.waitForSelector(".guide-steps");
		assert.match(await text(s.page, ".guide-progress"), /1 of 2 steps reviewed/);
		assert.match(await text(s.page, ".guide-row.done"), /Raise the limit/);
		await s.page.getByRole("button", { name: /Continue with step 2/ }).click();
		await onStep(s.page, 2);
	} finally {
		await s.close();
	}
});

test("19. a step's files: each with its note, open to read, and Viewed (or v) ticks one off", async () => {
	const s = await open({ step: 1 });
	try {
		const rows = s.page.locator(".guide-files .file");
		assert.equal(await rows.count(), 2);
		assert.match(await text(s.page, ".guide-files-head"), /0 of 2 viewed.*src\//); // the folder is said once
		assert.match((await rows.nth(0).textContent()) ?? "", /^Mlimit\.tsThe limit constant goes up\.\+1 −1/);
		assert.match((await rows.nth(1).textContent()) ?? "", /^Mclient\.tsThe client asks for more\./);
		await until(async () => (await s.page.locator(".guide-files .file-diff .panes").count()) === 2); // a small step opens whole

		// an open file's row stays under the bar while its diff is read, and leaves with it: rows never pile up
		await s.page.setViewportSize({ width: 1280, height: 420 });
		const top = (k: number, sel: string, y: number) => s.page.locator(".guide-file").nth(k).locator(sel).evaluate((e, to) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - to), y);
		await top(0, ".file-diff", -40);
		assert.ok(Math.abs((await rows.nth(0).boundingBox())!.y - 46) <= 1, "the open file's row does not stay under the bar");
		await top(1, ".file", 60);
		const [first, second] = [await rows.nth(0).boundingBox(), await rows.nth(1).boundingBox()];
		assert.ok(Math.abs(second!.y - 60) <= 1 && first!.y + first!.height <= second!.y + 1, "the first file's row lies over the second's");
		await s.page.setViewportSize(DESKTOP.viewport!);
		await s.page.evaluate(() => window.scrollTo(0, 0));

		// Viewed folds the file and goes to the next one
		await rows.nth(0).locator("input.viewed").check();
		await until(async () => (await s.state()).steps[0].seen.join() === "src/limit.ts");
		assert.equal(await s.page.locator(".guide-files .file-diff").count(), 1);
		assert.equal(await s.page.locator(".guide-files .file.cur .path").evaluate((e) => e.firstChild!.textContent), "client.ts");
		assert.equal((await s.state()).steps[0].reviewed, false);

		// v does the same for the file you are on; every file viewed is the step reviewed
		await s.page.keyboard.press("v");
		await until(async () => (await s.state()).steps[0].reviewed === true);
		assert.equal(await s.page.locator(".guide-files .file-diff").count(), 0);
		assert.match(await text(s.page, ".guide-step h2"), /Reviewed/);
		assert.equal(await s.page.getByRole("button", { name: /Next step/ }).count(), 1);

		// a row opens and folds; unticking takes the step back
		await rows.nth(1).click();
		await s.page.waitForSelector(".guide-files .file-diff .panes");
		await rows.nth(1).locator("input.viewed").uncheck();
		await until(async () => (await s.state()).steps[0].reviewed === false);
		assert.equal(await s.page.getByRole("button", { name: /Looks good/ }).count(), 1);
	} finally {
		await s.close();
	}
});

test("19. at the end, Submit review opens the review form with the pending count and the drafted summary", async () => {
	const s = await open({ step: 1 });
	try {
		await s.page.keyboard.press("y");
		await onStep(s.page, 2);
		await s.page.keyboard.press("y");
		await s.page.waitForSelector(".guide-done");
		assert.equal(await hash(s.page), GUIDE);
		assert.match(await text(s.page, ".guide-done"), /All 2 steps reviewed/);
		assert.match(await text(s.page, ".guide-done"), /2 pending comments/);
		await s.page.getByRole("button", { name: /Submit review/ }).first().click();
		await s.page.waitForSelector(".guide-done .review-form");
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

test("19. after a push, the list says how many steps changed and goes on at the first", async () => {
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
		await s.page.waitForSelector(".guide-steps");
		assert.match(await text(s.page, ".guide-changed"), /1 step changed since your review/);
		assert.match(await text(s.page, ".guide-progress"), /1 of 2 steps reviewed/);
		assert.match(await text(s.page, ".guide-row.next"), /Test the limit.*Changed/);
		await s.page.getByRole("button", { name: /Continue with step 2/ }).click();
		await onStep(s.page, 2);
		assert.match(await text(s.page, ".guide-step h2"), /Test the limit.*Changed/);
		assert.match(await text(s.page, ".guide-files .file"), /Changed/); // the file you viewed in its older version
	} finally {
		await s.close();
	}
});

test("19. on a phone a step fits the screen: its own bar on top, the decisions at the bottom", async () => {
	const s = await open({ step: 1, phone: true });
	try {
		await s.page.waitForSelector(".guide-files .file-diff .unified");
		const box = await s.page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: innerWidth, chrome: getComputedStyle(document.querySelector(".chrome")!).display }));
		assert.ok(box.page <= box.screen, `the page is ${box.page}px wide on a ${box.screen}px screen`);
		assert.equal(box.chrome, "none"); // the app's own header gives its room to the step
		await s.page.evaluate(() => window.scrollTo(0, 600));
		const bar = await s.page.locator(".guide-bar").boundingBox();
		const keys = await s.page.locator(".guide-keys").boundingBox();
		assert.equal(Math.round(bar!.y), 0);
		assert.ok(Math.abs(keys!.y + keys!.height - 844) <= 1, "the buttons stay at the bottom");
		assert.deepEqual((await s.page.locator(".guide-keys button:visible").allTextContents()).map((x) => x.replace(/[a-z]$/, "")), ["Back", "Ask", "Skip", "Viewed", "Looks good"]);
		await s.page.getByRole("button", { name: /Looks good/ }).tap();
		await onStep(s.page, 2);
	} finally {
		await s.close();
	}
});

// -- 19.12 questions about a step ---------------------------------------------------

const answers = (s: { t: { llm: { calls: Prompt[] } } }) => s.t.llm.calls.filter((c) => c.system.startsWith("You answer"));
const turns = (page: Page) => page.locator(".ask-turn");
const asked = async (page: Page, n: number) => {
	await until(async () => (await turns(page).count()) === n && (await page.locator(".ask-turn.streaming").count()) === 0, 8000);
};

test("19. in a step, a asks the AI: the answer streams in under the question, and the next question sees it", async () => {
	const s = await open({ step: 1 });
	try {
		await onStep(s.page, 1);
		assert.equal(await s.page.locator(".ask-dock").count(), 0);
		assert.match(await text(s.page, ".guide-keys .ask-open"), /^Ask ?a$/);
		await s.page.keyboard.press("a");
		const box = s.page.locator(".ask-dock textarea");
		await box.waitFor();
		assert.ok(await box.evaluate((b) => b === document.activeElement), "the cursor is in the question box");
		assert.equal(await s.page.inputValue(".ask-dock textarea"), "", "the key that opens the box is not typed into it");

		// Enter sends; the answer comes in pieces
		s.t.llm.delayMs = 40;
		await s.page.keyboard.type("Why 20?");
		await s.page.keyboard.press("Enter");
		await s.page.waitForSelector(".ask-turn.streaming");
		assert.match(await text(s.page, ".ask-turn .ask-q"), /Why 20\?/);
		assert.equal(await s.page.inputValue(".ask-dock textarea"), "");
		assert.ok(await s.page.locator(".ask-send").isDisabled(), "one question at a time");
		await asked(s.page, 1);
		s.t.llm.delayMs = 0;
		assert.match(await text(s.page, ".ask-turn .ask-answer"), /Because limit is the cap\. \(Why 20\?\)/);
		assert.equal(await text(s.page, ".ask-turn .ask-answer code"), "limit"); // the answer's Markdown is drawn
		assert.ok(answers(s)[0].user.includes("=== src/limit.ts") && answers(s)[0].user.includes("=== src/client.ts"));

		// Shift+Enter is a new line; the button sends too
		await box.focus();
		await s.page.keyboard.type("And");
		await s.page.keyboard.press("Shift+Enter");
		await s.page.keyboard.type("the client?");
		assert.equal(await turns(s.page).count(), 1);
		await s.page.locator(".ask-send").click();
		await asked(s.page, 2);
		const before = answers(s)[1].user.slice(0, answers(s)[1].user.lastIndexOf("The reviewer asks:"));
		assert.ok(before.includes("Why 20?") && before.includes("is the cap. (Why 20?)"), "the second question is asked with the first and its answer");
		assert.match(await text(s.page, ".guide-keys .ask-open"), /^Ask ?2 ?a$/);

		// Escape leaves the box, then closes it; the step stays
		await box.focus();
		await s.page.keyboard.press("Escape");
		await s.page.keyboard.press("Escape");
		await until(async () => (await s.page.locator(".ask-dock").count()) === 0);
		assert.equal(await hash(s.page), `${GUIDE}/1`);
		assert.equal(s.calls("addReviewComment").length, 0, "nothing goes to GitHub");

		// kept: there again after a reload, and only on this step
		await s.page.reload();
		await onStep(s.page, 1);
		await s.page.locator(".guide-keys .ask-open").click();
		await asked(s.page, 2);
		assert.deepEqual((await s.page.locator(".ask-turn .ask-q").allTextContents()).map((x) => x.replace(/\s+/g, " ").trim()), ["Why 20?", "And the client?"]);
		await s.page.locator(".ask-close").click();
		await s.page.keyboard.press("s");
		await onStep(s.page, 2);
		assert.match(await text(s.page, ".guide-keys .ask-open"), /^Ask ?a$/);
	} finally {
		await s.close();
	}
});

test("19. Ask on an AI draft or on a file asks about it, and Use as comment makes the answer a comment to edit", async () => {
	const s = await open({ step: 1 });
	try {
		await onStep(s.page, 1);
		await s.page.waitForSelector(".guide-step .file-diff .panes");

		// about a draft
		await s.page.locator(".draft").first().locator(".ask-about").click();
		await s.page.waitForSelector(".ask-dock");
		assert.match(await text(s.page, ".ask-chip"), /About the AI draft on limit\.ts:\+15/);
		await s.page.locator(".ask-dock textarea").fill("Is this real?");
		await s.page.keyboard.press("Enter");
		await asked(s.page, 1);
		assert.match(answers(s)[0].user, /The question is about this draft comment on src\/limit\.ts, line 15: First: is 20 safe\?/);
		assert.match(await text(s.page, ".ask-turn .ask-q"), /limit\.ts:\+15.*Is this real\?/);

		// about a file; the ✕ on the chip makes it a question about the whole step again
		await s.page.locator(".ask-chip button").click();
		assert.equal(await s.page.locator(".ask-chip").count(), 0);
		await s.page.locator('.guide-files .file[data-path="src/client.ts"] .file-ask').click();
		assert.match(await text(s.page, ".ask-chip"), /About client\.ts/);
		await s.page.locator(".ask-dock textarea").fill("What does the client send?");
		await s.page.locator(".ask-send").click();
		await asked(s.page, 2);
		assert.match(answers(s)[1].user, /The question is about the file src\/client\.ts\.\nThe reviewer asks:/);

		// the answer about the file becomes a comment on that file, to edit before it is added
		await turns(s.page).nth(1).locator(".ask-use").click();
		const form = s.page.locator('.guide-file:has(.file[data-path="src/client.ts"]) .comment-form');
		await form.waitFor();
		assert.equal(await s.page.locator(".ask-dock").count(), 0, "the ask box gives way to the comment");
		assert.match((await form.locator(".hint").textContent()) ?? "", /Comment on src\/client\.ts/);
		assert.equal(await form.locator("textarea").inputValue(), "Because `limit` is the cap. (What does the client send?)");
		assert.ok(await form.locator("textarea").evaluate((b) => b === document.activeElement));
		assert.equal(s.calls("addReviewComment").length, 0, "not sent until you say so");
		await form.locator("textarea").fill("The client must send 20.");
		await form.getByRole("button", { name: "Add review comment" }).click();
		await until(async () => s.calls("addReviewComment").length === 1);
		assert.deepEqual(s.calls("addReviewComment")[0].args, { mode: "review", path: "src/client.ts", subject: "file", body: "The client must send 20." });

		// the answer about the draft becomes a comment on the draft's line
		await s.page.keyboard.press("a");
		await asked(s.page, 2);
		await turns(s.page).nth(0).locator(".ask-use").click();
		const line = s.page.locator(".guide-step .file-diff .comment-form");
		await line.waitFor();
		assert.match((await line.locator(".hint").textContent()) ?? "", /Comment on line \+15/);
		assert.equal(await line.locator("textarea").inputValue(), "Because `limit` is the cap. (Is this real?)");
	} finally {
		await s.close();
	}
});

test("19. when the AI cannot answer, the page says so and the question is still in the box", async () => {
	const s = await open({ step: 1 });
	try {
		await onStep(s.page, 1);
		await s.page.keyboard.press("a");
		await s.page.locator(".ask-dock textarea").fill("Why 20?");
		s.t.llm.failNext = true;
		await s.page.keyboard.press("Enter");
		await until(async () => /LLM failed/.test(await text(s.page, "#toast")));
		assert.equal(await turns(s.page).count(), 0);
		assert.equal(await s.page.inputValue(".ask-dock textarea"), "Why 20?");
		assert.deepEqual((await s.state()).steps[0].asks, []);
	} finally {
		await s.close();
	}
});

test("19. on a phone, Ask opens over the buttons at the bottom and fits the screen", async () => {
	const s = await open({ step: 1, phone: true });
	try {
		await s.page.waitForSelector(".guide-files .file-diff .unified");
		await s.page.evaluate(() => window.scrollTo(0, 400));
		await s.page.locator(".guide-keys .ask-open").tap();
		const box = s.page.locator(".ask-dock textarea");
		await box.waitFor();
		await box.fill("Why 20?");
		await s.page.locator(".ask-send").tap();
		await asked(s.page, 1);
		const m = await s.page.evaluate(() => {
			// no helper function in here: tsx would wrap it in a name the page does not know
			const [dock, bar, answer] = [".ask-dock", ".guide-bar", ".ask-turn .ask-answer"].map((sel) => document.querySelector(sel)!.getBoundingClientRect());
			return { page: document.documentElement.scrollWidth, screen: innerWidth, top: dock.top, bottom: dock.bottom, left: dock.left, right: dock.right, bar: bar.bottom,
				answerTop: answer.top, answerBottom: answer.bottom, font: parseFloat(getComputedStyle(document.querySelector(".ask-dock textarea")!).fontSize) };
		});
		assert.ok(m.page <= m.screen, `the page is ${m.page}px wide on a ${m.screen}px screen`);
		assert.ok(m.left >= 0 && m.right <= 390 && m.bottom <= 844, "the ask box is on the screen");
		assert.ok(m.top >= m.bar + 200, `the ask box leaves the code room: it starts at ${m.top}px`);
		assert.ok(m.answerTop >= m.top && m.answerBottom <= m.bottom, "the answer is in sight");
		assert.ok(m.font >= 16, "a box with smaller text makes an iPhone zoom in");
		// Enter is a new line on a phone: only the button sends
		await box.focus();
		await s.page.keyboard.type("And");
		await s.page.keyboard.press("Enter");
		assert.equal(await turns(s.page).count(), 1);
		await s.page.locator(".ask-close").tap();
		await until(async () => (await s.page.locator(".ask-dock").count()) === 0);
		const keys = await s.page.locator(".guide-keys").boundingBox();
		assert.ok(Math.abs(keys!.y + keys!.height - 844) <= 1, "the buttons are back at the bottom");
	} finally {
		await s.close();
	}
});
