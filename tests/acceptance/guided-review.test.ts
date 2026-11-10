/**
 * SPEC 19. Guided review, server side: a PR prepared as noise (hidden), steps in reading
 * order, each with a summary, a note per file and verified draft comments, and data to
 * skim; per person, viewed files, reviewed steps and kept or dropped drafts; after a
 * push, only what changed is read again; questions about a step, answered by the model
 * and kept per person. The lab LLM is faked and answers by its instructions:
 * "You plan" (steps), "You review" (one step's drafts), "You check" (one draft),
 * "You answer" (a question about a step).
 * Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";
import type { Prompt } from "../../src/llm.ts";
import type { DiffResult, DiffSide } from "../../src/omnidiff.ts";

const LAB = "jeonglab-bcm/labbot";
const MINE = "hyunhwan-bcm/tailjobs";
const lines = (f: (i: number) => string) => Array.from({ length: 30 }, (_, i) => f(i)).join("\n") + "\n";
const at = (row: number, a: number, b: number) => ({ from: { row, col: a }, to: { row, col: b } });
const hunks14: DiffResult = { largeResidual: false, before: { hunks: [{ op: "update", ...at(14, 14, 16) }] }, after: { hunks: [{ op: "update", ...at(14, 14, 16) }] } };
const ranges = { left: [[12, 18]] as [number, number][], right: [[12, 18]] as [number, number][] };
const modified = (path: string) => ({ path, status: "modified" as const, additions: 1, deletions: 1, commentable: ranges });

// what omnidiff says about each file
const SUMMARY: Record<string, DiffResult["summary"]> = { "src/format.ts": "whitespace_only", "src/moved.ts": "refactor_moved_only", "src/old.ts": "comment_only" };
const differ = async (a: DiffSide | null, b: DiffSide | null): Promise<DiffResult> => {
	const s = SUMMARY[(b ?? a)!.path];
	return s ? { largeResidual: false, before: { hunks: [] }, after: { hunks: [] }, summary: s } : hunks14;
};

type Plan = { summary?: string; steps: { title: string; summary: string; files: string[]; skim?: boolean }[] } | string;
type Draft = { path: string; side: "LEFT" | "RIGHT"; line: number; body: string };
type Note = { path: string; note: string };

/** The question in a prompt that asks one (SPEC 19.12): the text after the last "The reviewer asks:". */
const asked = (p: Prompt) => p.user.split("The reviewer asks:").pop()!.trim();

/** The fake model: `plan` answers the planning call; `drafts` and `notes` answer each step by its files; "WRONG" drafts fail the check. */
function model(plan: Plan, drafts: (user: string) => Draft[] = () => [], notes: (user: string) => Note[] = () => []) {
	return (p: Prompt) => {
		if (p.system.startsWith("You plan")) return typeof plan === "string" ? plan : JSON.stringify(plan);
		if (p.system.startsWith("You review")) return JSON.stringify({ summary: "This step changes the limit.", notes: notes(p.user), drafts: drafts(p.user) });
		if (p.system.startsWith("You check")) return JSON.stringify({ real: !p.user.includes("WRONG"), reason: "checked" });
		if (p.system.startsWith("You answer")) return `Answer to: ${asked(p)}`;
		throw new Error(`unexpected prompt: ${p.system.slice(0, 40)}`);
	};
}

const GOOD_PLAN = {
	summary: "Raises the limit and documents it.",
	steps: [
		{ title: "Raise the limit", summary: "The limit goes from 10 to 20.", files: ["src/limit.ts", "src/limit.test.ts"] },
		{ title: "Notes", summary: "The notes describe the new limit.", files: ["docs/notes.md"] },
	],
};

/** `more`: files the PR adds besides the usual seven, with their content (a Buffer with a NUL byte is binary). */
async function setup(opts: { llm?: false; plan?: Plan; drafts?: (user: string) => Draft[]; notes?: (user: string) => Note[]; more?: Record<string, string | Buffer> } = {}) {
	const t = await start({ llm: opts.llm, diff: differ });
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Raise the limit", headSha: "h1" });
	t.github.addPr({ repo: MINE, number: 2, author: "hwan", title: "Mine", headSha: "m1" });
	const files = ["src/limit.ts", "src/limit.test.ts", "docs/notes.md", "package-lock.json", "src/format.ts", "src/moved.ts", "src/old.ts"];
	const more = Object.keys(opts.more ?? {});
	t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h1", files: [...files.map(modified), ...more.map((f) => ({ ...modified(f), status: "added" as const }))] });
	for (const f of more) t.github.blobs.set(`${LAB}@h1:${f}`, opts.more![f]);
	for (const f of files) {
		t.github.blobs.set(`${LAB}@b1:${f}`, lines((i) => (i === 14 ? `const limit = 10; // ${f}` : `line ${i + 1}`)));
		t.github.blobs.set(`${LAB}@h1:${f}`, lines((i) => (i === 14 ? `const limit = 20; // ${f}` : `line ${i + 1}`)));
	}
	if (opts.llm !== false) t.llm.answer = model(opts.plan ?? GOOD_PLAN, opts.drafts, opts.notes);
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	/** GET the guided review, waiting for it to be prepared. */
	const review = async (as: string, repo = LAB, number = 4) => {
		const get = () => t.req(`/api/review?repo=${encodeURIComponent(repo)}&number=${number}`, { as });
		let r = await get();
		if (r.status === 200 && (await r.clone().json()).state === "preparing") {
			await t.app.idle();
			r = await get();
		}
		return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
	};
	const post = (as: string, what: string, body: object) => t.req(`/api/review/${what}`, { as, method: "POST", body: JSON.stringify({ repo: LAB, number: 4, ...body }) });
	const calls = (kind: string) => t.llm.calls.filter((c) => c.system.startsWith(kind));
	/** The author pushes: the PR's head is `head`, with `changed` files given new content and `added` ones new. */
	const push = (head: string, changed: Record<string, string>, added: Record<string, string> = {}) => {
		const was = t.github.prFileSets.get(`${LAB}#4`)!;
		t.github.prs.get(`${LAB}#4`)!.headSha = head;
		t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head, files: [...was.files, ...Object.keys(added).filter((f) => !was.files.some((x) => x.path === f)).map((f) => ({ ...modified(f), status: "added" as const }))] });
		for (const f of was.files) if (f.status !== "added" || t.github.blobs.has(`${LAB}@${was.head}:${f.path}`)) t.github.blobs.set(`${LAB}@${head}:${f.path}`, t.github.blobs.get(`${LAB}@${was.head}:${f.path}`)!);
		for (const [f, text] of Object.entries({ ...changed, ...added })) t.github.blobs.set(`${LAB}@${head}:${f}`, text);
	};
	/** GitHub's webhook for a push to the PR, whose head is `head` now. */
	const pushed = (head: string) => t.webhook("pull_request", {
		action: "synchronize", number: 4, repository: { full_name: LAB },
		pull_request: { number: 4, title: "Raise the limit", html_url: `https://github.com/${LAB}/pull/4`, user: { login: "kelly" }, head: { sha: head } },
	});
	return { t, review, post, calls, push, pushed };
}

const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);

const stepFiles = (r: any) => r.steps.map((s: any) => s.files);

test("19.1 noise is hidden: lockfiles and files omnidiff calls whitespace-only, comment-only or moved", async () => {
	const { t, review } = await setup();
	try {
		const { body: r } = await review("hyunhwanj");
		assert.equal(r.state, "ready");
		assert.deepEqual(r.noise.map((n: any) => n.path).sort(), ["package-lock.json", "src/format.ts", "src/moved.ts", "src/old.ts"]);
		assert.ok(r.noise.every((n: any) => typeof n.why === "string" && n.why.length > 0));
		const inSteps = stepFiles(r).flat();
		for (const n of r.noise) assert.ok(!inSteps.includes(n.path), `${n.path} is noise but in a step`);
	} finally {
		await t.close();
	}
});

test("19.2 steps cover every other file once, in the model's reading order", async () => {
	const { t, review } = await setup();
	try {
		const { body: r } = await review("hyunhwanj");
		assert.deepEqual(r.steps.map((s: any) => s.title), ["Raise the limit", "Notes"]);
		assert.deepEqual(stepFiles(r), [["src/limit.ts", "src/limit.test.ts"], ["docs/notes.md"]]);
		assert.equal(r.summary, "Raises the limit and documents it.");
	} finally {
		await t.close();
	}
});

test("19.2 the plan is asked for at most 12 steps, with room in the answer to list every file", async () => {
	const { t, review, calls } = await setup();
	try {
		await review("hyunhwanj");
		const [p] = calls("You plan");
		assert.match(p.system, /never more than 12/);
		assert.ok((p.maxTokens ?? 0) >= 800 + 40 * 3, `the plan's answer gets ${p.maxTokens} tokens for 3 files`);
	} finally {
		await t.close();
	}
});

test("19.2 a plan with slips is repaired, not thrown away", async () => {
	const all = ["src/limit.ts", "src/limit.test.ts", "docs/notes.md"];
	const cases: [Plan, string[][]][] = [
		[{ summary: "S.", steps: [{ title: "a", summary: "s", files: ["src/limit.ts"] }] }, [["src/limit.ts"], ["docs/notes.md"], ["src/limit.test.ts"]]], // left out: one step each, after
		[{ summary: "S.", steps: [{ title: "a", summary: "s", files: all }, { title: "b", summary: "s", files: ["src/limit.ts"] }] }, [all]], // twice: stays in the first
		[{ summary: "S.", steps: [{ title: "a", summary: "s", files: [...all, "src/nope.ts"] }] }, [all]], // not in the PR
		[{ summary: "S.", steps: [{ title: "a", summary: "s", files: ["src/limit.ts", "src/limit.test.ts", "package-lock.json", "docs/notes.md"] }] }, [all]], // noise in a step
		['{"summary": "S.", "steps": [{"title": "a", "summary": "s", "files": ["src/limit.ts"]}, {"title": "b", "summary": "s", "files": ["src/limit.te', [["src/limit.ts"], ["docs/notes.md"], ["src/limit.test.ts"]]], // cut off: the complete step stays
	];
	for (const [plan, want] of cases) {
		const { t, review } = await setup({ plan });
		try {
			const { body: r } = await review("hyunhwanj");
			assert.equal(r.state, "ready", JSON.stringify(plan));
			assert.deepEqual(stepFiles(r), want, JSON.stringify(plan));
			assert.equal(r.steps[0].title, "a");
			assert.equal(r.summary, "S.");
		} finally {
			await t.close();
		}
	}
});

test("19.2 while it is prepared, the review says what the model is doing", async () => {
	const { t, review } = await setup();
	const slow = t.llm.answer!;
	t.llm.answer = async (p) => { await new Promise((r) => setTimeout(r, 120)); return slow(p); };
	try {
		const get = async () => (await t.req(`/api/review?repo=${encodeURIComponent(LAB)}&number=4`, { as: "hyunhwanj" })).json();
		const seen: any[] = [];
		for (let i = 0; i < 100; i++) {
			const r = await get();
			if (r.state !== "preparing") break;
			if (r.progress && r.progress.phase !== seen.at(-1)?.phase) seen.push(r.progress);
			await new Promise((r) => setTimeout(r, 20));
		}
		const phases = seen.map((p) => p.phase);
		assert.ok(phases.includes("planning"), `phases seen: ${phases}`);
		const reviewing = seen.find((p) => p.phase === "reviewing");
		assert.ok(reviewing, `phases seen: ${phases}`);
		assert.equal(reviewing.total, 2);
		assert.equal(reviewing.what, "Raise the limit");
		assert.ok(seen.every((p) => typeof p.since === "string" && !Number.isNaN(Date.parse(p.since))));
		const { body: r } = await review("hyunhwanj");
		assert.equal(r.state, "ready");
	} finally {
		await t.close();
	}
});

test("19.2 an answer that is no plan falls back to one step per file, in path order, and says so in the log", async () => {
	const bad: Plan[] = ["Sure! Here are the steps.", '{"summary": "cut off", "steps": [{"title": "a", "files": ["src/limit.ts", "src/lim', { steps: [] }, { steps: [{ title: "a", summary: "s", files: ["src/nope.ts"] }] }];
	for (const plan of bad) {
		const { t, review } = await setup({ plan });
		try {
			const { body: r } = await review("hyunhwanj");
			assert.equal(r.state, "ready", JSON.stringify(plan));
			assert.deepEqual(stepFiles(r), [["docs/notes.md"], ["src/limit.test.ts"], ["src/limit.ts"]], JSON.stringify(plan));
			assert.ok(r.steps.every((s: any) => s.summary === "This step changes the limit."));
			assert.ok(t.logs.some((l: string) => /labbot#4.*plan/.test(l)), `nothing in the log: ${JSON.stringify(t.logs)}`);
		} finally {
			await t.close();
		}
	}
});

test("19.2 data and figures are steps to skim, after the others, and the model is not asked about them", async () => {
	const { t, review, calls } = await setup({ more: { "results/fig1.png": BINARY, "results/run.npz": BINARY, "data/table.csv": "a,b\n1,2\n" } });
	try {
		const { body: r } = await review("hyunhwanj");
		assert.deepEqual(r.steps.map((s: any) => [s.title, s.skim]), [["Raise the limit", false], ["Notes", false], ["Data and figures in data/", true], ["Data and figures in results/", true]]);
		assert.deepEqual(stepFiles(r).slice(2), [["data/table.csv"], ["results/fig1.png", "results/run.npz"]]);
		assert.equal(r.steps[3].summary, "2 files the AI did not read: 1 .png, 1 .npz.");
		assert.deepEqual(r.steps[3].drafts, []);
		assert.ok(!calls("You plan")[0].user.includes("results/"), "the plan is not asked about data");
		assert.ok(!calls("You plan")[0].user.includes("table.csv"));
		assert.equal(calls("You review").length, 2, "only the steps to read are reviewed");
	} finally {
		await t.close();
	}
});

test("19.2 a step the plan marks to skim goes after the others and is not reviewed", async () => {
	const { t, review, calls } = await setup({ plan: { summary: "S.", steps: [
		{ title: "Run outputs", summary: "What the run wrote.", files: ["docs/notes.md"], skim: true },
		{ title: "Raise the limit", summary: "The limit goes from 10 to 20.", files: ["src/limit.ts", "src/limit.test.ts"] },
	] } });
	try {
		const { body: r } = await review("hyunhwanj");
		assert.deepEqual(r.steps.map((s: any) => [s.title, s.skim]), [["Raise the limit", false], ["Run outputs", true]]);
		assert.match(calls("You plan")[0].system, /"skim": true/);
		assert.equal(calls("You review").length, 1);
		assert.ok(!calls("You review")[0].user.includes("docs/notes.md"));
	} finally {
		await t.close();
	}
});

test("19.3 a step too big for one prompt is read whole, in parts", async () => {
	const big = (mark: string) => `${"x".repeat(30_000)} ${mark}\n`;
	const { t, review, calls } = await setup({
		more: { "src/big1.ts": big("END-ONE"), "src/big2.ts": big("END-TWO") },
		plan: { summary: "S.", steps: [{ title: "Two big files", summary: "s.", files: ["src/big1.ts", "src/big2.ts"] }, { title: "Rest", summary: "s.", files: ["src/limit.ts", "src/limit.test.ts", "docs/notes.md"] }] },
		drafts: (user) => (user.includes("END-TWO") ? [{ path: "src/big2.ts", side: "RIGHT", line: 15, body: "A problem in the second part." }] : []),
		notes: (user) => [{ path: user.includes("END-ONE") ? "src/big1.ts" : "src/big2.ts", note: "A big file." }],
	});
	try {
		const { body: r } = await review("hyunhwanj");
		const parts = calls("You review").filter((c) => c.user.includes("Step: Two big files"));
		assert.equal(parts.length, 2);
		assert.ok(parts[0].user.includes("Part 1 of 2") && parts[0].user.includes("END-ONE") && !parts[0].user.includes("=== src/big2.ts"));
		assert.ok(parts[1].user.includes("Part 2 of 2") && parts[1].user.includes("END-TWO"));
		assert.ok(parts.every((c) => c.user.length <= 48_000));
		assert.deepEqual(r.steps[0].drafts.map((d: any) => d.body), ["A problem in the second part."]);
		assert.deepEqual(r.steps[0].notes, { "src/big1.ts": "A big file.", "src/big2.ts": "A big file." });
		// a step that fits is one call, and is not called a part
		const rest = calls("You review").filter((c) => c.user.includes("Step: Rest"));
		assert.equal(rest.length, 1);
		assert.ok(!rest[0].user.includes("Part 1"));
	} finally {
		await t.close();
	}
});

test("19.3 each file has a note on what changes in it, and each draft the lines it points at", async () => {
	const { t, review } = await setup({
		drafts: (user) => (user.includes("src/limit.ts") ? [{ path: "src/limit.ts", side: "RIGHT", line: 15, body: "Is 20 safe for the small queue?" }] : []),
		notes: (user) => (user.includes("src/limit.ts") ? [{ path: "src/limit.ts", note: "Raises the limit\nto 20." }, { path: "src/nope.ts", note: "Not a file of this step." }] : []),
	});
	try {
		const { body: r } = await review("hyunhwanj");
		assert.deepEqual(r.steps[0].notes, { "src/limit.ts": "Raises the limit to 20." });
		assert.deepEqual(r.steps[1].notes, {});
		assert.deepEqual(r.steps[0].drafts[0].code, [
			{ n: 14, mark: " ", text: "line 14" },
			{ n: 15, mark: "-", text: "const limit = 10; // src/limit.ts" },
			{ n: 15, mark: "+", text: "const limit = 20; // src/limit.ts", hit: true },
			{ n: 16, mark: " ", text: "line 16" },
		]);
	} finally {
		await t.close();
	}
});

test("19.3 a review answer that is no JSON is asked for once more", async () => {
	const { t, review, calls } = await setup({ drafts: (user) => (user.includes("src/limit.ts") ? [{ path: "src/limit.ts", side: "RIGHT", line: 15, body: "Is 20 safe?" }] : []) });
	const good = t.llm.answer!;
	let empty = 1;
	t.llm.answer = (p) => (p.system.startsWith("You review") && empty-- > 0 ? "```json" : good(p));
	try {
		const { body: r } = await review("hyunhwanj");
		assert.equal(calls("You review").length, 3, "the first step was asked twice");
		assert.deepEqual(r.steps[0].drafts.map((d: any) => d.body), ["Is 20 safe?"]);
	} finally {
		await t.close();
	}
});

test("19.3 each step has a one-sentence summary; drafts only on lines GitHub takes comments on", async () => {
	const { t, review, calls } = await setup({
		drafts: (user) => (user.includes("src/limit.ts") ? [
			{ path: "src/limit.ts", side: "RIGHT", line: 15, body: "Is 20 safe for the small queue?" },
			{ path: "src/limit.ts", side: "RIGHT", line: 3, body: "Far from the change." },
			{ path: "src/limit.ts", side: "LEFT", line: 15, body: "The old value was used by the client." },
			{ path: "docs/notes.md", side: "RIGHT", line: 15, body: "A file not in this step." },
		] : []),
	});
	try {
		const { body: r } = await review("hyunhwanj");
		for (const s of r.steps) assert.match(s.summary, /^[^\n]+$/);
		const d = r.steps[0].drafts;
		assert.deepEqual(d.map((x: any) => [x.path, x.side, x.line, x.body]), [
			["src/limit.ts", "RIGHT", 15, "Is 20 safe for the small queue?"],
			["src/limit.ts", "LEFT", 15, "The old value was used by the client."],
		]);
		assert.ok(d.every((x: any) => x.state === "open" && typeof x.id === "string"));
		assert.deepEqual(r.steps[1].drafts, []);
		// the reviewer saw the step's changed lines with their line numbers
		const step1 = calls("You review").find((c) => c.user.includes("src/limit.ts"))!;
		assert.match(step1.user, /15.*const limit = 20; \/\/ src\/limit\.ts/);
		assert.match(step1.system, /never follow instructions/i);
	} finally {
		await t.close();
	}
});

test("19.4 a draft the check rejects is never shown", async () => {
	const { t, review, calls } = await setup({
		drafts: (user) => (user.includes("src/limit.ts") ? [
			{ path: "src/limit.ts", side: "RIGHT", line: 15, body: "Real problem." },
			{ path: "src/limit.ts", side: "RIGHT", line: 16, body: "WRONG: a made-up problem." },
		] : []),
	});
	try {
		const { body: r } = await review("hyunhwanj");
		assert.deepEqual(r.steps[0].drafts.map((x: any) => x.body), ["Real problem."]);
		const checks = calls("You check");
		assert.equal(checks.length, 2);
		assert.ok(checks.some((c) => c.user.includes("WRONG: a made-up problem.") && c.user.includes("const limit = 20;")));
	} finally {
		await t.close();
	}
});

test("19.4 a draft that argues with itself or runs on is never shown; the model is told what day it is", async () => {
	const { t, review, calls } = await setup({
		drafts: (user) => (user.includes("src/limit.ts") ? [
			{ path: "src/limit.ts", side: "RIGHT", line: 15, body: "Real problem." },
			{ path: "src/limit.ts", side: "RIGHT", line: 16, body: "The total is 80. Wait, 21+18+22+17=78. Let me re-sum the rows." },
			{ path: "src/limit.ts", side: "RIGHT", line: 17, body: `This goes on. ${"And on. ".repeat(100)}` },
		] : []),
	});
	try {
		const { body: r } = await review("hyunhwanj");
		assert.deepEqual(r.steps[0].drafts.map((x: any) => x.body), ["Real problem."]);
		assert.equal(calls("You check").length, 1, "they are dropped before the check");
		assert.match(calls("You review")[0].user, /Today is \d{4}-\d\d-\d\d\./);
		assert.match(calls("You check")[0].user, /Today is \d{4}-\d\d-\d\d\./);
		assert.match(calls("You review")[0].system, /looks like the future/);
	} finally {
		await t.close();
	}
});

test("19.5 prepared once per head commit and shared; not for a repo you cannot see", async () => {
	const { t, review, calls } = await setup();
	try {
		const a = await review("hyunhwanj");
		const b = await review("kellyl");
		assert.deepEqual(stepFiles(a.body), stepFiles(b.body));
		assert.equal(calls("You plan").length, 1);
		assert.equal((await review("kellyl", MINE, 2)).status, 404);
		assert.equal((await review("kellyl", LAB, 99)).status, 404);
	} finally {
		await t.close();
	}
});

test("19.6 Keep puts the draft, as edited, in your pending review on GitHub; Drop hides it and is remembered", async () => {
	const { t, review, post, calls } = await setup({
		drafts: (user) => (user.includes("src/limit.ts") ? [
			{ path: "src/limit.ts", side: "RIGHT", line: 15, body: "Is 20 safe?" },
			{ path: "src/limit.ts", side: "LEFT", line: 15, body: "Nitpick about naming." },
		] : []),
	});
	try {
		const { body: r } = await review("hyunhwanj");
		const [keep, drop] = r.steps[0].drafts;
		assert.equal((await post("hyunhwanj", "draft", { draft: keep.id, action: "keep", body: "Is 20 safe for the small queue?" })).status, 200);
		const [call] = t.github.calls.filter((c) => c.op === "addReviewComment");
		assert.ok(call.token?.includes("hwan"));
		assert.deepEqual(call.args, { mode: "review", path: "src/limit.ts", subject: "line", line: 15, side: "RIGHT", body: "Is 20 safe for the small queue?" });
		assert.equal((await post("hyunhwanj", "draft", { draft: drop.id, action: "drop" })).status, 200);

		const mine = (await review("hyunhwanj")).body.steps[0].drafts;
		assert.deepEqual(mine.map((x: any) => x.state), ["kept", "dropped"]);
		const kellys = (await review("kellyl")).body.steps[0].drafts;
		assert.deepEqual(kellys.map((x: any) => x.state), ["open", "open"]);
		assert.equal((await post("hyunhwanj", "draft", { draft: "no-such-draft", action: "keep" })).status, 404);
		assert.equal((await post("hyunhwanj", "draft", { draft: keep.id, action: "frobnicate" })).status, 400);

		// the next review of this repo is told what was dropped
		t.github.addPr({ repo: LAB, number: 5, author: "kelly", title: "Another", headSha: "h5" });
		t.github.prFileSets.set(`${LAB}#5`, { base: "b1", head: "h5", files: [modified("src/limit.ts")] });
		t.github.blobs.set(`${LAB}@h5:src/limit.ts`, t.github.blobs.get(`${LAB}@h1:src/limit.ts`)!);
		t.llm.answer = model({ steps: [{ title: "x", summary: "s", files: ["src/limit.ts"] }] });
		await t.app.sync();
		await review("hyunhwanj", LAB, 5);
		const later = calls("You review").at(-1)!;
		assert.ok(later.user.includes("Nitpick about naming."), "a dropped draft is given to later reviews of the repo");
	} finally {
		await t.close();
	}
});

test("19.7 Looks good marks a step reviewed for you only", async () => {
	const { t, review, post } = await setup();
	try {
		const { body: r } = await review("hyunhwanj");
		assert.equal((await post("hyunhwanj", "step", { step: r.steps[0].id, reviewed: true })).status, 200);
		assert.deepEqual((await review("hyunhwanj")).body.steps.map((s: any) => s.reviewed), [true, false]);
		assert.deepEqual((await review("kellyl")).body.steps.map((s: any) => s.reviewed), [false, false]);
		await post("hyunhwanj", "step", { step: r.steps[0].id, reviewed: false });
		assert.deepEqual((await review("hyunhwanj")).body.steps.map((s: any) => s.reviewed), [false, false]);
		assert.equal((await post("hyunhwanj", "step", { step: "no-such-step", reviewed: true })).status, 404);
	} finally {
		await t.close();
	}
});

test("19.7 Viewed marks one file for you only; a step with every file viewed is reviewed", async () => {
	const { t, review, post } = await setup();
	try {
		const step = async (as: string) => (await review(as)).body.steps[0];
		assert.deepEqual((await step("hyunhwanj")).seen, []);
		assert.equal((await post("hyunhwanj", "file", { path: "src/limit.ts", reviewed: true })).status, 200);
		let s = await step("hyunhwanj");
		assert.deepEqual([s.seen, s.reviewed, s.changed], [["src/limit.ts"], false, false]);
		assert.deepEqual((await step("kellyl")).seen, []);
		await post("hyunhwanj", "file", { path: "src/limit.test.ts", reviewed: true });
		s = await step("hyunhwanj");
		assert.deepEqual([s.seen, s.reviewed], [["src/limit.ts", "src/limit.test.ts"], true]);
		await post("hyunhwanj", "file", { path: "src/limit.ts", reviewed: false });
		s = await step("hyunhwanj");
		assert.deepEqual([s.seen, s.reviewed], [["src/limit.test.ts"], false]);
		assert.equal((await post("hyunhwanj", "file", { path: "src/nope.ts", reviewed: true })).status, 404);
		assert.equal((await post("hyunhwanj", "file", { path: "package-lock.json", reviewed: true })).status, 404); // noise is in no step
		assert.equal((await post("hyunhwanj", "file", { path: "src/limit.ts", reviewed: "yes" })).status, 400);
	} finally {
		await t.close();
	}
});

test("19.8 after a push the plan is kept: only a changed step is read again, and what you reviewed stays reviewed", async () => {
	const { t, review, post, calls, push } = await setup({
		drafts: (user) => (user.includes("=== docs/notes.md") ? [{ path: "docs/notes.md", side: "RIGHT", line: 15, body: "The notes still say 10." }] : []),
		notes: (user) => (user.includes("=== docs/notes.md") ? [{ path: "docs/notes.md", note: "Describes the limit." }] : []),
	});
	try {
		const { body: r } = await review("hyunhwanj");
		for (const s of r.steps) await post("hyunhwanj", "step", { step: s.id, reviewed: true });
		const reviews = calls("You review").length;

		// push: the test changes; src/new.ts is added beside it, tools/run.sh in a folder of its own
		push("h2", { "src/limit.test.ts": lines((i) => (i === 14 ? "const limit = 25;" : `line ${i + 1}`)) }, { "src/new.ts": lines((i) => `new ${i}`), "tools/run.sh": "echo run\n" });
		await t.app.sync();
		const { body: after } = await review("hyunhwanj");
		assert.equal(after.head, "h2");
		assert.equal(calls("You plan").length, 1, "the plan is not asked for again");
		assert.equal(after.summary, "Raises the limit and documents it.");
		assert.deepEqual(after.steps.map((s: any) => s.title), ["Raise the limit", "Notes", "Added since the last push"]);
		// a new file joins the step with files of its folder; one in a new folder is a step at the end
		assert.deepEqual(stepFiles(after), [["src/limit.ts", "src/limit.test.ts", "src/new.ts"], ["docs/notes.md"], ["tools/run.sh"]]);

		// only the steps with a changed or new file went to the model again
		const again = calls("You review").slice(reviews);
		assert.equal(again.length, 2);
		assert.ok(again[0].user.includes("=== src/limit.test.ts") && again[0].user.includes("=== src/new.ts"));
		assert.ok(again[1].user.includes("=== tools/run.sh"));
		assert.ok(!again.some((c) => c.user.includes("=== docs/notes.md")));

		const [limit, notes, added] = after.steps;
		// the untouched step is as it was: reviewed, with its draft and its note
		assert.equal(notes.reviewed, true);
		assert.equal(notes.id, r.steps[1].id);
		assert.deepEqual(notes.drafts.map((d: any) => [d.id, d.body]), [[r.steps[1].drafts[0].id, "The notes still say 10."]]);
		assert.deepEqual(notes.notes, { "docs/notes.md": "Describes the limit." });
		// the changed one comes back, and says which of its files you have seen in this version
		assert.deepEqual([limit.reviewed, limit.changed, limit.seen], [false, true, ["src/limit.ts"]]);
		assert.deepEqual(limit.stale, ["src/limit.test.ts"]); // and which you saw only as it was before the push
		assert.deepEqual([added.reviewed, added.changed, added.stale], [false, false, []]);
		assert.equal(after.changedSinceReview, 1);
	} finally {
		await t.close();
	}
});

test("19.8 a push that adds much is planned again", async () => {
	const { t, review, calls, push } = await setup();
	try {
		await review("hyunhwanj");
		push("h2", {}, Object.fromEntries(["a", "b", "c", "d"].map((n) => [`lib/${n}.ts`, lines((i) => `${n} ${i}`)])));
		t.llm.answer = model({ summary: "Now a library too.", steps: [
			{ title: "The library", summary: "s.", files: ["lib/a.ts", "lib/b.ts", "lib/c.ts", "lib/d.ts"] },
			{ title: "Raise the limit", summary: "s.", files: ["src/limit.ts", "src/limit.test.ts", "docs/notes.md"] },
		] });
		await t.app.sync();
		const { body: after } = await review("hyunhwanj");
		assert.equal(calls("You plan").length, 2);
		assert.deepEqual(after.steps.map((s: any) => s.title), ["The library", "Raise the limit"]);
		assert.equal(after.summary, "Now a library too.");
	} finally {
		await t.close();
	}
});

test("19.8 pushes in a row wait their turn: the newest builds on the one before, and one in between is not prepared", async () => {
	const { t, review, calls, push, pushed } = await setup();
	const fast = t.llm.answer!;
	t.llm.answer = async (p) => { await new Promise((r) => setTimeout(r, 200)); return fast(p); };
	try {
		const get = async () => (await t.req(`/api/review?repo=${encodeURIComponent(LAB)}&number=4`, { as: "hyunhwanj" })).json();
		assert.equal((await get()).state, "preparing"); // h1 is being prepared
		for (const head of ["h2", "h3"]) {
			push(head, { "src/limit.test.ts": lines((i) => (i === 14 ? `const limit = 25; // ${head}` : `line ${i + 1}`)) });
			assert.equal((await pushed(head)).status, 200);
		}
		let queued: any;
		for (let i = 0; i < 100 && !queued; i++) {
			const r = await get();
			if (r.state === "preparing" && r.progress?.phase === "queued") queued = r.progress;
			else await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(queued, "the review of the new push waits for the one under way");
		await t.app.idle();
		const { body: r } = await review("hyunhwanj");
		assert.deepEqual([r.state, r.head], ["ready", "h3"]);
		assert.equal(calls("You plan").length, 1, "planned once, for the first push");
		// h1: both steps; h2: nothing (h3 came before its turn); h3: the one changed step
		assert.equal(calls("You review").length, 3);
		assert.match(calls("You review")[2].user, /const limit = 25; \/\/ h3/);
	} finally {
		await t.close();
	}
});

test("19.9 without an LLM: one step per file, no drafts, and a note saying so", async () => {
	const { t, review } = await setup({ llm: false });
	try {
		const { body: r } = await review("hyunhwanj");
		assert.equal(r.state, "ready");
		assert.equal(r.ai, false);
		assert.match(r.note, /no AI/i);
		assert.deepEqual(stepFiles(r), [["docs/notes.md"], ["src/limit.test.ts"], ["src/limit.ts"]]);
		assert.ok(r.steps.every((s: any) => s.drafts.length === 0));
		assert.equal(r.noise.length, 4);
	} finally {
		await t.close();
	}
});

test("19.10 when the LLM fails, the error is shown, nothing is kept, and it can be tried again", async () => {
	const { t, review, post, calls } = await setup();
	try {
		t.llm.failNext = true;
		const { body: r } = await review("hyunhwanj");
		assert.equal(r.state, "failed");
		assert.match(r.error, /LLM/);
		const n = t.llm.calls.length;
		assert.equal((await review("hyunhwanj")).body.state, "failed");
		assert.equal(t.llm.calls.length, n, "a failure is not retried by itself");
		assert.equal((await post("hyunhwanj", "prepare", {})).status, 200);
		await t.app.idle();
		const again = await review("hyunhwanj");
		assert.equal(again.body.state, "ready");
		assert.equal(calls("You plan").length, 2);
	} finally {
		await t.close();
	}
});

test("19.11 a push or a new PR prepares the guided review in the background", async () => {
	const { t, review, calls } = await setup();
	try {
		const r = await t.webhook("pull_request", {
			action: "synchronize", number: 4, repository: { full_name: LAB },
			pull_request: { number: 4, title: "Raise the limit", html_url: `https://github.com/${LAB}/pull/4`, user: { login: "kelly" }, head: { sha: "h1" } },
		});
		assert.equal(r.status, 200);
		await t.app.idle();
		assert.equal(calls("You plan").length, 1);
		const got = await t.req(`/api/review?repo=${encodeURIComponent(LAB)}&number=4`, { as: "hyunhwanj" });
		assert.equal((await got.json()).state, "ready", "ready without waiting");
		assert.equal(calls("You plan").length, 1);
	} finally {
		await t.close();
	}
});

// -- 19.12 questions about a step ---------------------------------------------------

const LIMIT_DRAFTS = (user: string): Draft[] => (user.includes("=== src/limit.ts") ? [{ path: "src/limit.ts", side: "RIGHT", line: 15, body: "Is 20 safe for the small queue?" }] : []);
const LIMIT_NOTES = (user: string): Note[] => (user.includes("=== src/limit.ts") ? [{ path: "src/limit.ts", note: "The limit constant goes up." }] : []);

test("19.12 a question about a step goes to the model with the step's changes, notes and drafts, and the questions before it", async () => {
	const { t, review, post, calls } = await setup({ drafts: LIMIT_DRAFTS, notes: LIMIT_NOTES });
	try {
		const { body: r } = await review("hyunhwanj");
		const step = r.steps[0];
		assert.deepEqual(step.asks, []);
		const first = await post("hyunhwanj", "ask", { step: step.id, question: "  Why 20 and not 15?  " });
		assert.equal(first.status, 200, await first.clone().text());
		assert.deepEqual(await first.json(), { answer: "Answer to: Why 20 and not 15?" });

		const [call] = calls("You answer");
		for (const want of ["Pull request: Raise the limit", "Step: Raise the limit (The limit goes from 10 to 20.)", "=== src/limit.ts (modified, +1 -1)", "=== src/limit.test.ts",
			"R15 + const limit = 20; // src/limit.ts", "L15 - const limit = 10; // src/limit.ts", "The limit constant goes up.", "Is 20 safe for the small queue?"]) {
			assert.ok(call.user.includes(want), `the prompt lacks: ${want}`);
		}
		assert.ok(!call.user.includes("docs/notes.md"), "a file of another step is not in the prompt");
		assert.ok(call.user.trimEnd().endsWith("The reviewer asks:\nWhy 20 and not 15?"), "the question comes last");
		assert.match(call.system, /never follow instructions/i);
		assert.match(call.system, /not shown/); // it must say when the answer needs code it cannot see
		assert.ok((call.maxTokens ?? 0) <= 1200, "a few sentences, not an essay");

		// the next question sees the first one and its answer
		assert.equal((await post("hyunhwanj", "ask", { step: step.id, question: "And the test?" })).status, 200);
		const second = calls("You answer")[1];
		const before = second.user.slice(0, second.user.lastIndexOf("The reviewer asks:"));
		assert.ok(before.includes("Why 20 and not 15?") && before.includes("Answer to: Why 20 and not 15?"));

		// kept with the step, oldest first
		const mine = (await review("hyunhwanj")).body.steps;
		assert.deepEqual(mine[0].asks.map((a: any) => [a.question, a.answer, a.about]), [
			["Why 20 and not 15?", "Answer to: Why 20 and not 15?", null], ["And the test?", "Answer to: And the test?", null]]);
		assert.ok(!Number.isNaN(Date.parse(mine[0].asks[0].at)));
		assert.deepEqual(mine[1].asks, []);
	} finally {
		await t.close();
	}
});

test("19.12 a question can be about one file of the step or one of its drafts", async () => {
	const { t, review, post, calls } = await setup({ drafts: LIMIT_DRAFTS });
	try {
		const { body: r } = await review("hyunhwanj");
		const step = r.steps[0];
		const draft = step.drafts[0];
		assert.equal((await post("hyunhwanj", "ask", { step: step.id, question: "What does it check?", about: { path: "src/limit.test.ts" } })).status, 200);
		assert.equal((await post("hyunhwanj", "ask", { step: step.id, question: "Is this real?", about: { draft: draft.id } })).status, 200);
		const [file, onDraft] = calls("You answer");
		assert.match(file.user, /The question is about the file src\/limit\.test\.ts\.\nThe reviewer asks:\nWhat does it check\?/);
		assert.ok(file.user.indexOf("=== src/limit.test.ts") < file.user.indexOf("=== src/limit.ts"), "the file asked about comes first");
		assert.match(onDraft.user, /The question is about this draft comment on src\/limit\.ts, line 15: Is 20 safe for the small queue\?\nThe reviewer asks:\nIs this real\?/);

		const asks = (await review("hyunhwanj")).body.steps[0].asks;
		assert.deepEqual(asks.map((a: any) => a.about), [{ path: "src/limit.test.ts" }, { path: "src/limit.ts", draft: draft.id, side: "RIGHT", line: 15 }]);

		// only what is in the step
		assert.equal((await post("hyunhwanj", "ask", { step: step.id, question: "q", about: { path: "docs/notes.md" } })).status, 404);
		assert.equal((await post("hyunhwanj", "ask", { step: step.id, question: "q", about: { draft: "no-such-draft" } })).status, 404);
		assert.equal(calls("You answer").length, 2);
	} finally {
		await t.close();
	}
});

test("19.12 questions and answers are yours only, and nothing goes to GitHub", async () => {
	const { t, review, post, calls } = await setup();
	try {
		const { body: r } = await review("hyunhwanj");
		const step = r.steps[0];
		const writes = () => t.github.calls.filter((c) => c.token).length; // what is done with a person's token
		const was = writes();
		await post("hyunhwanj", "ask", { step: step.id, question: "Mine?" });
		assert.deepEqual((await review("kellyl")).body.steps[0].asks, []);
		await post("kellyl", "ask", { step: step.id, question: "Hers?" });
		assert.ok(!calls("You answer")[1].user.includes("Mine?"), "another person's question is not in the prompt");
		assert.deepEqual((await review("hyunhwanj")).body.steps[0].asks.map((a: any) => a.question), ["Mine?"]);
		assert.deepEqual((await review("kellyl")).body.steps[0].asks.map((a: any) => a.question), ["Hers?"]);
		assert.equal(t.github.calls.filter((c) => /comment|review/i.test(c.op) && c.op !== "prContent").length, 0, "no comment or review is made on GitHub");
		assert.equal(writes(), was);
	} finally {
		await t.close();
	}
});

test("19.12 when the LLM fails or says nothing, the error is shown and the question is not kept", async () => {
	const { t, review, post } = await setup();
	try {
		const { body: r } = await review("hyunhwanj");
		const step = r.steps[0];
		t.llm.failNext = true;
		const failed = await post("hyunhwanj", "ask", { step: step.id, question: "Why?" });
		assert.equal(failed.status, 502);
		assert.match((await failed.json()).error, /LLM failed: upstream unavailable/);
		const answer = t.llm.answer!;
		t.llm.answer = (p) => (p.system.startsWith("You answer") ? "  \n" : answer(p));
		const empty = await post("hyunhwanj", "ask", { step: step.id, question: "Why?" });
		assert.equal(empty.status, 502);
		assert.match((await empty.json()).error, /no answer/);
		assert.deepEqual((await review("hyunhwanj")).body.steps[0].asks, []);
		t.llm.answer = answer;
		assert.equal((await post("hyunhwanj", "ask", { step: step.id, question: "Why?" })).status, 200);
		assert.equal((await review("hyunhwanj")).body.steps[0].asks.length, 1);
	} finally {
		await t.close();
	}
});

test("19.12 an answer streams as the model writes it", async () => {
	const { t, review } = await setup();
	try {
		const { body: r } = await review("hyunhwanj");
		const res = await t.req("/api/review/ask", { as: "hyunhwanj", method: "POST", headers: { accept: "text/event-stream" },
			body: JSON.stringify({ repo: LAB, number: 4, step: r.steps[0].id, question: "Why 20?" }) });
		assert.match(res.headers.get("content-type")!, /event-stream/);
		const events = (await res.text()).split("\n\n").filter(Boolean).map((b) => ({ event: b.match(/^event: (.+)$/m)?.[1] ?? "message", data: JSON.parse(b.match(/^data: (.+)$/m)![1]) }));
		const pieces = events.filter((e) => e.event === "message").map((e) => e.data.delta);
		assert.ok(pieces.length > 1, "the answer comes in pieces");
		assert.equal(pieces.join(""), "Answer to: Why 20?");
		assert.deepEqual(events.at(-1), { event: "done", data: { answer: "Answer to: Why 20?", cached: false } });
	} finally {
		await t.close();
	}
});

test("19.12 a question is refused when it is empty or too long, for a step that is not there, a PR you cannot see, or with no AI", async () => {
	const { t, review, post, calls } = await setup();
	try {
		const { body: r } = await review("hyunhwanj");
		const step = r.steps[0].id;
		assert.equal((await post("hyunhwanj", "ask", { step, question: "   " })).status, 400);
		assert.equal((await post("hyunhwanj", "ask", { step, question: "x".repeat(2001) })).status, 400);
		assert.equal((await post("hyunhwanj", "ask", { step: "no-such-step", question: "Why?" })).status, 404);
		assert.equal((await t.req("/api/review/ask", { as: "kellyl", method: "POST", body: JSON.stringify({ repo: MINE, number: 2, step, question: "Why?" }) })).status, 404);
		assert.equal(calls("You answer").length, 0);
	} finally {
		await t.close();
	}
	const off = await setup({ llm: false });
	try {
		const { body: r } = await off.review("hyunhwanj");
		const res = await off.post("hyunhwanj", "ask", { step: r.steps[0].id, question: "Why?" });
		assert.equal(res.status, 503);
	} finally {
		await off.t.close();
	}
});

test("19.12 a step too big for one prompt: the file asked about is whole, and the others are cut to fit", async () => {
	const big = (mark: string) => `${"x".repeat(30_000)} ${mark}\n`;
	const { t, review, post, calls } = await setup({
		more: { "src/big1.ts": big("END-ONE"), "src/big2.ts": big("END-TWO") },
		plan: { summary: "S.", steps: [{ title: "Two big files", summary: "s.", files: ["src/big1.ts", "src/big2.ts"] }, { title: "Rest", summary: "s.", files: ["src/limit.ts", "src/limit.test.ts", "docs/notes.md"] }] },
	});
	try {
		const { body: r } = await review("hyunhwanj");
		const step = r.steps[0].id;
		await post("hyunhwanj", "ask", { step, question: "What ends the second?", about: { path: "src/big2.ts" } });
		await post("hyunhwanj", "ask", { step, question: "And both?" });
		const [about, both] = calls("You answer");
		assert.ok(about.user.length <= 48_000 && both.user.length <= 48_000);
		assert.ok(about.user.includes("END-TWO") && !about.user.includes("END-ONE") && about.user.includes("=== src/big1.ts"));
		assert.ok(about.user.includes("[... cut]"));
		// with no file asked about, each gets its share
		assert.ok(!both.user.includes("END-ONE") && !both.user.includes("END-TWO"));
		assert.equal(both.user.split("[... cut]").length - 1, 2);
		assert.ok(both.user.trimEnd().endsWith("The reviewer asks:\nAnd both?"));
	} finally {
		await t.close();
	}
});

test("19.12 after a push, the questions of a step that did not change stay; a changed step starts with none", async () => {
	const { t, review, post, calls, push } = await setup();
	try {
		const { body: r } = await review("hyunhwanj");
		await post("hyunhwanj", "ask", { step: r.steps[0].id, question: "About the limit?" });
		await post("hyunhwanj", "ask", { step: r.steps[1].id, question: "About the notes?" });
		push("h2", { "src/limit.test.ts": lines((i) => (i === 14 ? "const limit = 25;" : `line ${i + 1}`)) });
		await t.app.sync();
		const { body: after } = await review("hyunhwanj");
		assert.equal(after.head, "h2");
		assert.deepEqual(after.steps.map((s: any) => s.asks.map((a: any) => a.question)), [[], ["About the notes?"]]);
		// and the model is not given answers about lines that are gone
		await post("hyunhwanj", "ask", { step: after.steps[0].id, question: "Now?" });
		const last = calls("You answer").at(-1)!;
		assert.ok(!last.user.includes("About the limit?"));
		assert.ok(last.user.includes("const limit = 25;"));
	} finally {
		await t.close();
	}
});

test("19. after a start, the reviews of PRs active in the last 14 days are prepared before anyone opens them, one at a time", async () => {
	const { t, calls } = await setup();
	try {
		t.github.prs.get(`${MINE}#2`)!.updatedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
		await t.app.sync();
		assert.equal(calls("You plan").length, 0);
		await t.app.warm();
		assert.equal(calls("You plan").length, 1, "one PR is recent, the other is not");
		const r = await (await t.req(`/api/review?repo=${encodeURIComponent(LAB)}&number=4`, { as: "hyunhwanj" })).json();
		assert.equal(r.state, "ready", "nobody waits");
		assert.equal(r.steps.length, 2);
		await t.app.warm(); // what is kept is not made again
		assert.equal(calls("You plan").length, 1);
	} finally {
		await t.close();
	}
});
