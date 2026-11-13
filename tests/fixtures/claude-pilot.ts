/** Scratch file for trying "Fix with Claude". Not used by anything. */
export function pageOf(items: string[], page: number): string[] {
	const size = 10;
	const start = page * size;
	return items.slice(start, start + size);
}
