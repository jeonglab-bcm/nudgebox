/**
 * Runs the app against the fake GitHub with a realistic lab inbox, for looking at the
 * UI without real accounts: `node --import tsx scripts/demo.ts [port]` then open
 * http://127.0.0.1:<port>/. A small proxy in front plays the Keycloak sidecar (you are
 * lab user "hyunhwanj", GitHub "hwan").
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { start } from "../tests/helpers/harness.ts";
import { createOmnidiff } from "../src/omnidiff.ts";
import { commentableLines } from "../src/octokit-github.ts";
import { sidecar } from "../tests/helpers/browser.ts";

const port = Number(process.argv[2] ?? 8099);
// the real omnidiff when scripts/get-omnidiff.sh has fetched it (SPEC 15)
const t = await start(existsSync("bin/omnidiff") ? { diff: createOmnidiff("bin/omnidiff") } : {});
const DAY = 86400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const L = (r: string) => `jeonglab-bcm/${r}`;
const repos = [L("labbot"), L("AURORA"), L("variant-db"), L("gh-dashboard"), L("outloud"), "hyunhwan-bcm/tailjobs", "hyunhwan-bcm/dotfiles"];
t.github.grant("hwan", ...repos);

const pr = (repo: string, number: number, author: string, title: string, days: number, extra: object = {}) =>
	t.github.addPr({ repo, number, author, title, updatedAt: ago(days), ...extra });
// needs you
pr(L("labbot"), 88, "jlee", "Add calendar module with Outlook sync", 5, { requestedReviewers: ["hwan"], checks: "failure", reviewDecision: "REVIEW_REQUIRED" });
pr(L("variant-db"), 142, "mkim", "Fix liftover off-by-one on chrX PAR regions", 2, { requestedReviewers: ["hwan"], checks: "success", reviewDecision: "REVIEW_REQUIRED" });
pr(L("AURORA"), 311, "kelly", "Rank candidate genes with HPO similarity and inheritance mode", 0.3, { requestedReviewers: ["hwan"], checks: "pending", reviewDecision: "REVIEW_REQUIRED" });
pr("hyunhwan-bcm/tailjobs", 31, "hwan", "Slurm array job support", 0.05, { checks: "success", reviewDecision: null });
pr(L("outloud"), 57, "hwan", "Clear cookies after a bad sign-in", 3.5, { checks: "success", reviewDecision: "CHANGES_REQUESTED" });
// WIP
pr(L("gh-dashboard"), 9, "hwan", "Triage list: one line per PR, keyboard actions", 0.02, { draft: true, checks: "pending" });
pr("hyunhwan-bcm/dotfiles", 214, "hwan", "zsh: lazy-load nvm and pyenv", 1, { checks: "pending", reviewDecision: "REVIEW_REQUIRED" });
// CI failing / everything else
pr(L("AURORA"), 305, "sgarcia", "Bump torch to 2.9 and pin CUDA 12.8 wheels", 4, { checks: "failure" });
pr(L("variant-db"), 139, "jlee", "Migrate gnomAD v4.1 frequencies", 9, { checks: "success", reviewDecision: "APPROVED", mergeable: "CONFLICTING" });
pr(L("labbot"), 85, "mkim", "Lab meeting notes: pull slides from Box", 6, { checks: "success", reviewDecision: "APPROVED" });
pr(L("AURORA"), 298, "kelly", "Docs: explain the phenotype prior in README", 12, { checks: "none" });
pr(L("labbot"), 61, "sgarcia", "Prototype voice notes", 44, { draft: true });

const issue = (repo: string, number: number, author: string, title: string, days: number, extra: object = {}) =>
	t.github.addIssue({ repo, number, author, title, updatedAt: ago(days), ...extra });
issue(L("AURORA"), 320, "kelly", "Scores differ between GRCh37 and GRCh38 runs", 1, { assignees: ["hwan"], labels: ["bug"], comments: 4 });
issue(L("labbot"), 90, "jlee", "Calendar module double-books Thursday seminar", 0.2, { labels: ["bug", "calendar"], comments: 2 });
issue(L("variant-db"), 150, "hwan", "Add ClinVar 2026-10 release", 3, { labels: ["data"] });
issue("hyunhwan-bcm/tailjobs", 40, "hwan", "Show GPU memory in job list", 7, { comments: 1 });

// what the lab model answers (SPEC 12), so Summarize shows something realistic
t.llm.reply = [
	"What: This pull request adds a candidate-gene ranking to `rank.py`. It scores genes by HPO similarity and by the inheritance mode.",
	"",
	"Key points:",
	"- The ranking puts the known causal gene in the top 10 for 41 of 50 solved cases.",
	"- The old ranking put it in the top 10 for 33 of 50 cases.",
	"- The change adds `hpo_sim.py` and a test set in `tests/solved_cases.tsv`.",
	"",
	"Status: The checks are running. A review from @hwan is necessary.",
	"",
	"Next: @hwan must review the PR after the checks pass.",
].join("\n");

// Files of AURORA#311 (SPEC 15): real file versions from this repo's own history
const git = (rev: string, path: string) => execFileSync("git", ["show", `${rev}:${path}`]);
t.github.prFileSets.set(`${L("AURORA")}#311`, {
	base: "015c1e5", head: "fbb18e9",
	files: [
		{ path: "src/summary.ts", status: "modified", additions: 19, deletions: 2 },
		{ path: "public/sw.js", status: "modified", additions: 3, deletions: 1 },
		{ path: "SPEC.md", status: "modified", additions: 60, deletions: 4 },
		{ path: "public/fonts/Inter-400-700.woff2", status: "added", additions: 0, deletions: 0 },
	],
});
for (const rev of ["015c1e5", "fbb18e9"]) for (const p of ["src/summary.ts", "public/sw.js", "SPEC.md"]) t.github.blobs.set(`${L("AURORA")}@${rev}:${p}`, git(rev, p));
t.github.blobs.set(`${L("AURORA")}@fbb18e9:public/fonts/Inter-400-700.woff2`, Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1]));
// binary files (SPEC 15): the test fixtures, as a figure, a data bundle and a draft
const fx = (n: string) => readFileSync(`tests/fixtures/binary/${n}`);
t.github.prFileSets.get(`${L("AURORA")}#311`)!.files.push(
	{ path: "figures/fig2.png", status: "modified", additions: 0, deletions: 0 },
	{ path: "data/bundle.zip", status: "modified", additions: 0, deletions: 0 },
	{ path: "paper/draft.pdf", status: "modified", additions: 0, deletions: 0 },
);
for (const [p, ext] of [["figures/fig2.png", "png"], ["data/bundle.zip", "zip"], ["paper/draft.pdf", "pdf"]]) {
	t.github.blobs.set(`${L("AURORA")}@015c1e5:${p}`, fx(`before.${ext}`));
	t.github.blobs.set(`${L("AURORA")}@fbb18e9:${p}`, fx(`after.${ext}`));
}

// the PR page of AURORA#311 (SPEC 16): what GitHub would give, with comments only where the patch has hunks
for (const f of t.github.prFileSets.get(`${L("AURORA")}#311`)!.files) {
	const patch = execFileSync("git", ["diff", "-U3", "015c1e5", "fbb18e9", "--", f.path]).toString();
	if (patch.includes("@@")) f.commentable = commentableLines(patch.slice(patch.indexOf("@@")));
}
t.github.pages.set(`${L("AURORA")}#311`, {
	body: "Ranks candidate genes by **HPO similarity** and the inheritance mode.\n\n- adds `hpo_sim.py`\n- test set: `tests/solved_cases.tsv`\n\nTop-10 hit rate on 50 solved cases: 33 → 41.",
	createdAt: ago(2), baseRef: "main", headRef: "kelly/hpo-rank", commits: 3, additions: 82, deletions: 7, changedFiles: 7,
	mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED",
	reviewers: [{ login: "hwan", state: "REQUESTED" }, { login: "jlee", state: "COMMENTED" }],
	assignees: ["kelly"], labels: [{ name: "enhancement", color: "a2eeef" }, { name: "ranking", color: "5319e7" }], milestone: { number: 3, title: "AURORA 2.1" },
	timeline: [
		{ type: "commit", sha: "a1b2c3d4e5", message: "Add HPO similarity score", author: "kelly", at: ago(2) },
		{ type: "commit", sha: "b2c3d4e5f6", message: "Weight by inheritance mode", author: "kelly", at: ago(1.6) },
		{ type: "event", event: "review_requested", actor: "kelly", subject: "hwan", at: ago(1.6) },
		{ type: "review", id: "r1", author: "jlee", state: "COMMENTED", body: "Nice gain. One question on the prompt text.", at: ago(1) },
		{ type: "comment", id: "c1", author: "kelly", body: "Answered inline; the threshold comes from the 2024 benchmark.", at: ago(0.8) },
		{ type: "commit", sha: "c3d4e5f6a7", message: "Explain the threshold", author: "kelly", at: ago(0.3) },
	],
	threads: [{
		id: "t1", path: "src/summary.ts", line: 30, startLine: null, side: "RIGHT", resolved: false, outdated: false, reviewId: "r1",
		diffHunk: "@@ -25,6 +25,12 @@\n context\n+const SUMMARY_FORMAT = 3;",
		comments: [
			{ id: "tc1", author: "jlee", body: "Is this format number used anywhere else?", at: ago(1), pending: false },
			{ id: "tc2", author: "kelly", body: "Only for the summary cache key.", at: ago(0.8), pending: false },
		],
	}],
	checks: [
		{ name: "test (3.12)", workflow: "CI", state: "passed", startedAt: ago(0.31), completedAt: ago(0.3), url: "https://github.com" },
		{ name: "lint", workflow: "CI", state: "passed", startedAt: ago(0.31), completedAt: ago(0.305), url: "https://github.com" },
		{ name: "benchmark", workflow: "Bench", state: "running", startedAt: ago(0.2), url: "https://github.com" },
	],
	viewed: { "public/sw.js": "VIEWED" },
});
t.github.commits.set(`${L("AURORA")}#311`, [
	{ sha: "015c1e5", message: "Add HPO similarity score", author: "kelly", at: ago(2) },
	{ sha: "fbb18e9", message: "Weight by inheritance mode", author: "kelly", at: ago(1.6) },
]);
t.github.commitFileSets.set(`${L("AURORA")}@fbb18e9`, { base: "015c1e5", head: "fbb18e9", files: t.github.prFileSets.get(`${L("AURORA")}#311`)!.files.slice(0, 3) });
for (const r of repos) t.github.options.set(r, {
	assignable: ["hwan", "kelly", "jlee", "mkim", "sgarcia"],
	labels: [{ name: "bug", color: "d73a4a", description: "Something is broken" }, { name: "enhancement", color: "a2eeef", description: "" }, { name: "ranking", color: "5319e7", description: "" }],
	milestones: [{ number: 3, title: "AURORA 2.1" }],
});
// variant-db#139 has conflicts (SPEC 16): one file both branches changed in the same place
t.github.pages.set(`${L("variant-db")}#139`, { mergeable: "CONFLICTING", mergeState: "DIRTY", headRef: "jlee/gnomad-4.1", baseRef: "main", headSha: "vhd" });
t.github.mergeSets.set(`${L("variant-db")}#139`, {
	headRepo: L("variant-db"), headRef: "jlee/gnomad-4.1", headSha: "vhd", baseRef: "main", baseSha: "vbt", mergeBase: "vmb",
	headFiles: [{ path: "config/sources.yaml", status: "modified", additions: 1, deletions: 1 }],
	baseFiles: [{ path: "config/sources.yaml", status: "modified", additions: 1, deletions: 1 }, { path: "README.md", status: "modified", additions: 2, deletions: 0 }],
});
const yaml = (gnomad: string, clinvar: string) => `sources:\n  gnomad: ${gnomad}\n  clinvar: ${clinvar}\n  dbsnp: b156\n`;
t.github.blobs.set(`${L("variant-db")}@vmb:config/sources.yaml`, yaml("v4.0", "2026-09"));
t.github.blobs.set(`${L("variant-db")}@vhd:config/sources.yaml`, yaml("v4.1", "2026-09"));
t.github.blobs.set(`${L("variant-db")}@vbt:config/sources.yaml`, yaml("v4.0.1", "2026-10"));

t.llm.delayMs = 30; // summaries stream in like the real model

await t.link("hyunhwanj", "hwan");
await t.subscribe("hyunhwanj", "https://web.push.apple.com/demo-iphone");
await t.subscribe("hyunhwanj", "https://fcm.googleapis.com/fcm/send/demo-chrome");
await t.app.sync();

const { url } = await sidecar(t.base, "hyunhwanj", port);
console.log(`demo inbox on ${url}`);
