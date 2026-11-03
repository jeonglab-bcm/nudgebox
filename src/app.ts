/**
 * The app: HTTP handler (pages, API, webhook) plus the sync and stale-digest jobs.
 * The acceptance tests in tests/acceptance define the behaviour; SPEC.md the why.
 *
 * Identity comes only from the Keycloak sidecar's headers (SPEC 3.1): this process
 * must be reachable only through that sidecar, except /webhook (signature-checked)
 * and the static web-app files (no data in them).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHubPort, PullRequest } from "./github.ts";
import { Store, type LinkedUser } from "./store.ts";
import { seal, unseal } from "./crypto.ts";
import { buildInbox, isMine, reviewRequested, type Viewer } from "./inbox.ts";
import { verifySignature } from "./webhook.ts";

export interface Config {
	orgs: string[]; // accounts the GitHub App is installed on
	staleDays: number; // SPEC 7.3
	timezone: string; // for the 09:00 digest
}

export interface PushSubscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface PushPayload {
	title: string;
	body: string;
	url?: string;
}

export interface AppOptions {
	config: Config;
	origin: string; // e.g. https://gh.bioinfolder.com, for the cross-site POST check
	github: GitHubPort;
	githubClientId?: string; // the GitHub App's client id, for "link GitHub"
	webhookSecret: string;
	encryptionKey: Buffer; // 32 bytes, encrypts stored GitHub tokens
	dbPath: string;
	vapidPublicKey?: string; // given to browsers to subscribe to push
	push: (sub: PushSubscription, payload: PushPayload) => Promise<void>; // throws {statusCode: 404|410} when gone
	now: () => Date;
	log?: (msg: string) => void;
}

export interface App {
	handler: (req: IncomingMessage, res: ServerResponse) => void;
	sync(): Promise<void>; // full refresh from GitHub (start-up and every 10 min)
	runStaleDigest(): Promise<void>; // the daily stale-PR push
	idle(): Promise<void>; // resolves when webhook-triggered work has finished
	close(): Promise<void>;
}

const ACCESS_TTL_MS = 5 * 60_000;
const DAY_MS = 24 * 3600_000;
const MAX_BODY = 5 * 1024 * 1024;
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const STATIC: Record<string, string> = {
	"/manifest.webmanifest": "application/manifest+json",
	"/sw.js": "text/javascript",
	"/app.js": "text/javascript",
	"/icon.svg": "image/svg+xml",
	"/icon-180.png": "image/png",
	"/icon-512.png": "image/png",
};

class HttpError extends Error {
	status: number;
	extra: object;
	constructor(status: number, message: string, extra: object = {}) {
		super(message);
		this.status = status;
		this.extra = extra;
	}
}

export function createApp(opts: AppOptions): App {
	const { github, config } = opts;
	const store = new Store(opts.dbPath);
	const log = opts.log ?? (() => {});
	const access = new Map<string, { repos: Set<string>; teams: string[]; at: number }>();
	let work: Promise<void> = Promise.resolve();
	const later = (fn: () => Promise<void>) => {
		work = work.then(fn).catch((e) => log(`background work failed: ${e?.message ?? e}`));
	};

	// -- identity and GitHub tokens ---------------------------------------------

	function labUser(req: IncomingMessage): string {
		const name = String(req.headers["x-forwarded-preferred-username"] ?? "").trim().toLowerCase();
		const email = String(req.headers["x-forwarded-email"] ?? "").trim().toLowerCase();
		const who = name || email;
		if (!who) throw new HttpError(401, "sign in through the lab login");
		return who;
	}

	function linked(lab: string): LinkedUser {
		const u = store.user(lab);
		if (!u) throw new HttpError(409, "GitHub not linked", { link: "/auth/github" });
		return u;
	}

	function saveTokens(lab: string, t: { login: string; accessToken: string; refreshToken: string; expiresAt: string }) {
		store.saveUser({
			labUser: lab, login: t.login, expiresAt: t.expiresAt,
			accessSealed: seal(opts.encryptionKey, t.accessToken), refreshSealed: seal(opts.encryptionKey, t.refreshToken),
		});
	}

	/** A valid access token for this person, refreshed first if it is about to expire. */
	async function tokenFor(who: LinkedUser): Promise<string> {
		const u = store.user(who.labUser) ?? who; // may have been refreshed since `who` was read
		if (Date.parse(u.expiresAt) - opts.now().getTime() > 60_000) return unseal(opts.encryptionKey, u.accessSealed);
		try {
			const t = await github.refresh(unseal(opts.encryptionKey, u.refreshSealed));
			saveTokens(u.labUser, t);
			return t.accessToken;
		} catch (e) {
			throw new HttpError(409, "GitHub link expired, link again", { link: "/auth/github", cause: String((e as Error).message) });
		}
	}

	async function viewOf(u: LinkedUser): Promise<{ viewer: Viewer; repos: Set<string> }> {
		let a = access.get(u.labUser);
		if (!a || opts.now().getTime() - a.at > ACCESS_TTL_MS) {
			const token = await tokenFor(u);
			const [repos, teams] = await Promise.all([github.reposForUser(token), github.teamsForUser(token)]);
			a = { repos: new Set(repos.map((r) => r.toLowerCase())), teams, at: opts.now().getTime() };
			access.set(u.labUser, a);
		}
		return { viewer: { login: u.login, teams: a.teams }, repos: a.repos };
	}

	const visible = (repos: Set<string>) => (p: PullRequest) => repos.has(p.repo.toLowerCase());

	// -- push --------------------------------------------------------------------

	async function notify(lab: string, payload: PushPayload) {
		for (const d of store.devices(lab)) {
			try {
				await opts.push({ endpoint: d.endpoint, keys: d.keys }, payload);
			} catch (e) {
				const status = (e as { statusCode?: number }).statusCode;
				if (status === 404 || status === 410) store.deleteDevice(d.endpoint);
				else log(`push to a device of ${lab} failed: ${(e as Error).message}`);
			}
		}
	}

	const short = (p: { repo: string; number: number }) => `${p.repo.split("/")[1]}#${p.number}`;

	// -- webhook handling (SPEC 7-8) -------------------------------------------

	async function refreshPr(repo: string, number: number): Promise<PullRequest | null> {
		const p = await github.pullRequest(repo, number);
		if (p) store.putPr(p);
		else store.deletePr(repo, number);
		return p;
	}

	async function onReviewRequested(pr: PullRequest, payload: any) {
		const targets = new Set<string>();
		if (payload.requested_reviewer?.login) for (const u of store.usersByLogin(payload.requested_reviewer.login)) targets.add(u.labUser);
		if (payload.requested_team?.slug) {
			const team = `${payload.organization?.login ?? pr.repo.split("/")[0]}/${payload.requested_team.slug}`.toLowerCase();
			for (const u of store.users()) {
				try {
					const { viewer, repos } = await viewOf(u);
					if (repos.has(pr.repo.toLowerCase()) && viewer.teams.some((t) => t.toLowerCase() === team)) targets.add(u.labUser);
				} catch (e) {
					log(`team lookup for ${u.labUser} failed: ${(e as Error).message}`);
				}
			}
		}
		for (const lab of targets) await notify(lab, { title: "Review requested", body: `${short(pr)}: ${pr.title} (by ${pr.author})`, url: pr.url });
	}

	async function onChecks(repo: string, numbers: number[]) {
		for (const n of numbers) {
			const pr = await refreshPr(repo, n);
			if (!pr || (pr.checks !== "success" && pr.checks !== "failure")) continue;
			if (!store.markOnce(`ci:${repo}#${n}@${pr.headSha}`, opts.now().toISOString())) continue;
			const word = pr.checks === "success" ? "passed" : "failed";
			for (const u of store.usersByLogin(pr.author)) {
				await notify(u.labUser, { title: `CI ${word}`, body: `${short(pr)}: checks ${word}. ${pr.title}`, url: pr.url });
			}
		}
	}

	async function onWebhook(event: string, payload: any) {
		const repo: string | undefined = payload.repository?.full_name;
		if (!repo) return;
		if (event === "pull_request") {
			const n = payload.pull_request?.number ?? payload.number;
			const pr = payload.action === "closed" ? (store.deletePr(repo, n), null) : await refreshPr(repo, n);
			if (pr && payload.action === "review_requested") await onReviewRequested(pr, payload);
		} else if (event === "pull_request_review" || event === "pull_request_review_comment") {
			await refreshPr(repo, payload.pull_request.number);
		} else if (event === "issue_comment" && payload.issue?.pull_request) {
			await refreshPr(repo, payload.issue.number);
		} else if (event === "check_suite" && payload.action === "completed") {
			await onChecks(repo, (payload.check_suite.pull_requests ?? []).map((p: { number: number }) => p.number));
		} else if (event === "check_run" && payload.action === "completed") {
			await onChecks(repo, (payload.check_run.pull_requests ?? []).map((p: { number: number }) => p.number));
		} else if (event === "status") {
			const nums = store.prs().filter((p) => p.repo === repo && p.headSha === payload.sha).map((p) => p.number);
			await onChecks(repo, nums);
		}
	}

	// -- HTTP --------------------------------------------------------------------

	async function body(req: IncomingMessage): Promise<Buffer> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const c of req) {
			size += (c as Buffer).length;
			if (size > MAX_BODY) throw new HttpError(413, "request too large");
			chunks.push(c as Buffer);
		}
		return Buffer.concat(chunks);
	}

	async function json(req: IncomingMessage): Promise<any> {
		try {
			return JSON.parse((await body(req)).toString("utf8") || "{}");
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new HttpError(400, "body is not JSON");
		}
	}

	function send(res: ServerResponse, status: number, data: unknown, type = "application/json") {
		const out = type === "application/json" ? JSON.stringify(data) : (data as string | Buffer);
		res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
		res.end(out);
	}

	function sameOrigin(req: IncomingMessage) {
		if (req.headers.origin !== opts.origin) throw new HttpError(403, "cross-site request refused");
	}

	async function act(req: IncomingMessage, lab: string, action: string) {
		const ops: Record<string, (t: string, repo: string, n: number, b: any) => Promise<void>> = {
			merge: (t, r, n, b) => {
				if (b.confirm !== true) throw new HttpError(400, "merge needs confirm: true");
				return github.merge(t, r, n);
			},
			approve: (t, r, n) => github.approve(t, r, n),
			rerun: (t, r, n) => github.rerunFailedChecks(t, r, n),
			comment: (t, r, n, b) => {
				const text = typeof b.body === "string" ? b.body.trim() : "";
				if (!text) throw new HttpError(400, "empty comment");
				return github.comment(t, r, n, text);
			},
		};
		const op = Object.hasOwn(ops, action) ? ops[action] : undefined;
		if (!op) throw new HttpError(404, "no such action");
		const b = await json(req);
		const u = linked(lab);
		const { repos } = await viewOf(u);
		const pr = typeof b.repo === "string" && Number.isInteger(b.number) ? store.pr(b.repo, b.number) : undefined;
		if (!pr || !repos.has(pr.repo.toLowerCase())) throw new HttpError(404, "no such pull request");
		const token = await tokenFor(u);
		try {
			await op(token, pr.repo, pr.number, b);
		} catch (e) {
			if (e instanceof HttpError) throw e;
			const status = (e as { status?: number }).status ?? 0;
			const message = (e as Error).message;
			if ([405, 409, 422].includes(status)) throw new HttpError(409, message);
			if (status === 403 || status === 404) throw new HttpError(status, message);
			if (status === 401) throw new HttpError(409, "GitHub link expired, link again", { link: "/auth/github" });
			throw new HttpError(502, message || "GitHub request failed");
		}
		later(async () => void (await refreshPr(pr.repo, pr.number)));
		return { ok: true };
	}

	async function route(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://x");
		const path = url.pathname;
		const method = req.method ?? "GET";

		if (method === "POST" && path === "/webhook") {
			const raw = await body(req);
			if (!verifySignature(opts.webhookSecret, raw, String(req.headers["x-hub-signature-256"] ?? ""))) {
				return send(res, 401, { error: "bad signature" });
			}
			const event = String(req.headers["x-github-event"] ?? "");
			let payload: unknown;
			try {
				payload = JSON.parse(raw.toString("utf8"));
			} catch {
				return send(res, 400, { error: "body is not JSON" });
			}
			later(() => onWebhook(event, payload)); // answer GitHub quickly, work afterwards
			return send(res, 200, { ok: true });
		}

		if (method === "GET" && Object.hasOwn(STATIC, path)) {
			return send(res, 200, readFileSync(join(PUBLIC_DIR, path.slice(1))), STATIC[path]);
		}

		const lab = labUser(req);
		if (method !== "GET") sameOrigin(req);

		if (method === "GET" && (path === "/" || path === "/index.html")) {
			return send(res, 200, readFileSync(join(PUBLIC_DIR, "index.html")), "text/html; charset=utf-8");
		}
		if (method === "GET" && path === "/auth/github") {
			const state = randomBytes(24).toString("base64url");
			store.addState(state, lab, opts.now().getTime());
			const to = new URL("https://github.com/login/oauth/authorize");
			to.searchParams.set("client_id", opts.githubClientId ?? "");
			to.searchParams.set("redirect_uri", `${opts.origin}/auth/github/callback`);
			to.searchParams.set("state", state);
			res.writeHead(302, { location: to.toString() }).end();
			return;
		}
		if (method === "GET" && path === "/auth/github/callback") {
			const state = url.searchParams.get("state") ?? "";
			const code = url.searchParams.get("code") ?? "";
			if (!code || !store.takeState(state, lab, opts.now().getTime())) throw new HttpError(400, "link request expired or not yours; start again");
			saveTokens(lab, await github.exchangeCode(code));
			access.delete(lab);
			res.writeHead(302, { location: "/" }).end();
			return;
		}
		if (method === "GET" && path === "/api/inbox") {
			const u = linked(lab);
			const { viewer, repos } = await viewOf(u);
			return send(res, 200, { login: u.login, ...buildInbox(store.prs().filter(visible(repos)), viewer) });
		}
		if (method === "POST" && path === "/api/unlink") {
			store.deleteUser(lab);
			access.delete(lab);
			return send(res, 200, { ok: true });
		}
		if (method === "POST" && path.startsWith("/api/prs/")) {
			return send(res, 200, await act(req, lab, path.slice("/api/prs/".length)));
		}
		if (method === "GET" && path === "/api/push/key") {
			return send(res, 200, { publicKey: opts.vapidPublicKey ?? "" });
		}
		if (method === "GET" && path === "/api/push/subscriptions") {
			return send(res, 200, store.devices(lab).map((d) => ({ endpoint: d.endpoint, created: d.created })));
		}
		if (method === "POST" && path === "/api/push/subscribe") {
			const b = await json(req);
			if (typeof b.endpoint !== "string" || !/^https:\/\//.test(b.endpoint) || typeof b.keys?.p256dh !== "string" || typeof b.keys?.auth !== "string") {
				throw new HttpError(400, "not a push subscription");
			}
			store.addDevice(lab, { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } }, opts.now().toISOString());
			return send(res, 201, { ok: true });
		}
		if (method === "POST" && path === "/api/push/unsubscribe") {
			const b = await json(req);
			if (typeof b.endpoint === "string") store.deleteDevice(b.endpoint, lab);
			return send(res, 200, { ok: true });
		}
		throw new HttpError(404, "not found");
	}

	const handler = (req: IncomingMessage, res: ServerResponse) => {
		route(req, res).catch((e) => {
			if (res.headersSent) return res.end();
			if (e instanceof HttpError) return send(res, e.status, e.status === 409 && "link" in e.extra ? e.extra : { error: e.message, ...e.extra });
			log(`request failed: ${(e as Error)?.stack ?? e}`);
			send(res, 500, { error: "internal error" });
		});
	};

	// -- jobs --------------------------------------------------------------------

	async function sync() {
		store.replacePrs(await github.openPullRequests());
	}

	async function runStaleDigest() {
		const now = opts.now();
		const day = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
		const cutoff = now.getTime() - config.staleDays * DAY_MS;
		for (const u of store.users()) {
			try {
				const { viewer, repos } = await viewOf(u);
				const stale = store.prs().filter(visible(repos))
					.filter((p) => (isMine(p, viewer) || reviewRequested(p, viewer)) && Date.parse(p.updatedAt) <= cutoff)
					.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
				if (!stale.length || !store.markOnce(`stale:${u.labUser}:${day}`, now.toISOString())) continue;
				const list = stale.slice(0, 5).map(short).join(", ") + (stale.length > 5 ? ` and ${stale.length - 5} more` : "");
				await notify(u.labUser, {
					title: `${stale.length} stale PR${stale.length > 1 ? "s" : ""}`,
					body: `No activity for ${config.staleDays}+ days: ${list}`,
					url: "/",
				});
			} catch (e) {
				log(`stale digest for ${u.labUser} failed: ${(e as Error).message}`);
			}
		}
	}

	return {
		handler,
		sync,
		runStaleDigest,
		idle: async () => {
			let seen: Promise<void>;
			do {
				seen = work;
				await seen;
			} while (seen !== work);
		},
		close: async () => {
			await work;
			store.close();
		},
	};
}
