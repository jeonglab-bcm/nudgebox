/**
 * Production entry point: real GitHub (OctokitGitHub), Web Push (web-push, VAPID),
 * config.yaml + environment, the 10-minute sync and the daily stale digest.
 *
 * Two listeners (SPEC 3.1, 9), so identity headers can only come from the sidecar:
 * - APP_PORT (default 8080): the whole app. Reachable ONLY from the Keycloak
 *   oauth2-proxy sidecar on the compose network; never publish it on the host.
 * - PUBLIC_PORT (default 8081): only POST /webhook (signature-checked) and the static
 *   web-app files. nginx sends GitHub's webhooks here; identity headers are useless
 *   on it because every other path is 404.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import webpush from "web-push";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createLlm, listModels } from "./llm.ts";
import { createCodeIntel } from "./code.ts";
import { createOmnidiff } from "./omnidiff.ts";
import { OctokitGitHub } from "./octokit-github.ts";
import { publicOnly } from "./public.ts";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function need(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`missing environment variable ${name} (see .env.example)`);
		process.exit(1);
	}
	return v;
}

const { config, origin, digestHour, admins, ai, unknown } = readConfig(readFileSync(process.env.CONFIG ?? "config.yaml", "utf8"), process.env);
if (unknown.length) log(`config.yaml: not used (a typo?): ${unknown.join(", ")}`);

const tokenKey = Buffer.from(need("TOKEN_KEY"), "base64");
if (tokenKey.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes, base64 (openssl rand -base64 32)");

const vapid = { subject: need("VAPID_SUBJECT"), publicKey: need("VAPID_PUBLIC_KEY"), privateKey: need("VAPID_PRIVATE_KEY") };

const github = new OctokitGitHub({
	appId: need("GITHUB_APP_ID"),
	privateKey: readFileSync(need("GITHUB_APP_PRIVATE_KEY_FILE"), "utf8"),
	clientId: need("GITHUB_CLIENT_ID"),
	clientSecret: need("GITHUB_CLIENT_SECRET"),
	accounts: config.orgs,
	log,
});

// SPEC 12, 20: the server's own LLM from config.yaml (`llm:`) and LLM_API_KEY. An admin
// can choose another in Settings → AI, which then wins.
const summarize = ai ? createLlm(ai) : undefined;
log(ai ? `AI on (${ai.provider}, ${ai.model})` : "AI off in config.yaml (an admin can turn it on in Settings)");

const app = createApp({
	config,
	origin,
	github,
	githubClientId: need("GITHUB_CLIENT_ID"),
	webhookSecret: need("GITHUB_WEBHOOK_SECRET"),
	encryptionKey: tokenKey,
	dbPath: process.env.DB_PATH ?? "/data/nudgebox.sqlite",
	vapidPublicKey: vapid.publicKey,
	push: async (sub, payload, opts) => {
		await webpush.sendNotification(sub, JSON.stringify(payload), { vapidDetails: vapid, TTL: 24 * 3600, urgency: opts?.urgency ?? "normal" });
	},
	now: () => new Date(),
	log,
	summarize,
	serverAi: ai,
	admins,
	providers: { make: createLlm, models: listModels },
	diff: createOmnidiff(process.env.OMNIDIFF_BIN ?? "omnidiff"), // SPEC 15; the image has it on PATH
	code: createCodeIntel({ archive: (repo, ref) => github.archive(repo, ref), log }), // SPEC 21; the language servers come with npm
});

const host = process.env.LISTEN_HOST ?? "0.0.0.0";
const appServer = createServer(app.handler).listen(Number(process.env.APP_PORT ?? 8080), host);
const publicServer = createServer(publicOnly(app.handler)).listen(Number(process.env.PUBLIC_PORT ?? 8081), host);
log(`listening: app :${process.env.APP_PORT ?? 8080} (sidecar only), public :${process.env.PUBLIC_PORT ?? 8081} (webhook + static)`);

async function syncNow() {
	try {
		await app.sync();
		log("sync ok");
	} catch (e) {
		log(`sync failed: ${(e as Error).message}`);
	}
}

let digestDay = "";
async function maybeDigest() {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
		.formatToParts(new Date()).map((p) => [p.type, p.value]));
	const day = `${parts.year}-${parts.month}-${parts.day}`;
	if (Number(parts.hour) < digestHour || day === digestDay) return;
	digestDay = day;
	try {
		await app.runStaleDigest();
		log(`stale digest sent for ${day}`);
	} catch (e) {
		log(`stale digest failed: ${(e as Error).message}`);
	}
}

await syncNow();
const timers = [setInterval(syncNow, 10 * 60_000), setInterval(maybeDigest, 60_000)];
void maybeDigest();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
	process.on(sig, async () => {
		timers.forEach(clearInterval);
		appServer.close();
		publicServer.close();
		await app.close();
		process.exit(0);
	});
}
