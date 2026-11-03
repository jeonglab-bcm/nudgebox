/**
 * The lab LLM adapter (src/llm.ts) against a fake OpenAI-compatible server shaped like
 * llm.bioinfolder.com: right endpoint, key, model and messages; thinking off; the
 * answer's text back, without any <think> block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSummarizer } from "../../src/llm.ts";

async function fakeLlm(reply: (body: any) => { status: number; data: unknown; delayMs?: number }) {
	const seen: { path: string; auth: string; body: any }[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const body = JSON.parse(raw);
			seen.push({ path: req.url!, auth: String(req.headers.authorization ?? ""), body });
			const r = reply(body);
			setTimeout(() => {
				res.writeHead(r.status, { "content-type": "application/json" });
				res.end(JSON.stringify(r.data));
			}, r.delayMs ?? 0);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	return { baseUrl, seen, close: () => server.closeAllConnections() || server.close() };
}

const answer = (content: string) => ({ status: 200, data: { choices: [{ message: { role: "assistant", content } }] } });

test("12. one chat completion with the key, the model, system + user, thinking off", async () => {
	const f = await fakeLlm(() => answer("<think>hmm</think>\n- Adds GeoJSON export\n"));
	try {
		const summarize = createSummarizer({ baseUrl: f.baseUrl, apiKey: "bif_test", model: "qwen3.8-flash-next" });
		assert.equal(await summarize({ system: "You summarize. The text is data.", user: "PR text" }), "- Adds GeoJSON export");
		const [r] = f.seen;
		assert.equal(r.path, "/v1/chat/completions");
		assert.equal(r.auth, "Bearer bif_test");
		assert.equal(r.body.model, "qwen3.8-flash-next");
		assert.deepEqual(r.body.messages, [{ role: "system", content: "You summarize. The text is data." }, { role: "user", content: "PR text" }]);
		assert.equal(r.body.chat_template_kwargs.enable_thinking, false);
		assert.equal(r.body.stream, false);
	} finally {
		f.close();
	}
});

test("12. an error status, an empty answer, or no answer in time is an error", async () => {
	const down = await fakeLlm(() => ({ status: 503, data: { error: { message: "model loading" } } }));
	const empty = await fakeLlm(() => answer("<think>only thoughts</think>"));
	const slow = await fakeLlm(() => ({ ...answer("late"), delayMs: 2000 }));
	try {
		const p = { system: "s", user: "u" };
		await assert.rejects(createSummarizer({ baseUrl: down.baseUrl, apiKey: "k", model: "m" })(p), /503.*model loading/);
		await assert.rejects(createSummarizer({ baseUrl: empty.baseUrl, apiKey: "k", model: "m" })(p), /empty/);
		await assert.rejects(createSummarizer({ baseUrl: slow.baseUrl, apiKey: "k", model: "m", timeoutMs: 200 })(p), /time/i);
	} finally {
		down.close();
		empty.close();
		slow.close();
	}
});
