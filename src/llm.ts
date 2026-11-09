/**
 * SPEC 12, 20: the LLM as one function: a system + user prompt in, the answer's text out.
 * Given `onDelta`, the answer is streamed and each new piece of visible text is passed on
 * as it arrives. Three providers (SPEC 20):
 * - "openai" and "compatible" (the lab LLM, Ollama, vLLM, ...) speak chat completions;
 *   any <think> block a model emits is dropped. Qwen's thinking is turned off only when
 *   asked (`noThinking`): OpenAI refuses fields it does not know.
 * - "anthropic" is Anthropic's own Messages API, through @anthropic-ai/sdk.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface Prompt {
	system: string; // fixed instructions
	user: string; // the item's text: data, never instructions
	maxTokens?: number; // room the answer needs when it is long (a plan naming every file); the chat path's default is 1200
}

export type Summarize = (prompt: Prompt, onDelta?: (text: string) => void) => Promise<string>;

export type Provider = "openai" | "anthropic" | "compatible";

/** One provider and model. `baseUrl` is needed for "compatible"; the others have their own. */
export interface LlmConfig {
	provider: Provider;
	baseUrl?: string; // e.g. https://llm.bioinfolder.com/v1
	apiKey?: string; // optional for "compatible" (Ollama needs none)
	model: string;
	noThinking?: boolean; // "compatible" only: Qwen's chat_template_kwargs.enable_thinking = false
	timeoutMs?: number; // default 90 s (Anthropic: 5 min)
}

export const OPENAI_URL = "https://api.openai.com/v1";

export function createLlm(c: LlmConfig): Summarize {
	if (c.provider === "anthropic") return anthropic(c);
	if (c.provider === "openai") return chat({ ...c, baseUrl: c.baseUrl ?? OPENAI_URL, noThinking: false, openai: true });
	if (!c.baseUrl) throw new Error("an OpenAI-compatible provider needs an address");
	return chat({ ...c, baseUrl: c.baseUrl });
}

/** The provider's models, sorted. Throws with the provider's message (e.g. a wrong key). */
export async function listModels(c: Omit<LlmConfig, "model">): Promise<string[]> {
	if (c.provider === "anthropic") {
		const ids: string[] = [];
		for await (const m of client(c).models.list()) ids.push(m.id);
		return ids.sort();
	}
	const base = (c.baseUrl ?? (c.provider === "openai" ? OPENAI_URL : "")).replace(/\/$/, "");
	if (!base) throw new Error("an OpenAI-compatible provider needs an address");
	const r = await fetch(`${base}/models`, { headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}, signal: AbortSignal.timeout(15_000) });
	const data: any = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(`${r.status}: ${data?.error?.message ?? data?.message ?? r.statusText}`);
	return (Array.isArray(data?.data) ? data.data : []).map((m: any) => String(m?.id ?? "")).filter(Boolean).sort();
}

// -- Anthropic ---------------------------------------------------------------------------

/** Models that take the server-side fallback on a refusal (Claude API, "default" form). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

const client = (c: Pick<LlmConfig, "apiKey" | "baseUrl" | "timeoutMs">) =>
	new Anthropic({ apiKey: c.apiKey ?? "", baseURL: c.baseUrl ?? null, timeout: c.timeoutMs ?? 300_000, maxRetries: 1 });

function anthropic(c: LlmConfig): Summarize {
	const api = client(c);
	return async ({ system, user }, onDelta) => {
		const fallback = FALLBACK_MODELS.has(c.model);
		const stream = api.beta.messages.stream({
			model: c.model,
			max_tokens: 16000, // thinking counts too; summaries and reviews are short
			system,
			messages: [{ role: "user", content: user }],
			...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
		});
		if (onDelta) stream.on("text", (delta) => onDelta(delta));
		let msg;
		try {
			msg = await stream.finalMessage();
		} catch (e) {
			if (e instanceof Anthropic.APIError && e.status) throw new Error(`LLM error ${e.status}: ${anthropicMessage(e)}`);
			if (e instanceof Anthropic.APIConnectionTimeoutError) throw new Error("LLM did not answer in time");
			throw new Error(`LLM unreachable: ${(e as Error).message}`);
		}
		if (msg.stop_reason === "refusal") throw new Error("Claude declined to answer this one");
		const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
		if (!text) throw new Error("LLM gave an empty answer");
		return text;
	};
}

function anthropicMessage(e: InstanceType<typeof Anthropic.APIError>) {
	const err = (e.error as any)?.error;
	return String(err?.message ?? e.message);
}

// -- chat completions (OpenAI and OpenAI-compatible) ------------------------------------

/** The lab LLM's original options (SPEC 12), kept for callers of createSummarizer. */
export interface LlmOptions {
	baseUrl: string;
	apiKey?: string;
	model: string;
	noThinking?: boolean;
	timeoutMs?: number;
}

export const createSummarizer = (o: LlmOptions): Summarize => chat(o);

function chat(o: LlmOptions & { openai?: boolean }): Summarize {
	return async ({ system, user, maxTokens }, onDelta) => {
		let r: Response;
		try {
			r = await fetch(`${o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				headers: { ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}), "content-type": "application/json" },
				body: JSON.stringify({
					model: o.model,
					messages: [{ role: "system", content: system }, { role: "user", content: user }],
					stream: Boolean(onDelta),
					// OpenAI's reasoning models take only max_completion_tokens, and no temperature
					...(o.openai ? { max_completion_tokens: 16000 } : { max_tokens: maxTokens ?? 1200, temperature: 0.3 }),
					...(o.noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
				}),
				// a long answer (a plan over many files: 2-3 minutes on the lab model) gets the five minutes OpenAI gets
				signal: AbortSignal.timeout(o.timeoutMs ?? (o.openai || maxTokens ? 300_000 : 90_000)),
			});
		} catch (e) {
			const name = (e as Error).name;
			if (name === "TimeoutError" || name === "AbortError") throw new Error("LLM did not answer in time");
			throw new Error(`LLM unreachable: ${(e as Error).message}`);
		}
		if (!r.ok || !onDelta) {
			const data: any = await r.json().catch(() => ({}));
			if (!r.ok) {
				const msg = data?.error?.message ?? data?.message ?? r.statusText;
				throw Object.assign(new Error(`LLM error ${r.status}: ${msg}`), { status: r.status });
			}
			const text = visible(String(data?.choices?.[0]?.message?.content ?? "")).trim();
			if (!text) throw new Error("LLM gave an empty answer");
			return text;
		}
		// streamed: "data: {json}" lines, then "data: [DONE]"
		let raw = "";
		let sent = 0; // visible characters passed on so far
		let buf = "";
		const dec = new TextDecoder();
		for await (const chunk of r.body!) {
			buf += dec.decode(chunk as Uint8Array, { stream: true });
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") continue;
				const piece = JSON.parse(payload)?.choices?.[0]?.delta?.content ?? "";
				if (!piece) continue;
				raw += piece;
				// pass on only text outside <think>, without leading blank lines
				const shown = visible(raw).replace(/^\s+/, "");
				const safe = /<[^>]*$/.test(shown) ? shown.slice(0, shown.lastIndexOf("<")) : shown; // a tag may be half arrived
				if (safe.length > sent) {
					onDelta(safe.slice(sent));
					sent = safe.length;
				}
			}
		}
		const text = visible(raw).trim();
		if (!text) throw new Error("LLM gave an empty answer");
		if (text.length > sent) onDelta(text.slice(sent)); // a held-back "<" that was not a tag after all
		return text;
	};
}

/** The answer without <think> blocks; an unfinished one hides everything after it. */
function visible(s: string) {
	return s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
}
