/** Scratch file for trying "Fix with Claude". Not used by anything. */
export function pageOf(items: string[], page: number, size = 10): string[] {
	if (size < 1) throw new Error("size must be at least 1");
	const start = page * size;
	return items.slice(start, start + size);
}
