/**
 * SPEC 17. Explain a file's diff: the model reads the file's changed lines (read from
 * GitHub by Nudgebox) with a little context, and the explanation is kept per version pair.
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
	return { t, explain };
}

test("17. Explain sends the model the file's changed lines with 3 lines around them, and the PR title", async () => {
	const { t, explain } = await setup();
	try {
		const r = await explain("hyunhwanj", { before, after, pr: { repo: LAB, number: 4 } });
		assert.equal(r.status, 200, await r.clone().text());
		assert.deepEqual(await r.json(), { explanation: "The change raises `limit` from 10 to 20.", cached: false });
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
		assert.deepEqual(again, { explanation: "The change raises `limit` from 10 to 20.", cached: true });
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
		assert.match(text, /event: done\ndata: \{"explanation":"The change raises `limit` from 10 to 20\.","cached":false\}/);
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
