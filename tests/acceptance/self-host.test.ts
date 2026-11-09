/**
 * Issue #33, part 1: running your own Nudgebox outside bioinfolder. Sign-in through
 * oauth2-proxy with plain GitHub login (no Keycloak), neutral defaults, and deploy
 * files that match what the server reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { start } from "../helpers/harness.ts";
import { readConfig } from "../../src/config.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const LAB = "jeonglab-bcm/labbot";

/** oauth2-proxy with the GitHub provider: user and email, maybe no preferred username. */
const viaGitHub = (user: string, extra: Record<string, string> = {}) => ({ "x-forwarded-user": user, "x-forwarded-email": `${user}@users.noreply.github.com`, ...extra });

test("33.1 signed in through GitHub (only X-Forwarded-User and email), a person gets their inbox", async () => {
	const t = await start();
	try {
		t.github.grant("octo", LAB);
		t.github.addPr({ repo: LAB, number: 1, author: "kelly", title: "Review me", requestedReviewers: ["octo"] });
		// link GitHub as lab user "octo", sending only GitHub-style headers
		const go = await t.req("/auth/github", { headers: viaGitHub("Octo") });
		assert.equal(go.status, 302);
		const state = new URL(go.headers.get("location")!).searchParams.get("state")!;
		t.github.codes.set("c1", "octo");
		assert.equal((await t.req(`/auth/github/callback?code=c1&state=${state}`, { headers: viaGitHub("Octo") })).status, 302);
		await t.app.sync();
		const r = await t.req("/api/inbox", { headers: viaGitHub("Octo") });
		assert.equal(r.status, 200);
		const body = await r.json();
		assert.equal(body.user, "octo", "the GitHub login, lower-cased, is the lab user");
		assert.ok(body.sections.some((s: any) => s.prs.some((p: any) => p.number === 1)));
	} finally {
		await t.close();
	}
});

test("33.2 when both are sent, X-Forwarded-Preferred-Username wins (Keycloak setups unchanged)", async () => {
	const t = await start();
	try {
		await t.link("hyunhwanj", "hwan");
		const r = await t.req("/api/inbox", { headers: viaGitHub("some-uuid-1234", { "x-forwarded-preferred-username": "hyunhwanj" }) });
		assert.equal(r.status, 200);
		assert.equal((await r.json()).user, "hyunhwanj");
		const none = await t.req("/api/inbox", { headers: {} });
		assert.equal(none.status, 401);
	} finally {
		await t.close();
	}
});

test("33.3 config: no llm section, or OpenAI/Anthropic without a key, means AI off; no lab address built in", () => {
	const base = "origin: https://review.example.org\norgs: [example-lab]\n";
	assert.equal(readConfig(base, {}).ai, undefined);
	assert.equal(readConfig(`${base}llm:\n  provider: openai\n  model: gpt-x\n`, {}).ai, undefined);
	assert.deepEqual(readConfig(`${base}llm:\n  provider: anthropic\n  model: claude-x\n`, { LLM_API_KEY: "sk-ant" }).ai,
		{ provider: "anthropic", baseUrl: undefined, apiKey: "sk-ant", model: "claude-x", deepModel: undefined, noThinking: false });
	assert.deepEqual(readConfig(`${base}llm:\n  provider: compatible\n  baseUrl: http://ollama:11434/v1\n  model: qwen3:30b\n`, {}).ai,
		{ provider: "compatible", baseUrl: "http://ollama:11434/v1", apiKey: undefined, model: "qwen3:30b", deepModel: undefined, noThinking: false });
	assert.throws(() => readConfig(`${base}llm:\n  provider: compatible\n  model: m\n`, {}), /baseUrl/);
	assert.throws(() => readConfig(`${base}llm:\n  provider: gemini\n  model: m\n`, {}), /provider/);
	assert.throws(() => readConfig("orgs: [x]\n", {}), /origin/);
	const c = readConfig(base, {});
	assert.deepEqual(c.admins, []);
	assert.equal(c.config.timezone, "UTC", "no lab timezone built in");
});

test("33.5 no bioinfolder address in the code or page, except in comments", () => {
	const hits: string[] = [];
	for (const dir of ["src", "public"]) {
		for (const f of readdirSync(join(ROOT, dir))) {
			if (!/\.(ts|js|html|webmanifest)$/.test(f)) continue;
			readFileSync(join(ROOT, dir, f), "utf8").split("\n").forEach((line, i) => {
				const code = line.replace(/^\s*(\*|\/\*|\/\/).*$/, "").replace(/(^|\s)\/\/.*$/, "").replace(/<!--.*?-->/g, "");
				if (/bioinfolder/i.test(code)) hits.push(`${dir}/${f}:${i + 1}: ${line.trim()}`);
			});
		}
	}
	assert.deepEqual(hits, []);
});

test("33.6 the deploy files parse, and the example config uses only keys the server reads", () => {
	const example = readFileSync(join(ROOT, "deploy", "config.example.yaml"), "utf8");
	const c = readConfig(example, { LLM_API_KEY: "k" });
	assert.deepEqual(c.unknown, [], "every key is one the server reads");
	assert.deepEqual(readConfig(readFileSync(join(ROOT, "config.yaml"), "utf8"), {}).unknown, [], "the lab's own config too");

	const compose = parse(readFileSync(join(ROOT, "deploy", "docker-compose.yml"), "utf8"));
	const app = compose.services.app;
	const proxy = compose.services["oauth2-proxy"];
	assert.ok(app && proxy, "an app and an oauth2-proxy service");
	assert.ok(!(app.ports ?? []).some((p: string) => String(p).endsWith(":8080")), "the app's trusting port 8080 is never published");
	const env = proxy.environment;
	assert.equal(env.OAUTH2_PROXY_PROVIDER, "github");
	assert.equal(String(env.OAUTH2_PROXY_PASS_USER_HEADERS), "true", "the app identifies people from these headers");
	assert.match(env.OAUTH2_PROXY_UPSTREAMS, /http:\/\/app:8080\//);
	assert.match(env.OAUTH2_PROXY_UPSTREAMS, /http:\/\/app:8081\/webhook/, "GitHub's webhook goes to the public port");
	assert.match(env.OAUTH2_PROXY_SKIP_AUTH_ROUTES, /POST=\^\/webhook\$/);
	assert.ok((app.volumes ?? []).some((v: string) => /config\.yaml:\/app\/config\.yaml/.test(v)), "your own config.yaml is mounted");
});
