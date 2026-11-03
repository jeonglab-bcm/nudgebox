/**
 * Creates the lab's GitHub App with every setting filled in, using GitHub's documented
 * "app manifest" flow, and writes its credentials straight to files: nothing to copy,
 * nothing printed.
 *
 *   node scripts/create-github-app.ts <secrets-dir> [listen-ip] [port]
 *
 * 1. Serves one page on listen-ip:port (default: anjanda's tailnet address).
 * 2. You open it and click "Create on GitHub": the browser posts the manifest to GitHub,
 *    you confirm the name, GitHub creates the App and sends you back here with a code.
 * 3. This script trades the code (valid 1 hour, single use) for the App's credentials
 *    and writes <secrets-dir>/.env (0600) and <secrets-dir>/github-app.pem (0600),
 *    adding a TOKEN_KEY and VAPID keys. It refuses to overwrite an existing .env.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import webpush from "web-push";

const [dirArg, ip = "100.103.101.49", port = "18765"] = process.argv.slice(2);
if (!dirArg) {
	console.error("usage: node scripts/create-github-app.ts <secrets-dir> [listen-ip] [port]");
	process.exit(1);
}
const dir = resolve(dirArg);
if (existsSync(join(dir, ".env"))) {
	console.error(`${dir}/.env already exists; not overwriting it`);
	process.exit(1);
}

const ORG = "jeonglab-bcm";
const SITE = "https://gh.bioinfolder.com";
const here = `http://${ip}:${port}`;
const state = randomBytes(16).toString("hex");

const manifest = {
	name: "Jeong Lab Nudgebox", // renamed from "Jeong Lab PRs" on 2026-11-03
	url: SITE,
	description: "Nudgebox (gh.bioinfolder.com): the lab's GitHub inbox for PRs and issues, with iPhone/Mac push.",
	hook_attributes: { url: `${SITE}/webhook`, active: true },
	redirect_url: `${here}/created`,
	callback_urls: [`${SITE}/auth/github/callback`],
	// Public only so it can be installed on hyunhwan-bcm (a user account) as well as the
	// org; the app ignores every other account (src/app.ts, onWebhook).
	public: true,
	request_oauth_on_install: false,
	default_permissions: {
		metadata: "read",
		pull_requests: "write", // approve, comment, read reviews
		contents: "write", // merge
		checks: "read",
		statuses: "read",
		actions: "write", // re-run failed jobs
		issues: "read", // issue_comment events on PRs
		members: "read", // which teams a person is in (review requests to a team)
	},
	default_events: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "check_suite", "check_run", "status"],
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const page = (body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Create the GitHub App</title><style>body{font:16px/1.5 -apple-system,sans-serif;max-width:560px;margin:40px auto;padding:0 16px}
button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#1f883d;color:#fff;cursor:pointer}
code{background:#eee;padding:1px 4px;border-radius:4px}</style>${body}`;

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", here);
	if (url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		return res.end(page(`<h1>Create “${manifest.name}”</h1>
<p>This creates the lab's GitHub App in <b>${ORG}</b> with all settings filled in. GitHub will ask you to confirm the name.</p>
<form action="https://github.com/organizations/${ORG}/settings/apps/new?state=${state}" method="post">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<button type="submit">Create on GitHub</button></form>`));
	}
	if (url.pathname === "/created") {
		if (url.searchParams.get("state") !== state) {
			res.writeHead(400, { "content-type": "text/plain" });
			return res.end("state mismatch: start again from the first page");
		}
		const code = url.searchParams.get("code") ?? "";
		const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
			method: "POST",
			headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
		});
		if (!r.ok) {
			res.writeHead(502, { "content-type": "text/plain" });
			return res.end(`GitHub refused the code (${r.status}). Start again from the first page.`);
		}
		const app = (await r.json()) as Record<string, any>;
		const vapid = webpush.generateVAPIDKeys();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, "github-app.pem"), app.pem, { mode: 0o600 });
		writeFileSync(join(dir, ".env"), [
			"# gh.bioinfolder.com secrets, written by scripts/create-github-app.ts. Never commit.",
			`GITHUB_APP_ID=${app.id}`,
			`GITHUB_CLIENT_ID=${app.client_id}`,
			`GITHUB_CLIENT_SECRET=${app.client_secret}`,
			`GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`,
			"GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app.pem",
			`TOKEN_KEY=${randomBytes(32).toString("base64")}`,
			`VAPID_PUBLIC_KEY=${vapid.publicKey}`,
			`VAPID_PRIVATE_KEY=${vapid.privateKey}`,
			"VAPID_SUBJECT=mailto:hyun-hwan.jeong@bcm.edu",
			"",
		].join("\n"), { mode: 0o600 });
		const install = `https://github.com/apps/${app.slug}/installations/new`;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(page(`<h1>Created ✓</h1><p>The credentials are saved on anjanda. Last step: install the App.</p>
<p><a href="${esc(install)}"><button>Install the App</button></a></p>
<p>Install it twice: on <b>${ORG}</b> (all repositories), then again on <b>hyunhwan-bcm</b> (all repositories).</p>`));
		console.log(`created GitHub App "${app.name}" (slug ${app.slug}, id ${app.id}); credentials written to ${dir}`);
		console.log(`install: ${install}`);
		setTimeout(() => process.exit(0), 500);
		return;
	}
	res.writeHead(404).end();
});
server.listen(Number(port), ip, () => console.log(`open ${here}/ in a browser on the tailnet`));
