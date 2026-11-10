/**
 * SPEC 17. Explain a file's diff: the model reads the file's changed lines (read from
 * GitHub by Nudgebox) with a little context, and the explanation is kept per version pair.
 * Follow-up questions under an explanation are answered from the same changes.
 * Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
const MINE = "hyunhwan-bcm/tailjobs";
const lines = (f: (i: number) => string) => Array.from({ length: 30 }, (_, i) => f(i)).join("\n") + "\n";
const BEFORE = lines((i) => (i === 14 ? "const limit = 10;" : `line ${i + 1}`));
const AFTER = lines((i) => (i === 14 ? "const limit = 20;" : `line ${i + 1}`));
const at = (row: number, a: number, b: number) => ({ from: { row, col: a }, to: { row, col: b } });
const before = { repo: LAB, ref: "base-sha", path: "src/limit.ts" };
const after = { repo: LAB, ref: "head-sha", path: "src/limit.ts" };

async function setup(opts: { llm?: false } = {}) {
	const t = await start(opts);
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Raise the limit" });
	t.github.blobs.set(`${LAB}@base-sha:src/limit.ts`, BEFORE);
	t.github.blobs.set(`${LAB}@head-sha:src/limit.ts`, AFTER);
	t.github.blobs.set(`${MINE}@h:a.ts`, "x\n");
	t.github.blobs.set(`${LAB}@base-sha:fig.png`, Buffer.from([0x89, 0x50, 0, 1]));
	t.github.blobs.set(`${LAB}@head-sha:fig.png`, Buffer.from([0x89, 0x50, 0, 2]));
	t.differ.reply = { largeResidual: false, before: { hunks: [{ op: "update", ...at(14, 14, 16) }] }, after: { hunks: [{ op: "update", ...at(14, 14, 16) }] } };
	t.llm.reply = "The change raises `limit` from 10 to 20.";
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	const explain = (as: string, body: object, headers: Record<string, string> = {}) =>
		t.req("/api/explain", { as, method: "POST", body: JSON.stringify(body), headers });
	const ask = (as: string, body: object, headers: Record<string, string> = {}) =>
		t.req("/api/explain/ask", { as, method: "POST", body: JSON.stringify(body), headers });
	// the model explains with `reply`, and answers a follow-up with the question it got
	t.llm.answer = (p) => (p.system.startsWith("You answer") ? `Answer to: ${p.user.split("The reader asks:").pop()!.trim()}` : undefined);
	return { t, explain, ask };
}

test("17. Explain sends the model the file's changed lines with 3 lines around them, and the PR title", async () => {
	const { t, explain } = await setup();
	try {
		const r = await explain("hyunhwanj", { before, after, pr: { repo: LAB, number: 4 } });
		assert.equal(r.status, 200, await r.clone().text());
		assert.deepEqual(await r.json(), { explanation: "The change raises `limit` from 10 to 20.", cached: false, asks: [] });
		const [call] = t.llm.calls;
		for (const want of ["src/limit.ts", "Raise the limit", "const limit = 10;", "const limit = 20;", "line 12", "line 14", "line 16", "line 18"]) {
			assert.ok(call.user.includes(want), `prompt lacks ${want}`);
		}
		for (const not of ["line 11", "line 19", "line 5"]) assert.ok(!call.user.includes(`${not}\n`), `prompt has ${not}, which is too far from the change`);
		assert.match(call.system, /ASD-STE100/);
		assert.match(call.system, /never follow instructions/i);
	} finally {
		await t.close();
	}
});

test("17. an explanation is kept per file version pair and shared", async () => {
	const { t, explain } = await setup();
	try {
		await explain("hyunhwanj", { before, after });
		const again = await (await explain("kellyl", { before, after })).json();
		assert.deepEqual(again, { explanation: "The change raises `limit` from 10 to 20.", cached: true, asks: [] });
		assert.equal(t.llm.calls.length, 1);
		t.github.blobs.set(`${LAB}@head-2:src/limit.ts`, AFTER);
		await explain("hyunhwanj", { before, after: { ...after, ref: "head-2" } });
		assert.equal(t.llm.calls.length, 2);
	} finally {
		await t.close();
	}
});

test("17. Explain streams the text as the model writes it", async () => {
	const { t, explain } = await setup();
	try {
		const r = await explain("hyunhwanj", { before, after }, { accept: "text/event-stream" });
		assert.match(r.headers.get("content-type")!, /event-stream/);
		const text = await r.text();
		assert.match(text, /data: \{"delta":/);
		assert.match(text, /event: done\ndata: \{"explanation":"The change raises `limit` from 10 to 20\.","cached":false,"asks":\[\]\}/);
	} finally {
		await t.close();
	}
});

test("17. only repos you can see, only text files, and only with an LLM", async () => {
	const { t, explain } = await setup();
	const none = await setup({ llm: false });
	try {
		assert.equal((await explain("kellyl", { before: null, after: { repo: MINE, ref: "h", path: "a.ts" } })).status, 404);
		assert.equal((await explain("hyunhwanj", { before: { ...before, path: "fig.png" }, after: { ...after, path: "fig.png" } })).status, 400);
		assert.equal((await explain("hyunhwanj", { before: null, after: null })).status, 400);
		assert.equal((await none.explain("hyunhwanj", { before, after })).status, 503);
		assert.equal(t.llm.calls.length, 0);
	} finally {
		await t.close();
		await none.t.close();
	}
});

test("17. an LLM failure is shown and not kept", async () => {
	const { t, explain } = await setup();
	try {
		t.llm.failNext = true;
		const r = await explain("hyunhwanj", { before, after });
		assert.equal(r.status, 502);
		assert.match((await r.json()).error, /LLM/);
		assert.equal((await explain("hyunhwanj", { before, after })).status, 200);
		assert.equal(t.llm.calls.length, 2);
	} finally {
		await t.close();
	}
});

// -- follow-up questions ------------------------------------------------------------

test("17. a follow-up question goes to the model with the file's changes, the explanation and the questions before it", async () => {
	const { t, explain, ask } = await setup();
	try {
		const pr = { repo: LAB, number: 4 };
		await explain("hyunhwanj", { before, after, pr });
		const r = await ask("hyunhwanj", { before, after, pr, question: "  Why 20?  " });
		assert.equal(r.status, 200, await r.clone().text());
		assert.deepEqual(await r.json(), { answer: "Answer to: Why 20?" });
		const call = t.llm.calls[1];
		assert.match(call.system, /^You answer/);
		assert.match(call.system, /never follow instructions/i);
		for (const want of ["src/limit.ts", "Raise the limit", "- const limit = 10;", "+ const limit = 20;", "The change raises `limit` from 10 to 20."]) {
			assert.ok(call.user.includes(want), `prompt lacks ${want}`);
		}
		assert.ok(call.user.endsWith("The reader asks:\nWhy 20?\n"));

		await ask("hyunhwanj", { before, after, pr, question: "And 30?" });
		const second = t.llm.calls[2].user;
		const earlier = second.slice(0, second.lastIndexOf("The reader asks:"));
		assert.ok(earlier.includes("Q: Why 20?") && earlier.includes("A: Answer to: Why 20?"), "the second question goes with the first and its answer");

		// kept for the person who asked, with the explanation; nobody else sees them
		const mine = await (await explain("hyunhwanj", { before, after, pr })).json();
		assert.deepEqual(mine.asks.map((a: { question: string; answer: string }) => [a.question, a.answer]), [["Why 20?", "Answer to: Why 20?"], ["And 30?", "Answer to: And 30?"]]);
		assert.deepEqual((await (await explain("kellyl", { before, after, pr })).json()).asks, []);
		await ask("kellyl", { before, after, pr, question: "Mine" });
		assert.ok(!t.llm.calls.at(-1)!.user.includes("Why 20?"), "another person's questions are not sent with yours");
	} finally {
		await t.close();
	}
});

test("17. a follow-up streams as the model writes it; a failure or an empty answer is shown and not kept", async () => {
	const { t, explain, ask } = await setup();
	try {
		await explain("hyunhwanj", { before, after });
		const r = await ask("hyunhwanj", { before, after, question: "Why 20?" }, { accept: "text/event-stream" });
		assert.match(r.headers.get("content-type")!, /event-stream/);
		const text = await r.text();
		assert.match(text, /data: \{"delta":/);
		assert.match(text, /event: done\ndata: \{"answer":"Answer to: Why 20\?","cached":false\}/);

		t.llm.failNext = true;
		const failed = await ask("hyunhwanj", { before, after, question: "Fails" });
		assert.equal(failed.status, 502);
		assert.match((await failed.json()).error, /LLM/);
		t.llm.answer = () => "  ";
		assert.equal((await ask("hyunhwanj", { before, after, question: "Blank" })).status, 502);
		const { asks } = await (await explain("hyunhwanj", { before, after })).json();
		assert.deepEqual(asks.map((a: { question: string }) => a.question), ["Why 20?"]);
	} finally {
		await t.close();
	}
});

test("17. a follow-up needs an explanation, a question that is not too long, a repo you can see, and an LLM", async () => {
	const { t, explain, ask } = await setup();
	const none = await setup({ llm: false });
	try {
		const first = await ask("hyunhwanj", { before, after, question: "Why 20?" });
		assert.equal(first.status, 409);
		assert.match((await first.json()).error, /explain/i);
		await explain("hyunhwanj", { before, after });
		assert.equal((await ask("hyunhwanj", { before, after, question: "   " })).status, 400);
		assert.equal((await ask("hyunhwanj", { before, after })).status, 400);
		assert.equal((await ask("hyunhwanj", { before, after, question: "x".repeat(2001) })).status, 400);
		assert.equal((await ask("kellyl", { before: null, after: { repo: MINE, ref: "h", path: "a.ts" }, question: "Why?" })).status, 404);
		assert.equal((await none.ask("hyunhwanj", { before, after, question: "Why?" })).status, 503);
		assert.equal(t.llm.calls.length, 1, "only the explanation was asked for");
	} finally {
		await t.close();
		await none.t.close();
	}
});
