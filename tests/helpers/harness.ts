/**
 * Starts the app on a random port with a FakeGitHub, an in-memory push sender and a
 * temp SQLite file, and gives tests a small client that acts like the browser behind
 * the Keycloak sidecar (it sends the sidecar's identity headers).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { createApp, type App } from "../../src/app.ts";
import { FakeGitHub } from "./fake-github.ts";
import type { DiffResult, DiffSide, Differ } from "../../src/omnidiff.ts";
import type { LlmConfig } from "../../src/llm.ts";

export const ORIGIN = "https://gh.bioinfolder.com";
export const WEBHOOK_SECRET = "test-webhook-secret";

/** One request the app made to the LLM (SPEC 12). */
export type LlmCall = { system: string; user: string };

export type Pushed = { endpoint: string; payload: { title: string; body: string; url?: string; badge?: number }; urgency?: string };

/** `llm: false` starts the app with no LLM configured (SPEC 12: no Summarize). */
export async function start(opts: { staleDays?: number; oldDays?: number; now?: () => Date; llm?: false; diff?: Differ; admins?: string[] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ghd-"));
	const github = new FakeGitHub();
	const pushed: Pushed[] = [];
	const gone = new Set<string>(); // push endpoints that answer 410 Gone
	// in-memory stand-in for llm.bioinfolder.com: records prompts, answers "summary N"
	// `answer`, when set, answers each prompt by itself (SPEC 19: the model is asked different things)
	// SPEC 20: `made` records each provider the settings set up, `models` the model each call
	// went to ("server-model" is the server's own LLM), `listed` each model-list request
	const llm = {
		calls: [] as LlmCall[], failNext: false, reply: undefined as string | undefined, delayMs: 0, answer: undefined as ((p: LlmCall) => string) | undefined,
		made: [] as LlmConfig[], models: [] as string[], listed: [] as Omit<LlmConfig, "model">[],
	};
	// stand-in for omnidiff (SPEC 15): records what it was asked, answers `reply`
	const differ = { calls: [] as (DiffSide | null)[][], reply: { largeResidual: false, before: { hunks: [] }, after: { hunks: [] } } as DiffResult };
	// streamed when asked (onDelta): the answer in pieces of 6 characters, `delayMs` apart
	const summarize = async (prompt: LlmCall, onDelta?: (text: string) => void, model = "server-model") => {
		llm.calls.push(prompt);
		llm.models.push(model);
		if (llm.failNext) {
			llm.failNext = false;
			throw Object.assign(new Error("upstream unavailable"), { status: 503 });
		}
		const text = llm.answer?.(prompt) ?? llm.reply ?? `- summary ${llm.calls.length}`;
		if (onDelta) for (let i = 0; i < text.length; i += 6) {
			if (llm.delayMs) await new Promise((r) => setTimeout(r, llm.delayMs));
			onDelta(text.slice(i, i + 6));
		}
		return text;
	};
	const logs: string[] = [];
	const app: App = createApp({
		log: (m) => logs.push(m),
		config: { orgs: ["jeonglab-bcm", "hyunhwan-bcm"], staleDays: opts.staleDays ?? 3, oldDays: opts.oldDays ?? 30, timezone: "America/Chicago" },
		origin: ORIGIN,
		github,
		webhookSecret: WEBHOOK_SECRET,
		vapidPublicKey: "BAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QA" /* shape of a real one: 65 bytes, base64url */,
		githubClientId: "Iv1.test",
		encryptionKey: randomBytes(32),
		dbPath: join(dir, "ghd.sqlite"),
		push: async (sub, payload, opts) => {
			if (gone.has(sub.endpoint)) throw Object.assign(new Error("Gone"), { statusCode: 410 });
			pushed.push({ endpoint: sub.endpoint, payload, urgency: opts?.urgency });
		},
		now: opts.now ?? (() => new Date()),
		summarize: opts.llm === false ? undefined : summarize,
		admins: opts.admins ?? ["hyunhwanj"],
		// SPEC 20: providers chosen on the settings page; "wrong" is a key the provider refuses
		providers: {
			make: (c) => {
				llm.made.push(c);
				return async (p, onDelta) => {
					if (c.apiKey === "wrong") throw new Error("LLM error 401: invalid x-api-key");
					return summarize(p, onDelta, c.model);
				};
			},
			models: async (c) => {
				llm.listed.push(c);
				if (c.apiKey === "wrong") throw new Error("401 invalid x-api-key");
				return ["fake-a", "fake-b"];
			},
		},
		diff: async (a, b) => {
			differ.calls.push([a, b]);
			return opts.diff ? opts.diff(a, b) : differ.reply;
		},
	});
	const server: Server = createServer(app.handler);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	async function req(path: string, init: RequestInit & { as?: string } = {}) {
		const headers = new Headers(init.headers);
		if (init.as) {
			headers.set("x-forwarded-email", `${init.as}@bcm.edu`);
			headers.set("x-forwarded-preferred-username", init.as);
		}
		if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
		if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
		return fetch(base + path, { ...init, headers, redirect: "manual" });
	}

	/** Lab user `as` links GitHub account `login` through the OAuth round trip. */
	async function link(as: string, login: string) {
		const start = await req("/auth/github", { as });
		const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
		const code = `code-${login}`;
		github.codes.set(code, login);
		const cb = await req(`/auth/github/callback?code=${code}&state=${state}`, { as });
		if (cb.status !== 302) throw new Error(`link failed: ${cb.status} ${await cb.text()}`);
	}

	async function inbox(as: string) {
		const r = await req("/api/inbox", { as });
		if (r.status !== 200) throw new Error(`inbox ${r.status}: ${await r.text()}`);
		return (await r.json()) as {
			sections: { id: string; prs: { repo: string; number: number }[] }[];
			old: { repo: string; number: number }[];
			hidden: { repo: string; number: number }[];
		};
	}

	/** SPEC 11: the Issues tab. */
	async function issues(as: string) {
		const r = await req("/api/issues", { as });
		if (r.status !== 200) throw new Error(`issues ${r.status}: ${await r.text()}`);
		return (await r.json()) as { items: { repo: string; number: number }[]; old: { repo: string; number: number }[]; hidden: { repo: string; number: number }[] };
	}

	/** SPEC 5: Hide / Unhide one PR or issue for `as`. */
	async function hide(as: string, kind: "pr" | "issue", repo: string, number: number, un = false) {
		return req(un ? "/api/unhide" : "/api/hide", { as, method: "POST", body: JSON.stringify({ kind, repo, number }) });
	}

	/** SPEC 12: the Summarize button. */
	async function summary(as: string, kind: "pr" | "issue", repo: string, number: number) {
		return req("/api/summarize", { as, method: "POST", body: JSON.stringify({ kind, repo, number }) });
	}

	async function webhook(event: string, payload: unknown, secret = WEBHOOK_SECRET) {
		const body = JSON.stringify(payload);
		const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
		return fetch(base + "/webhook", {
			method: "POST",
			body,
			headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": randomBytes(8).toString("hex"), "x-hub-signature-256": sig },
		});
	}

	/** SPEC 7: the page tells the server it was opened (resets the unread count). */
	async function seen(as: string) {
		return req("/api/push/seen", { as, method: "POST", body: "{}" });
	}

	async function subscribe(as: string, endpoint: string) {
		const r = await req("/api/push/subscribe", { as, method: "POST", body: JSON.stringify({ endpoint, keys: { p256dh: "k", auth: "a" } }) });
		if (r.status !== 201) throw new Error(`subscribe ${r.status}`);
	}

	const close = async () => {
		await app.close();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	};
	return { app, github, llm, differ, pushed, gone, base, dir, logs, req, link, inbox, issues, hide, summary, webhook, subscribe, seen, close };
}

/** "owner/repo#n" ids per section, for compact assertions. */
export const ids = (inbox: { sections: { id: string; prs: { repo: string; number: number }[] }[] }) =>
	Object.fromEntries(inbox.sections.map((s) => [s.id, s.prs.map((p) => `${p.repo}#${p.number}`)]));
