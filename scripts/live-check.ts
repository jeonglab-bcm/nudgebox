/**
 * Read-only check of the GraphQL search + mapping against real GitHub, with your own
 * gh CLI token (no App needed):   GH_TOKEN=$(gh auth token) node scripts/live-check.ts jeonglab-bcm hyunhwan-bcm
 * Prints counts and the inbox section each PR would land in for you. Changes nothing.
 */
import { Octokit } from "octokit";
import { searchOpenPullRequests } from "../src/octokit-github.ts";
import { section } from "../src/inbox.ts";

const o = new Octokit({ auth: process.env.GH_TOKEN });
const { data: me } = await o.request("GET /user");
for (const account of process.argv.slice(2)) {
	const prs = await searchOpenPullRequests(o, account);
	console.log(`${account}: ${prs.length} open PRs`);
	for (const p of prs) console.log(`  ${section(p, { login: me.login, teams: [] }).padEnd(15)} ${p.repo}#${p.number} checks=${p.checks} review=${p.reviewDecision} mergeable=${p.mergeable} draft=${p.draft}`);
}
