/**
 * Read-only check of the GraphQL search + mapping against real GitHub, with your own
 * gh CLI token (no App needed):   npm run live-check
 * Prints each open PR's inbox section for you, and open-issue counts. Changes nothing.
 */
import { Octokit } from "octokit";
import { searchOpenIssues, searchOpenPullRequests } from "../src/octokit-github.ts";
import { section } from "../src/inbox.ts";

const o = new Octokit({ auth: process.env.GH_TOKEN });
const { data: me } = await o.request("GET /user");
const OLD_MS = 30 * 24 * 3600_000;
for (const account of process.argv.slice(2)) {
	const prs = await searchOpenPullRequests(o, account);
	console.log(`${account}: ${prs.length} open PRs`);
	for (const p of prs) console.log(`  ${section(p, { login: me.login, teams: [] }).padEnd(15)} ${p.repo}#${p.number} checks=${p.checks} review=${p.reviewDecision} mergeable=${p.mergeable} draft=${p.draft}`);
	const issues = await searchOpenIssues(o, account);
	const byRepo: Record<string, number> = {};
	for (const i of issues) byRepo[i.repo.split("/")[1]] = (byRepo[i.repo.split("/")[1]] ?? 0) + 1;
	const old = issues.filter((i) => Date.now() - Date.parse(i.updatedAt) > OLD_MS).length;
	console.log(`${account}: ${issues.length} open issues (${old} idle > 30 days) ${JSON.stringify(byRepo)}`);
}
