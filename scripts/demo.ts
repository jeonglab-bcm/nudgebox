/**
 * Runs the app against the fake GitHub with a realistic lab inbox, for looking at the
 * UI without real accounts: `node --import tsx scripts/demo.ts [port]` then open
 * http://127.0.0.1:<port>/. A small proxy in front plays the Keycloak sidecar (you are
 * lab user "hyunhwanj", GitHub "hwan").
 */
import { createServer, request } from "node:http";
import { start, ORIGIN } from "../tests/helpers/harness.ts";

const port = Number(process.argv[2] ?? 8099);
const t = await start();
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

await t.link("hyunhwanj", "hwan");
await t.app.sync();

// the sidecar: identity headers on every request, and the public origin on POSTs
createServer((req, res) => {
	const headers = { ...req.headers, "x-forwarded-email": "hyunhwanj@bcm.edu", "x-forwarded-preferred-username": "hyunhwanj", host: new URL(t.base).host } as Record<string, string>;
	if (req.method !== "GET") headers.origin = ORIGIN;
	const up = request(t.base + req.url, { method: req.method, headers }, (r) => {
		res.writeHead(r.statusCode ?? 502, r.headers);
		r.pipe(res);
	});
	req.pipe(up);
}).listen(port, "127.0.0.1", () => console.log(`demo inbox on http://127.0.0.1:${port}/`));
