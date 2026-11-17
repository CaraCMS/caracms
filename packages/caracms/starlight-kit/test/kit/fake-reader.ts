/** A DocumentReader over a list of pages, in the order given (the reader's tree order). */
import type { DocumentReader, ReadEntry } from 'caracms/document';

export type FakePage = { path: string; title: string; description?: string; hidden?: boolean; blocks?: { type: string; data: Record<string, unknown> }[] };

export function fakeReader(pages: FakePage[]): DocumentReader {
	const entries: ReadEntry[] = pages.map((p) => ({
		collection: 'pages',
		path: p.path,
		url: p.path === 'index' ? '/' : `/${p.path}`,
		title: p.title,
		data: {},
		document: {
			title: p.title,
			...(p.description ? { seo: { description: p.description } } : {}),
			...(p.hidden ? { hidden: true } : {}),
			blocks: (p.blocks ?? []).map((b, i) => ({ source: i, type: b.type, known: true, data: b.data })),
		},
	}));
	return {
		document: async (_c, path) => entries.find((e) => e.path === path) ?? null,
		documents: async () => entries,
		exists: async (_c, path) => entries.some((e) => e.path === path),
	};
}
