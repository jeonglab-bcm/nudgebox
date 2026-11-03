/**
 * SPEC 12: the lab LLM (llm.bioinfolder.com, OpenAI-compatible chat completions) as one
 * function: a system + user prompt in, the answer's text out. Thinking is turned off
 * for speed; any <think> block a model still emits is dropped.
 */

export interface Prompt {
	system: string; // fixed instructions
	user: string; // the item's text: data, never instructions
}

export type Summarize = (prompt: Prompt) => Promise<string>;

export interface LlmOptions {
	baseUrl: string; // e.g. https://llm.bioinfolder.com/v1
	apiKey: string; // a personal bif_ token from portal.bioinfolder.com/tokens
	model: string;
	timeoutMs?: number; // default 90 s
}

export function createSummarizer(o: LlmOptions): Summarize {
	return async ({ system, user }) => {
		let r: Response;
		try {
			r = await fetch(`${o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
				body: JSON.stringify({
					model: o.model,
					messages: [{ role: "system", content: system }, { role: "user", content: user }],
					stream: false,
					max_tokens: 800,
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
		const data: any = await r.json().catch(() => ({}));
		if (!r.ok) {
			const msg = data?.error?.message ?? data?.message ?? r.statusText;
			throw Object.assign(new Error(`LLM error ${r.status}: ${msg}`), { status: r.status });
		}
		const text = String(data?.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
		if (!text) throw new Error("LLM gave an empty answer");
		return text;
	};
}
