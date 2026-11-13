/**
 * SPEC 16. Fix with Claude: a PR's conflicts are handed to Claude with a comment, as the
 * person, that the repository's workflow answers. Nothing is posted where nobody would
 * answer. Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
const MINE = "hyunhwan-bcm/tailjobs";
const WORKFLOW = ".github/workflows/claude-fix-conflicts.yml";
const NOW = new Date("2026-11-12T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

async function setup() {
	const t = await start({ now: () => NOW });
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", headSha: "hd", mergeable: "CONFLICTING", updatedAt: ago(60) });
	t.github.addPr({ repo: LAB, number: 5, author: "kelly", updatedAt: ago(60) });
	t.github.addPr({ repo: MINE, number: 7, author: "hwan", mergeable: "CONFLICTING", updatedAt: ago(60) });
	t.github.pages.set(`${LAB}#4`, { baseRef: "develop", mergeState: "DIRTY" });
	t.github.blobs.set(`${LAB}@HEAD:${WORKFLOW}`, "name: Claude fixes conflicts\n");
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	const ask = (as: string, repo = LAB, n = 4) => t.req("/api/prs/ask-claude", { as, method: "POST", body: JSON.stringify({ repo, number: n }) });
	const comments = () => t.github.calls.filter((c) => c.op === "comment");
	return { t, ask, comments };
}

test("16. Fix with Claude: one comment on the PR, as the person, naming the base branch", async () => {
	const { t, ask, comments } = await setup();
	try {
		const r = await ask("kellyl");
		assert.equal(r.status, 200, await r.clone().text());
		const [c] = comments();
		assert.ok(c.token!.endsWith(":kelly"));
		assert.deepEqual({ repo: c.repo, number: c.number }, { repo: LAB, number: 4 });
		assert.equal(c.body, "@claude fix the merge conflicts with `develop`");
		assert.equal(comments().length, 1);
	} finally {
		await t.close();
	}
});

test("16. Fix with Claude: nothing is posted for a PR without conflicts, a repository without the workflow, or a fork's branch", async () => {
	const { t, ask, comments } = await setup();
	try {
		const clean = await ask("hyunhwanj", LAB, 5);
		assert.equal(clean.status, 409);
		assert.match((await clean.json()).error, /no conflicts/);

		const bare = await ask("hyunhwanj", MINE, 7);
		assert.equal(bare.status, 409);
		assert.match((await bare.json()).error, /Claude is not set up in hyunhwan-bcm\/tailjobs/);

		t.github.pages.set(`${LAB}#4`, { mergeState: "DIRTY", headRepo: "kelly/labbot" });
		const fork = await ask("hyunhwanj");
		assert.equal(fork.status, 409);
		assert.match((await fork.json()).error, /fork/);

		assert.equal((await ask("kellyl", MINE, 7)).status, 404); // not hers to see
		assert.equal(comments().length, 0);
	} finally {
		await t.close();
	}
});

test("16. Fix with Claude: not asked twice while Claude is at it; again once it has answered", async () => {
	const { t, ask, comments } = await setup();
	try {
		const asked = { type: "comment" as const, id: "c1", author: "kelly", body: "@claude fix the merge conflicts with `main`", at: ago(3) };
		t.github.pages.set(`${LAB}#4`, { mergeState: "DIRTY", timeline: [asked] });
		const again = await ask("hyunhwanj");
		assert.equal(again.status, 409);
		assert.match((await again.json()).error, /already/);
		assert.equal(comments().length, 0);

		// Claude said it could not: asking again is fine
		t.github.pages.set(`${LAB}#4`, { mergeState: "DIRTY", timeline: [asked, { type: "comment", id: "c2", author: "github-actions", body: "Claude could not fix the conflicts.", at: ago(1) }] });
		assert.equal((await ask("hyunhwanj")).status, 200);

		// an old request nobody answered does not block either
		t.github.pages.set(`${LAB}#4`, { mergeState: "DIRTY", timeline: [{ ...asked, at: ago(40) }] });
		assert.equal((await ask("hyunhwanj")).status, 200);
		assert.equal(comments().length, 2);
	} finally {
		await t.close();
	}
});
