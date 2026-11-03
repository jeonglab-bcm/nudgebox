/**
 * SPEC 3.1, 9. The public listener (webhook + static files, no sidecar in front) cannot
 * be used to act as a lab member, even with forged identity headers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { start, WEBHOOK_SECRET, ORIGIN } from "../helpers/harness.ts";
import { publicOnly } from "../../src/public.ts";

test("9. public port: only the webhook and static files; forged identity is ignored", async () => {
	const t = await start();
	const pub = createServer(publicOnly(t.app.handler));
	await new Promise<void>((r) => pub.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(pub.address() as AddressInfo).port}`;
	const forged = { "x-forwarded-email": "hyunhwanj@bcm.edu", "x-forwarded-preferred-username": "hyunhwanj", origin: ORIGIN, "content-type": "application/json" };
	try {
		t.github.grant("hwan", "jeonglab-bcm/labbot");
		await t.link("hyunhwanj", "hwan"); // a real linked account exists on the app side
		for (const [method, path] of [["GET", "/"], ["GET", "/api/inbox"], ["GET", "/auth/github"], ["POST", "/api/prs/merge"], ["POST", "/api/unlink"], ["GET", "/api/push/subscriptions"]]) {
			const r = await fetch(base + path, { method, headers: forged, body: method === "POST" ? "{}" : undefined, redirect: "manual" });
			assert.equal(r.status, 404, `${method} ${path}`);
		}
		assert.equal((await fetch(base + "/manifest.webmanifest")).status, 200);
		assert.equal((await fetch(base + "/sw.js")).status, 200);
		const body = JSON.stringify({ action: "opened", repository: { full_name: "jeonglab-bcm/labbot" }, pull_request: { number: 1 } });
		const sig = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
		const w = await fetch(base + "/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": sig } });
		assert.equal(w.status, 200);
		// still linked: nothing on the public port reached the account
		assert.equal((await t.req("/api/inbox", { as: "hyunhwanj" })).status, 200);
	} finally {
		pub.close();
		await t.close();
	}
});
