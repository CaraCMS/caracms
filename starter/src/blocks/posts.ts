import { number, reference, select, text, type BlockConfig, type BlockData } from 'caracms/config';
import { documentKind, type BlockContext, type DocumentBlock, type DocumentReader, type SiteDocument } from 'caracms/document';
import { journalPosts } from '../collections/journal.ts';
import { band } from './background.ts';

/**
 * The Posts block (posts and tags, Decisions 1, 9, 10): the journal's posts as listing cards,
 * in the post order (collections/journal.ts). One block, two uses: "Latest" shows a few (Home's
 * latest three), "All, a page at a time" is the journal's listing, ten a page, the page's own
 * address first and `<address>/page/<n>` after (pages/[...path].astro makes those). An optional
 * Tag keeps only that tag's posts. One paged Posts block per page: a second one, or a shared one,
 * shows its first ten and no pager (pagingBlockIndex).
 */
export const posts = {
	label: 'Posts',
	component: 'src/blocks/Posts.astro',
	help: 'The journal’s posts as cards, newest first: the latest few, or all of them a page at a time.',
	fields: {
		heading: text({ label: 'Heading', heading: true }),
		show: select({
			label: 'Show',
			options: [
				{ value: 'latest', label: 'Latest' },
				{ value: 'all', label: 'All, a page at a time' },
			],
			default: 'latest',
		}),
		count: number({ label: 'How many', help: 'For Latest. All shows ten a page.', min: 1, max: 12, step: 1 }),
		tag: reference({ to: 'tags', label: 'Tag', help: 'Optional. Only the posts with this tag.' }),
		...band(),
	},
} satisfies BlockConfig;

export type PostsData = BlockData<typeof posts.fields>;

/** Latest's count when it's empty or out of range (the render gets null). */
export const DEFAULT_COUNT = 3;

/** Posts on one page of "All, a page at a time" (fixed, Decision 9). */
export const PAGE_SIZE = 10;

/** How many pages `count` posts take, at least 1. */
export const pageCount = (count: number): number => Math.max(1, Math.ceil(count / PAGE_SIZE));

/** The address of page `n` of a listing at `base` (`/journal`): the base itself for page 1. */
export const pageAddress = (base: string, n: number): string => (n === 1 ? base : `${base === '/' ? '' : base}/page/${n}`);

/**
 * Decision 10's one rule for which block pages, shared by the route (listingPages) and the block
 * (pagesHere), so they can't disagree: the index of a page's first "All, a page at a time" Posts
 * block that isn't a shared entry, or -1. A shared entry is never `known`, so it never pages, and
 * every later All block shows its first ten.
 */
export const pagingBlockIndex = (blocks: readonly DocumentBlock[]): number => blocks.findIndex((b) => b.known && b.shared === undefined && b.type === 'posts' && b.data.show === 'all');

const blocksOf = async (read: DocumentReader, path: string): Promise<readonly DocumentBlock[] | null> => {
	const page = await read.document('pages', path);
	return page && documentKind(page.document) === 'sections' ? (page.document as SiteDocument).blocks : null;
};

/**
 * How many pages a page's listing has (pages/[...path].astro, Decision 10): its paging block's
 * (pagingBlockIndex), over its Tag's posts when the Tag exists. 1 when it has none.
 */
export async function listingPages(read: DocumentReader, path: string): Promise<number> {
	const blocks = (await blocksOf(read, path)) ?? [];
	const paged = blocks[pagingBlockIndex(blocks)];
	if (!paged) return 1;
	const tag = typeof paged.data.tag === 'string' && (await read.exists('tags', paged.data.tag)) ? paged.data.tag : null;
	return pageCount((await journalPosts(read, tag)).length);
}

/**
 * Whether this All block is its page's paging one (Posts.astro): it is when it's the page's
 * pagingBlockIndex, read from its own document in the Pages collection. A public render finds that
 * by its address (`/journal/page/2` is `journal`, `/` and `/page/2` are `index`); a preview by its
 * request (`?collection=pages&path=…`). Never a shared block, on a page or in its own preview, and
 * never a block outside the Pages collection (only pages get `/page/<n>`). A preview with no stored
 * document to check (or no `?collection`) can't tell, so the block pages, as it would alone.
 */
export async function pagesHere(cms: Pick<BlockContext, 'index' | 'preview' | 'shared' | 'read' | 'listPage'>, url: URL): Promise<boolean> {
	if (cms.shared) return false;
	if (cms.preview) {
		const collection = url.searchParams.get('collection');
		if (collection !== null && collection !== 'pages') return false;
		const path = url.searchParams.get('path');
		const blocks = collection && path !== null ? await blocksOf(cms.read, path) : null;
		return blocks ? pagingBlockIndex(blocks) === cms.index : true;
	}
	const address = decodeURIComponent(url.pathname.slice(1).replace(/\/+$/, ''));
	const path = (cms.listPage > 1 ? address.replace(/(^|\/)page\/\d+$/, '') : address) || 'index';
	const blocks = await blocksOf(cms.read, path);
	return !!blocks && pagingBlockIndex(blocks) === cms.index;
}
