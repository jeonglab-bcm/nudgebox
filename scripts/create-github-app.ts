/**
 * Creates a Nudgebox GitHub App with every setting filled in, using GitHub's documented
 * "app manifest" flow, and writes its credentials straight to files: nothing to copy,
 * nothing printed.
 *
 *   node scripts/create-github-app.ts <secrets-dir> --site https://review.example.org \
 *     [--org example-lab] [--name "Example Lab Nudgebox"] [--contact mailto:you@example.org] \
 *     [--listen 127.0.0.1:18765]
 *
 * Without --org the App is created on your own account. (The Jeong Lab's was made with
 * --org jeonglab-bcm --site https://gh.bioinfolder.com --name "Jeong Lab Nudgebox".)
 *
 * 1. Serves one page on the --listen address (default 127.0.0.1:18765).
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
import { parseArgs } from "node:util";
import webpush from "web-push";

const { values: opt, positionals } = parseArgs({
	allowPositionals: true,
	options: { site: { type: "string" }, org: { type: "string" }, name: { type: "string", default: "Nudgebox" }, contact: { type: "string" }, listen: { type: "string", default: "127.0.0.1:18765" } },
});
const dirArg = positionals[0];
if (!dirArg || !opt.site?.startsWith("https://")) {
	console.error("usage: node scripts/create-github-app.ts <secrets-dir> --site https://<your site> [--org <org>] [--name <app name>] [--contact mailto:<you>] [--listen ip:port]");
	process.exit(1);
}
const [ip, port] = opt.listen!.split(":");
const dir = resolve(dirArg);
if (existsSync(join(dir, ".env"))) {
	console.error(`${dir}/.env already exists; not overwriting it`);
	process.exit(1);
}

const ORG = opt.org; // undefined: your own account
const SITE = opt.site.replace(/\/$/, "");
const here = `http://${ip}:${port}`;
const state = randomBytes(16).toString("hex");

const manifest = {
	name: opt.name!,
	url: SITE,
	description: `Nudgebox (${new URL(SITE).host}): one GitHub inbox for PRs and issues, with push notifications.`,
	hook_attributes: { url: `${SITE}/webhook`, active: true },
	redirect_url: `${here}/created`,
	callback_urls: [`${SITE}/auth/github/callback`],
	// Public so it can be installed on more than one account (an org and a person's own);
	// the app ignores accounts not in config.yaml's orgs (src/app.ts, onWebhook).
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
<p>This creates the GitHub App ${ORG ? `in <b>${esc(ORG)}</b>` : "on your own account"} with all settings filled in. GitHub will ask you to confirm the name.</p>
<form action="https://github.com/${ORG ? `organizations/${encodeURIComponent(ORG)}/` : ""}settings/apps/new?state=${state}" method="post">
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
			`# ${new URL(SITE).host} secrets, written by scripts/create-github-app.ts. Never commit.`,
			`GITHUB_APP_ID=${app.id}`,
			`GITHUB_CLIENT_ID=${app.client_id}`,
			`GITHUB_CLIENT_SECRET=${app.client_secret}`,
			`GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`,
			"GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app.pem",
			`TOKEN_KEY=${randomBytes(32).toString("base64")}`,
			`VAPID_PUBLIC_KEY=${vapid.publicKey}`,
			`VAPID_PRIVATE_KEY=${vapid.privateKey}`,
			`VAPID_SUBJECT=${opt.contact ?? ""}`,
			"",
		].join("\n"), { mode: 0o600 });
		const install = `https://github.com/apps/${app.slug}/installations/new`;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(page(`<h1>Created ✓</h1><p>The credentials are saved in ${esc(dir)}. Last step: install the App.</p>
<p><a href="${esc(install)}"><button>Install the App</button></a></p>
<p>Install it on each account listed under <code>orgs</code> in config.yaml (all repositories).</p>`));
		console.log(`created GitHub App "${app.name}" (slug ${app.slug}, id ${app.id}); credentials written to ${dir}`);
		console.log(`install: ${install}`);
		setTimeout(() => process.exit(0), 500);
		return;
	}
	res.writeHead(404).end();
});
server.listen(Number(port), ip, () => console.log(`open ${here}/ in a browser`));
