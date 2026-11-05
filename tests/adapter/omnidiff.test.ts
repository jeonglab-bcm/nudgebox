/**
 * SPEC 15. The real omnidiff (bin/omnidiff, from scripts/get-omnidiff.sh): its JSON turned
 * into ranges a page can use (rows and UTF-16 columns), moves with their target.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createOmnidiff } from "../../src/omnidiff.ts";

const BIN = process.env.OMNIDIFF_BIN ?? "bin/omnidiff";
if (!existsSync(BIN)) throw new Error(`${BIN} is missing: run scripts/get-omnidiff.sh`);
const diff = createOmnidiff(BIN);

/** The text a range covers, as a page would cut it out (one row ranges only). */
const cut = (text: string, h: { from: { row: number; col: number }; to: { row: number; col: number } }) =>
	text.split("\n")[h.from.row].slice(h.from.col, h.to.col);

test("15. changed parts come back as rows and UTF-16 columns, also after non-ASCII text", async () => {
	const before = "const name = \"café\"; const n = 1;\n";
	const after = "const name = \"café\"; const n = 2;\n";
	const r = await diff({ path: "a.ts", text: before }, { path: "a.ts", text: after });
	const changed = r.after.hunks.filter((h) => h.op !== "move");
	assert.ok(changed.length > 0, JSON.stringify(r));
	assert.ok(changed.some((h) => cut(after, h) === "2"), JSON.stringify(changed));
	assert.ok(r.before.hunks.some((h) => cut(before, h) === "1"), JSON.stringify(r.before.hunks));
});

test("15. moved code carries where it moved to", async () => {
	const before = "def a():\n    return 1\n\ndef b():\n    return 2\n";
	const after = "def b():\n    return 2\n\ndef a():\n    return 1\n";
	const r = await diff({ path: "m.py", text: before }, { path: "m.py", text: after });
	const moves = [...r.before.hunks, ...r.after.hunks].filter((h) => h.op === "move");
	assert.ok(moves.length > 0 && moves.every((m) => m.target && typeof m.target.from.row === "number"), JSON.stringify(r));
});

test("15. a new file is diffed against nothing and named as new", async () => {
	const r = await diff(null, { path: "n.md", text: "# Title\n\nText.\n" });
	assert.equal(r.summary, "new_file");
	assert.equal(r.before.hunks.length, 0);
});

test("15. the language comes from the file name", async () => {
	const r = await diff({ path: "x.py", text: "a = 1\n" }, { path: "x.py", text: "a = 2\n" });
	assert.equal(r.language, "Python");
});

const fixture = (name: string) => readFileSync(`tests/fixtures/binary/${name}`);

test("15. two pictures: a content diff with the changed areas", async () => {
	const r = await diff({ path: "fig.png", bytes: fixture("before.png") }, { path: "fig.png", bytes: fixture("after.png") });
	assert.equal(r.binary, true);
	const c = r.content as { kind: string; comparison: { kind: string; regions: unknown[] }; after: { width: number } };
	assert.equal(c.kind, "picture");
	assert.equal(c.comparison.kind, "pixels");
	assert.equal(c.comparison.regions.length, 2);
	assert.equal(c.after.width, 400);
});

test("15. two archives: the files inside that changed, were added or removed", async () => {
	const r = await diff({ path: "a.zip", bytes: fixture("before.zip") }, { path: "a.zip", bytes: fixture("after.zip") });
	const c = r.content as { kind: string; family: string; members: { key: string; status: string }[] };
	assert.deepEqual([c.kind, c.family], ["container", "archives"]);
	assert.deepEqual(c.members.map((m) => `${m.status} ${m.key}`).sort(), ["added data/new.csv", "changed README.txt", "changed fig.png"]);
});

test("15. two PDFs: pages that changed, as pictures with their changed areas", async () => {
	const r = await diff({ path: "d.pdf", bytes: fixture("before.pdf") }, { path: "d.pdf", bytes: fixture("after.pdf") });
	const c = r.content as { family: string; members: { key: string; status: string; detail?: { kind: string; comparison: { regions: unknown[] } } }[] };
	assert.equal(c.family, "documents");
	const page = c.members.find((m) => m.key === "page 1")!;
	assert.equal(page.status, "changed");
	assert.equal(page.detail!.kind, "picture");
	assert.ok(page.detail!.comparison.regions.length >= 2);
});
