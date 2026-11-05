/**
 * SPEC 12: the lab LLM (llm.bioinfolder.com, OpenAI-compatible chat completions) as one
 * function: a system + user prompt in, the answer's text out. Thinking is turned off
 * for speed; any <think> block a model still emits is dropped. Given `onDelta`, the
 * answer is streamed (server-sent events) and each new piece of visible text is passed
 * on as it arrives.
 */

export interface Prompt {
	system: string; // fixed instructions
	user: string; // the item's text: data, never instructions
}

export type Summarize = (prompt: Prompt, onDelta?: (text: string) => void) => Promise<string>;

export interface LlmOptions {
	baseUrl: string; // e.g. https://llm.bioinfolder.com/v1
	apiKey: string; // a personal bif_ token from portal.bioinfolder.com/tokens
	model: string;
	timeoutMs?: number; // default 90 s
}

export function createSummarizer(o: LlmOptions): Summarize {
	return async ({ system, user }, onDelta) => {
		let r: Response;
		try {
			r = await fetch(`${o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
				body: JSON.stringify({
					model: o.model,
					messages: [{ role: "system", content: system }, { role: "user", content: user }],
					stream: Boolean(onDelta),
					max_tokens: 1200,
					temperature: 0.3,
					chat_template_kwargs: { enable_thinking: false },
				}),
				signal: AbortSignal.timeout(o.timeoutMs ?? 90_000),
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
