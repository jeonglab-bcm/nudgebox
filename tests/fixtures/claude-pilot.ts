/** Scratch file for trying "Fix with Claude". Not used by anything. */
export function pageOf(rows: string[], page: number): string[] {
	const size = 25;
	const start = Math.max(0, page) * size;
	return rows.slice(start, start + size);
}
