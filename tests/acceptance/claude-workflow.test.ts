/**
 * SPEC 16. Fix with Claude, the GitHub side: the workflow that answers the comment. Its
 * shell steps are cut out of the workflow file and run on scratch repositories by
 * tests/workflow/claude-fix-conflicts.sh, with a stand-in for Claude. What Claude itself
 * writes is not tested here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { CLAUDE_ASK, CLAUDE_WORKFLOW } from "../../src/conflicts.ts";

const root = join(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(root, CLAUDE_WORKFLOW), "utf8"));
const job = workflow.jobs.fix;
const NAMES: Record<string, string> = {
	"Read the request": "pr",
	"Merge the base branch in": "merge",
	"Push the merge, if Claude's own push did not happen": "push",
	"Say what happened on the pull request": "say",
};

test("16. the workflow answers the words Nudgebox posts, on pull requests only", () => {
	assert.deepEqual(workflow.on, { issue_comment: { types: ["created"] } });
	assert.equal(job.if, `github.event.issue.pull_request && startsWith(github.event.comment.body, '${CLAUDE_ASK}')`);
});

test("16. the workflow pastes nothing from GitHub into a script, and gives no script a key", () => {
	for (const step of job.steps) {
		if (!step.run) continue;
		assert.doesNotMatch(step.run, /\$\{\{/, `${step.name}: an expression inside a script`);
		for (const value of Object.values(step.env ?? {})) assert.doesNotMatch(String(value), /secrets\.\w+\s*\}\}/, `${step.name}: a key in a script's environment`);
	}
});

test("16. the workflow's steps: what is merged, what is refused, what is said", { skip: !hasTools() && "needs bash, git and jq" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-wf-"));
	try {
		for (const step of job.steps) if (step.run) writeFileSync(join(dir, `${NAMES[step.name]}.sh`), step.run);
		const run = spawnSync("bash", [join(root, "tests/workflow/claude-fix-conflicts.sh"), dir], { encoding: "utf8" });
		const failed = (run.stdout + run.stderr).split("\n").filter((l) => !l.startsWith("  ok")).join("\n");
		assert.equal(run.status, 0, failed);
		assert.match(run.stdout, /pass \d+, fail 0/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function hasTools() {
	try {
		for (const tool of ["bash", "git", "jq"]) execFileSync(tool, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
