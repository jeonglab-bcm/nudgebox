/**
 * config.yaml, read and checked (deploy/config.example.yaml shows every key). Secrets are
 * not here: they come from the environment (.env). Nothing lab-specific is built in, so a
 * lab running its own copy only writes its own config.yaml.
 */
import { parse } from "yaml";
import type { Config, ServerAi } from "./app.ts";
import type { Provider } from "./llm.ts";

/** Every top-level key the server reads, and those under `llm:`. */
export const CONFIG_KEYS = ["origin", "orgs", "admins", "staleDays", "oldDays", "timezone", "digestHour", "llm"];
export const LLM_KEYS = ["provider", "baseUrl", "model", "deepModel", "noThinking"];

export interface ServerConfig {
	config: Config;
	origin: string;
	digestHour: number;
	admins: string[];
	ai: ServerAi | undefined; // SPEC 12, 20: the server's own LLM, if any
	unknown: string[]; // keys the server does not read (a typo, or an old key)
}

export function readConfig(text: string, env: Record<string, string | undefined>): ServerConfig {
	const cfg = parse(text) ?? {};
	if (typeof cfg.origin !== "string" || !/^https?:\/\//.test(cfg.origin)) throw new Error("config.yaml: origin must be this site's address, e.g. https://review.example.org");
	if (!Array.isArray(cfg.orgs) || !cfg.orgs.length) throw new Error("config.yaml: orgs must list the GitHub accounts the app is installed on");
	const unknown = [
		...Object.keys(cfg).filter((k) => !CONFIG_KEYS.includes(k)),
		...Object.keys(cfg.llm ?? {}).filter((k) => !LLM_KEYS.includes(k)).map((k) => `llm.${k}`),
	];
	return {
		config: { orgs: cfg.orgs.map(String), staleDays: Number(cfg.staleDays ?? 3), oldDays: Number(cfg.oldDays ?? 30), timezone: String(cfg.timezone ?? "UTC") },
		origin: cfg.origin.replace(/\/$/, ""),
		digestHour: Number(cfg.digestHour ?? 9),
		admins: (cfg.admins ?? []).map((a: unknown) => String(a).toLowerCase()),
		ai: readAi(cfg.llm, env.LLM_API_KEY || undefined),
		unknown,
	};
}

function readAi(l: any, apiKey: string | undefined): ServerAi | undefined {
	if (!l?.model) return undefined;
	const provider = String(l.provider ?? (l.baseUrl ? "compatible" : "")) as Provider;
	if (!["openai", "anthropic", "compatible"].includes(provider)) throw new Error("config.yaml: llm.provider must be openai, anthropic or compatible");
	if (provider === "compatible" && !l.baseUrl) throw new Error("config.yaml: llm.baseUrl is needed for an OpenAI-compatible provider");
	if (provider !== "compatible" && !apiKey) return undefined; // OpenAI and Anthropic need LLM_API_KEY
	return {
		provider,
		baseUrl: provider === "compatible" ? String(l.baseUrl) : undefined,
		apiKey,
		model: String(l.model),
		deepModel: l.deepModel ? String(l.deepModel) : undefined,
		noThinking: Boolean(l.noThinking),
	};
}
