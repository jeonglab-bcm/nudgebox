/**
 * The app: HTTP handler (pages, API, webhook) plus the sync and stale-digest jobs.
 * The acceptance tests in tests/acceptance define the behaviour; SPEC.md the why.
 *
 * Identity comes only from the sign-in sidecar's headers (SPEC 3.1; oauth2-proxy with
 * Keycloak at the lab, or with GitHub login, deploy/): this process
 * must be reachable only through that sidecar, except /webhook (signature-checked)
 * and the static web-app files (no data in them).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangedFile, GitHubPort, Issue, NewReviewComment, PrFiles, PullRequest } from "./github.ts";
import { Store, type LinkedUser } from "./store.ts";
import { seal, unseal } from "./crypto.ts";
import { buildInbox, isMine, reviewRequested, type Viewer } from "./inbox.ts";
import { verifySignature } from "./webhook.ts";
import type { LlmConfig, Prompt, Provider, Summarize } from "./llm.ts";
import { issuePrompt, prPrompt, SUMMARY_FORMAT } from "./summary.ts";
import type { Differ, DiffSide } from "./omnidiff.ts";
import { CLAUDE_ASK, CLAUDE_WORKFLOW, claudeAsked, hasMarkers, planMerge, type ReadFile } from "./conflicts.ts";
import { EXPLAIN_FORMAT, explainAskPrompt, explainPrompt } from "./explain.ts";
import { CODE_KINDS, CodeError, type CodeIntel } from "./code.ts";
import { fileKind, type FileKind } from "./filekind.ts";
import { links, type Link } from "./depgraph.ts";
import { askPrPrompt, askPrompt, carryPlan, checkPrompt, codeAt, commentable, dataSteps, isData, MAX_DRAFTS_PER_STEP, MAX_QUESTION, noiseReason, numberedChanges, parseJson, planPrompt, readCheck, readPlan, readReview, REVIEW_FORMAT, reviewPrompts, type AskAbout, type CodeLine, type Draft, type FileChanges, type PlanStep } from "./review.ts";

export interface Config {
	orgs: string[]; // accounts the GitHub App is installed on
	staleDays: number; // SPEC 7.3
	oldDays?: number; // SPEC 5: no activity this long -> "Old" (default 30)
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
	badge?: number; // SPEC 7: the person's unread count, for the app icon
	test?: string; // SPEC 14: id of a Send a test push, echoed back by the device
}

/** SPEC 7: "high" makes iOS deliver even in Low Power Mode. */
export type PushOptions = { urgency?: "normal" | "high" };

export interface AppOptions {
	config: Config;
	origin: string; // e.g. https://gh.bioinfolder.com, for the cross-site POST check
	github: GitHubPort;
	githubClientId?: string; // the GitHub App's client id, for "link GitHub"
	webhookSecret: string;
	encryptionKey: Buffer; // 32 bytes, encrypts stored GitHub tokens
	dbPath: string;
	vapidPublicKey?: string; // given to browsers to subscribe to push
	push: (sub: PushSubscription, payload: PushPayload, opts?: PushOptions) => Promise<void>; // throws {statusCode: 404|410} when gone
	now: () => Date;
	log?: (msg: string) => void;
	summarize?: Summarize; // SPEC 12: the server's own LLM (config.yaml); absent -> no AI unless the admin sets one
	serverAi?: ServerAi; // SPEC 20: what that LLM is, shown on the settings page
	admins?: string[]; // SPEC 20: lab users who may change the AI settings
	providers?: Providers; // SPEC 20: sets up the provider the admin picks on the page
	diff?: Differ; // SPEC 15: omnidiff; absent -> no diffs
	code?: CodeIntel; // SPEC 21: language servers; absent -> no go to definition
}

/** SPEC 20: makes a provider's LLM, and lists its models. */
export interface Providers {
	make: (c: LlmConfig) => Summarize;
	models: (c: Omit<LlmConfig, "model">) => Promise<string[]>;
}

/** SPEC 20: the LLM the server was started with (config.yaml + LLM_API_KEY). */
export type ServerAi = Omit<LlmConfig, "timeoutMs"> & { deepModel?: string };

export interface App {
	handler: (req: IncomingMessage, res: ServerResponse) => void;
	warm(): Promise<void>; // SPEC 19: prepares the guided reviews of recently active PRs (after a start)
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
	"/vendor/marked-18.1.3.esm.js": "text/javascript", // SPEC 15: rendered Markdown (MIT)
	"/vendor/purify-3.4.17.es.mjs": "text/javascript", // SPEC 15: cleans it (MPL-2.0 or Apache-2.0)
	"/vendor/pdf-6.5.438.min.mjs": "text/javascript", // SPEC 15: draws PDF pages (pdf.js, Apache-2.0)
	"/vendor/pdf.worker-6.5.438.min.mjs": "text/javascript",
	"/vendor/highlight-11.12.0.min.mjs": "text/javascript", // SPEC 15: syntax colours (highlight.js, BSD-3-Clause)
	...Object.fromEntries(["latex", "groovy", "dockerfile", "matlab", "julia"].map((l) => [`/vendor/highlight-11.12.0-${l}.min.mjs`, "text/javascript"])),
	"/fonts/Inter-400-700.woff2": "font/woff2",
	"/fonts/SpaceGrotesk-500-700.woff2": "font/woff2",
	"/fonts/JetBrainsMono-400-600.woff2": "font/woff2",
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
	// Cloudflare overrides our no-store with a 4 h browser cache for .js, so the page asks
	// for the script under a name that changes whenever its content does.
	const scriptVersion = createHash("sha256").update(readFileSync(join(PUBLIC_DIR, "app.js"))).digest("hex").slice(0, 12);
	const indexHtml = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8").replace('src="/app.js"', `src="/app.js?v=${scriptVersion}"`);
	let work: Promise<void> = Promise.resolve();
	const later = (fn: () => Promise<void>) => {
		work = work.then(fn).catch((e) => log(`background work failed: ${e?.message ?? e}`));
	};

	// -- identity and GitHub tokens ---------------------------------------------

	function labUser(req: IncomingMessage): string {
		// Keycloak sends a preferred username; oauth2-proxy's GitHub login only the user (#33)
		const header = (h: string) => String(req.headers[h] ?? "").trim().toLowerCase();
		const who = header("x-forwarded-preferred-username") || header("x-forwarded-user") || header("x-forwarded-email");
		if (!who) throw new HttpError(401, "sign in first");
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

	const visible = (repos: Set<string>) => (p: { repo: string }) => repos.has(p.repo.toLowerCase());
	const inConfig = (repo: string) => config.orgs.some((o) => o.toLowerCase() === repo.split("/")[0].toLowerCase());
	const newest = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);

	type Kind = "pr" | "issue";
	type Item = { repo: string; number: number; updatedAt: string };

	/** SPEC 5: "hidden" (Hide, until new activity), "old" (idle oldDays) or null. */
	function quietness(kind: Kind, item: Item, hidden: Map<string, string>): "hidden" | "old" | null {
		const at = hidden.get(`${kind}:${item.repo}#${item.number}`);
		if (at && Date.parse(item.updatedAt) <= Date.parse(at)) return "hidden";
		if (opts.now().getTime() - Date.parse(item.updatedAt) > (config.oldDays ?? 30) * DAY_MS) return "old";
		return null;
	}

	const isQuiet = (lab: string, kind: Kind, item: Item) => quietness(kind, item, store.hiddenFor(lab)) !== null;

	/** Split visible items into the live list and the folded Old / Hidden groups. */
	function fold<T extends Item>(lab: string, kind: Kind, items: T[]) {
		const hidden = store.hiddenFor(lab);
		const out = { live: [] as T[], old: [] as T[], hidden: [] as T[] };
		for (const i of items) {
			const q = quietness(kind, i, hidden);
			(q === "hidden" ? out.hidden : q === "old" ? out.old : out.live).push(i);
		}
		out.old.sort(newest);
		out.hidden.sort(newest);
		return out;
	}

	// -- push --------------------------------------------------------------------

	// One notification to every device of `lab`, carrying their unread count (SPEC 7).
	// Logged per device by push service only: the endpoint itself is a secret address.
	async function notify(lab: string, payload: PushPayload, pushOpts: PushOptions = {}) {
		const devices = store.devices(lab);
		const apps = [...streams.values()].filter((a) => a.lab === lab);
		if (!devices.length && !apps.length) return;
		const badge = store.bumpUnread(lab);
		for (const a of apps) a.emit("notify", { ...payload, badge }); // SPEC 18: open desktop apps
		for (const d of devices) await pushTo(lab, d, { ...payload, badge }, pushOpts);
	}

	// -- desktop app live stream (SPEC 18) -----------------------------------------
	// Each open Nudgebox desktop app holds one GET /api/events; client id -> its stream.
	const streams = new Map<string, { lab: string; emit: (event: string, data: unknown) => void; end: () => void }>();
	const HEARTBEAT_MS = 25_000; // under nginx's and oauth2-proxy's idle timeouts

	function openStream(req: IncomingMessage, res: ServerResponse, lab: string) {
		res.writeHead(200, {
			"content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff",
			"x-accel-buffering": "no",
		});
		const client = randomBytes(12).toString("base64url");
		const emit = (event: string, data: unknown) => {
			if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};
		const beat = setInterval(() => res.writableEnded || res.write(": ping\n\n"), HEARTBEAT_MS);
		beat.unref?.();
		const end = () => {
			clearInterval(beat);
			streams.delete(client);
			if (!res.writableEnded) res.end();
		};
		streams.set(client, { lab, emit, end });
		req.on("close", end);
		res.on("close", end);
		res.write("retry: 5000\n\n");
		emit("hello", { client });
	}

	/** One push to one device; true if the push service took it. */
	async function pushTo(lab: string, d: PushSubscription, payload: PushPayload, pushOpts: PushOptions = {}): Promise<boolean> {
		const service = new URL(d.endpoint).host;
		try {
			await opts.push({ endpoint: d.endpoint, keys: d.keys }, payload, pushOpts);
			log(`push ${service} for ${lab}: sent "${payload.title}"`);
			return true;
		} catch (e) {
			const status = (e as { statusCode?: number }).statusCode;
			if (status === 404 || status === 410) {
				store.deleteDevice(d.endpoint);
				log(`push ${service} for ${lab}: ${status}, device removed`);
			} else log(`push ${service} for ${lab}: failed ${status ?? ""} ${(e as Error).message}`);
			return false;
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
		for (const lab of targets) {
			if (!isQuiet(lab, "pr", pr)) await notify(lab, { title: "Review requested", body: `${short(pr)}: ${pr.title} (by ${pr.author})`, url: pr.url }, { urgency: "high" });
		}
	}

	async function onChecks(repo: string, numbers: number[]) {
		for (const n of numbers) {
			const pr = await refreshPr(repo, n);
			if (!pr || (pr.checks !== "success" && pr.checks !== "failure")) continue;
			if (!store.markOnce(`ci:${repo}#${n}@${pr.headSha}`, opts.now().toISOString())) continue;
			const word = pr.checks === "success" ? "passed" : "failed";
			for (const u of store.usersByLogin(pr.author)) {
				if (isQuiet(u.labUser, "pr", pr)) continue;
				await notify(u.labUser, { title: `CI ${word}`, body: `${short(pr)}: checks ${word}. ${pr.title}`, url: pr.url });
			}
		}
	}

	// -- issues (SPEC 11) --------------------------------------------------------

	async function refreshIssue(repo: string, number: number): Promise<Issue | null> {
		const i = await github.issue(repo, number);
		if (i) store.putIssue(i);
		else store.deleteIssue(repo, number);
		return i;
	}

	/** GitHub logins @mentioned in a text (not e-mail addresses or paths). */
	function mentions(text: unknown): string[] {
		if (typeof text !== "string") return [];
		return [...text.matchAll(/(?:^|[^A-Za-z0-9_`/.@-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/g)].map((m) => m[1]);
	}

	/** One push per person, first matching reason wins; never the person who acted. */
	async function notifyIssue(issue: Issue, sender: string, reasons: [string, string[]][], extra: string) {
		const done = new Set<string>();
		for (const [title, logins] of reasons) {
			for (const login of logins) {
				if (login.toLowerCase() === sender.toLowerCase()) continue;
				for (const u of store.usersByLogin(login)) {
					if (done.has(u.labUser)) continue;
					done.add(u.labUser);
					try {
						const { repos } = await viewOf(u);
						if (!repos.has(issue.repo.toLowerCase()) || isQuiet(u.labUser, "issue", issue)) continue;
					} catch (e) {
						log(`access check for ${u.labUser} failed: ${(e as Error).message}`);
						continue;
					}
					await notify(u.labUser, { title, body: `${short(issue)}: ${issue.title}${extra}`, url: issue.url });
				}
			}
		}
	}

	async function onIssueEvent(repo: string, payload: any) {
		const n = payload.issue?.number;
		if (!Number.isInteger(n)) return;
		const gone = ["closed", "deleted", "transferred"].includes(payload.action);
		const issue = gone ? (store.deleteIssue(repo, n), null) : await refreshIssue(repo, n);
		if (!issue) return;
		const sender = payload.sender?.login ?? "";
		if (payload.action === "assigned" && payload.assignee?.login) {
			await notifyIssue(issue, sender, [["Assigned to you", [payload.assignee.login]]], "");
		} else if (payload.action === "opened") {
			await notifyIssue(issue, sender, [["You were mentioned", mentions(payload.issue?.body)]], ` (by ${issue.author})`);
		}
	}

	async function onIssueComment(repo: string, payload: any) {
		const issue = await refreshIssue(repo, payload.issue.number);
		if (!issue || payload.action !== "created") return;
		const sender = payload.comment?.user?.login ?? payload.sender?.login ?? "";
		await notifyIssue(issue, sender, [
			["You were mentioned", mentions(payload.comment?.body)],
			["New comment", [issue.author, ...issue.assignees]],
		], ` (comment by ${sender})`);
	}

	async function onWebhook(event: string, payload: any) {
		const repo: string | undefined = payload.repository?.full_name;
		if (!repo) return;
		// The App is public (GitHub requires that to install it on both an org and a user
		// account), so strangers can install it too: ignore every account not in config.
		if (!inConfig(repo)) return;
		if (event === "pull_request") {
			const n = payload.pull_request?.number ?? payload.number;
			const pr = payload.action === "closed" ? (store.deletePr(repo, n), null) : await refreshPr(repo, n);
			if (pr && payload.action === "review_requested") await onReviewRequested(pr, payload);
			// SPEC 19: ready before anyone opens it
			if (pr && ai() && ["opened", "synchronize", "reopened", "ready_for_review"].includes(payload.action)) startPrep(pr);
		} else if (event === "pull_request_review" || event === "pull_request_review_comment") {
			await refreshPr(repo, payload.pull_request.number);
		} else if (event === "issue_comment" && payload.issue?.pull_request) {
			await refreshPr(repo, payload.issue.number);
		} else if (event === "issue_comment") {
			await onIssueComment(repo, payload);
		} else if (event === "issues") {
			await onIssueEvent(repo, payload);
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

	/** GitHub's refusal, as the page should see it. */
	function fromGitHub(e: unknown): never {
		if (e instanceof HttpError) throw e;
		const status = (e as { status?: number }).status ?? 0;
		const message = (e as Error).message;
		if ([405, 409, 422].includes(status)) throw new HttpError(409, message);
		if (status === 403 || status === 404) throw new HttpError(status, message);
		if (status === 401) throw new HttpError(409, "GitHub link expired, link again", { link: "/auth/github" });
		throw new HttpError(502, message || "GitHub request failed");
	}

	// -- request checks (SPEC 16) ------------------------------------------------
	const bad = (what: string): never => {
		throw new HttpError(400, what);
	};
	const text = (v: unknown, what: string) => (typeof v === "string" && v.trim() ? v : bad(`${what} is empty`));
	const flag = (v: unknown, what: string) => (typeof v === "boolean" ? v : bad(`${what} must be true or false`));
	const names = (v: unknown, what: string) => (Array.isArray(v) && v.every((x) => typeof x === "string" && x) ? (v as string[]) : bad(`${what} must be a list of names`));
	const line = (v: unknown, what: string) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : bad(`${what} must be a line number`));

	function reviewComment(b: any): NewReviewComment {
		const mode = b.mode === "single" || b.mode === "review" ? b.mode : bad("mode must be single or review");
		const path = text(b.path, "path");
		const body = text(b.body, "comment");
		if (b.subject === "file") return { mode, subject: "file", path, body };
		const side = b.side === "LEFT" || b.side === "RIGHT" ? b.side : bad("side must be LEFT or RIGHT");
		const c: NewReviewComment = { mode, subject: "line", path, line: line(b.line, "line"), side, body };
		if (b.startLine !== undefined) {
			c.startLine = line(b.startLine, "startLine");
			if (c.startLine >= c.line!) bad("startLine must come before line");
		}
		return c;
	}

	/** SPEC 16: a PR's files as text at a commit, or "binary"; the repo's own copy of each commit. */
	const readFile = (repo: string): ReadFile => async (ref, path) => {
		const got = await github.fileAt(repo, ref, path);
		if (got === null) return null;
		if (got === "too large" || got.length > MAX_TEXT || isBinary(got)) return "binary";
		return got.toString("utf8");
	};

	async function conflictsOf(repo: string, number: number) {
		const m = await github.mergeInputs(repo, number);
		if (!m) throw new HttpError(404, "no such pull request");
		return { m, plan: await planMerge(m, readFile(repo)) };
	}

	async function resolveConflicts(t: string, repo: string, n: number, b: any) {
		const { m, plan } = await conflictsOf(repo, n);
		if (b.head !== m.headSha) throw new HttpError(409, "The branch has changed since you opened this; reload and resolve again.");
		if (plan.unsupported.length) throw new HttpError(409, `Some conflicts must be resolved on the command line: ${plan.unsupported.map((u) => u.path).join(", ")}`);
		const files = Array.isArray(b.files) && b.files.every((f: any) => typeof f?.path === "string" && typeof f?.text === "string")
			? (b.files as { path: string; text: string }[]) : bad("files must be a list of {path, text}");
		const want = new Set(plan.conflicts.map((c) => c.path));
		const got = new Set(files.map((f) => f.path));
		if (files.length !== got.size || got.size !== want.size || [...got].some((p) => !want.has(p))) bad(`resolve exactly these files: ${[...want].join(", ")}`);
		const left = files.find((f) => hasMarkers(f.text));
		if (left) bad(`${left.path} still has conflict markers`);
		await github.commitMerge(t, m.headRepo, m.headRef, {
			message: `Merge branch '${m.baseRef}' into ${m.headRef}`, parents: [m.headSha, m.baseSha],
			take: plan.take, remove: plan.remove, write: [...plan.clean, ...files.map((f) => ({ path: f.path, text: f.text }))],
		});
	}

	/**
	 * SPEC 16: hand a PR's conflicts to Claude. A comment, as the person, that the
	 * repository's workflow answers; nothing is posted where nobody would answer.
	 */
	async function askClaude(t: string, repo: string, n: number) {
		const page = await github.prPage(t, repo, n);
		if (!page) throw new HttpError(404, "no such pull request");
		if (page.state !== "OPEN" || !(page.mergeable === "CONFLICTING" || page.mergeState === "DIRTY")) throw new HttpError(409, "This pull request has no conflicts to fix.");
		if (page.headRepo.toLowerCase() !== repo.toLowerCase()) throw new HttpError(409, "Claude cannot push to a branch in a fork. Resolve these conflicts here.");
		if ((await github.fileAt(repo, "HEAD", CLAUDE_WORKFLOW)) === null) throw new HttpError(409, `Claude is not set up in ${repo}.`);
		if (claudeAsked(page.timeline, opts.now().getTime())) throw new HttpError(409, "Claude was already asked a moment ago. It answers on the pull request.");
		await github.comment(t, repo, n, `${CLAUDE_ASK} with \`${page.baseRef}\``);
	}

	async function act(req: IncomingMessage, lab: string, action: string) {
		const ops: Record<string, (t: string, repo: string, n: number, b: any) => Promise<void>> = {
			merge: (t, r, n, b) => {
				if (b.confirm !== true) throw new HttpError(400, "merge needs confirm: true");
				if (b.method === undefined) return github.merge(t, r, n);
				if (!["merge", "squash", "rebase"].includes(b.method)) bad("method must be merge, squash or rebase");
				if ((b.title !== undefined && typeof b.title !== "string") || (b.message !== undefined && typeof b.message !== "string")) bad("title and message must be text");
				return github.merge(t, r, n, { method: b.method, ...(b.title !== undefined ? { title: b.title } : {}), ...(b.message !== undefined ? { message: b.message } : {}) });
			},
			// SPEC 16: the PR page's buttons
			"review-comment": (t, r, n, b) => github.addReviewComment(t, r, n, reviewComment(b)),
			reply: (t, r, n, b) => github.replyToThread(t, r, n, text(b.thread, "thread"), text(b.body, "reply")),
			"resolve-thread": (t, r, n, b) => github.setThreadResolved(t, r, n, text(b.thread, "thread"), flag(b.resolved, "resolved")),
			"submit-review": (t, r, n, b) => {
				if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(b.event)) bad("event must be COMMENT, APPROVE or REQUEST_CHANGES");
				return github.submitReview(t, r, n, b.event, typeof b.body === "string" ? b.body : "");
			},
			"cancel-review": (t, r, n) => github.cancelReview(t, r, n),
			"update-branch": (t, r, n) => github.updateBranch(t, r, n),
			draft: (t, r, n, b) => github.setDraft(t, r, n, flag(b.draft, "draft")),
			viewed: (t, r, n, b) => github.setViewed(t, r, n, text(b.path, "path"), flag(b.viewed, "viewed")),
			reviewers: (t, r, n, b) => github.requestReviewers(t, r, n, b.add === undefined ? [] : names(b.add, "add"), b.remove === undefined ? [] : names(b.remove, "remove")),
			assignees: (t, r, n, b) => github.setAssignees(t, r, n, names(b.logins, "logins")),
			labels: (t, r, n, b) => github.setLabels(t, r, n, names(b.names, "names")),
			milestone: (t, r, n, b) => github.setMilestone(t, r, n, b.milestone === null ? null : Number.isInteger(b.milestone) ? b.milestone : bad("milestone must be a number or null")),
			close: (t, r, n, b) => {
				if (b.confirm !== true) throw new HttpError(400, "close needs confirm: true");
				return github.setState(t, r, n, "closed");
			},
			reopen: async (t, r, n) => {
				const page = await github.prPage(t, r, n);
				if (page?.state !== "CLOSED") throw new HttpError(409, "only a closed pull request can be reopened");
				return github.setState(t, r, n, "open");
			},
			"resolve-conflicts": resolveConflicts,
			"ask-claude": askClaude,
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
		const ok = typeof b.repo === "string" && Number.isInteger(b.number);
		// a closed PR is no longer in the store; Reopen asks GitHub about it instead
		const pr = ok ? store.pr(b.repo, b.number) ?? (action === "reopen" && inConfig(b.repo) ? { repo: b.repo as string, number: b.number as number } : undefined) : undefined;
		if (!pr || !repos.has(pr.repo.toLowerCase())) throw new HttpError(404, "no such pull request");
		const token = await tokenFor(u);
		try {
			await op(token, pr.repo, pr.number, b);
		} catch (e) {
			fromGitHub(e);
		}
		later(async () => void (await refreshPr(pr.repo, pr.number)));
		return { ok: true };
	}

	/** SPEC 16: a visible repo in an account Nudgebox serves, and the person's token. */
	async function asReader(lab: string, repo: string | null) {
		const u = linked(lab);
		const { repos } = await viewOf(u);
		if (!repo || !inConfig(repo) || !repos.has(repo.toLowerCase())) throw new HttpError(404, "not found");
		return { u, repo, token: await tokenFor(u) };
	}

	/** SPEC 12: one click on Summarize. Kept per item version; one model call at a time per version. */
	const summarizing = new Map<string, SummaryRun>(); // by "kind:repo#n@version"
	// -- files and diffs (SPEC 15) -----------------------------------------------

	const MAX_TEXT = 1_000_000; // text diffs stop here; binary files go to 10 MB (MAX_FILE_BYTES)
	const MAX_BINARY = 10_000_000;
	const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);
	const diffs = new Map<string, Promise<unknown>>(); // kept diffs, newest last (the versions are commits, so they never change)

	async function prFilesFor(lab: string, repo: string | null, number: number) {
		const { repos } = await viewOf(linked(lab));
		const pr = repo && Number.isInteger(number) ? store.pr(repo, number) : undefined;
		if (!pr || !repos.has(pr.repo.toLowerCase())) throw new HttpError(404, "no such pull request");
		const files = await github.prFiles(pr.repo, pr.number);
		if (!files) throw new HttpError(404, "no such pull request");
		return { ...files, files: files.files.map((f) => ({ ...f, kind: fileKind(f.path) })) };
	}

	/** SPEC 22: the PR's changed code and docs, and which of them uses which. Read once per head commit. */
	type Graph = { head: string; nodes: { path: string; kind: FileKind }[]; links: Link[]; others: number };
	const graphs = new Map<string, Promise<Graph>>();
	const MAX_GRAPH_FILES = 400;
	async function prGraph(lab: string, repo: string | null, number: number): Promise<Graph> {
		const set = await prFilesFor(lab, repo, number);
		const key = `${repo!.toLowerCase()}#${number}@${set.head}`;
		let run = graphs.get(key);
		if (!run) {
			run = (async () => {
				const nodes = set.files.filter((f) => f.status !== "removed" && f.kind !== "other").map((f) => ({ path: f.path, kind: f.kind }));
				const texts: string[] = new Array(nodes.length).fill("");
				let next = 0;
				await Promise.all(Array.from({ length: Math.min(6, nodes.length) }, async () => {
					while (next < Math.min(nodes.length, MAX_GRAPH_FILES)) {
						const k = next++;
						const got = await github.fileAt(repo!, set.head, nodes[k].path).catch(fromGitHub);
						if (got instanceof Buffer && got.length <= MAX_TEXT && !isBinary(got)) texts[k] = got.toString("utf8");
					}
				}));
				return { head: set.head, nodes, links: links(nodes.map((n, k) => ({ path: n.path, text: texts[k] }))), others: set.files.length - nodes.length };
			})();
			graphs.set(key, run);
			run.catch(() => graphs.delete(key)); // a failure is not kept
			if (graphs.size > 100) graphs.delete(graphs.keys().next().value!);
		}
		return run;
	}

	type FileRef = { repo: string; ref: string; path: string };
	const isRef = (x: unknown): x is FileRef => !!x && typeof x === "object" &&
		["repo", "ref", "path"].every((k) => typeof (x as Record<string, unknown>)[k] === "string" && (x as Record<string, string>)[k] !== "");

	/** The two sides of a diff from a request body, checked and visible to `lab`. */
	async function sidesOf(b: any, lab: string): Promise<(FileRef | null)[]> {
		const sides = [b.before ?? null, b.after ?? null] as (FileRef | null)[];
		if (!sides.some(Boolean) || !sides.every((s) => s === null || isRef(s))) throw new HttpError(400, "give before and/or after as {repo, ref, path}");
		const { repos } = await viewOf(linked(lab));
		if (!sides.every((s) => !s || repos.has(s.repo.toLowerCase()))) throw new HttpError(404, "not found");
		return sides;
	}

	/** SPEC 21: what the name at a place in a commit's file is, where it is defined and where it is used. */
	async function codeLookup(req: IncomingMessage, lab: string) {
		if (!opts.code) throw new HttpError(503, "go to definition is not set up");
		const b: FileRef & { row: number; col: number } = await json(req);
		const pos = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 10_000_000;
		if (!isRef(b) || !pos(b.row) || !pos(b.col) || !/^[\w.-]{1,100}$/.test(b.ref)) throw new HttpError(400, "give repo, ref, path, row and col");
		const { repos } = await viewOf(linked(lab));
		if (!repos.has(b.repo.toLowerCase())) throw new HttpError(404, "not found");
		try {
			return await opts.code.lookup(b.repo, b.ref, b.path, b.row, b.col);
		} catch (e) {
			if (e instanceof CodeError) throw new HttpError(e.status, e.message);
			if ((e as { status?: number }).status) throw fromGitHub(e);
			throw new HttpError(502, `could not look this up: ${(e as Error).message}`);
		}
	}

	async function diffFiles(req: IncomingMessage, lab: string) {
		if (!opts.diff) throw new HttpError(503, "diffs are not set up");
		return diffOf(await sidesOf(await json(req), lab));
	}

	/** SPEC 15: two file versions diffed by omnidiff, once (the versions are commits). */
	async function diffOf(sides: (FileRef | null)[]): Promise<any> {
		const differ = opts.diff;
		if (!differ) throw new HttpError(503, "diffs are not set up");
		const key = JSON.stringify(sides.map((s) => s && [s.repo.toLowerCase(), s.ref, s.path]));
		let run = diffs.get(key);
		if (!run) {
			run = (async () => {
				const got = await Promise.all(sides.map((s) => (s ? github.fileAt(s.repo, s.ref, s.path) : null)));
				if (sides.some((s, i) => s && got[i] === null)) throw new HttpError(404, "file not found");
				const bufs = got.map((g) => (g instanceof Buffer ? g : null));
				const binary = bufs.some((b) => b && isBinary(b));
				const limit = binary ? MAX_BINARY : MAX_TEXT;
				const view = (i: number) => (sides[i] ? { ...sides[i]!, text: null as string | null } : null);
				if (got.some((g) => g === "too large" || (g && g.length > limit))) return { before: view(0), after: view(1), skipped: "too large" };
				if (binary) {
					// SPEC 15: diffed by content; the page draws the files from /api/file, so no text here
					const arg = (i: number): DiffSide | null => (sides[i] ? { path: sides[i]!.path, bytes: bufs[i]! } : null);
					const result = await differ(arg(0), arg(1));
					const side = (i: number) => sides[i] && { ...sides[i]!, size: bufs[i]!.length };
					return { before: side(0), after: side(1), result };
				}
				const text = bufs.map((b) => (b ? b.toString("utf8") : null));
				const arg = (i: number): DiffSide | null => (sides[i] ? { path: sides[i]!.path, text: text[i]! } : null);
				const result = await differ(arg(0), arg(1));
				return { before: sides[0] && { ...sides[0], text: text[0] }, after: sides[1] && { ...sides[1], text: text[1] }, result };
			})();
			diffs.set(key, run);
			run.catch(() => diffs.delete(key)); // a failure is not kept
			if (diffs.size > 200) diffs.delete(diffs.keys().next().value!);
		}
		try {
			return await run;
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new HttpError(502, `could not diff: ${(e as Error).message}`);
		}
	}

	// One model call per item version at a time; everyone asking meanwhile watches it (SPEC 12).
	type SummaryEvent = { stage: "reading" | "writing" } | { delta: string };
	type SummaryRun = { text: string; stage: "reading" | "writing"; watchers: Set<(e: SummaryEvent) => void>; done: Promise<string> };

	/** The kept summary, or the run making it (started if need be). Throws HttpError for refusals. */
	async function summaryFor(req: IncomingMessage, lab: string): Promise<{ kept: string } | { run: SummaryRun }> {
		const llm = ai();
		if (!llm) throw new HttpError(503, "AI summary is not set up");
		const b = await json(req);
		if (b.kind !== "pr" && b.kind !== "issue") throw new HttpError(400, "kind must be pr or issue");
		const { repos } = await viewOf(linked(lab));
		const ok = typeof b.repo === "string" && Number.isInteger(b.number);
		const pr = ok && b.kind === "pr" ? store.pr(b.repo, b.number) : undefined;
		const issue = ok && b.kind === "issue" ? store.issue(b.repo, b.number) : undefined;
		const item = pr ?? issue;
		if (!item || !repos.has(item.repo.toLowerCase())) throw new HttpError(404, "not found");
		const key = `${b.kind}:${item.repo}#${item.number}`;
		const version = `${SUMMARY_FORMAT}|${pr ? `${pr.updatedAt}|${pr.headSha}` : item.updatedAt}`;
		const kept = store.summary(key, version);
		if (kept !== undefined) return { kept };
		return {
			run: modelRun(key, version, async () => {
				try {
					const content = pr ? await github.prContent(pr.repo, pr.number) : await github.issueContent(issue!.repo, issue!.number);
					return pr ? prPrompt(pr, content) : issuePrompt(issue!, content);
				} catch (e) {
					throw new HttpError(502, `could not read it from GitHub: ${(e as Error).message}`);
				}
			}),
		};
	}

	/**
	 * One model call per (key, version) at a time, kept in the store when it succeeds;
	 * everyone asking meanwhile watches the same run (SPEC 12, 17).
	 */
	function modelRun(key: string, version: string, prompt: () => Promise<Prompt>): SummaryRun {
		return startRun(`${key}@${version}`, prompt, (text) => store.saveSummary(key, version, text, opts.now().toISOString()));
	}

	/** One model call per `id` at a time; `keep` gets the whole answer when it succeeds. */
	function startRun(id: string, prompt: () => Promise<Prompt>, keep: (text: string) => void): SummaryRun {
		const llm = ai()!;
		let run = summarizing.get(id);
		if (run) return run;
		const r: SummaryRun = { text: "", stage: "reading", watchers: new Set(), done: Promise.resolve("") };
		const tell = (e: SummaryEvent) => r.watchers.forEach((w) => w(e));
		r.done = (async () => {
			const p = await prompt();
			r.stage = "writing";
			tell({ stage: "writing" });
			let text: string;
			try {
				text = await llm(p, (delta) => {
					r.text += delta;
					tell({ delta });
				});
			} catch (e) {
				throw new HttpError(502, `LLM failed: ${(e as Error).message}`);
			}
			keep(text);
			return text;
		})().finally(() => summarizing.delete(id));
		r.done.catch(() => {}); // watchers get the error; an unwatched run must not crash the process
		summarizing.set(id, r);
		return r;
	}

	/** SPEC 17: the diff a request body names, as Explain reads it, and where its explanation is kept. */
	async function explainTarget(b: any, lab: string) {
		const sides = await sidesOf(b, lab);
		const d = await diffOf(sides);
		// a binary side comes back with its size and no text
		const text = (x: { text?: unknown } | null) => (x === null ? null : typeof x.text === "string" ? x.text : undefined);
		const [before, after] = [text(d.before), text(d.after)];
		if (d.skipped || before === undefined || after === undefined) throw new HttpError(400, "only a text file's diff can be explained");
		const { repos } = await viewOf(linked(lab));
		const pr = b.pr && typeof b.pr.repo === "string" && Number.isInteger(b.pr.number) ? store.pr(b.pr.repo, b.pr.number) : undefined;
		const title = pr && repos.has(pr.repo.toLowerCase()) ? pr.title : null;
		const key = `explain:${JSON.stringify(sides.map((s) => s && [s.repo.toLowerCase(), s.ref, s.path]))}`;
		const version = `${EXPLAIN_FORMAT}|${title ?? ""}`;
		return { key, version, path: (sides[1] ?? sides[0])!.path, title, before, after, result: d.result };
	}

	/** SPEC 17: Explain a file's diff. The kept explanation, or the run making it, and this person's questions under it. */
	async function explainFor(req: IncomingMessage, lab: string): Promise<({ kept: string } | { run: SummaryRun }) & { asks: object[] }> {
		if (!ai()) throw new HttpError(503, "AI explanations are not set up");
		const x = await explainTarget(await json(req), lab);
		const asks = store.asks(lab, x.key).map(({ question, answer, at }) => ({ question, answer, at }));
		const kept = store.summary(x.key, x.version);
		if (kept !== undefined) return { kept, asks };
		return { run: modelRun(x.key, x.version, async () => explainPrompt(x.path, x.title, x.before, x.after, x.result)), asks };
	}

	/**
	 * SPEC 17: a question about an explained diff, answered by the model from the same
	 * changes, the explanation and the questions before. Kept for the person who asked,
	 * with the explanation. One question per person and diff at a time.
	 */
	async function explainAskFor(req: IncomingMessage, lab: string): Promise<SummaryRun> {
		if (!ai()) throw new HttpError(503, "AI answers are not set up");
		const b = await json(req);
		const x = await explainTarget(b, lab);
		const question = typeof b.question === "string" ? b.question.trim() : "";
		if (!question) bad("the question is empty");
		if (question.length > MAX_QUESTION) bad(`the question is too long (at most ${MAX_QUESTION} characters)`);
		const explanation = store.summary(x.key, x.version);
		if (explanation === undefined) throw new HttpError(409, "explain the file first");
		const id = `ask:${lab}:${x.key}`;
		if (summarizing.has(id)) throw new HttpError(409, "wait for the answer to your last question");
		const earlier = store.asks(lab, x.key);
		return startRun(id, async () => explainAskPrompt(x.path, x.title, x.before, x.after, x.result, explanation, earlier, question), (answer) => {
			if (!answer.trim()) throw new HttpError(502, "the model gave no answer; ask again");
			store.addAsk(lab, x.key, "", { question, answer: answer.trim(), about: null }, opts.now().toISOString());
		});
	}

	// -- guided review (SPEC 19) -------------------------------------------------------

	type PrepFile = FileChanges & { fp: string };
	type PrepDraft = Draft & { id: string; code?: CodeLine[] };
	// `skim`: data or results nobody reads line by line, so the model did not either; `notes`: what changes in each file
	type PrepStep = { id: string; title: string; summary: string; files: string[]; fps: { path: string; fp: string }[]; drafts: PrepDraft[]; skim?: boolean; notes?: Record<string, string> };
	// `planned`: the steps are the model's plan (not one per file), so the next push can keep them
	type Prep = { head: string; ai: boolean; planned?: boolean; summary: string; noise: { path: string; why: string }[]; steps: PrepStep[] };
	/** What the preparation is doing now, for the page to show while it waits. `push`: it builds on the review before a push. */
	type Progress = { phase: "queued" | "reading" | "planning" | "reviewing" | "checking"; done: number; total: number; what?: string; push?: boolean; since: string };
	// one preparation per PR head commit at a time; a failure is kept (in memory) until retried
	const preparing = new Map<string, { state: "preparing" | "failed"; error?: string; done: Promise<void>; progress: Progress }>();
	const prepWork = new Set<Promise<void>>(); // waited for by idle()
	const short16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
	const prKey = (pr: { repo: string; number: number }) => `${pr.repo.toLowerCase()}#${pr.number}`;
	const prepKey = (pr: PullRequest) => `${prKey(pr)}@${pr.headSha}|${REVIEW_FORMAT}`;

	/** The PR `lab` asks about, if they can see it. */
	async function reviewTarget(lab: string, repo: unknown, number: unknown): Promise<PullRequest> {
		const { repos } = await viewOf(linked(lab));
		const pr = typeof repo === "string" && Number.isInteger(number) ? store.pr(repo, number as number) : undefined;
		if (!pr || !repos.has(pr.repo.toLowerCase())) throw new HttpError(404, "no such pull request");
		return pr;
	}

	/**
	 * Starts preparing `pr`'s guided review unless it is kept or under way. It waits for a
	 * preparation of the same PR's earlier push, to build on it; if the PR was pushed to
	 * again meanwhile, this one is dropped (the newer one is waiting behind it).
	 */
	function startPrep(pr: PullRequest) {
		const key = prepKey(pr);
		if (store.reviewPrep(key) !== undefined || preparing.get(key)?.state === "preparing") return;
		const earlier = [...preparing].filter(([k, e]) => k.startsWith(`${prKey(pr)}@`) && e.state === "preparing").map(([, e]) => e.done);
		const progress: Progress = { phase: earlier.length ? "queued" : "reading", done: 0, total: 0, since: opts.now().toISOString() };
		const entry: { state: "preparing" | "failed"; error?: string; done: Promise<void>; progress: Progress } = { state: "preparing", done: Promise.resolve(), progress };
		entry.done = (async () => {
			await Promise.all(earlier);
			if (earlier.length && store.pr(pr.repo, pr.number)?.headSha !== pr.headSha) return void preparing.delete(key);
			try {
				store.saveReviewPrep(key, await prepare(pr, (p) => Object.assign(progress, p)), opts.now().toISOString());
				preparing.delete(key);
			} catch (e) {
				entry.state = "failed";
				entry.error = (e as Error).message;
				log(`guided review of ${pr.repo}#${pr.number} failed: ${entry.error}`);
			}
		})();
		preparing.set(key, entry);
		prepWork.add(entry.done);
		entry.done.finally(() => prepWork.delete(entry.done));
	}

	/**
	 * SPEC 19: after a start, the guided reviews that are not kept (a new version of the
	 * server can ask for them in a new form) are prepared before anybody opens them: the
	 * PRs active in the last 14 days, the latest first, one at a time.
	 */
	async function warm() {
		if (!ai()) return;
		const since = opts.now().getTime() - 14 * 86_400_000;
		const recent = store.prs().filter((p) => Date.parse(p.updatedAt) >= since).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
		for (const seen of recent) {
			const pr = store.pr(seen.repo, seen.number);
			if (!pr) continue; // merged or closed meanwhile
			startPrep(pr);
			await preparing.get(prepKey(pr))?.done;
		}
	}

	/**
	 * SPEC 19: noise, steps in reading order, and checked drafts for one head commit. After
	 * a push it builds on the review of the push before: the plan is kept, and a step
	 * whose files did not change keeps its drafts, so only what changed is read again.
	 */
	type Read = PrepFile & { why: string | null; file: ChangedFile };

	/** One changed file of a PR as the model reads it: its changed lines, numbered (null: binary or too large), and its version. */
	async function readChange(repo: string, set: { base: string; head: string }, f: ChangedFile): Promise<Read> {
		const before = f.status === "added" ? null : { repo, ref: set.base, path: f.previous ?? f.path };
		const after = f.status === "removed" ? null : { repo, ref: set.head, path: f.path };
		let d: any = null;
		if (opts.diff) d = await diffOf([before, after]).catch(() => null);
		const text = (x: { text?: unknown } | null | undefined) => (x === null ? null : typeof x?.text === "string" ? x.text : undefined);
		const [bt, at] = [text(d?.before), text(d?.after)];
		const readable = d && !d.skipped && bt !== undefined && at !== undefined;
		return {
			path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, file: f,
			text: readable ? numberedChanges(bt, at, d.result) : null,
			fp: `${f.path}|${short16(String(bt ?? d?.before?.size ?? ""))}|${short16(String(at ?? d?.after?.size ?? ""))}|${f.status}`,
			why: noiseReason(f.path, d?.result?.summary),
		};
	}

	/** Every changed file of a PR as the model reads it, a few at a time: a big PR is a hundred round trips to GitHub. */
	async function readChanges(repo: string, set: PrFiles, each: () => void = () => {}): Promise<Read[]> {
		const files: Read[] = new Array(set.files.length);
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(6, set.files.length) }, async () => {
			while (next < set.files.length) {
				const k = next++;
				files[k] = await readChange(repo, set, set.files[k]);
				each();
			}
		}));
		return files;
	}

	async function prepare(pr: PullRequest, report: (p: Partial<Progress>) => void = () => {}): Promise<Prep> {
		const set = await github.prFiles(pr.repo, pr.number);
		if (!set) throw new Error("the pull request is gone");
		let read = 0;
		report({ phase: "reading", done: 0, total: set.files.length });
		const files = await readChanges(pr.repo, set, () => report({ done: ++read }));
		const noise = files.filter((f) => f.why).map((f) => ({ path: f.path, why: f.why! }));
		const seen = files.filter((f) => !f.why);
		// steps to skim, without asking the model (with no omnidiff nothing is read, and that makes no file data)
		const skimmed = (f: Read) => isData(f.path, opts.diff ? f.text : "");
		const data = seen.filter(skimmed);
		const rest = seen.filter((f) => !skimmed(f));
		const byPath = new Map(seen.map((f) => [f.path, f]));
		const llm = ai();
		const step = (s: PlanStep, more: { drafts?: PrepDraft[]; notes?: Record<string, string>; summary?: string } = {}): PrepStep => {
			const fps = s.files.map((p) => ({ path: p, fp: byPath.get(p)!.fp }));
			return {
				id: short16(fps.map((x) => x.fp).sort().join("\n")), title: s.title, summary: s.summary || more.summary || "", files: s.files, fps, drafts: more.drafts ?? [],
				...(s.skim ? { skim: true } : {}), ...(more.notes && Object.keys(more.notes).length ? { notes: more.notes } : {}),
			};
		};
		const onePerFile = (): PlanStep[] => rest.map((f) => f.path).sort().map((p) => ({ title: p, summary: "", files: [p] }));
		const skims = dataSteps(data.map((f) => f.path));
		if (!llm) return { head: pr.headSha, ai: false, summary: "", noise, steps: [...onePerFile(), ...skims].map((s) => step(s)) };

		const ask = async (p: Prompt) => {
			try {
				return await llm(p);
			} catch (e) {
				throw new Error(`LLM failed: ${(e as Error).message}`);
			}
		};
		const paths = rest.map((f) => f.path);
		const prev = store.lastReviewPrep(`${prKey(pr)}@`, `|${REVIEW_FORMAT}`) as Prep | undefined;
		const before = prev?.ai ? prev : undefined; // the review of the push before this one
		let plan = before?.planned ? carryPlan({ summary: before.summary, steps: before.steps.filter((s) => s.files.some((p) => paths.includes(p))) }, paths) : null;
		const carried = plan !== null;
		if (carried) report({ push: true });
		if (!carried && rest.length) {
			report({ phase: "planning", done: 0, total: rest.length, what: undefined });
			const answer = await ask(planPrompt(pr, rest));
			plan = readPlan(answer, paths);
			if (!plan) {
				const a = answer.replace(/\s+/g, " ");
				log(`guided review of ${pr.repo}#${pr.number}: the model's answer was no plan, so one step per file. It said: ${a.length > 300 ? `${a.slice(0, 180)} […] ${a.slice(-100)}` : a}`);
			}
		}
		const dropped = store.learnings(pr.repo);
		const today = opts.now().toISOString().slice(0, 10);
		const planned = [...(plan?.steps ?? onePerFile()), ...skims];
		// a step with the same files in the same versions as before keeps what the model said about it
		const kept = new Map((before?.steps ?? []).map((s) => [s.id, s]));
		const same = (s: PlanStep) => kept.get(step(s).id);
		const toReview = planned.filter((s) => !s.skim && !same(s));
		const steps: PrepStep[] = [];
		let done = 0;
		for (const s of planned) {
			const old = same(s);
			if (s.skim || old) {
				steps.push(step(s, old ? { drafts: old.drafts, notes: old.notes, summary: old.summary } : {}));
				continue;
			}
			const mine = s.files.map((p) => byPath.get(p)!);
			const parts = reviewPrompts(pr, s, mine, dropped, today);
			const drafts: PrepDraft[] = [];
			const notes: Record<string, string> = {};
			let summary = "";
			for (const [k, part] of parts.entries()) {
				report({ phase: "reviewing", done, total: toReview.length, what: parts.length > 1 ? `${s.title} (part ${k + 1} of ${parts.length})` : s.title });
				let answer = await ask(part);
				if (parseJson(answer) === null) answer = await ask(part); // the lab model now and then answers nothing: once more
				const r = readReview(answer);
				summary ||= r.summary;
				for (const [path, note] of Object.entries(r.notes)) if (s.files.includes(path)) notes[path] ??= note;
				if (r.drafts.length) report({ phase: "checking" });
				for (const d of r.drafts) {
					const f = byPath.get(d.path);
					if (!f || !s.files.includes(d.path) || !commentable(d, f.file) || drafts.length >= MAX_DRAFTS_PER_STEP) continue;
					const id = short16(`${d.path}|${d.side}|${d.line}|${d.body}`);
					if (drafts.some((x) => x.id === id)) continue;
					if (readCheck(await ask(checkPrompt(pr, d, f, today)))) drafts.push({ ...d, id, code: codeAt(f.text, d) });
				}
			}
			done++;
			steps.push(step(s, { drafts, notes, summary }));
		}
		return { head: pr.headSha, ai: true, planned: plan !== null, summary: plan?.summary ?? "", noise, steps };
	}

	/** One person's view of a prepared review: what they marked reviewed and did with each draft. */
	function reviewView(prep: Prep, lab: string, pr: PullRequest) {
		const marks = store.reviewMarks(lab, prKey(pr));
		const fps = new Set(marks.map((m) => m.fp));
		const paths = new Set(marks.map((m) => m.path));
		const states = store.draftStates(lab, prKey(pr));
		const asks = store.asks(lab, askScope(pr));
		const steps = prep.steps.map((s) => {
			const reviewed = s.fps.every((f) => fps.has(f.fp));
			const stale = s.fps.filter((f) => paths.has(f.path) && !fps.has(f.fp)).map((f) => f.path); // viewed, but in an older version
			return {
				id: s.id, title: s.title, summary: s.summary, files: s.files, reviewed,
				seen: s.fps.filter((f) => fps.has(f.fp)).map((f) => f.path), // the files you marked viewed, in this version
				stale, changed: !reviewed && stale.length > 0,
				skim: s.skim === true, notes: s.notes ?? {},
				drafts: s.drafts.map((d) => ({ ...d, state: states.get(d.id) ?? "open" })),
				// what you asked the AI about this step, as its files are now (SPEC 19, Ask)
				asks: asks.filter((a) => a.thread === s.id).map(({ question, answer, about, at }) => ({ question, answer, about, at })),
			};
		});
		return {
			state: "ready", head: prep.head, ai: prep.ai, summary: prep.summary, noise: prep.noise, steps,
			changedSinceReview: steps.filter((s) => s.changed).length,
			...(prep.ai ? {} : { note: "No AI is set up here: one step per file, and no draft comments." }),
		};
	}

	async function reviewGet(lab: string, repo: string | null, number: number) {
		const pr = await reviewTarget(lab, repo, number);
		const prep = store.reviewPrep(prepKey(pr)) as Prep | undefined;
		if (prep) return reviewView(prep, lab, pr);
		const run = preparing.get(prepKey(pr));
		if (run?.state === "failed") return { state: "failed", error: run.error };
		startPrep(pr);
		return { state: "preparing", progress: preparing.get(prepKey(pr))?.progress ?? null };
	}

	async function reviewPost(req: IncomingMessage, lab: string, what: string) {
		const b = await json(req);
		const pr = await reviewTarget(lab, b.repo, b.number);
		if (what === "prepare") {
			const key = prepKey(pr);
			if (preparing.get(key)?.state === "failed") preparing.delete(key);
			startPrep(pr);
			return { ok: true };
		}
		const prep = store.reviewPrep(prepKey(pr)) as Prep | undefined;
		if (!prep) throw new HttpError(409, "the guided review is not ready yet");
		if (what === "step") {
			const s = prep.steps.find((x) => x.id === b.step);
			if (!s) throw new HttpError(404, "no such step");
			if (typeof b.reviewed !== "boolean") throw new HttpError(400, "reviewed must be true or false");
			store.setReviewMarks(lab, prKey(pr), s.fps, b.reviewed);
			return { ok: true };
		}
		if (what === "file") { // one file of a step, viewed or not
			const f = prep.steps.flatMap((s) => s.fps).find((x) => x.path === b.path);
			if (!f) throw new HttpError(404, "no such file");
			if (typeof b.reviewed !== "boolean") throw new HttpError(400, "reviewed must be true or false");
			store.setReviewMarks(lab, prKey(pr), [f], b.reviewed);
			return { ok: true };
		}
		if (what === "draft") {
			if (b.action !== "keep" && b.action !== "drop") throw new HttpError(400, "action must be keep or drop");
			const d = prep.steps.flatMap((s) => s.drafts).find((x) => x.id === b.draft);
			if (!d) throw new HttpError(404, "no such draft");
			if (b.action === "drop") {
				store.setDraftState(lab, prKey(pr), d.id, "dropped");
				store.addLearning(pr.repo, d.body, opts.now().toISOString());
				return { ok: true };
			}
			const body = b.body === undefined ? d.body : typeof b.body === "string" && b.body.trim() ? b.body.trim() : bad("the comment is empty");
			const u = linked(lab);
			await github.addReviewComment(await tokenFor(u), pr.repo, pr.number, { mode: "review", path: d.path, body, subject: "line", line: d.line, side: d.side }).catch(fromGitHub);
			store.setDraftState(lab, prKey(pr), d.id, "kept");
			return { ok: true };
		}
		throw new HttpError(404, "not found");
	}

	const askScope = (pr: PullRequest) => `review:${prKey(pr)}`;

	/**
	 * SPEC 19, Ask: a question about one step of a guided review, answered by the model from
	 * what it saw when it reviewed the step and the questions before. Kept for the person who
	 * asked, with the step; never sent to GitHub. One question per person and step at a time.
	 * With no step the question is about the whole pull request (SPEC 19.13): it needs no
	 * prepared review, and is kept with the pull request.
	 */
	async function askFor(req: IncomingMessage, lab: string): Promise<SummaryRun> {
		if (!ai()) throw new HttpError(503, "AI answers are not set up");
		const b = await json(req);
		const pr = await reviewTarget(lab, b.repo, b.number);
		const question = typeof b.question === "string" ? b.question.trim() : "";
		if (!question) bad("the question is empty");
		if (question.length > MAX_QUESTION) bad(`the question is too long (at most ${MAX_QUESTION} characters)`);
		const prep = store.reviewPrep(prepKey(pr)) as Prep | undefined;
		if (b.step === undefined || b.step === null) return askPr(lab, pr, prep, question);
		if (!prep) throw new HttpError(409, "the guided review is not ready yet");
		const step = prep.steps.find((x) => x.id === b.step);
		if (!step) throw new HttpError(404, "no such step");
		let about: AskAbout | null = null;
		if (b.about?.draft !== undefined) {
			const d = step.drafts.find((x) => x.id === b.about.draft);
			if (!d) throw new HttpError(404, "no such draft in this step");
			about = { path: d.path, draft: d.id, side: d.side, line: d.line };
		} else if (b.about?.path !== undefined) {
			if (!step.files.includes(b.about.path)) throw new HttpError(404, "no such file in this step");
			about = { path: b.about.path };
		}
		const id = `ask:${lab}:${askScope(pr)}:${step.id}`;
		if (summarizing.has(id)) throw new HttpError(409, "wait for the answer to your last question");
		const earlier = store.asks(lab, askScope(pr)).filter((a) => a.thread === step.id);
		return startRun(id, async () => {
			const set = await github.prFiles(pr.repo, pr.number).catch((e) => { throw new HttpError(502, `could not read it from GitHub: ${(e as Error).message}`); });
			if (!set) throw new HttpError(404, "the pull request is gone");
			const changed = new Map(set.files.map((f) => [f.path, f]));
			const files = await Promise.all(step.files.map(async (path): Promise<FileChanges> => {
				const f = changed.get(path);
				return f ? readChange(pr.repo, set, f) : { path, status: "modified", additions: 0, deletions: 0, text: null };
			}));
			return askPrompt(pr, step, files, earlier, { question, about }, opts.now().toISOString().slice(0, 10));
		}, (answer) => {
			if (!answer.trim()) throw new HttpError(502, "the model gave no answer; ask again");
			store.addAsk(lab, askScope(pr), step.id, { question, answer: answer.trim(), about }, opts.now().toISOString());
		});
	}

	const PR_THREAD = ""; // no step has this id

	/** SPEC 19.13: a question about the whole pull request. */
	function askPr(lab: string, pr: PullRequest, prep: Prep | undefined, question: string): SummaryRun {
		const id = `ask:${lab}:${askScope(pr)}:${PR_THREAD}`;
		if (summarizing.has(id)) throw new HttpError(409, "wait for the answer to your last question");
		const earlier = store.asks(lab, askScope(pr)).filter((a) => a.thread === PR_THREAD);
		return startRun(id, async () => {
			const gone = (e: unknown): never => { throw new HttpError(502, `could not read it from GitHub: ${(e as Error).message}`); };
			const [set, content] = await Promise.all([github.prFiles(pr.repo, pr.number).catch(gone), github.prContent(pr.repo, pr.number).catch(() => null)]);
			if (!set) throw new HttpError(404, "the pull request is gone");
			const files = await readChanges(pr.repo, set);
			const data = (f: Read) => isData(f.path, opts.diff ? f.text : "");
			const left = { noise: files.filter((f) => f.why).map((f) => f.path), data: files.filter((f) => !f.why && data(f)).map((f) => f.path) };
			const review = prep?.ai ? { summary: prep.summary, steps: prep.steps.filter((x) => !x.skim) } : null;
			return askPrPrompt(pr, content?.body ?? "", review, files.filter((f) => !f.why && !data(f)), left, earlier, question, opts.now().toISOString().slice(0, 10));
		}, (answer) => {
			if (!answer.trim()) throw new HttpError(502, "the model gave no answer; ask again");
			store.addAsk(lab, askScope(pr), PR_THREAD, { question, answer: answer.trim(), about: null }, opts.now().toISOString());
		});
	}

	/** SPEC 19.13: what `lab` asked about the whole pull request, oldest first, and whether there is an AI to ask. */
	async function prAsks(lab: string, repo: string | null, number: number) {
		const pr = await reviewTarget(lab, repo, number);
		const asks = store.asks(lab, askScope(pr)).filter((a) => a.thread === PR_THREAD).map(({ question, answer, at }) => ({ question, answer, at }));
		return { ai: Boolean(ai()), asks };
	}

	/**
	 * SPEC 15: a file's bytes for the page to draw (a picture or a PDF). The type comes from
	 * the bytes, never the name; anything else is a download. A sandbox CSP and nosniff keep
	 * a browser from running anything in it, even when it is opened on its own.
	 */
	const SHOWABLE: [string, (b: Buffer) => boolean][] = [
		["image/png", (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))],
		["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
		["image/gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
		["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
		["image/bmp", (b) => b.subarray(0, 2).toString("latin1") === "BM"],
		["image/x-icon", (b) => b.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))],
		["application/pdf", (b) => b.subarray(0, 5).toString("latin1") === "%PDF-"],
	];

	async function fileBytes(res: ServerResponse, lab: string, repo: string | null, ref: string | null, path: string | null) {
		if (!repo || !ref || !path) throw new HttpError(400, "give repo, ref and path");
		const { repos } = await viewOf(linked(lab));
		if (!repos.has(repo.toLowerCase())) throw new HttpError(404, "not found");
		const got = await github.fileAt(repo, ref, path);
		if (got === null) throw new HttpError(404, "file not found");
		if (got === "too large") throw new HttpError(413, "over 10 MB");
		const type = SHOWABLE.find(([, is]) => is(got))?.[0];
		res.writeHead(200, {
			"content-type": type ?? "application/octet-stream",
			...(type ? {} : { "content-disposition": "attachment" }),
			"content-length": got.length,
			"x-content-type-options": "nosniff",
			"content-security-policy": "sandbox; default-src 'none'",
			// a commit's file never changes; other refs may
			"cache-control": /^[0-9a-f]{40}$/.test(ref) ? "private, max-age=31536000, immutable" : "no-store",
		});
		res.end(got);
	}

	async function summarizeItem(req: IncomingMessage, lab: string) {
		const s = await summaryFor(req, lab);
		if ("kept" in s) return { summary: s.kept, cached: true };
		return { summary: await s.run.done, cached: false };
	}

	/** Summarize as server-sent events: stage, then text pieces, then done or error (SPEC 12). */
	async function summarizeStream(req: IncomingMessage, res: ServerResponse, lab: string) {
		return streamRun(res, await summaryFor(req, lab), "summary"); // refusals are plain JSON errors, before the stream starts
	}

	/** A model run as server-sent events: stage, text pieces, then done ({[name], cached}) or error. */
	async function streamRun(res: ServerResponse, s: { kept: string } | { run: SummaryRun }, name: string, more: object = {}) {
		res.writeHead(200, {
			"content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff",
			"x-accel-buffering": "no", // nginx: pass each event on at once
		});
		const emit = (event: string | null, data: unknown) => {
			if (!res.writableEnded) res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
		};
		if ("kept" in s) {
			emit("done", { [name]: s.kept, cached: true, ...more });
			return res.end();
		}
		const run = s.run;
		emit("stage", { stage: "reading" });
		if (run.stage === "writing") emit("stage", { stage: "writing" });
		if (run.text) emit(null, { delta: run.text }); // what was written before this watcher came
		const watch = (e: SummaryEvent) => ("delta" in e ? emit(null, { delta: e.delta }) : emit("stage", e));
		run.watchers.add(watch);
		try {
			emit("done", { [name]: await run.done, cached: false, ...more });
		} catch (e) {
			emit("error", { error: (e as Error).message });
		} finally {
			run.watchers.delete(watch);
			res.end();
		}
	}


	// -- AI settings (SPEC 20) -------------------------------------------------------------

	/** Saved on the settings page; the key sealed like GitHub tokens. */
	type AiSaved = { provider: "off" | Provider; baseUrl?: string; model?: string; deepModel?: string; noThinking?: boolean; keySealed?: string };
	type AiForm = AiSaved & { apiKey?: string };
	const PROVIDERS = ["off", "openai", "anthropic", "compatible"];
	const made = new Map<string, Summarize>();
	const isAdmin = (lab: string) => (opts.admins ?? []).some((a) => a.toLowerCase() === lab);
	const savedAi = () => store.setting("ai") as AiSaved | undefined;

	/**
	 * The LLM to use now: the admin's choice on the page, else the server's own. The
	 * everyday model runs summaries, explanations and guided review; "deep" is for Deep review.
	 */
	function ai(kind: "everyday" | "deep" = "everyday"): Summarize | undefined {
		const s = savedAi();
		if (!s) return opts.summarize;
		if (s.provider === "off" || !opts.providers) return undefined;
		const model = kind === "deep" ? s.deepModel || s.model! : s.model!;
		const c = configOf(s, model, s.keySealed ? unseal(opts.encryptionKey, s.keySealed) : undefined);
		const id = JSON.stringify(c);
		let llm = made.get(id);
		if (!llm) {
			if (made.size > 4) made.clear(); // only the current settings matter
			llm = opts.providers.make(c);
			made.set(id, llm);
		}
		return llm;
	}

	/** OpenAI and Anthropic always use their own address; only OpenAI-compatible takes one. */
	function configOf(s: Pick<AiSaved, "provider" | "baseUrl" | "noThinking">, model: string, apiKey: string | undefined): LlmConfig {
		const compatible = s.provider === "compatible";
		return { provider: s.provider as Provider, baseUrl: compatible ? s.baseUrl : undefined, apiKey, model, noThinking: compatible && Boolean(s.noThinking) };
	}

	function requireAdmin(lab: string) {
		if (!isAdmin(lab)) throw new HttpError(403, "only an admin can change the AI settings");
		if (!opts.providers) throw new HttpError(503, "AI providers are not available on this server");
	}

	/** What the page shows: never the key, only whether one is set. */
	function aiView() {
		const s = savedAi();
		if (s) return { from: "page", provider: s.provider, baseUrl: s.baseUrl, model: s.model, deepModel: s.deepModel, noThinking: Boolean(s.noThinking), keySet: Boolean(s.keySealed) };
		const v = opts.serverAi;
		if (v) return { from: "server", provider: v.provider, baseUrl: v.baseUrl, model: v.model, deepModel: v.deepModel, noThinking: Boolean(v.noThinking), keySet: Boolean(v.apiKey) };
		return { from: opts.summarize ? "server" : "none", provider: opts.summarize ? undefined : "off", keySet: false };
	}

	const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

	/** A form from the page, checked. `needModel` for saving and testing, not for listing models. */
	function readAiForm(b: any, needModel: boolean): AiForm {
		if (!PROVIDERS.includes(b?.provider)) throw new HttpError(400, "provider must be off, openai, anthropic or compatible");
		const f: AiForm = { provider: b.provider };
		if (f.provider === "off") return f;
		f.model = str(b.model, 200);
		f.deepModel = str(b.deepModel, 200);
		f.apiKey = str(b.apiKey, 4000);
		if (f.provider === "compatible") {
			f.baseUrl = str(b.baseUrl, 500);
			if (!f.baseUrl || !/^https?:\/\/[^\s/]+/.test(f.baseUrl)) throw new HttpError(400, "an OpenAI-compatible provider needs an http(s) address");
			f.noThinking = Boolean(b.noThinking);
		}
		if (needModel && !f.model) throw new HttpError(400, "choose a model");
		return f;
	}

	/** The key to use with a form: the one typed, else the one kept for that provider. */
	function keyFor(f: AiForm): string | undefined {
		if (f.apiKey) return f.apiKey;
		const s = savedAi();
		if (s?.keySealed && s.provider === f.provider) return unseal(opts.encryptionKey, s.keySealed);
		if (opts.serverAi?.apiKey && opts.serverAi.provider === f.provider) return opts.serverAi.apiKey;
		return undefined;
	}

	async function saveAi(req: IncomingMessage) {
		const b = await json(req);
		const f = readAiForm(b, true);
		const key = b?.clearKey || f.provider === "off" ? undefined : keyFor(f);
		const { apiKey: _typed, ...rest } = f;
		const saved: AiSaved = { ...rest, ...(key ? { keySealed: seal(opts.encryptionKey, key) } : {}) };
		store.saveSetting("ai", saved);
		made.clear();
		log(`AI settings changed by ${b?.provider === "off" ? "turning AI off" : `choosing ${f.provider} ${f.model}`}`);
		return aiView();
	}

	async function testAi(req: IncomingMessage) {
		const f = readAiForm(await json(req), true);
		if (f.provider === "off") return { ok: true, ms: 0 };
		const started = Date.now();
		try {
			await opts.providers!.make(configOf(f, f.model!, keyFor(f)))({ system: "Reply with the single word OK.", user: "Are you there?" });
			return { ok: true, ms: Date.now() - started };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	async function aiModels(req: IncomingMessage) {
		const f = readAiForm(await json(req), false);
		if (f.provider === "off") return { models: [] };
		try {
			const { model: _m, ...c } = configOf(f, "", keyFor(f));
			return { models: await opts.providers!.models(c) };
		} catch (e) {
			return { error: (e as Error).message };
		}
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
			return send(res, 200, indexHtml, "text/html; charset=utf-8");
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
			const f = fold(lab, "pr", store.prs().filter(visible(repos)));
			// `version` lets an open page (e.g. the Home Screen app, which never reloads by
			// itself) notice a newer deploy and reload.
			return send(res, 200, { user: lab, login: u.login, version: scriptVersion, staleDays: config.staleDays, ...buildInbox(f.live, viewer), old: f.old, hidden: f.hidden, summarize: Boolean(ai()), admin: isAdmin(lab), code: opts.code ? CODE_KINDS : [] });
		}
		if (method === "GET" && path === "/api/issues") {
			const { repos } = await viewOf(linked(lab));
			const f = fold(lab, "issue", store.issues().filter(visible(repos)));
			return send(res, 200, { items: f.live.sort(newest), old: f.old, hidden: f.hidden, summarize: Boolean(ai()) });
		}
		if (method === "POST" && (path === "/api/hide" || path === "/api/unhide")) {
			const b = await json(req);
			if (b.kind !== "pr" && b.kind !== "issue") throw new HttpError(400, "kind must be pr or issue");
			const { repos } = await viewOf(linked(lab));
			const item = typeof b.repo === "string" && Number.isInteger(b.number)
				? (b.kind === "pr" ? store.pr(b.repo, b.number) : store.issue(b.repo, b.number)) : undefined;
			if (!item || !repos.has(item.repo.toLowerCase())) throw new HttpError(404, "not found");
			const key = `${item.repo}#${item.number}`;
			if (path === "/api/hide") store.hide(lab, b.kind, key, opts.now().toISOString());
			else store.unhide(lab, b.kind, key);
			return send(res, 200, { ok: true });
		}
		if (method === "POST" && path === "/api/unlink") {
			store.deleteUser(lab);
			access.delete(lab);
			return send(res, 200, { ok: true });
		}
		if (method === "GET" && path === "/api/prs/files") {
			return send(res, 200, await prFilesFor(lab, url.searchParams.get("repo"), Number(url.searchParams.get("number"))));
		}
		if (method === "GET" && path === "/api/prs/graph") {
			return send(res, 200, await prGraph(lab, url.searchParams.get("repo"), Number(url.searchParams.get("number"))));
		}
		// SPEC 16: the PR page, read as the person
		if (method === "GET" && path === "/api/pr") {
			const { u, repo, token } = await asReader(lab, url.searchParams.get("repo"));
			const n = Number(url.searchParams.get("number"));
			if (!Number.isInteger(n)) throw new HttpError(404, "no such pull request");
			const page = await github.prPage(token, repo, n).catch(fromGitHub);
			if (!page) throw new HttpError(404, "no such pull request");
			return send(res, 200, { page, login: u.login });
		}
		if (method === "GET" && path === "/api/repo/options") {
			const { repo, token } = await asReader(lab, url.searchParams.get("repo"));
			return send(res, 200, await github.repoOptions(token, repo).catch(fromGitHub));
		}
		if (method === "GET" && path === "/api/prs/commits") {
			const { repo } = await asReader(lab, url.searchParams.get("repo"));
			const commits = await github.prCommits(repo, Number(url.searchParams.get("number"))).catch(fromGitHub);
			if (!commits) throw new HttpError(404, "no such pull request");
			return send(res, 200, commits);
		}
		if (method === "GET" && path === "/api/commit/files") {
			const { repo } = await asReader(lab, url.searchParams.get("repo"));
			const sha = url.searchParams.get("sha") ?? "";
			const files = /^[\w.-]{1,100}$/.test(sha) ? await github.commitFiles(repo, sha).catch(fromGitHub) : null;
			if (!files) throw new HttpError(404, "no such commit");
			return send(res, 200, files);
		}
		if (method === "GET" && path === "/api/prs/conflicts") {
			const { repos } = await viewOf(linked(lab));
			const pr = store.pr(url.searchParams.get("repo") ?? "", Number(url.searchParams.get("number")));
			if (!pr || !repos.has(pr.repo.toLowerCase())) throw new HttpError(404, "no such pull request");
			const { m, plan } = await conflictsOf(pr.repo, pr.number).catch(fromGitHub);
			return send(res, 200, { head: m.headSha, base: m.baseSha, headRef: m.headRef, baseRef: m.baseRef, files: plan.conflicts, unsupported: plan.unsupported });
		}
		if (method === "GET" && path === "/api/file") {
			return fileBytes(res, lab, url.searchParams.get("repo"), url.searchParams.get("ref"), url.searchParams.get("path"));
		}
		if (method === "POST" && path === "/api/diff") {
			return send(res, 200, await diffFiles(req, lab));
		}
		if (method === "POST" && path === "/api/code/lookup") { // SPEC 21
			return send(res, 200, await codeLookup(req, lab));
		}
		if (method === "GET" && path === "/api/review") { // SPEC 19
			return send(res, 200, await reviewGet(lab, url.searchParams.get("repo"), Number(url.searchParams.get("number"))));
		}
		if (method === "GET" && path === "/api/review/asks") { // SPEC 19.13
			return send(res, 200, await prAsks(lab, url.searchParams.get("repo"), Number(url.searchParams.get("number"))));
		}
		if (method === "POST" && path === "/api/review/ask") { // SPEC 19, Ask
			const run = await askFor(req, lab);
			if ((req.headers.accept ?? "").includes("text/event-stream")) return streamRun(res, { run }, "answer");
			return send(res, 200, { answer: (await run.done).trim() });
		}
		if (method === "POST" && path.startsWith("/api/review/")) {
			return send(res, 200, await reviewPost(req, lab, path.slice("/api/review/".length)));
		}
		if (method === "POST" && path === "/api/explain") { // SPEC 17
			const s = await explainFor(req, lab);
			if (String(req.headers.accept ?? "").includes("text/event-stream")) return streamRun(res, s, "explanation", { asks: s.asks });
			return send(res, 200, "kept" in s ? { explanation: s.kept, cached: true, asks: s.asks } : { explanation: await s.run.done, cached: false, asks: s.asks });
		}
		if (method === "POST" && path === "/api/explain/ask") { // SPEC 17
			const run = await explainAskFor(req, lab);
			if (String(req.headers.accept ?? "").includes("text/event-stream")) return streamRun(res, { run }, "answer");
			return send(res, 200, { answer: (await run.done).trim() });
		}
		if (method === "POST" && path === "/api/summarize" && String(req.headers.accept ?? "").includes("text/event-stream")) {
			return summarizeStream(req, res, lab);
		}
		if (path === "/api/ai" || path.startsWith("/api/ai/")) {
			requireAdmin(lab);
			if (method === "GET" && path === "/api/ai") return send(res, 200, aiView());
			if (method === "POST" && path === "/api/ai") return send(res, 200, await saveAi(req));
			if (method === "POST" && path === "/api/ai/test") return send(res, 200, await testAi(req));
			if (method === "POST" && path === "/api/ai/models") return send(res, 200, await aiModels(req));
		}
		if (method === "POST" && path === "/api/summarize") {
			return send(res, 200, await summarizeItem(req, lab));
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
		if (method === "POST" && path === "/api/push/test") {
			// SPEC 14: Send a test, to one of your own devices; not counted as unread
			const b = await json(req);
			const d = store.devices(lab).find((x) => x.endpoint === b.endpoint);
			if (!d) throw new HttpError(404, "not one of your devices");
			const id = randomBytes(6).toString("base64url");
			const ok = await pushTo(lab, d, { title: "Nudgebox test", body: "Notifications work on this device.", url: "/#settings", test: id }, { urgency: "high" });
			if (!ok) throw new HttpError(502, "the push service did not take it; turn notifications off and on again");
			return send(res, 200, { ok: true, id });
		}
		if (method === "GET" && path === "/api/events") {
			return openStream(req, res, lab);
		}
		if (method === "POST" && path === "/api/events/test") {
			// SPEC 14 + 18: Send a test, to this desktop app only; not counted as unread
			const b = await json(req);
			const a = typeof b.client === "string" ? streams.get(b.client) : undefined;
			if (!a || a.lab !== lab) throw new HttpError(404, "not one of your apps");
			const id = randomBytes(6).toString("base64url");
			a.emit("notify", { title: "Nudgebox test", body: "Notifications work in this app.", url: "/#settings", test: id });
			log(`event stream for ${lab}: sent "Nudgebox test"`);
			return send(res, 200, { ok: true, id });
		}
		if (method === "POST" && path === "/api/push/seen") {
			store.resetUnread(lab); // SPEC 7: Nudgebox was opened
			return send(res, 200, { ok: true });
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
		const [prs, issues] = await Promise.all([github.openPullRequests(), github.openIssues()]);
		store.replacePrs(prs.filter((p) => inConfig(p.repo)));
		store.replaceIssues(issues.filter((i) => inConfig(i.repo)));
	}

	async function runStaleDigest() {
		const now = opts.now();
		const day = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
		const cutoff = now.getTime() - config.staleDays * DAY_MS;
		for (const u of store.users()) {
			try {
				const { viewer, repos } = await viewOf(u);
				const stale = fold(u.labUser, "pr", store.prs().filter(visible(repos))).live // hidden and old stay quiet
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
		warm,
		runStaleDigest,
		idle: async () => {
			let seen: Promise<void>;
			do {
				seen = work;
				await seen;
				await Promise.all([...prepWork]); // SPEC 19 preparations run beside the queue
			} while (seen !== work || prepWork.size);
		},
		close: async () => {
			for (const a of [...streams.values()]) a.end();
			await work;
			await opts.code?.close();
			store.close();
		},
	};
}
