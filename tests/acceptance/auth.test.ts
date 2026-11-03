/**
 * SPEC 3. Sign-in: the Keycloak sidecar's headers get you in; GitHub is linked once
 * through the lab's GitHub App, and the token is stored encrypted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { start } from "../helpers/harness.ts";

test("3.1 no sidecar identity headers: 401", async () => {
	const t = await start();
	try {
		assert.equal((await t.req("/api/inbox")).status, 401);
		assert.equal((await t.req("/")).status, 401);
	} finally {
		await t.close();
	}
});

test("3.2 signed in but GitHub not linked: the inbox says where to link", async () => {
	const t = await start();
	try {
		const r = await t.req("/api/inbox", { as: "kellyl" });
		assert.equal(r.status, 409);
		assert.deepEqual(await r.json(), { link: "/auth/github" });
	} finally {
		await t.close();
	}
});

test("3.2 linking goes through GitHub's authorize page with a one-time state", async () => {
	const t = await start();
	try {
		const r = await t.req("/auth/github", { as: "kellyl" });
		assert.equal(r.status, 302);
		const loc = new URL(r.headers.get("location")!);
		assert.equal(loc.origin + loc.pathname, "https://github.com/login/oauth/authorize");
		const state = loc.searchParams.get("state")!;
		assert.ok(state.length >= 16);
		t.github.codes.set("c1", "kelly");

		// a made-up state, or someone else's, is refused
		assert.equal((await t.req("/auth/github/callback?code=c1&state=forged", { as: "kellyl" })).status, 400);
		assert.equal((await t.req(`/auth/github/callback?code=c1&state=${state}`, { as: "jorgeb" })).status, 400);

		const ok = await t.req(`/auth/github/callback?code=c1&state=${state}`, { as: "kellyl" });
		assert.equal(ok.status, 302);
		assert.equal(ok.headers.get("location"), "/");
		// a state works once
		assert.equal((await t.req(`/auth/github/callback?code=c1&state=${state}`, { as: "kellyl" })).status, 400);
		assert.equal((await t.req("/api/inbox", { as: "kellyl" })).status, 200);
	} finally {
		await t.close();
	}
});

test("3.2 GitHub tokens are not stored in plain text", async () => {
	const t = await start();
	try {
		await t.link("kellyl", "kelly");
		const raw = readdirSync(t.dir).map((f) => readFileSync(join(t.dir, f)).toString("latin1")).join("");
		assert.ok(!raw.includes("tok1:kelly"), "access token found in the database files");
		assert.ok(!raw.includes("ref1:kelly"), "refresh token found in the database files");
	} finally {
		await t.close();
	}
});

test("3.3 unlinking forgets the token", async () => {
	const t = await start();
	try {
		await t.link("kellyl", "kelly");
		assert.equal((await t.req("/api/unlink", { as: "kellyl", method: "POST" })).status, 200);
		assert.equal((await t.req("/api/inbox", { as: "kellyl" })).status, 409);
	} finally {
		await t.close();
	}
});
