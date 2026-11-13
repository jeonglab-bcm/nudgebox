/** Scratch file for trying "Fix with Claude". Not used by anything. */
export function pageOf(rows: string[], page: number, size = 25): string[] {
	if (size < 1) throw new Error("size must be at least 1");
	const start = Math.max(0, page) * size;
	return rows.slice(start, start + size);
}
