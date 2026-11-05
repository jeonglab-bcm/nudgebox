/**
 * SPEC 15. Files of a PR and diffs of two file versions, through a stand-in for omnidiff.
 * Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
const MINE = "hyunhwan-bcm/tailjobs";

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly" });
	t.github.addPr({ repo: MINE, number: 7, author: "hwan" });
	t.github.prFileSets.set(`${LAB}#4`, {
		base: "base-sha", head: "head-sha",
		files: [
			{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
			{ path: "docs/new.md", status: "added", additions: 10, deletions: 0 },
			{ path: "src/b.ts", previous: "src/old-b.ts", status: "renamed", additions: 0, deletions: 0 },
		],
	});
	t.github.blobs.set(`${LAB}@base-sha:src/a.ts`, "const x = 1;\n");
	t.github.blobs.set(`${LAB}@head-sha:src/a.ts`, "const x = 2;\n");
	t.github.blobs.set(`${LAB}@head-sha:docs/new.md`, "# New\n");
	t.github.blobs.set(`${LAB}@head-sha:logo.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
	t.github.blobs.set(`${LAB}@head-sha:big.json`, "x".repeat(1_000_001));
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	return t;
}

const files = (t: Awaited<ReturnType<typeof setup>>, as: string, repo: string, n: number) =>
	t.req(`/api/prs/files?repo=${encodeURIComponent(repo)}&number=${n}`, { as });
const diff = (t: Awaited<ReturnType<typeof setup>>, as: string, before: object | null, after: object | null) =>
	t.req("/api/diff", { as, method: "POST", body: JSON.stringify({ before, after }) });

test("15. Files lists a PR's changed files against where its branch left the base", async () => {
	const t = await setup();
	try {
		const r = await files(t, "hyunhwanj", LAB, 4);
		assert.equal(r.status, 200);
		const body = await r.json();
		assert.deepEqual({ base: body.base, head: body.head }, { base: "base-sha", head: "head-sha" });
		assert.deepEqual(body.files.map((f: { path: string; status: string }) => `${f.status} ${f.path}`), ["modified src/a.ts", "added docs/new.md", "renamed src/b.ts"]);
		assert.equal(body.files[2].previous, "src/old-b.ts");
	} finally {
		await t.close();
	}
});

test("15. Files only for PRs you can see", async () => {
	const t = await setup();
	try {
		assert.equal((await files(t, "kellyl", MINE, 7)).status, 404);
		assert.equal((await files(t, "hyunhwanj", LAB, 999)).status, 404);
	} finally {
		await t.close();
	}
});

test("15. a diff runs on the two whole versions of a file, with their paths", async () => {
	const t = await setup();
	try {
		const r = await diff(t, "hyunhwanj", { repo: LAB, ref: "base-sha", path: "src/a.ts" }, { repo: LAB, ref: "head-sha", path: "src/a.ts" });
		assert.equal(r.status, 200);
		const body = await r.json();
		assert.deepEqual(t.differ.calls, [[{ path: "src/a.ts", text: "const x = 1;\n" }, { path: "src/a.ts", text: "const x = 2;\n" }]]);
		assert.equal(body.before.text, "const x = 1;\n");
		assert.equal(body.after.text, "const x = 2;\n");
		assert.ok(Array.isArray(body.result.after.hunks));
	} finally {
		await t.close();
	}
});

test("15. an added file is diffed against nothing", async () => {
	const t = await setup();
	try {
		const r = await diff(t, "hyunhwanj", null, { repo: LAB, ref: "head-sha", path: "docs/new.md" });
		assert.equal(r.status, 200);
		assert.deepEqual(t.differ.calls, [[null, { path: "docs/new.md", text: "# New\n" }]]);
		assert.equal((await r.json()).before, null);
	} finally {
		await t.close();
	}
});

test("15. text files over 1 MB are not diffed", async () => {
	const t = await setup();
	try {
		const big = await (await diff(t, "hyunhwanj", null, { repo: LAB, ref: "head-sha", path: "big.json" })).json();
		assert.equal(big.skipped, "too large");
		assert.equal(t.differ.calls.length, 0);
	} finally {
		await t.close();
	}
});

test("15. a binary pair is diffed by content: the differ gets the bytes, the page gets no text", async () => {
	const t = await setup();
	try {
		const png = (n: string) => readFileSync(`tests/fixtures/binary/${n}.png`);
		t.github.blobs.set(`${LAB}@base-sha:fig.png`, png("before"));
		t.github.blobs.set(`${LAB}@head-sha:fig.png`, png("after"));
		t.differ.reply = { largeResidual: false, binary: true, content: { kind: "picture" }, before: { hunks: [] }, after: { hunks: [] } } as never;
		const body = await (await diff(t, "hyunhwanj", { repo: LAB, ref: "base-sha", path: "fig.png" }, { repo: LAB, ref: "head-sha", path: "fig.png" })).json();
		const [[a, b]] = t.differ.calls;
		assert.ok(Buffer.isBuffer(a!.bytes) && a!.bytes.equals(png("before")), "before bytes");
		assert.ok(b!.bytes!.equals(png("after")), "after bytes");
		assert.equal(a!.text, undefined);
		assert.equal(body.result.content.kind, "picture");
		assert.equal(body.before.text, undefined);
		assert.equal(body.after.size, png("after").length);
	} finally {
		await t.close();
	}
});

test("15. binary files up to 10 MB are diffed; over 10 MB they are not", async () => {
	const t = await setup();
	try {
		const bin = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.alloc(n - 5, 7)]);
		t.github.blobs.set(`${LAB}@head-sha:scan.tif`, bin(5_000_000));
		t.github.blobs.set(`${LAB}@head-sha:huge.tif`, bin(10_000_001));
		assert.equal((await (await diff(t, "hyunhwanj", null, { repo: LAB, ref: "head-sha", path: "scan.tif" })).json()).skipped, undefined);
		assert.equal((await (await diff(t, "hyunhwanj", null, { repo: LAB, ref: "head-sha", path: "huge.tif" })).json()).skipped, "too large");
		assert.equal(t.differ.calls.length, 1);
	} finally {
		await t.close();
	}
});

const file = (t: Awaited<ReturnType<typeof setup>>, as: string, repo: string, ref: string, path: string) =>
	t.req(`/api/file?repo=${encodeURIComponent(repo)}&ref=${ref}&path=${encodeURIComponent(path)}`, { as });

test("15. the page gets a picture's or a PDF's bytes to draw, and nothing it could run", async () => {
	const t = await setup();
	try {
		t.github.blobs.set(`${LAB}@head-sha:fig.png`, readFileSync("tests/fixtures/binary/after.png"));
		t.github.blobs.set(`${LAB}@head-sha:doc.pdf`, readFileSync("tests/fixtures/binary/after.pdf"));
		t.github.blobs.set(`${LAB}@head-sha:page.html`, "<script>alert(1)</script>");
		const png = await file(t, "hyunhwanj", LAB, "head-sha", "fig.png");
		assert.equal(png.status, 200);
		assert.equal(png.headers.get("content-type"), "image/png");
		assert.equal(png.headers.get("x-content-type-options"), "nosniff");
		assert.match(png.headers.get("content-security-policy")!, /sandbox/);
		assert.ok(Buffer.from(await png.arrayBuffer()).equals(readFileSync("tests/fixtures/binary/after.png")));
		assert.equal((await file(t, "hyunhwanj", LAB, "head-sha", "doc.pdf")).headers.get("content-type"), "application/pdf");
		const html = await file(t, "hyunhwanj", LAB, "head-sha", "page.html");
		assert.equal(html.headers.get("content-type"), "application/octet-stream"); // by its bytes, never its name
		assert.match(html.headers.get("content-disposition")!, /attachment/);
	} finally {
		await t.close();
	}
});

test("15. file bytes only from repos you can see, and only files that exist", async () => {
	const t = await setup();
	try {
		t.github.blobs.set(`${MINE}@h:fig.png`, readFileSync("tests/fixtures/binary/after.png"));
		assert.equal((await file(t, "kellyl", MINE, "h", "fig.png")).status, 404);
		assert.equal((await file(t, "hyunhwanj", LAB, "head-sha", "nope.png")).status, 404);
	} finally {
		await t.close();
	}
});

test("15. a diff refuses repos you cannot see, and a missing file", async () => {
	const t = await setup();
	try {
		assert.equal((await diff(t, "kellyl", null, { repo: MINE, ref: "head-sha", path: "x.ts" })).status, 404);
		assert.equal((await diff(t, "hyunhwanj", null, { repo: LAB, ref: "head-sha", path: "nope.ts" })).status, 404);
		assert.equal((await diff(t, "hyunhwanj", null, null)).status, 400);
		assert.equal(t.differ.calls.length, 0);
	} finally {
		await t.close();
	}
});

test("15. the same two versions are diffed once", async () => {
	const t = await setup();
	try {
		const a = { repo: LAB, ref: "base-sha", path: "src/a.ts" };
		const b = { repo: LAB, ref: "head-sha", path: "src/a.ts" };
		await diff(t, "hyunhwanj", a, b);
		await diff(t, "kellyl", a, b);
		assert.equal(t.differ.calls.length, 1);
	} finally {
		await t.close();
	}
});
