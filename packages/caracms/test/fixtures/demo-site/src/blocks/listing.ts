import { text, type BlockConfig, type BlockData } from 'caracms/config';

/**
 * Posts and tags (Decisions 12, 15, 16): a small paged list of journal posts, only for the
 * package's tests of a page number reaching blocks and routes. It isn't in the fixture's own
 * config (the editor's block picker and its mockup diffs stay as they were): `caracms.paged.config.ts`
 * adds it, with a `date` page field on the journal, and `pagedSite()` (test/helpers/site-render.ts)
 * builds a copy on that config.
 */
export const listing = {
	label: 'Paged list',
	component: 'src/blocks/Listing.astro',
	fields: {
		heading: text({ label: 'Heading', heading: true }),
	},
} satisfies BlockConfig;

export type ListingData = BlockData<typeof listing.fields>;

/** Posts on one page of the list. */
export const PAGE_SIZE = 10;

interface Post {
	title: string;
	data: Record<string, unknown>;
}

/** Newest date first, undated last, ties by title. */
export function postOrder(a: Post, b: Post): number {
	const da = typeof a.data.date === 'string' ? a.data.date : '';
	const db = typeof b.data.date === 'string' ? b.data.date : '';
	if (da !== db) return !da ? 1 : !db ? -1 : db.localeCompare(da);
	return a.title.localeCompare(b.title);
}

/** How many pages a list of `count` posts takes (at least 1). */
export const pageCount = (count: number) => Math.max(1, Math.ceil(count / PAGE_SIZE));
