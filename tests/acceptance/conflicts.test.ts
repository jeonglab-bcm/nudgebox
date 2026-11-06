/**
 * SPEC 16. Resolving conflicts: the files whose changes overlap, with GitHub's markers, and
 * one merge commit on the PR's branch once each is resolved. Merging runs real
 * `git merge-file`. Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
const MINE = "hyunhwan-bcm/tailjobs";
const LIMIT = { mb: "export const limit = 10;\nexport const name = 'x';\n", hd: "export const limit = 20;\nexport const name = 'x';\n", bt: "export const limit = 15;\nexport const name = 'x';\n" };
const MARKED = "<<<<<<< feature\nexport const limit = 20;\n=======\nexport const limit = 15;\n>>>>>>> main\nexport const name = 'x';\n";
const README = { mb: "a\nb\nc\nd\ne\nf\ng\n", hd: "A\nb\nc\nd\ne\nf\ng\n", bt: "a\nb\nc\nd\ne\nf\nG\n" };

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", headSha: "hd", mergeable: "CONFLICTING" });
	t.github.addPr({ repo: MINE, number: 7, author: "hwan", mergeable: "CONFLICTING" });
	const m = (path: string, status: "modified" | "added" | "removed" | "renamed", previous?: string) =>
		({ path, status, additions: 1, deletions: 1, ...(previous ? { previous } : {}) });
	t.github.mergeSets.set(`${LAB}#4`, {
		headRepo: LAB, headRef: "feature", headSha: "hd", baseRef: "main", baseSha: "bt", mergeBase: "mb",
		headFiles: [m("src/limit.ts", "modified"), m("README.md", "modified"), m("src/new.ts", "added")],
		baseFiles: [m("src/limit.ts", "modified"), m("README.md", "modified"), m("docs/base-only.md", "added"), m("old.txt", "removed"), m("docs/b.md", "renamed", "docs/a.md")],
	});
	t.github.mergeSets.set(`${MINE}#7`, { ...t.github.mergeSets.get(`${LAB}#4`)!, headRepo: MINE });
	for (const [ref, k] of [["mb", "mb"], ["hd", "hd"], ["bt", "bt"]] as const) {
		t.github.blobs.set(`${LAB}@${ref}:src/limit.ts`, LIMIT[k]);
		t.github.blobs.set(`${LAB}@${ref}:README.md`, README[k]);
	}
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	const conflicts = (as: string, repo = LAB, n = 4) => t.req(`/api/prs/conflicts?repo=${encodeURIComponent(repo)}&number=${n}`, { as });
	const resolve = (as: string, body: object, repo = LAB, n = 4) =>
		t.req("/api/prs/resolve-conflicts", { as, method: "POST", body: JSON.stringify({ repo, number: n, ...body }) });
	const commits = () => t.github.calls.filter((c) => c.op === "commitMerge");
	return { t, conflicts, resolve, commits };
}

test("16. conflicts: each file whose changes overlap, with GitHub's markers named by branch", async () => {
	const { t, conflicts } = await setup();
	try {
		const r = await conflicts("hyunhwanj");
		assert.equal(r.status, 200);
		const c = await r.json();
		assert.deepEqual({ head: c.head, headRef: c.headRef, baseRef: c.baseRef }, { head: "hd", headRef: "feature", baseRef: "main" });
		assert.deepEqual(c.files, [{ path: "src/limit.ts", text: MARKED, conflicts: 1 }]); // README merges cleanly: not listed
		assert.deepEqual(c.unsupported, []);
	} finally {
		await t.close();
	}
});

test("16. Commit merge: one merge commit on the PR's branch, as the person", async () => {
	const { t, resolve, commits } = await setup();
	try {
		const r = await resolve("kellyl", { head: "hd", files: [{ path: "src/limit.ts", text: LIMIT.hd }] });
		assert.equal(r.status, 200, await r.clone().text());
		const [c] = commits();
		assert.ok(c.token!.endsWith(":kelly"));
		assert.equal(c.repo, LAB);
		assert.equal(c.args.branch, "feature");
		assert.equal(c.args.message, "Merge branch 'main' into feature");
		assert.deepEqual(c.args.parents, ["hd", "bt"]);
		assert.deepEqual(c.args.take.sort(), ["docs/b.md", "docs/base-only.md"]);
		assert.deepEqual(c.args.remove.sort(), ["docs/a.md", "old.txt"]);
		assert.deepEqual(c.args.write.sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)), [
			{ path: "README.md", text: "A\nb\nc\nd\ne\nf\nG\n" }, // both changed, apart: merged as git would
			{ path: "src/limit.ts", text: LIMIT.hd },
		]);
	} finally {
		await t.close();
	}
});

test("16. a file with markers left, a conflicting file left out, or an unknown file is refused", async () => {
	const { t, resolve, commits } = await setup();
	try {
		assert.equal((await resolve("kellyl", { head: "hd", files: [{ path: "src/limit.ts", text: MARKED }] })).status, 400);
		assert.equal((await resolve("kellyl", { head: "hd", files: [] })).status, 400);
		assert.equal((await resolve("kellyl", { head: "hd", files: [{ path: "src/limit.ts", text: LIMIT.hd }, { path: "src/other.ts", text: "x" }] })).status, 400);
		assert.equal(commits().length, 0);
	} finally {
		await t.close();
	}
});

test("16. if the branch moved while resolving, nothing is committed", async () => {
	const { t, resolve, commits } = await setup();
	try {
		const r = await resolve("kellyl", { head: "older", files: [{ path: "src/limit.ts", text: LIMIT.hd }] });
		assert.equal(r.status, 409);
		assert.match((await r.json()).error, /reload/i);
		assert.equal(commits().length, 0);
	} finally {
		await t.close();
	}
});

test("16. conflicts the editor cannot show are listed, and block Commit merge", async () => {
	const { t, conflicts, resolve, commits } = await setup();
	try {
		const m = t.github.mergeSets.get(`${LAB}#4`)!;
		m.headFiles.push({ path: "src/gone.ts", status: "modified", additions: 1, deletions: 0 }, { path: "fig.png", status: "modified", additions: 0, deletions: 0 });
		m.baseFiles.push({ path: "src/gone.ts", status: "removed", additions: 0, deletions: 4 }, { path: "fig.png", status: "modified", additions: 0, deletions: 0 });
		for (const ref of ["mb", "hd", "bt"]) t.github.blobs.set(`${LAB}@${ref}:fig.png`, Buffer.from([0x89, 0x50, 0, ref.charCodeAt(0)]));
		const c = await (await conflicts("hyunhwanj")).json();
		assert.deepEqual(c.unsupported.map((u: { path: string }) => u.path).sort(), ["fig.png", "src/gone.ts"]);
		assert.match(c.unsupported.find((u: { path: string }) => u.path === "src/gone.ts").why, /deleted/);
		assert.match(c.unsupported.find((u: { path: string }) => u.path === "fig.png").why, /binary/);
		const r = await resolve("kellyl", { head: "hd", files: [{ path: "src/limit.ts", text: LIMIT.hd }] });
		assert.equal(r.status, 409);
		assert.match((await r.json()).error, /command line/);
		assert.equal(commits().length, 0);
	} finally {
		await t.close();
	}
});

test("16. conflicts only for PRs you can see", async () => {
	const { t, conflicts, resolve, commits } = await setup();
	try {
		assert.equal((await conflicts("kellyl", MINE, 7)).status, 404);
		assert.equal((await resolve("kellyl", { head: "hd", files: [] }, MINE, 7)).status, 404);
		assert.equal(commits().length, 0);
	} finally {
		await t.close();
	}
});
