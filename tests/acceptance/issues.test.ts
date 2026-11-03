/**
 * SPEC 11. Issues: all open issues you can see, read-only, with Hide/Old like PRs, and
 * push when you are assigned, @mentioned, or someone comments on your issue.
 * Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/AURORA";
const MINE = "hyunhwan-bcm/tailjobs";
const DAY = 24 * 3600_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const key = (xs: { repo: string; number: number }[]) => xs.map((x) => `${x.repo}#${x.number}`);

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.subscribe("hyunhwanj", "https://push.example/hwan");
	await t.subscribe("kellyl", "https://push.example/kelly");
	return t;
}

const issueEvent = (action: string, n: number, sender: string, extra: object = {}) => ({
	action,
	issue: { number: n, title: `Issue ${n}`, html_url: `https://github.com/${LAB}/issues/${n}`, user: { login: "kelly" } },
	repository: { full_name: LAB },
	sender: { login: sender },
	...extra,
});
const commentEvent = (n: number, sender: string, body: string) =>
	issueEvent("created", n, sender, { comment: { body, user: { login: sender }, html_url: `https://github.com/${LAB}/issues/${n}#c1` } });
const to = (t: Awaited<ReturnType<typeof setup>>, who: string) => t.pushed.filter((p) => p.endpoint.endsWith(who));

test("11. the Issues list: open issues you can see, newest first, no PRs", async () => {
	const t = await setup();
	try {
		t.github.addIssue({ repo: LAB, number: 80, author: "kelly", updatedAt: ago(3) });
		t.github.addIssue({ repo: LAB, number: 81, author: "hwan", updatedAt: ago(1) });
		t.github.addIssue({ repo: MINE, number: 5, author: "hwan", updatedAt: ago(2) });
		t.github.addIssue({ repo: LAB, number: 70, author: "kelly", updatedAt: ago(45) }); // old
		t.github.addPr({ repo: LAB, number: 74, author: "kelly" });
		await t.app.sync();
		const h = await t.issues("hyunhwanj");
		assert.deepEqual(key(h.items), [`${LAB}#81`, `${MINE}#5`, `${LAB}#80`]);
		assert.deepEqual(key(h.old), [`${LAB}#70`]);
		assert.deepEqual(key((await t.issues("kellyl")).items), [`${LAB}#81`, `${LAB}#80`]);
		const row = h.items[0] as Record<string, unknown>;
		for (const k of ["repo", "number", "title", "url", "author", "assignees", "labels", "comments", "updatedAt"]) assert.ok(k in row, `row lacks ${k}`);
	} finally {
		await t.close();
	}
});

test("11. issues are read-only", async () => {
	const t = await setup();
	try {
		t.github.addIssue({ repo: LAB, number: 80, author: "kelly" });
		await t.app.sync();
		for (const a of ["close", "comment", "assign", "label", "reopen"]) {
			const r = await t.req(`/api/issues/${a}`, { as: "hyunhwanj", method: "POST", body: JSON.stringify({ repo: LAB, number: 80, body: "x" }) });
			assert.equal(r.status, 404, a);
		}
		assert.equal(t.github.calls.filter((c) => c.token).length, 0);
	} finally {
		await t.close();
	}
});

test("11. Hide works for issues and lifts on new activity", async () => {
	const t = await setup();
	try {
		const i = t.github.addIssue({ repo: LAB, number: 80, author: "kelly", updatedAt: ago(1) });
		await t.app.sync();
		assert.equal((await t.hide("hyunhwanj", "issue", LAB, 80)).status, 200);
		assert.deepEqual(key((await t.issues("hyunhwanj")).hidden), [`${LAB}#80`]);
		i.updatedAt = new Date(Date.now() + 1000).toISOString();
		await t.webhook("issue_comment", commentEvent(80, "kelly", "any update?"));
		await t.app.idle();
		assert.deepEqual(key((await t.issues("hyunhwanj")).items), [`${LAB}#80`]);
	} finally {
		await t.close();
	}
});

test("11. webhooks keep the list current; the sync catches misses", async () => {
	const t = await setup();
	try {
		await t.app.sync();
		t.github.addIssue({ repo: LAB, number: 82, author: "kelly" });
		await t.webhook("issues", issueEvent("opened", 82, "kelly"));
		await t.app.idle();
		assert.deepEqual(key((await t.issues("hyunhwanj")).items), [`${LAB}#82`]);
		t.github.issues.delete(`${LAB}#82`);
		await t.webhook("issues", issueEvent("closed", 82, "kelly"));
		await t.app.idle();
		assert.deepEqual((await t.issues("hyunhwanj")).items, []);

		t.github.addIssue({ repo: LAB, number: 83, author: "kelly" }); // webhook lost
		await t.app.sync();
		assert.deepEqual(key((await t.issues("hyunhwanj")).items), [`${LAB}#83`]);
	} finally {
		await t.close();
	}
});

test("11.1 push when an issue is assigned to you, not when you assign yourself", async () => {
	const t = await setup();
	try {
		t.github.addIssue({ repo: LAB, number: 84, author: "kelly", assignees: ["hwan"] });
		await t.webhook("issues", issueEvent("assigned", 84, "kelly", { assignee: { login: "hwan" } }));
		await t.app.idle();
		assert.equal(to(t, "hwan").length, 1);
		assert.match(to(t, "hwan")[0].payload.title, /assigned/i);
		assert.match(to(t, "hwan")[0].payload.body, /AURORA#84/);

		t.github.addIssue({ repo: LAB, number: 85, author: "kelly", assignees: ["hwan"] });
		await t.webhook("issues", issueEvent("assigned", 85, "hwan", { assignee: { login: "hwan" } }));
		await t.app.idle();
		assert.equal(to(t, "hwan").length, 1, "assigning yourself must not notify you");
	} finally {
		await t.close();
	}
});

test("11.2 push on an @mention in a new issue or a comment, only to people who can see it", async () => {
	const t = await setup();
	try {
		t.github.grant("jorge", "jeonglab-bcm/other"); // linked but cannot see AURORA
		await t.link("jorgeb", "jorge");
		await t.subscribe("jorgeb", "https://push.example/jorge");
		t.github.addIssue({ repo: LAB, number: 86, author: "kelly" });
		await t.webhook("issues", issueEvent("opened", 86, "kelly", { issue: { number: 86, title: "ROI export", body: "cc @hwan @jorge please look", user: { login: "kelly" } } }));
		await t.app.idle();
		assert.equal(to(t, "hwan").length, 1);
		assert.match(to(t, "hwan")[0].payload.title, /mention/i);
		assert.equal(to(t, "jorge").length, 0);

		await t.webhook("issue_comment", commentEvent(86, "kelly", "@HWAN ping"));
		await t.app.idle();
		assert.equal(to(t, "hwan").length, 2, "mentions are case-insensitive");
		await t.webhook("issue_comment", commentEvent(86, "kelly", "mail hwan@bcm.edu, not a mention"));
		await t.app.idle();
		assert.equal(to(t, "hwan").length, 2);
	} finally {
		await t.close();
	}
});

test("11.3 push on a new comment on an issue you opened or are assigned to, never your own", async () => {
	const t = await setup();
	try {
		t.github.addIssue({ repo: LAB, number: 87, author: "kelly", assignees: ["hwan"] });
		await t.webhook("issue_comment", commentEvent(87, "kelly", "pushed a fix"));
		await t.app.idle();
		assert.equal(to(t, "hwan").length, 1, "assignee hears about the comment");
		assert.equal(to(t, "kelly").length, 0, "the commenter does not");

		await t.webhook("issue_comment", commentEvent(87, "hwan", "thanks"));
		await t.app.idle();
		assert.equal(to(t, "kelly").length, 1, "the author hears about it");
		assert.equal(to(t, "hwan").length, 1, "not about your own comment");

		await t.webhook("issue_comment", commentEvent(87, "kelly", "@hwan one more thing"));
		await t.app.idle();
		assert.equal(to(t, "hwan").length, 2, "mention + comment on assigned issue = one push");
	} finally {
		await t.close();
	}
});

test("11. hidden or old issues send no push; other accounts are ignored", async () => {
	const t = await setup();
	try {
		t.github.addIssue({ repo: LAB, number: 88, author: "kelly", assignees: ["hwan"], updatedAt: ago(1) });
		t.github.addIssue({ repo: LAB, number: 89, author: "kelly", assignees: ["hwan"], updatedAt: ago(40) });
		await t.app.sync();
		await t.hide("hyunhwanj", "issue", LAB, 88);
		await t.webhook("issues", issueEvent("assigned", 88, "kelly", { assignee: { login: "hwan" } }));
		await t.webhook("issues", issueEvent("assigned", 89, "kelly", { assignee: { login: "hwan" } }));
		t.github.grant("hwan", "stranger/repo");
		t.github.addIssue({ repo: "stranger/repo", number: 1, author: "x", assignees: ["hwan"] });
		await t.webhook("issues", { ...issueEvent("assigned", 1, "x", { assignee: { login: "hwan" } }), repository: { full_name: "stranger/repo" } });
		await t.app.idle();
		assert.deepEqual(t.pushed, []);
		assert.ok(!key((await t.issues("hyunhwanj")).items).includes("stranger/repo#1"));
	} finally {
		await t.close();
	}
});
