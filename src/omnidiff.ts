/**
 * SPEC 15: diffs two versions of one file with omnidiff (github.com/ivankovic/omnidiff),
 * run as a separate program: `omnidiff --mode json BEFORE AFTER`. The files are written
 * under their real names (omnidiff picks the language from the extension) in a fresh
 * temp folder that is removed afterwards. Ranges come back as rows and UTF-16 columns,
 * the units a page's strings use (omnidiff gives byte columns).
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type DiffSide = { path: string; text: string };
export type Pos = { row: number; col: number };
export type Hunk = { op: "insert" | "delete" | "update" | "move"; from: Pos; to: Pos; target?: { from: Pos; to: Pos } };
export type DiffResult = {
	before: { hunks: Hunk[] };
	after: { hunks: Hunk[] };
	largeResidual: boolean;
	language?: string;
	summary?: "no_changes" | "new_file" | "deleted_file" | "whitespace_only" | "comment_only" | "refactor_moved_only";
};
export type Differ = (before: DiffSide | null, after: DiffSide | null) => Promise<DiffResult>;

type RawRange = { start_row: number; start_column: number; end_row: number; end_column: number };
type RawHunk = { operation: Hunk["op"]; range: RawRange; move_target?: RawRange };

/** Byte column -> UTF-16 column, per row of `text`. */
function columns(text: string) {
	const rows = text.split("\n");
	return (row: number, byteCol: number) => {
		const line = rows[row] ?? "";
		return Buffer.from(line, "utf8").subarray(0, byteCol).toString("utf8").length;
	};
}

export function createOmnidiff(bin = "omnidiff", timeoutMs = 15_000): Differ {
	return async (before, after) => {
		const dir = await mkdtemp(join(tmpdir(), "omnidiff-"));
		try {
			const name = basename((after ?? before)!.path) || "file";
			const files = { before: join(dir, "before", name), after: join(dir, "after", name) };
			await Promise.all([mkdir(join(dir, "before")), mkdir(join(dir, "after"))]);
			await Promise.all([writeFile(files.before, before?.text ?? ""), writeFile(files.after, after?.text ?? "")]);
			const { stdout } = await run(bin, ["--mode", "json", files.before, files.after], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
			const raw = JSON.parse(stdout);
			const col = { before: columns(before?.text ?? ""), after: columns(after?.text ?? "") };
			const range = (side: "before" | "after", r: RawRange) => ({
				from: { row: r.start_row, col: col[side](r.start_row, r.start_column) },
				to: { row: r.end_row, col: col[side](r.end_row, r.end_column) },
			});
			const other = { before: "after", after: "before" } as const;
			const hunks = (side: "before" | "after"): Hunk[] => (raw[side]?.hunks ?? []).map((h: RawHunk) => ({
				op: h.operation, ...range(side, h.range), ...(h.move_target ? { target: range(other[side], h.move_target) } : {}),
			}));
			const out: DiffResult = { before: { hunks: hunks("before") }, after: { hunks: hunks("after") }, largeResidual: Boolean(raw.large_residual) };
			const language = raw.after?.language ?? raw.before?.language;
			if (language) out.language = language;
			if (raw.summary) out.summary = raw.summary;
			else if (!before && after) out.summary = "new_file";
			else if (before && !after) out.summary = "deleted_file";
			return out;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	};
}
