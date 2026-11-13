/**
 * SPEC 16: resolving a PR's conflicts with its base. From the files each side changed since
 * the merge base, works out what a merge of the base into the PR's branch needs: files to
 * take from the base as they are, files to delete, files merged cleanly, and files whose
 * changes overlap (with GitHub's conflict markers), using `git merge-file` as git would.
 * Anything the web editor cannot show (deleted against changed, renames, binary files)
 * is "unsupported": resolve it on the command line, as on GitHub.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedFile, MergeInputs } from "./github.ts";

export type Plan = {
	take: string[];
	remove: string[];
	clean: { path: string; text: string }[]; // both sides changed it, apart
	conflicts: { path: string; text: string; conflicts: number }[];
	unsupported: { path: string; why: string }[];
};

/** A file at a commit: its text, "binary", or null when it is not there. */
export type ReadFile = (ref: string, path: string) => Promise<string | "binary" | null>;

/** git merge-file: [merged text, number of conflicts]. Markers name the branches. */
export async function mergeFile(ours: string, base: string, theirs: string, labels: [string, string, string]): Promise<[string, number]> {
	const dir = await mkdtemp(join(tmpdir(), "nudgebox-merge-"));
	try {
		const f = { ours: join(dir, "ours"), base: join(dir, "base"), theirs: join(dir, "theirs") };
		await Promise.all([writeFile(f.ours, ours), writeFile(f.base, base), writeFile(f.theirs, theirs)]);
		return await new Promise((ok, fail) => {
			execFile("git", ["merge-file", "-p", "-L", labels[0], "-L", labels[1], "-L", labels[2], f.ours, f.base, f.theirs],
				{ maxBuffer: 32 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => {
					const code = err ? (err as { code?: unknown }).code : 0;
					// exit status: the number of conflicts (capped at 127); anything else is an error
					if (typeof code === "number" && code >= 0 && code < 128) ok([stdout, code]);
					else fail(err);
				});
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Lines that are still conflict markers. */
export const hasMarkers = (text: string) => /^(<{7}|>{7})( |$)|^={7}$/m.test(text);

const touched = (files: ChangedFile[]) => {
	const m = new Map<string, ChangedFile>();
	for (const f of files) {
		m.set(f.path, f);
		if (f.previous) m.set(f.previous, f);
	}
	return m;
};

export async function planMerge(m: MergeInputs, read: ReadFile): Promise<Plan> {
	const plan: Plan = { take: [], remove: [], clean: [], conflicts: [], unsupported: [] };
	const head = touched(m.headFiles);
	for (const b of m.baseFiles) {
		const h = head.get(b.path) ?? (b.previous ? head.get(b.previous) : undefined);
		if (!h) {
			// only the base changed it: take the base's version
			if (b.status === "removed") plan.remove.push(b.path);
			else {
				if (b.previous && b.previous !== b.path) plan.remove.push(b.previous);
				plan.take.push(b.path);
			}
			continue;
		}
		if (b.status === "removed" && h.status === "removed") continue;
		if (b.status === "removed" || h.status === "removed") {
			plan.unsupported.push({ path: b.path, why: `deleted in ${b.status === "removed" ? m.baseRef : m.headRef} and changed in ${b.status === "removed" ? m.headRef : m.baseRef}` });
			continue;
		}
		if (b.previous || h.previous || h.path !== b.path) {
			plan.unsupported.push({ path: b.path, why: "renamed in one branch and changed in the other" });
			continue;
		}
		const both = b.status === "added" && h.status === "added";
		const [origin, ours, theirs] = await Promise.all([both ? "" : read(m.mergeBase, b.path), read(m.headSha, b.path), read(m.baseSha, b.path)]);
		if ([origin, ours, theirs].includes("binary")) {
			plan.unsupported.push({ path: b.path, why: "a binary file changed in both branches" });
			continue;
		}
		if (origin === null || ours === null || theirs === null) {
			plan.unsupported.push({ path: b.path, why: "could not read every version of it" });
			continue;
		}
		if (ours === theirs) continue; // the same change on both sides
		const [text, n] = await mergeFile(ours as string, origin as string, theirs as string, [m.headRef, "merge base", m.baseRef]);
		if (n === 0) plan.clean.push({ path: b.path, text });
		else plan.conflicts.push({ path: b.path, text, conflicts: n });
	}
	return plan;
}

/** Pilot only: how many conflict regions a text holds. */
export function countConflicts(text: string): number {
	return text.split("\n").filter((line) => line.startsWith("<<<<<<< ")).length;
}

/** SPEC 16: the workflow that answers, and the words that start it. Both are in the workflow file too. */
export const CLAUDE_WORKFLOW = ".github/workflows/claude-fix-conflicts.yml";
export const CLAUDE_ASK = "@claude fix the merge conflicts";
const CLAUDE_WAIT_MS = 15 * 60_000;

/**
 * Whether Claude was asked and has not answered: the request is the last word on the PR
 * (no comment or commit after it) and is recent. An old one nobody answered does not count.
 */
export function claudeAsked(timeline: { type: string; body?: string; at: string }[], now: number): boolean {
	const said = timeline.filter((i) => i.type === "comment" || i.type === "commit");
	const last = said[said.length - 1];
	return !!last && last.type === "comment" && !!last.body?.startsWith(CLAUDE_ASK) && now - Date.parse(last.at) < CLAUDE_WAIT_MS;
}
