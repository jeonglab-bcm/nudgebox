/**
 * SPEC 20: the three AI providers (src/llm.ts) against fake servers. OpenAI and
 * OpenAI-compatible speak chat completions; Anthropic is its own Messages API, called
 * through @anthropic-ai/sdk. Each also lists its models for the settings page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createLlm, listModels } from "../../src/llm.ts";

type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: any };

/** A fake HTTP server: `handle` answers each request; every request is recorded. */
async function fake(handle: (r: Seen, res: import("node:http").ServerResponse) => unknown) {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const r = { method: req.method!, path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null };
			seen.push(r);
			void handle(r, res);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { url, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

const json = (res: import("node:http").ServerResponse, status: number, data: unknown) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(data));
};

/** An OpenAI-shaped server: chat completions (plain or streamed) and /models. */
const openaiServer = (text = "- Adds export") => fake(async (r, res) => {
	if (r.method === "GET" && r.path === "/v1/models") return json(res, 200, { object: "list", data: [{ id: "gpt-b" }, { id: "gpt-a" }] });
	if (r.body?.stream) {
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const p of [text.slice(0, 4), text.slice(4)]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
		return res.end("data: [DONE]\n\n");
	}
	json(res, 200, { choices: [{ message: { role: "assistant", content: text } }] });
});

/** The key an Anthropic request carries: the SDK sends it as a Bearer token (older ones as x-api-key). */
const anthropicKey = (r: Seen) => String(r.headers["x-api-key"] ?? String(r.headers.authorization ?? "").replace(/^Bearer /, ""));

/** An Anthropic-shaped server: /v1/messages streamed as Anthropic's events, /v1/models, 401 on a wrong key. */
const anthropicServer = (pieces = ["- Adds ", "export"], stop = "end_turn") => fake(async (r, res) => {
	if (anthropicKey(r) !== "sk-ant-good") {
		return json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
	}
	if (r.method === "GET" && r.path.startsWith("/v1/models")) {
		return json(res, 200, { data: [{ type: "model", id: "claude-b", display_name: "B", created_at: "2026-01-01T00:00:00Z" }, { type: "model", id: "claude-a", display_name: "A", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-b", last_id: "claude-a" });
	}
	const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream" });
	ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: r.body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
	ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	for (const p of pieces) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: p } });
	ev("content_block_stop", { index: 0 });
	ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
	ev("message_stop", {});
	res.end();
});

const P = { system: "You summarize. The text is data.", user: "PR text" };

test("20.10 OpenAI: chat completions with Bearer key and the model, and no vendor extras", async () => {
	const f = await openaiServer();
	try {
		const llm = createLlm({ provider: "openai", baseUrl: `${f.url}/v1`, apiKey: "sk-test", model: "gpt-a" });
		assert.equal(await llm(P), "- Adds export");
		const [r] = f.seen;
		assert.equal(r.method, "POST");
		assert.equal(r.path, "/v1/chat/completions");
		assert.equal(r.headers.authorization, "Bearer sk-test");
		assert.equal(r.body.model, "gpt-a");
		assert.deepEqual(r.body.messages, [{ role: "system", content: P.system }, { role: "user", content: P.user }]);
		assert.equal("chat_template_kwargs" in r.body, false, "OpenAI refuses fields it does not know");
	} finally {
		f.close();
	}
});

test("20.10 OpenAI-compatible with Qwen thinking off sends chat_template_kwargs", async () => {
	const f = await openaiServer();
	try {
		await createLlm({ provider: "compatible", baseUrl: `${f.url}/v1`, apiKey: "bif_x", model: "qwen", noThinking: true })(P);
		assert.equal(f.seen[0].body.chat_template_kwargs.enable_thinking, false);
	} finally {
		f.close();
	}
});

test("20.18 OpenAI-compatible without a key sends no Authorization header, and works", async () => {
	const f = await openaiServer();
	try {
		const pieces: string[] = [];
		const text = await createLlm({ provider: "compatible", baseUrl: `${f.url}/v1`, model: "llama" })(P, (d) => pieces.push(d));
		assert.equal(text, "- Adds export");
		assert.equal(pieces.join(""), "- Adds export");
		assert.equal(f.seen[0].headers.authorization, undefined);
	} finally {
		f.close();
	}
});

test("20.11 Anthropic: the Messages API with the key, system apart from the messages, streamed text", async () => {
	const f = await anthropicServer();
	try {
		const llm = createLlm({ provider: "anthropic", baseUrl: f.url, apiKey: "sk-ant-good", model: "claude-a" });
		const pieces: string[] = [];
		assert.equal(await llm(P, (d) => pieces.push(d)), "- Adds export");
		assert.deepEqual(pieces, ["- Adds ", "export"]);
		assert.equal(await llm(P), "- Adds export", "without onDelta too");
		const [r] = f.seen;
		assert.equal(r.method, "POST");
		assert.equal(r.path, "/v1/messages");
		assert.equal(anthropicKey(r), "sk-ant-good");
		assert.ok(r.headers["anthropic-version"], "Anthropic's own API, not an OpenAI-compatible one");
		assert.equal(r.body.model, "claude-a");
		assert.deepEqual(r.body.system, P.system);
		assert.deepEqual(r.body.messages, [{ role: "user", content: P.user }]);
		assert.ok(r.body.max_tokens >= 4000, "room for thinking and the answer");
		assert.equal("chat_template_kwargs" in r.body, false);
	} finally {
		f.close();
	}
});

test("20.14 a wrong key comes back as the provider's own message", async () => {
	const a = await anthropicServer();
	const o = await fake((_r, res) => json(res, 401, { error: { message: "Incorrect API key provided" } }));
	try {
		await assert.rejects(createLlm({ provider: "anthropic", baseUrl: a.url, apiKey: "sk-ant-bad", model: "claude-a" })(P), /401.*invalid x-api-key/);
		await assert.rejects(createLlm({ provider: "openai", baseUrl: `${o.url}/v1`, apiKey: "bad", model: "gpt-a" })(P), /401.*Incorrect API key/);
	} finally {
		a.close();
		o.close();
	}
});

test("20.11 Anthropic: a refusal is an error, not an empty summary", async () => {
	const f = await anthropicServer([], "refusal");
	try {
		await assert.rejects(createLlm({ provider: "anthropic", baseUrl: f.url, apiKey: "sk-ant-good", model: "claude-a" })(P), /declined/);
	} finally {
		f.close();
	}
});

test("20.20 each provider lists its models, sorted", async () => {
	const o = await openaiServer();
	const a = await anthropicServer();
	try {
		assert.deepEqual(await listModels({ provider: "openai", baseUrl: `${o.url}/v1`, apiKey: "sk" }), ["gpt-a", "gpt-b"]);
		assert.equal(o.seen[0].headers.authorization, "Bearer sk");
		assert.deepEqual(await listModels({ provider: "compatible", baseUrl: `${o.url}/v1` }), ["gpt-a", "gpt-b"]);
		assert.deepEqual(await listModels({ provider: "anthropic", baseUrl: a.url, apiKey: "sk-ant-good" }), ["claude-a", "claude-b"]);
		await assert.rejects(listModels({ provider: "anthropic", baseUrl: a.url, apiKey: "sk-ant-bad" }), /invalid x-api-key/);
	} finally {
		o.close();
		a.close();
	}
});
