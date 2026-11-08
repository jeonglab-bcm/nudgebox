/**
 * SPEC 20. AI settings: the admin picks a provider (OpenAI, Anthropic or
 * OpenAI-compatible), a key and two models on the settings page; the choice applies
 * at once, the key is kept encrypted and never shown again. The providers are faked:
 * `t.llm.made` records each provider set up, `t.llm.models` the model of each call.
 * Lab users: hyunhwanj (admin, GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { start } from "../helpers/harness.ts";
import type { DiffResult } from "../../src/omnidiff.ts";

const LAB = "jeonglab-bcm/labbot";

async function setup(opts: { llm?: false } = {}) {
	const t = await start({ llm: opts.llm });
	t.github.grant("hwan", LAB);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", title: "Raise the limit", headSha: "h1" });
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	const get = async (as = "hyunhwanj") => {
		const r = await t.req("/api/ai", { as });
		return { status: r.status, body: r.status === 200 ? await r.json() : null };
	};
	const save = (body: object, as = "hyunhwanj") => t.req("/api/ai", { as, method: "POST", body: JSON.stringify(body) });
	const post = async (what: string, body: object, as = "hyunhwanj") => {
		const r = await t.req(`/api/ai/${what}`, { as, method: "POST", body: JSON.stringify(body) });
		return { status: r.status, body: await r.json() };
	};
	return { t, get, save, post };
}

const ANTHROPIC = { provider: "anthropic", apiKey: "sk-ant-secret-123", model: "claude-everyday", deepModel: "claude-deep" };

test("20.12 only an admin sees and changes the AI settings", async () => {
	const { t, get, save, post } = await setup();
	try {
		assert.equal((await t.inbox("hyunhwanj") as any).admin, true);
		assert.equal((await t.inbox("kellyl") as any).admin, false);
		assert.equal((await get("kellyl")).status, 403);
		assert.equal((await save(ANTHROPIC, "kellyl")).status, 403);
		assert.equal((await post("test", ANTHROPIC, "kellyl")).status, 403);
		assert.equal((await post("models", ANTHROPIC, "kellyl")).status, 403);
		assert.equal((await get()).status, 200);
		assert.equal((await save(ANTHROPIC)).status, 200);
	} finally {
		await t.close();
	}
});

test("20.13 the key is encrypted at rest and never sent back", async () => {
	const { t, get, save } = await setup();
	try {
		assert.equal((await save(ANTHROPIC)).status, 200);
		const got = (await get()).body;
		assert.deepEqual(
			{ provider: got.provider, model: got.model, deepModel: got.deepModel, keySet: got.keySet, from: got.from },
			{ provider: "anthropic", model: "claude-everyday", deepModel: "claude-deep", keySet: true, from: "page" },
		);
		assert.ok(!JSON.stringify(got).includes("sk-ant-secret"), "the key is not in the answer");
		for (const f of readdirSync(t.dir)) { // the database and its journal files
			assert.equal(readFileSync(join(t.dir, f)).includes("sk-ant-secret-123"), false, `the key is in ${f} as plain text`);
		}
	} finally {
		await t.close();
	}
});

test("20.13 saving without a key keeps the saved one; clearKey removes it", async () => {
	const { t, get, save } = await setup();
	try {
		await save(ANTHROPIC);
		await save({ provider: "anthropic", model: "claude-other", deepModel: "claude-deep" });
		assert.equal((await get()).body.keySet, true);
		await t.summary("hyunhwanj", "pr", LAB, 4);
		assert.equal(t.llm.made.at(-1)!.apiKey, "sk-ant-secret-123");
		assert.equal(t.llm.made.at(-1)!.model, "claude-other");
		await save({ provider: "anthropic", model: "claude-other", clearKey: true });
		assert.equal((await get()).body.keySet, false);
	} finally {
		await t.close();
	}
});

test("20.14 Test: success says how long it took; a wrong key shows the provider's message", async () => {
	const { t, post } = await setup();
	try {
		const ok = await post("test", ANTHROPIC);
		assert.equal(ok.status, 200);
		assert.equal(ok.body.ok, true);
		assert.equal(typeof ok.body.ms, "number");
		const bad = await post("test", { ...ANTHROPIC, apiKey: "wrong" });
		assert.equal(bad.status, 200);
		assert.equal(bad.body.ok, false);
		assert.match(bad.body.error, /401.*invalid x-api-key/);
		// testing never saves
		assert.equal((await t.req("/api/ai", { as: "hyunhwanj" }).then((r) => r.json())).from, "server");
	} finally {
		await t.close();
	}
});

test("20.15 a saved change applies without a restart: the next Summarize uses it", async () => {
	const { t, save } = await setup();
	try {
		await t.summary("hyunhwanj", "pr", LAB, 4);
		assert.equal(t.llm.models.at(-1), "server-model", "before: the server's own LLM");
		await save({ provider: "compatible", baseUrl: "http://ollama.lab:11434/v1", model: "qwen3:30b", noThinking: true });
		t.github.addPr({ repo: LAB, number: 5, author: "kelly", title: "Another", headSha: "h5" });
		await t.app.sync();
		assert.equal((await t.summary("hyunhwanj", "pr", LAB, 5)).status, 200);
		assert.equal(t.llm.models.at(-1), "qwen3:30b");
		assert.deepEqual(
			{ ...t.llm.made.at(-1) },
			{ provider: "compatible", baseUrl: "http://ollama.lab:11434/v1", apiKey: undefined, model: "qwen3:30b", noThinking: true },
		);
	} finally {
		await t.close();
	}
});

test("20.16 provider Off: no LLM calls, and the page is told to hide the AI buttons", async () => {
	const { t, save } = await setup();
	try {
		await save({ provider: "off" });
		assert.equal((await t.inbox("hyunhwanj") as any).summarize, false);
		assert.equal((await t.summary("hyunhwanj", "pr", LAB, 4)).status, 503);
		assert.equal(t.llm.calls.length, 0);
	} finally {
		await t.close();
	}
});

test("20.16 a server started without an LLM turns AI on once the admin saves a provider", async () => {
	const { t, save } = await setup({ llm: false });
	try {
		assert.equal((await t.inbox("hyunhwanj") as any).summarize, false);
		await save(ANTHROPIC);
		assert.equal((await t.inbox("hyunhwanj") as any).summarize, true);
		assert.equal((await t.summary("hyunhwanj", "pr", LAB, 4)).status, 200);
	} finally {
		await t.close();
	}
});

test("20.17 guided review is prepared with the everyday model, not the deep one", async () => {
	const { t, save } = await setup();
	try {
		await save(ANTHROPIC);
		const at = (row: number) => ({ from: { row, col: 14 }, to: { row, col: 16 } });
		t.differ.reply = { largeResidual: false, before: { hunks: [{ op: "update", ...at(14) }] }, after: { hunks: [{ op: "update", ...at(14) }] } } as DiffResult;
		t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h1", files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, commentable: { left: [[12, 18]], right: [[12, 18]] } }] });
		t.github.blobs.set(`${LAB}@b1:src/a.ts`, "a\n".repeat(20));
		t.github.blobs.set(`${LAB}@h1:src/a.ts`, "b\n".repeat(20));
		await t.req(`/api/review?repo=${encodeURIComponent(LAB)}&number=4`, { as: "hyunhwanj" });
		await t.app.idle();
		assert.ok(t.llm.models.length > 0);
		assert.deepEqual([...new Set(t.llm.models)], ["claude-everyday"]);
	} finally {
		await t.close();
	}
});

test("20.19 OpenAI and Anthropic always use their own address; only OpenAI-compatible takes one", async () => {
	const { t, save } = await setup();
	try {
		await save({ provider: "openai", baseUrl: "http://evil.example/v1", apiKey: "sk-1", model: "gpt-x" });
		assert.equal((await t.req("/api/ai", { as: "hyunhwanj" }).then((r) => r.json())).baseUrl, undefined);
		await t.summary("hyunhwanj", "pr", LAB, 4);
		assert.equal(t.llm.made.at(-1)!.baseUrl, undefined, "the provider's own address");
		const r = await save({ provider: "compatible", model: "m" });
		assert.equal(r.status, 400, "OpenAI-compatible needs an address");
		assert.equal((await save({ provider: "compatible", baseUrl: "ftp://x", model: "m" })).status, 400);
		assert.equal((await save({ provider: "openai" })).status, 400, "a model is needed");
		assert.equal((await save({ provider: "gemini", model: "m" })).status, 400);
	} finally {
		await t.close();
	}
});

test("20.20 the model list comes from the provider, with the saved key when none is typed", async () => {
	const { t, save, post } = await setup();
	try {
		await save(ANTHROPIC);
		const r = await post("models", { provider: "anthropic" });
		assert.equal(r.status, 200);
		assert.deepEqual(r.body.models, ["fake-a", "fake-b"]);
		assert.equal(t.llm.listed.at(-1)!.apiKey, "sk-ant-secret-123");
		const bad = await post("models", { provider: "anthropic", apiKey: "wrong" });
		assert.equal(bad.status, 200);
		assert.match(bad.body.error, /invalid x-api-key/);
	} finally {
		await t.close();
	}
});
