/**
 * SPEC 19. Guided review, server side: a PR prepared as noise (hidden) and steps in
 * reading order, each with a summary and verified draft comments; per person, reviewed
 * steps and kept or dropped drafts. The lab LLM is faked and answers by its instructions:
 * "You plan" (steps), "You review" (one step's drafts), "You check" (one draft).
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

type Plan = { summary?: string; steps: { title: string; summary: string; files: string[] }[] } | string;
type Draft = { path: string; side: "LEFT" | "RIGHT"; line: number; body: string };

/** The fake model: `plan` answers the planning call; `drafts` answers each step by its files; "WRONG" drafts fail the check. */
function model(plan: Plan, drafts: (user: string) => Draft[] = () => []) {
	return (p: Prompt) => {
		if (p.system.startsWith("You plan")) return typeof plan === "string" ? plan : JSON.stringify(plan);
		if (p.system.startsWith("You review")) return JSON.stringify({ summary: "This step changes the limit.", drafts: drafts(p.user) });
		if (p.system.startsWith("You check")) return JSON.stringify({ real: !p.user.includes("WRONG"), reason: "checked" });
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

async function setup(opts: { llm?: false; plan?: Plan; drafts?: (user: string) => Draft[] } = {}) {
	const t = await start({ llm: opts.llm, diff: differ });
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Raise the limit", headSha: "h1" });
	t.github.addPr({ repo: MINE, number: 2, author: "hwan", title: "Mine", headSha: "m1" });
	const files = ["src/limit.ts", "src/limit.test.ts", "docs/notes.md", "package-lock.json", "src/format.ts", "src/moved.ts", "src/old.ts"];
	t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h1", files: files.map(modified) });
	for (const f of files) {
		t.github.blobs.set(`${LAB}@b1:${f}`, lines((i) => (i === 14 ? `const limit = 10; // ${f}` : `line ${i + 1}`)));
		t.github.blobs.set(`${LAB}@h1:${f}`, lines((i) => (i === 14 ? `const limit = 20; // ${f}` : `line ${i + 1}`)));
	}
	if (opts.llm !== false) t.llm.answer = model(opts.plan ?? GOOD_PLAN, opts.drafts);
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
	return { t, review, post, calls };
}

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

test("19.2 a bad plan falls back to one step per file, in path order", async () => {
	const bad: Plan[] = [
		"Sure! Here are the steps.",
		{ steps: [{ title: "a", summary: "s", files: ["src/limit.ts"] }] }, // files missing
		{ steps: [{ title: "a", summary: "s", files: ["src/limit.ts", "src/limit.test.ts", "docs/notes.md"] }, { title: "b", summary: "s", files: ["src/limit.ts"] }] }, // twice
		{ steps: [{ title: "a", summary: "s", files: ["src/limit.ts", "src/limit.test.ts", "docs/notes.md", "src/nope.ts"] }] }, // unknown
		{ steps: [{ title: "a", summary: "s", files: ["src/limit.ts", "src/limit.test.ts", "package-lock.json", "docs/notes.md"] }] }, // noise in a step
	];
	for (const plan of bad) {
		const { t, review } = await setup({ plan });
		try {
			const { body: r } = await review("hyunhwanj");
			assert.equal(r.state, "ready", JSON.stringify(plan));
			assert.deepEqual(stepFiles(r), [["docs/notes.md"], ["src/limit.test.ts"], ["src/limit.ts"]], JSON.stringify(plan));
			assert.ok(r.steps.every((s: any) => s.summary === "This step changes the limit."));
		} finally {
			await t.close();
		}
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

test("19.8 after a push, unchanged steps stay reviewed, changed ones come back, new files are new steps", async () => {
	const { t, review, post } = await setup();
	try {
		const { body: r } = await review("hyunhwanj");
		for (const s of r.steps) await post("hyunhwanj", "step", { step: s.id, reviewed: true });

		// push: the test changes, src/limit.ts and the notes do not, src/new.ts is added
		const pr = t.github.prs.get(`${LAB}#4`)!;
		pr.headSha = "h2";
		const files = ["src/limit.ts", "src/limit.test.ts", "docs/notes.md", "src/new.ts"];
		t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h2", files: [...files.slice(0, 3).map(modified), { ...modified("src/new.ts"), status: "added" }] });
		for (const f of files.slice(0, 3)) t.github.blobs.set(`${LAB}@h2:${f}`, t.github.blobs.get(`${LAB}@h1:${f}`)!);
		t.github.blobs.set(`${LAB}@h2:src/limit.test.ts`, lines((i) => (i === 14 ? "const limit = 25;" : `line ${i + 1}`)));
		t.github.blobs.set(`${LAB}@h2:src/new.ts`, lines((i) => `new ${i}`));
		t.llm.answer = model({ steps: [
			{ title: "Limit", summary: "s.", files: ["src/limit.ts"] },
			{ title: "Test", summary: "s.", files: ["src/limit.test.ts"] },
			{ title: "Notes", summary: "s.", files: ["docs/notes.md"] },
			{ title: "New", summary: "s.", files: ["src/new.ts"] },
		] });
		await t.app.sync();

		const { body: after } = await review("hyunhwanj");
		assert.equal(after.head, "h2");
		const by = Object.fromEntries(after.steps.map((s: any) => [s.title, s]));
		assert.equal(by.Limit.reviewed, true);
		assert.equal(by.Notes.reviewed, true);
		assert.deepEqual([by.Test.reviewed, by.Test.changed], [false, true]);
		assert.deepEqual([by.New.reviewed, by.New.changed], [false, false]);
		assert.equal(after.changedSinceReview, 1);
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
