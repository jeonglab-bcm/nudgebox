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

export const ORIGIN = "https://gh.bioinfolder.com";
export const WEBHOOK_SECRET = "test-webhook-secret";

export type Pushed = { endpoint: string; payload: { title: string; body: string; url?: string } };

export async function start(opts: { staleDays?: number; oldDays?: number; now?: () => Date } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ghd-"));
	const github = new FakeGitHub();
	const pushed: Pushed[] = [];
	const gone = new Set<string>(); // push endpoints that answer 410 Gone
	const app: App = createApp({
		config: { orgs: ["jeonglab-bcm", "hyunhwan-bcm"], staleDays: opts.staleDays ?? 3, oldDays: opts.oldDays ?? 30, timezone: "America/Chicago" },
		origin: ORIGIN,
		github,
		webhookSecret: WEBHOOK_SECRET,
		vapidPublicKey: "BTestVapidPublicKey-not-a-real-key-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
		githubClientId: "Iv1.test",
		encryptionKey: randomBytes(32),
		dbPath: join(dir, "ghd.sqlite"),
		push: async (sub, payload) => {
			if (gone.has(sub.endpoint)) throw Object.assign(new Error("Gone"), { statusCode: 410 });
			pushed.push({ endpoint: sub.endpoint, payload });
		},
		now: opts.now ?? (() => new Date()),
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

	async function webhook(event: string, payload: unknown, secret = WEBHOOK_SECRET) {
		const body = JSON.stringify(payload);
		const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
		return fetch(base + "/webhook", {
			method: "POST",
			body,
			headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": randomBytes(8).toString("hex"), "x-hub-signature-256": sig },
		});
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
	return { app, github, pushed, gone, base, dir, req, link, inbox, issues, hide, webhook, subscribe, close };
}

/** "owner/repo#n" ids per section, for compact assertions. */
export const ids = (inbox: { sections: { id: string; prs: { repo: string; number: number }[] }[] }) =>
	Object.fromEntries(inbox.sections.map((s) => [s.id, s.prs.map((p) => `${p.repo}#${p.number}`)]));
