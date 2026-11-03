/** SPEC 5: which section a PR belongs to for one person, and the section order. */
import type { PullRequest } from "./github.ts";

export const SECTIONS = [
	{ id: "needs_you", title: "Needs you" },
	{ id: "waiting", title: "Waiting on others" },
	{ id: "ci_failing", title: "CI failing" },
	{ id: "everything_else", title: "Everything else" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

export interface Viewer {
	login: string;
	teams: string[]; // "org/team-slug"
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const isMine = (p: PullRequest, v: Viewer) => same(p.author, v.login);

export const reviewRequested = (p: PullRequest, v: Viewer) =>
	p.requestedReviewers.some((r) => same(r, v.login)) || p.requestedTeams.some((t) => v.teams.some((m) => same(m, t)));

export function readyToMerge(p: PullRequest): boolean {
	return !p.draft && p.mergeable !== "CONFLICTING" && (p.checks === "success" || p.checks === "none") &&
		(p.reviewDecision === "APPROVED" || p.reviewDecision === null);
}

export function section(p: PullRequest, v: Viewer): SectionId {
	if (reviewRequested(p, v)) return "needs_you";
	if (isMine(p, v)) {
		if (p.mergeable === "CONFLICTING" || p.reviewDecision === "CHANGES_REQUESTED") return "needs_you";
		if (p.checks === "failure") return "ci_failing";
		return readyToMerge(p) ? "needs_you" : "waiting";
	}
	return p.checks === "failure" ? "ci_failing" : "everything_else";
}

export function buildInbox(prs: PullRequest[], v: Viewer) {
	const newest = (a: PullRequest, b: PullRequest) => b.updatedAt.localeCompare(a.updatedAt);
	return {
		sections: SECTIONS.map((s) => {
			const inIt = prs.filter((p) => section(p, v) === s.id);
			const sorted = s.id === "ci_failing"
				? [...inIt.filter((p) => isMine(p, v)).sort(newest), ...inIt.filter((p) => !isMine(p, v)).sort(newest)]
				: inIt.sort(newest);
			return { id: s.id, title: s.title, prs: sorted };
		}),
	};
}
