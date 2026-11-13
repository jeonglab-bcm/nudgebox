/**
 * SPEC 16. The PR page in a real browser: GitHub's layout and buttons, omnidiff for the
 * diffs. omnidiff is stood in for by the harness's differ; conflicts merge with real
 * `git merge-file`. Lab user hyunhwanj is GitHub "hwan".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContextOptions, Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import type { PrPage } from "../../src/github.ts";
import { sidecar, browser, closeBrowser, DESKTOP, PHONE } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
const PR = `#pr/${LAB}/4`;
after(closeBrowser);

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";
const BEFORE = lines(30, (i) => (i === 14 ? "const limit = 10;" : `line ${i + 1}`));
const AFTER = lines(30, (i) => (i === 14 ? "const limit = 20;" : `line ${i + 1}`));
const at = (row: number, a: number, b: number) => ({ from: { row, col: a }, to: { row, col: b } });
const LIMIT = { mb: "export const limit = 10;\nexport const name = 'x';\n", hd: "export const limit = 20;\nexport const name = 'x';\n", bt: "export const limit = 15;\nexport const name = 'x';\n" };

async function open(o: { device?: BrowserContextOptions; page?: Partial<PrPage>; author?: string; hash?: string } = {}) {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: o.author ?? "kelly", title: "Raise the limit", requestedReviewers: ["hwan"], checks: "failure", headSha: "head-sha" });
	t.github.pages.set(`${LAB}#4`, {
		body: "Raises the **limit**.\n\n<script>window.pwned = 1</script><img src=x onerror=\"window.pwned = 2\">",
		baseRef: "main", headRef: "feature", commits: 1, additions: 4, deletions: 1, changedFiles: 3,
		timeline: [
			{ type: "commit", sha: "c0ffee1234", message: "Raise the limit", author: "kelly", at: "2026-11-02T09:00:00Z" },
			{ type: "comment", id: "c1", author: "hwan", body: "Why 20?", at: "2026-11-02T10:00:00Z" },
			{ type: "review", id: "r1", author: "jlee", state: "COMMENTED", body: "One note.", at: "2026-11-02T11:00:00Z" },
		],
		threads: [{
			id: "t1", path: "src/limit.ts", line: 15, startLine: null, side: "RIGHT", resolved: false, outdated: false, reviewId: "r1",
			diffHunk: "@@ -12,7 +12,7 @@\n line 12\n-const limit = 10;\n+const limit = 20;",
			comments: [{ id: "tc1", author: "jlee", body: "Make it a setting.", at: "2026-11-02T11:00:00Z", pending: false }],
		}],
		checks: [
			{ name: "test", workflow: "CI", state: "failed", startedAt: "2026-11-02T09:01:00Z", completedAt: "2026-11-02T09:03:00Z", url: "https://github.com/jeonglab-bcm/labbot/actions/runs/1" },
			{ name: "lint", workflow: "CI", state: "passed", url: "https://github.com/jeonglab-bcm/labbot/actions/runs/2" },
		],
		viewed: { "docs/new.md": "VIEWED" },
		...o.page,
	});
	t.github.options.set(LAB, { assignable: ["hwan", "kelly", "jlee"], labels: [{ name: "bug", color: "d73a4a", description: "" }], milestones: [{ number: 2, title: "v1.0" }] });
	t.github.prFileSets.set(`${LAB}#4`, {
		base: "base-sha", head: "head-sha",
		files: [
			{ path: "src/limit.ts", status: "modified", additions: 1, deletions: 1, commentable: { left: [[12, 18]], right: [[13, 16]] } },
			{ path: "assets/logo.png", status: "modified", additions: 0, deletions: 0 },
			{ path: "docs/new.md", status: "added", additions: 3, deletions: 0, commentable: { left: [], right: [[1, 3]] } },
		],
	});
	t.github.commits.set(`${LAB}#4`, [{ sha: "c0ffee1234", message: "Raise the limit", author: "kelly", at: "2026-11-02T09:00:00Z" }]);
	t.github.commitFileSets.set(`${LAB}@c0ffee1234`, { base: "parent-sha", head: "c0ffee1234", files: [{ path: "src/limit.ts", status: "modified", additions: 1, deletions: 1 }] });
	t.github.blobs.set(`${LAB}@parent-sha:src/limit.ts`, BEFORE);
	t.github.blobs.set(`${LAB}@c0ffee1234:src/limit.ts`, AFTER);
	t.github.blobs.set(`${LAB}@base-sha:src/limit.ts`, BEFORE);
	t.github.blobs.set(`${LAB}@head-sha:src/limit.ts`, AFTER);
	t.differ.reply = { largeResidual: false, before: { hunks: [{ op: "update", ...at(14, 14, 16) }] }, after: { hunks: [{ op: "update", ...at(14, 14, 16) }] } };
	await t.link("hyunhwanj", "hwan");
	await t.app.sync();
	const side = await sidecar(t.base, "hyunhwanj");
	const ctx = await (await browser()).newContext(o.device ?? DESKTOP);
	await ctx.route("https://github.com/**", (r) => r.fulfill({ body: "github" }));
	const page = await ctx.newPage();
	await page.goto(side.url + (o.hash ?? PR));
	await page.waitForSelector(o.hash ? ".row, #pr-page" : "#pr-page .pr-head");
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	const calls = (op: string) => t.github.calls.filter((c) => c.op === op);
	return { t, ctx, page, close, calls };
}

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const until = async (f: () => boolean, what: string) => {
	for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 30));
	assert.ok(f(), `timed out waiting for ${what}`);
};

test("16. Enter opens the PR page: header, tabs with counts, sidebar; Escape returns", async () => {
	const s = await open({ hash: "#" });
	try {
		await s.page.keyboard.press("Enter");
		await s.page.waitForSelector("#pr-page .pr-head");
		assert.match(s.page.url(), /#pr\/jeonglab-bcm\/labbot\/4$/);
		assert.match((await s.page.locator(".pr-head h1").textContent())!, /Raise the limit.*#4/);
		assert.equal(await s.page.locator(".state-badge").textContent(), "Open");
		assert.match((await s.page.locator(".pr-meta").textContent())!, /kelly wants to merge 1 commit into main from feature/);
		assert.deepEqual(await s.page.locator(".pr-tabs a").allTextContents(), ["Conversation2", "Commits1", "Checks2", "Files changed3", "Guided review"]);
		assert.deepEqual(await s.page.locator(".sidebar h3").allTextContents(), ["Reviewers", "Assignees", "Labels", "Milestone"]);
		assert.match((await s.page.locator(".side-reviewers").textContent())!, /hwan/);
		await s.page.keyboard.press("Escape");
		await s.page.waitForSelector(".row");
	} finally {
		await s.close();
	}
});

test("16. Conversation: the description rendered and cleaned, then the timeline in order", async () => {
	const s = await open();
	try {
		await s.page.waitForSelector(".tl[data-type=description] .comment-body strong");
		assert.deepEqual(await s.page.locator(".timeline > .tl").evaluateAll((xs) => xs.map((x) => x.getAttribute("data-type"))),
			["description", "commit", "comment", "review"]);
		assert.equal(await s.page.locator(".tl[data-type=description] .comment-body strong").textContent(), "limit");
		assert.equal(await s.page.locator(".comment-body script").count(), 0);
		assert.equal(await s.page.evaluate(() => (window as { pwned?: number }).pwned), undefined);
		assert.match((await s.page.locator(".tl[data-type=review]").textContent())!, /jlee.*commented/);
		const thread = s.page.locator(".tl[data-type=review] .thread");
		assert.equal(await thread.locator(".thread-path").textContent(), "src/limit.ts");
		assert.match((await thread.textContent())!, /Make it a setting\./);
	} finally {
		await s.close();
	}
});

test("16. a thread: Reply and Resolve conversation, as the person", async () => {
	const s = await open();
	try {
		const thread = s.page.locator(".tl[data-type=review] .thread");
		await thread.locator("textarea.reply").fill("Done in the next commit.");
		await thread.getByRole("button", { name: "Reply", exact: true }).click();
		await until(() => s.calls("replyToThread").length === 1, "reply");
		assert.equal(s.calls("replyToThread")[0].body, "Done in the next commit.");
		await thread.getByRole("button", { name: "Resolve conversation" }).click();
		await until(() => s.calls("setThreadResolved").length === 1, "resolve");
		assert.deepEqual(s.calls("setThreadResolved")[0].args, { thread: "t1", resolved: true });
	} finally {
		await s.close();
	}
});

test("16. the comment box posts a comment and the page reads the PR again", async () => {
	const s = await open();
	try {
		const reads = s.calls("prPage").length;
		await s.page.locator("#new-comment").fill("Looks good to me.");
		await button(s.page, "Comment").click();
		await until(() => s.calls("comment").length === 1, "comment");
		assert.equal(s.calls("comment")[0].body, "Looks good to me.");
		await until(() => s.calls("prPage").length > reads, "re-read");
		assert.equal(await s.page.locator("#new-comment").inputValue(), "");
	} finally {
		await s.close();
	}
});

test("16. merge box: the repo's merge methods, a confirm step, then Confirm merge", async () => {
	const s = await open({ page: { mergeMethods: ["squash", "rebase"] } });
	try {
		assert.match((await s.page.locator(".merge-box .mb-checks").textContent())!, /Some checks were not successful/);
		assert.match((await s.page.locator(".merge-box .mb-branch").textContent())!, /no conflicts with the base branch/);
		await s.page.locator(".merge-menu-toggle").click();
		assert.deepEqual(await s.page.locator(".merge-menu button").allTextContents(), ["Squash and merge", "Rebase and merge"]);
		await s.page.locator(".merge-menu button", { hasText: "Squash and merge" }).click();
		await s.page.locator(".merge-btn").click();
		assert.equal(await s.page.locator(".merge-confirm input.merge-title").inputValue(), "Raise the limit (#4)");
		assert.equal(s.calls("merge").length, 0);
		await button(s.page, "Confirm merge").click();
		await until(() => s.calls("merge").length === 1, "merge");
		assert.deepEqual(s.calls("merge")[0].args, { method: "squash", title: "Raise the limit (#4)" });
	} finally {
		await s.close();
	}
});

test("16. merge box: conflicts offer Resolve conflicts and no merge", async () => {
	const s = await open({ page: { mergeable: "CONFLICTING", mergeState: "DIRTY" } });
	try {
		assert.match((await s.page.locator(".merge-box .mb-branch").textContent())!, /This branch has conflicts that must be resolved/);
		assert.equal(await button(s.page, "Resolve conflicts").count(), 1);
		assert.equal(await s.page.locator(".merge-btn:enabled").count(), 0);
	} finally {
		await s.close();
	}
});

test("16. merge box: Update branch when behind, Ready for review on a draft", async () => {
	const behind = await open({ page: { mergeState: "BEHIND" } });
	try {
		assert.match((await behind.page.locator(".merge-box .mb-branch").textContent())!, /out-of-date with the base branch/);
		await button(behind.page, "Update branch").click();
		await until(() => behind.calls("updateBranch").length === 1, "update branch");
	} finally {
		await behind.close();
	}
	const draft = await open({ page: { draft: true, mergeState: "DRAFT" } });
	try {
		assert.equal(await draft.page.locator(".state-badge").textContent(), "Draft");
		assert.match((await draft.page.locator(".merge-box").textContent())!, /still a work in progress/);
		assert.equal(await draft.page.locator(".merge-btn:enabled").count(), 0);
		await button(draft.page, "Ready for review").click();
		await until(() => draft.calls("setDraft").length === 1, "ready");
		assert.deepEqual(draft.calls("setDraft")[0].args, { draft: false });
	} finally {
		await draft.close();
	}
});

test("16. Checks tab: each check with its state and Details; Re-run failed jobs", async () => {
	const s = await open();
	try {
		await s.page.locator(".pr-tabs a", { hasText: "Checks" }).click();
		await s.page.waitForSelector(".check");
		assert.match(s.page.url(), /#pr\/jeonglab-bcm\/labbot\/4\/checks$/);
		assert.deepEqual(await s.page.locator(".check .check-name").allTextContents(), ["CI / test", "CI / lint"]);
		assert.deepEqual(await s.page.locator(".check .check-state").allTextContents(), ["Failed", "Passed"]);
		assert.equal(await s.page.locator(".check a.details").first().getAttribute("href"), "https://github.com/jeonglab-bcm/labbot/actions/runs/1");
		await button(s.page, "Re-run failed jobs").click();
		await until(() => s.calls("rerunFailedChecks").length === 1, "re-run");
	} finally {
		await s.close();
	}
});

test("16. Files changed: + only on lines GitHub takes a comment on; Add single comment", async () => {
	const s = await open({ hash: `${PR}/files` });
	try {
		await s.page.waitForSelector(".file");
		await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").click();
		await s.page.waitForSelector(".pane.after .m-update");
		assert.equal(await s.page.locator(".pane.after .add-comment").count(), 4); // after lines 13-16 of the 12-18 shown
		assert.equal(await s.page.locator(".pane.before .add-comment").count(), 7);
		await s.page.locator(".pane.after .code-line", { has: s.page.locator(".ln", { hasText: /^15$/ }) }).locator(".add-comment").click();
		await s.page.locator(".comment-form textarea").fill("Make it 25");
		await button(s.page, "Add single comment").click();
		await until(() => s.calls("addReviewComment").length === 1, "line comment");
		assert.deepEqual(s.calls("addReviewComment")[0].args, { mode: "single", subject: "line", path: "src/limit.ts", line: 15, side: "RIGHT", body: "Make it 25" });
	} finally {
		await s.close();
	}
});

test("16. Files changed: Start a review, then Review changes and Approve", async () => {
	const s = await open({ hash: `${PR}/files` });
	try {
		await s.page.waitForSelector(".file");
		await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").click();
		await s.page.waitForSelector(".pane.before .add-comment");
		await s.page.locator(".pane.before .code-line", { has: s.page.locator(".ln", { hasText: /^14$/ }) }).locator(".add-comment").click();
		await s.page.locator(".comment-form textarea").fill("Was 10 on purpose?");
		s.t.github.pages.get(`${LAB}#4`)!.pendingReview = { id: "rv", comments: 1 }; // what GitHub has after it
		await button(s.page, "Start a review").click();
		await until(() => s.calls("addReviewComment").length === 1, "review comment");
		assert.deepEqual(s.calls("addReviewComment")[0].args, { mode: "review", subject: "line", path: "src/limit.ts", line: 14, side: "LEFT", body: "Was 10 on purpose?" });
		await s.page.waitForSelector(".review-changes .n");
		assert.equal(await s.page.locator(".review-changes .n").textContent(), "1");
		await s.page.locator(".review-changes").click();
		assert.deepEqual(await s.page.locator(".review-form input[name=event]").evaluateAll((xs) => xs.map((x) => (x as HTMLInputElement).value)), ["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
		await s.page.locator(".review-form textarea.review-body").fill("LGTM");
		await s.page.locator(".review-form input[value=APPROVE]").check();
		await button(s.page, "Submit review").click();
		await until(() => s.calls("submitReview").length === 1, "submit");
		assert.deepEqual([s.calls("submitReview")[0].args, s.calls("submitReview")[0].body], [{ event: "APPROVE" }, "LGTM"]);
	} finally {
		await s.close();
	}
});

test("16. Review changes on your own PR offers only Comment", async () => {
	const s = await open({ author: "hwan", hash: `${PR}/files` });
	try {
		await s.page.waitForSelector(".review-changes");
		await s.page.locator(".review-changes").click();
		assert.deepEqual(await s.page.locator(".review-form input[name=event]").evaluateAll((xs) => xs.map((x) => (x as HTMLInputElement).value)), ["COMMENT"]);
	} finally {
		await s.close();
	}
});

test("16. Files changed: threads under their line; Viewed ticks GitHub's and folds the file", async () => {
	const s = await open({ hash: `${PR}/files` });
	try {
		await s.page.waitForSelector(".file");
		assert.match((await s.page.locator(".files-head").textContent())!, /1 \/ 3 files viewed/);
		assert.ok(await s.page.locator(".file", { hasText: "docs/new.md" }).locator("input.viewed").isChecked());
		await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").click();
		await s.page.waitForSelector(".pane.after .thread");
		assert.match((await s.page.locator(".pane.after .thread").textContent())!, /Make it a setting\./);
		await s.page.locator(".file", { hasText: "src/limit.ts" }).locator("input.viewed").check();
		await until(() => s.calls("setViewed").length === 1, "viewed");
		assert.deepEqual(s.calls("setViewed")[0].args, { path: "src/limit.ts", viewed: true });
		await s.page.waitForFunction(() => /2 \/ 3 files viewed/.test(document.querySelector(".files-head")?.textContent ?? ""));
		assert.equal(await s.page.locator(".file-diff").count(), 0);
	} finally {
		await s.close();
	}
});

test("16. merge box: Fix with Claude asks Claude on the PR, then says Claude is at it", async () => {
	const s = await open({ page: { mergeable: "CONFLICTING", mergeState: "DIRTY" } });
	try {
		// not set up in the repository: said so, and nothing posted
		await button(s.page, "Fix with Claude").click();
		await s.page.waitForFunction(() => /Claude is not set up in jeonglab-bcm\/labbot/.test(document.querySelector("#toast")!.textContent!));
		assert.equal(s.calls("comment").length, 0);

		s.t.github.blobs.set(`${LAB}@HEAD:.github/workflows/claude-fix-conflicts.yml`, "name: Claude fixes conflicts\n");
		await button(s.page, "Fix with Claude").click();
		await until(() => s.calls("comment").length === 1, "the comment");
		assert.equal(s.calls("comment")[0].body, "@claude fix the merge conflicts with `main`");
		await s.page.waitForFunction(() => /Claude is fixing the conflicts/.test(document.querySelector("#toast")!.textContent!));

		// once the comment is on the PR, the box says Claude is at it and does not offer to ask again
		const page = s.t.github.pages.get(`${LAB}#4`)!;
		const asked = { type: "comment" as const, id: "c9", author: "hwan", body: "@claude fix the merge conflicts with `main`", at: new Date().toISOString() };
		s.t.github.pages.set(`${LAB}#4`, { ...page, timeline: [...page.timeline!, asked] });
		await s.page.reload();
		await s.page.waitForFunction(() => /Claude is fixing the conflicts/.test(document.querySelector(".merge-box .mb-branch")?.textContent ?? ""));
		assert.equal(await button(s.page, "Fix with Claude").count(), 0);
		assert.equal(await button(s.page, "Resolve conflicts").count(), 1); // still there, to do it by hand
		assert.equal(await s.page.locator(".merge-btn:enabled").count(), 0);
	} finally {
		await s.close();
	}
});

test("16. merge box: Fix with Claude fits beside Resolve conflicts on a phone", async () => {
	const s = await open({ device: PHONE, page: { mergeable: "CONFLICTING", mergeState: "DIRTY" } });
	try {
		const box = (await s.page.locator(".merge-box .mb-branch").boundingBox())!;
		for (const name of ["Resolve conflicts", "Fix with Claude"]) {
			const b = (await button(s.page, name).boundingBox())!;
			assert.ok(b.x >= box.x && b.x + b.width <= box.x + box.width + 0.5, `${name} is inside the box`);
			assert.ok(b.height >= 32, `${name} is ${b.height}px tall`);
		}
		assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	} finally {
		await s.close();
	}
});

test("16. Resolve conflicts: Accept current change, Mark as resolved, Commit merge", async () => {
	const s = await open({ page: { mergeable: "CONFLICTING", mergeState: "DIRTY" } });
	try {
		s.t.github.mergeSets.set(`${LAB}#4`, {
			headRepo: LAB, headRef: "feature", headSha: "hd", baseRef: "main", baseSha: "bt", mergeBase: "mb",
			headFiles: [{ path: "src/limit.ts", status: "modified", additions: 1, deletions: 1 }],
			baseFiles: [{ path: "src/limit.ts", status: "modified", additions: 1, deletions: 1 }],
		});
		for (const k of ["mb", "hd", "bt"] as const) s.t.github.blobs.set(`${LAB}@${k}:src/limit.ts`, LIMIT[k]);
		await button(s.page, "Resolve conflicts").click();
		await s.page.waitForSelector(".conflict-file textarea.conflict-text");
		assert.match(s.page.url(), /#pr\/jeonglab-bcm\/labbot\/4\/conflicts$/);
		assert.match(await s.page.locator("textarea.conflict-text").inputValue(), /^<<<<<<< feature\n/);
		assert.ok(await button(s.page, "Mark as resolved").isDisabled());
		assert.ok(await button(s.page, "Commit merge").isDisabled());
		assert.equal(await button(s.page, "Accept incoming change").count(), 1);
		assert.equal(await button(s.page, "Accept both changes").count(), 1);
		await button(s.page, "Accept current change").click();
		assert.equal(await s.page.locator("textarea.conflict-text").inputValue(), LIMIT.hd);
		await button(s.page, "Mark as resolved").click();
		await button(s.page, "Commit merge").click();
		await until(() => s.calls("commitMerge").length === 1, "commit merge");
		const c = s.calls("commitMerge")[0];
		assert.deepEqual([c.args.branch, c.args.parents, c.args.write], ["feature", ["hd", "bt"], [{ path: "src/limit.ts", text: LIMIT.hd }]]);
		await s.page.waitForFunction(() => /#pr\/jeonglab-bcm\/labbot\/4$/.test(location.hash));
	} finally {
		await s.close();
	}
});

test("16. sidebar: assign yourself, a label, a reviewer", async () => {
	const s = await open();
	try {
		await s.page.locator(".side-assignees").getByRole("button", { name: "assign yourself" }).click();
		await until(() => s.calls("setAssignees").length === 1, "assign");
		assert.deepEqual(s.calls("setAssignees")[0].args, { logins: ["hwan"] });
		await s.page.locator(".side-labels .gear").click();
		await s.page.locator(".side-labels .picker label", { hasText: "bug" }).click();
		await until(() => s.calls("setLabels").length === 1, "label");
		assert.deepEqual(s.calls("setLabels")[0].args, { names: ["bug"] });
		await s.page.locator(".side-reviewers .gear").click();
		assert.equal(await s.page.locator(".side-reviewers .picker label", { hasText: "kelly" }).count(), 0); // not the author
		await s.page.locator(".side-reviewers .picker label", { hasText: "jlee" }).click();
		await until(() => s.calls("requestReviewers").length === 1, "reviewer");
		assert.deepEqual(s.calls("requestReviewers")[0].args, { add: ["jlee"], remove: [] });
	} finally {
		await s.close();
	}
});

test("16. f opens Files changed; the old #files address still works", async () => {
	const s = await open({ hash: "#" });
	try {
		await s.page.keyboard.press("f");
		await s.page.waitForSelector(".file");
		assert.match(s.page.url(), /#pr\/jeonglab-bcm\/labbot\/4\/files$/);
		await s.page.evaluate(() => (location.hash = "#"));
		await s.page.waitForSelector(".row");
		await s.page.evaluate((h) => (location.hash = h), `#files/${LAB}/4`);
		await s.page.waitForFunction(() => /#pr\/jeonglab-bcm\/labbot\/4\/files$/.test(location.hash));
		await s.page.waitForSelector(".file");
	} finally {
		await s.close();
	}
});

test("16. on a phone: the sidebar above the tabs, and no sideways scrolling", async () => {
	const s = await open({ device: PHONE });
	try {
		const side = await s.page.locator(".sidebar").boundingBox();
		const tabs = await s.page.locator(".pr-tabs").boundingBox();
		assert.ok(side!.y < tabs!.y, "sidebar is not above the tabs");
		for (const h of [PR, `${PR}/checks`, `${PR}/files`]) {
			await s.page.evaluate((x) => (location.hash = x), h);
			await s.page.waitForTimeout(150);
			assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `scrolls sideways on ${h}`);
		}
	} finally {
		await s.close();
	}
});

test("16. on a phone: a table in the description keeps its words whole; a wide one scrolls inside itself", async () => {
	const body = [
		"What came back:", "",
		"| Item | Verdict | Measure | Why |", "| --- | --- | --- | --- |",
		"| Fig. 1 (diagram) | not attempted | not attempted | A diagram of the framework. Its panels B to D and H reuse toggle switch results. |",
		"| Fig. 1H, toggle switch posterior | partly | 1 of 6 fields as printed | Our prior on lambda (SD 0.025) does not hold lambda at 0.25: its posterior mean is 0.34. |",
		"", "| alpha | beta | gamma | delta | epsilon | zeta | eta | theta | iota | kappa |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		"| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |",
	].join("\n");
	const s = await open({ device: PHONE, page: { body } });
	try {
		await s.page.waitForSelector(".tl[data-type=description] table");
		const cells = await s.page.locator(".tl[data-type=description] table").first().locator("th, td").evaluateAll((xs) => xs.map((x) => {
			const range = document.createRange(); // the text's own box, not the row's
			range.selectNodeContents(x);
			const line = parseFloat(getComputedStyle(x).lineHeight);
			const words = x.textContent!.trim().split(/\s+/);
			return { text: words.join(" "), words: words.length, lines: Math.round(range.getBoundingClientRect().height / line) };
		}));
		for (const c of cells) assert.ok(c.lines <= c.words, `"${c.text}" is ${c.lines} lines tall for ${c.words} words: a word was broken`);
		for (const c of cells.filter((c) => c.words > 8)) assert.ok(c.lines <= Math.ceil(c.words / 2), `"${c.text}" is ${c.lines} lines for ${c.words} words: the column is too narrow to read`);
		assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page scrolls sideways");
		const wide = s.page.locator(".tl[data-type=description] table").nth(1);
		assert.ok(await wide.evaluate((t) => t.scrollWidth > t.clientWidth && getComputedStyle(t).overflowX === "auto"), "the wide table does not scroll inside itself");
	} finally {
		await s.close();
	}
});

test("16. Commits tab: commits by day; a commit opens its files, diffed against its parent", async () => {
	const s = await open();
	try {
		await s.page.locator(".pr-tabs a", { hasText: "Commits" }).click();
		await s.page.waitForSelector(".commit");
		assert.match(s.page.url(), /#pr\/jeonglab-bcm\/labbot\/4\/commits$/);
		assert.match((await s.page.locator(".commit-day").first().textContent())!, /Commits on Nov 2/);
		assert.match((await s.page.locator(".commit").first().textContent())!, /Raise the limit.*kelly.*c0ffee1/);
		await s.page.locator(".commit").first().click();
		await s.page.waitForSelector(".file");
		assert.match(s.page.url(), /\/commits\/c0ffee1234$/);
		await s.page.locator(".file .path").first().click();
		await s.page.waitForSelector(".pane.after .m-update");
		assert.deepEqual(s.t.differ.calls.map((c) => c.map((x) => x?.path)), [["src/limit.ts", "src/limit.ts"]]);
		assert.match((await s.page.locator(".pane.before h4").textContent())!, /^Parent/);
	} finally {
		await s.close();
	}
});

test("16. Close pull request asks first; a closed PR offers Reopen", async () => {
	const s = await open();
	try {
		let asked = "";
		s.page.on("dialog", (d) => { asked = d.message(); void d.accept(); });
		await button(s.page, "Close pull request").click();
		await until(() => s.calls("setState").length === 1, "close");
		assert.match(asked, /Close/);
		assert.deepEqual(s.calls("setState")[0].args, { state: "closed" });
	} finally {
		await s.close();
	}
	const closed = await open({ page: { state: "CLOSED" } });
	try {
		assert.equal(await closed.page.locator(".state-badge").textContent(), "Closed");
		assert.equal(await button(closed.page, "Close pull request").count(), 0);
		await button(closed.page, "Reopen pull request").click();
		await until(() => closed.calls("setState").length === 1, "reopen");
		assert.deepEqual(closed.calls("setState")[0].args, { state: "open" });
	} finally {
		await closed.close();
	}
});

test("16. on a phone, tapping a line number GitHub takes a comment on opens the comment box", async () => {
	const s = await open({ device: PHONE, hash: `${PR}/files` });
	try {
		await s.page.waitForSelector(".file");
		await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").tap();
		await s.page.waitForSelector(".unified .u-add");
		assert.equal(await s.page.locator(".add-comment:visible").count(), 0); // no + buttons over the numbers
		await s.page.locator(".u-add .ln.can-comment", { hasText: /^15$/ }).tap();
		await s.page.locator(".comment-form textarea").fill("Why 20?");
		await button(s.page, "Add single comment").tap();
		await until(() => s.calls("addReviewComment").length === 1, "line comment");
		assert.deepEqual(s.calls("addReviewComment")[0].args, { mode: "single", subject: "line", path: "src/limit.ts", line: 15, side: "RIGHT", body: "Why 20?" });
		assert.equal(await s.page.locator(".u-ctx .ln.can-comment", { hasText: /^20$/ }).count(), 0); // outside the hunks: not tappable
	} finally {
		await s.close();
	}
});

test("16. on a phone the open file's row stays at the top while its diff scrolls", async () => {
	const s = await open({ device: PHONE, hash: `${PR}/files` });
	try {
		// a long file with a change every 5 lines, so the diff is much taller than the screen
		const long = (w: string) => Array.from({ length: 200 }, (_, i) => (i % 5 ? `line ${i + 1}` : `${w} ${i + 1}`)).join("\n") + "\n";
		s.t.github.blobs.set(`${LAB}@base-sha:src/limit.ts`, long("old"));
		s.t.github.blobs.set(`${LAB}@head-sha:src/limit.ts`, long("new"));
		const every = Array.from({ length: 40 }, (_, k) => ({ op: "update" as const, ...at(k * 5, 0, 3) }));
		s.t.differ.reply = { largeResidual: false, before: { hunks: every }, after: { hunks: every } };
		await s.page.waitForSelector(".file");
		await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").tap();
		await s.page.waitForSelector(".unified .u-add");
		await s.page.evaluate(() => window.scrollBy(0, document.querySelector(".file.open")!.getBoundingClientRect().top + 600));
		const top = await s.page.locator(".file.open").evaluate((e) => e.getBoundingClientRect().top);
		assert.ok(Math.abs(top) < 2, `the file row is at ${top}px, not the top`);
	} finally {
		await s.close();
	}
});

for (const [device, name] of [[DESKTOP, "a computer"], [PHONE, "a phone"]] as const) {
	test(`17. Explain on a file's diff shows the model's explanation above the diff, on ${name}`, async () => {
		const s = await open({ device, hash: `${PR}/files` });
		try {
			s.t.llm.reply = "The change raises `limit` from 10 to 20.";
			await s.page.waitForSelector(".file");
			await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").click();
			await s.page.waitForSelector(".file-diff .m-update");
			await s.page.locator(".file-diff").getByRole("button", { name: "Explain", exact: true }).click();
			await s.page.waitForSelector(".explain:not(.streaming) code");
			assert.equal(await s.page.locator(".explain").textContent(), "The change raises limit from 10 to 20.");
			assert.equal(await s.page.locator(".explain code").textContent(), "limit");
			const [ex, diff] = await Promise.all([".explain", device === PHONE ? ".unified" : ".panes"].map((x) => s.page.locator(x).boundingBox()));
			assert.ok(ex!.y < diff!.y, "the explanation is not above the diff");
			const [call] = s.t.llm.calls;
			assert.ok(call.user.includes("Raise the limit") && call.user.includes("const limit = 20;"));
		} finally {
			await s.close();
		}
	});
}

for (const [device, name] of [[DESKTOP, "a computer"], [PHONE, "a phone"]] as const) {
	test(`17. a question under an explanation is answered there, and is there again after a reload, on ${name}`, async () => {
		const s = await open({ device, hash: `${PR}/files` });
		const explainIt = async () => {
			await s.page.waitForSelector(".file");
			await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").click();
			await s.page.waitForSelector(".file-diff .m-update");
			await s.page.locator(".file-diff").getByRole("button", { name: "Explain", exact: true }).click();
			await s.page.waitForSelector(".explain:not(.streaming) code");
		};
		try {
			s.t.llm.reply = "The change raises `limit` from 10 to 20.";
			s.t.llm.answer = (p) => (p.system.startsWith("You answer") ? "Because **10** was too low." : undefined);
			s.t.llm.delayMs = 15;
			await s.page.waitForSelector(".file");
			assert.equal(await s.page.locator(".explain-ask").count(), 0, "no question box before an explanation");
			await explainIt();
			const box = s.page.locator(".explain-ask textarea");
			await box.fill("Why 20?");
			if (device === PHONE) await s.page.locator(".explain-ask").getByRole("button", { name: "Ask" }).click();
			else await box.press("Enter");
			await s.page.waitForSelector(".explain-ask .ask-turn:not(.streaming) .ask-answer strong");
			assert.equal(await s.page.locator(".explain-ask .ask-q").textContent(), "Why 20?");
			assert.equal((await s.page.locator(".explain-ask .ask-answer").textContent())!.trim(), "Because 10 was too low.");
			assert.equal(await box.inputValue(), "", "the box is empty for the next question");
			assert.equal(await s.page.locator(".explain").textContent(), "The change raises limit from 10 to 20.");
			assert.ok(s.t.llm.calls[1].user.endsWith("The reader asks:\nWhy 20?\n"));

			// under the explanation, above the diff, and inside the page's width
			const [ex, ask, diff] = await Promise.all([".explain", ".explain-ask", device === PHONE ? ".unified" : ".panes"].map((x) => s.page.locator(x).boundingBox()));
			assert.ok(ex!.y + ex!.height <= ask!.y + 1 && ask!.y + ask!.height <= diff!.y + 1, "the questions are not between the explanation and the diff");
			assert.ok(ask!.x >= 0 && ask!.x + ask!.width <= device.viewport!.width, "the questions are wider than the page");
			assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the page scrolls sideways");

			if (device === DESKTOP) { // the box keeps the cursor while an answer comes in
				await box.fill("And 30?");
				await box.press("Enter");
				await s.page.waitForSelector(".explain-ask .ask-turn.streaming");
				await s.page.keyboard.type("next");
				await s.page.waitForFunction(() => document.querySelectorAll(".explain-ask .ask-turn:not(.streaming)").length === 2);
				assert.equal(await box.inputValue(), "next");
				assert.ok(s.t.llm.calls[2].user.includes("Q: Why 20?"), "the second question goes with the first");
			}

			await s.page.reload();
			await explainIt();
			await s.page.waitForSelector(".explain-ask .ask-turn");
			assert.equal(await s.page.locator(".explain-ask .ask-q").first().textContent(), "Why 20?");
		} finally {
			await s.close();
		}
	});
}

test("17. a question that fails stays in the box, and the model's error is shown", async () => {
	const s = await open({ hash: `${PR}/files` });
	try {
		s.t.llm.reply = "The change raises `limit` from 10 to 20.";
		await s.page.waitForSelector(".file");
		await s.page.locator(".file", { hasText: "src/limit.ts" }).locator(".path").click();
		await s.page.waitForSelector(".file-diff .m-update");
		await s.page.locator(".file-diff").getByRole("button", { name: "Explain", exact: true }).click();
		await s.page.waitForSelector(".explain:not(.streaming) code");
		s.t.llm.failNext = true;
		const box = s.page.locator(".explain-ask textarea");
		await box.fill("Why 20?");
		await box.press("Enter");
		await s.page.waitForFunction(() => /LLM/.test(document.querySelector("#toast")!.textContent!));
		assert.equal(await box.inputValue(), "Why 20?");
		assert.equal(await s.page.locator(".explain-ask .ask-turn").count(), 0);
	} finally {
		await s.close();
	}
});
