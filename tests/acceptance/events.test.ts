/**
 * SPEC 7 + 18. The desktop app's live stream: GET /api/events sends each of your
 * notifications to your open Nudgebox desktop apps, as Server-Sent Events, alongside
 * web push. Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
type T = Awaited<ReturnType<typeof start>>;
type Ev = { event: string; data: any };

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.grant("kelly", LAB);
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	return t;
}

/** Opens the stream as `as`; `next()` waits for the next event (or fails after `ms`). */
async function listen(t: T, as: string) {
	const ac = new AbortController();
	const r = await t.req("/api/events", { as, headers: { accept: "text/event-stream" }, signal: ac.signal });
	const events: Ev[] = [];
	const waiters: (() => void)[] = [];
	if (r.status === 200) (async () => {
		const dec = new TextDecoder();
		let buf = "";
		try {
			for await (const chunk of r.body!) {
				buf += dec.decode(chunk, { stream: true });
				let i;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const block = buf.slice(0, i);
					buf = buf.slice(i + 2);
					const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
					const data = /^data: (.*)$/m.exec(block)?.[1];
					if (data === undefined) continue; // a heartbeat comment
					events.push({ event, data: JSON.parse(data) });
					waiters.splice(0).forEach((w) => w());
				}
			}
		} catch {}
	})();
	let read = 0;
	async function next(ms = 2000): Promise<Ev> {
		const deadline = Date.now() + ms;
		while (read >= events.length) {
			if (Date.now() > deadline) throw new Error(`no event for ${as} within ${ms} ms`);
			await new Promise<void>((res) => { waiters.push(res); setTimeout(res, 50); });
		}
		return events[read++];
	}
	return { status: r.status, type: r.headers.get("content-type"), events, next, close: () => ac.abort() };
}

const reviewRequested = (t: T, n: number) => {
	t.github.addPr({ repo: LAB, number: n, author: "kelly", requestedReviewers: ["hwan"] });
	return t.webhook("pull_request", {
		action: "review_requested",
		number: n,
		pull_request: { number: n, title: `PR ${n}`, html_url: `https://github.com/${LAB}/pull/${n}`, user: { login: "kelly" }, head: { sha: `sha-${n}` } },
		repository: { full_name: LAB },
		requested_reviewer: { login: "hwan" },
	});
};

test("18. the stream starts with a hello naming this app, and is an event stream", async () => {
	const t = await setup();
	try {
		const s = await listen(t, "hyunhwanj");
		assert.equal(s.status, 200);
		assert.match(s.type ?? "", /text\/event-stream/);
		const hello = await s.next();
		assert.equal(hello.event, "hello");
		assert.match(hello.data.client, /^[\w-]{8,}$/);
		s.close();
	} finally {
		await t.close();
	}
});

test("18. without the lab sign-in there is no stream", async () => {
	const t = await setup();
	try {
		assert.equal((await t.req("/api/events", { headers: { accept: "text/event-stream" } })).status, 401);
	} finally {
		await t.close();
	}
});

test("7 + 18. a notification reaches your desktop apps, and web push still goes out", async () => {
	const t = await setup();
	try {
		await t.subscribe("hyunhwanj", "https://web.push.apple.com/hwan-iphone");
		const a = await listen(t, "hyunhwanj");
		const b = await listen(t, "hyunhwanj"); // a second desktop
		await a.next();
		await b.next();
		await reviewRequested(t, 4);
		await t.app.idle();
		for (const s of [a, b]) {
			const e = await s.next();
			assert.equal(e.event, "notify");
			assert.match(e.data.title, /review/i);
			assert.match(e.data.body, /labbot#4/);
			assert.equal(e.data.url, `https://github.com/${LAB}/pull/4`);
			assert.equal(e.data.badge, 1); // counted once per person, not per app
		}
		assert.deepEqual(t.pushed.map((p) => p.endpoint), ["https://web.push.apple.com/hwan-iphone"]);
		a.close();
		b.close();
	} finally {
		await t.close();
	}
});

test("7 + 18. a desktop app alone is enough: no web push device needed", async () => {
	const t = await setup();
	try {
		const a = await listen(t, "hyunhwanj");
		await a.next();
		await reviewRequested(t, 5);
		await t.app.idle();
		assert.equal((await a.next()).event, "notify");
		assert.equal(t.pushed.length, 0);
		a.close();
	} finally {
		await t.close();
	}
});

test("18. nobody else's notifications reach your app", async () => {
	const t = await setup();
	try {
		const kelly = await listen(t, "kellyl");
		await kelly.next();
		await reviewRequested(t, 6); // for hwan
		await t.app.idle();
		await assert.rejects(kelly.next(300));
		kelly.close();
	} finally {
		await t.close();
	}
});

test("14 + 18. Send a test reaches this app only, and does not count as unread", async () => {
	const t = await setup();
	try {
		await t.subscribe("hyunhwanj", "https://web.push.apple.com/hwan-iphone");
		const a = await listen(t, "hyunhwanj");
		const b = await listen(t, "hyunhwanj");
		const { client } = (await a.next()).data;
		await b.next();
		const r = await t.req("/api/events/test", { as: "hyunhwanj", method: "POST", body: JSON.stringify({ client }) });
		assert.equal(r.status, 200);
		const e = await a.next();
		assert.equal(e.event, "notify");
		assert.match(e.data.title, /test/i);
		assert.equal((await r.json()).id, e.data.test);
		await assert.rejects(b.next(300));
		assert.equal(t.pushed.length, 0);
		await reviewRequested(t, 7);
		await t.app.idle();
		assert.equal((await a.next()).data.badge, 1); // the test did not count
		a.close();
		b.close();
	} finally {
		await t.close();
	}
});

test("14 + 18. Send a test refuses an app that is not yours", async () => {
	const t = await setup();
	try {
		const kelly = await listen(t, "kellyl");
		const { client } = (await kelly.next()).data;
		const r = await t.req("/api/events/test", { as: "hyunhwanj", method: "POST", body: JSON.stringify({ client }) });
		assert.equal(r.status, 404);
		await assert.rejects(kelly.next(300));
		kelly.close();
	} finally {
		await t.close();
	}
});

test("18. a closed app is forgotten and nothing breaks", async () => {
	const t = await setup();
	try {
		const a = await listen(t, "hyunhwanj");
		const { client } = (await a.next()).data;
		a.close();
		await new Promise((r) => setTimeout(r, 100));
		await reviewRequested(t, 8);
		assert.equal((await t.webhook("ping", {})).status, 200);
		await t.app.idle();
		const r = await t.req("/api/events/test", { as: "hyunhwanj", method: "POST", body: JSON.stringify({ client }) });
		assert.equal(r.status, 404);
	} finally {
		await t.close();
	}
});
