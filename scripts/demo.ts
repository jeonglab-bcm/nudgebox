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

t.llm.delayMs = 30; // summaries stream in like the real model

await t.link("hyunhwanj", "hwan");
await t.subscribe("hyunhwanj", "https://web.push.apple.com/demo-iphone");
await t.subscribe("hyunhwanj", "https://fcm.googleapis.com/fcm/send/demo-chrome");
await t.app.sync();

const { url } = await sidecar(t.base, "hyunhwanj", port);
console.log(`demo inbox on ${url}`);
