/**
 * SPEC 4-5. Who sees what, and how the inbox is ordered.
 * Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly"), jorgeb ("jorge").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, ids } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
const MINE = "hyunhwan-bcm/tailjobs";
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function lab() {
	const t = await start();
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	t.github.teams.set("hwan", ["jeonglab-bcm/core"]);
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	return t;
}

test("4. a PR shows only to people whose own GitHub access covers its repo", async () => {
	const t = await lab();
	try {
		t.github.addPr({ repo: LAB, number: 1, author: "kelly" });
		t.github.addPr({ repo: MINE, number: 7, author: "hwan" });
		t.github.addPr({ repo: "jeonglab-bcm/private-grant", number: 2, author: "jorge" });
		await t.app.sync();
		const all = (x: Awaited<ReturnType<typeof t.inbox>>) => x.sections.flatMap((s) => s.prs.map((p) => `${p.repo}#${p.number}`)).sort();
		assert.deepEqual(all(await t.inbox("hyunhwanj")), [`${MINE}#7`, `${LAB}#1`]);
		assert.deepEqual(all(await t.inbox("kellyl")), [`${LAB}#1`]);
	} finally {
		await t.close();
	}
});

test("5. inbox sections and order, for hwan", async () => {
	const t = await lab();
	try {
		const g = t.github;
		// Needs you
		g.addPr({ repo: LAB, number: 1, author: "kelly", requestedReviewers: ["hwan"], updatedAt: ago(5) });
		g.addPr({ repo: LAB, number: 2, author: "kelly", requestedTeams: ["jeonglab-bcm/core"], updatedAt: ago(10) });
		g.addPr({ repo: LAB, number: 3, author: "hwan", reviewDecision: "APPROVED", checks: "success", updatedAt: ago(15) });
		g.addPr({ repo: MINE, number: 4, author: "hwan", reviewDecision: null, checks: "success", updatedAt: ago(1) }); // no review required
		g.addPr({ repo: LAB, number: 5, author: "hwan", reviewDecision: "CHANGES_REQUESTED", checks: "success", updatedAt: ago(20) });
		g.addPr({ repo: LAB, number: 6, author: "hwan", reviewDecision: "APPROVED", checks: "success", mergeable: "CONFLICTING", updatedAt: ago(25) });
		// WIP
		g.addPr({ repo: LAB, number: 7, author: "hwan", reviewDecision: "REVIEW_REQUIRED", checks: "success", updatedAt: ago(30) });
		g.addPr({ repo: LAB, number: 8, author: "hwan", reviewDecision: "APPROVED", checks: "pending", updatedAt: ago(2) });
		// CI failing: mine first, then others
		g.addPr({ repo: LAB, number: 9, author: "kelly", checks: "failure", updatedAt: ago(3) });
		g.addPr({ repo: LAB, number: 10, author: "hwan", checks: "failure", updatedAt: ago(40) });
		// Everything else
		g.addPr({ repo: LAB, number: 11, author: "jorge", updatedAt: ago(50) });
		g.addPr({ repo: LAB, number: 12, author: "kelly", checks: "success", draft: true, updatedAt: ago(45) });
		await t.app.sync();

		assert.deepEqual(ids(await t.inbox("hyunhwanj")), {
			needs_you: [`${MINE}#4`, `${LAB}#1`, `${LAB}#2`, `${LAB}#3`, `${LAB}#5`, `${LAB}#6`],
			waiting: [`${LAB}#8`, `${LAB}#7`],
			ci_failing: [`${LAB}#10`, `${LAB}#9`],
			everything_else: [`${LAB}#12`, `${LAB}#11`],
		});
		// kelly's view of the same lab repo: her PRs needing her, hwan's failing PR is just "CI failing"
		const k = ids(await t.inbox("kellyl"));
		assert.deepEqual(k.ci_failing, [`${LAB}#9`, `${LAB}#10`]);
		assert.ok(!Object.values(k).flat().some((id) => id.startsWith(MINE)));
	} finally {
		await t.close();
	}
});

test("5. each row carries what the list shows", async () => {
	const t = await lab();
	try {
		t.github.addPr({ repo: LAB, number: 1, author: "kelly", title: "Add email tools", draft: true, checks: "pending", reviewDecision: "REVIEW_REQUIRED" });
		await t.app.sync();
		const row = (await t.inbox("hyunhwanj")).sections.flatMap((s) => s.prs)[0] as Record<string, unknown>;
		for (const k of ["repo", "number", "title", "author", "url", "draft", "checks", "reviewDecision", "updatedAt"]) assert.ok(k in row, `row lacks ${k}`);
		assert.equal(row.title, "Add email tools");
		assert.equal(row.draft, true);
		assert.equal("size" in row, false, "a PR whose size is not known carries none");
		// the size comes with the sync and goes to the list as it is
		t.github.addPr({ repo: LAB, number: 1, author: "kelly", title: "Add email tools", size: { files: 3, lines: 1300, read: 55 } });
		await t.app.sync();
		const sized = (await t.inbox("hyunhwanj")).sections.flatMap((s) => s.prs)[0] as Record<string, unknown>;
		assert.deepEqual(sized.size, { files: 3, lines: 1300, read: 55 });
	} finally {
		await t.close();
	}
});
