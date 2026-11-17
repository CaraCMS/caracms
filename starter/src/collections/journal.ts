import { date, list, media, reference, text, type BlockData, type SectionsCollectionConfig } from 'caracms/config';
import type { DocumentReader, ReadEntry } from 'caracms/document';

/**
 * The journal (posts and tags, Decisions 6–7): dated posts at /journal/<slug> (the Journal page
 * holds them: `"holds": "journal"` in its file, so they follow its address), each a page of
 * blocks with four page fields, edited in "Journal entry details" (M6c G2). None is required
 * (the package has no required flag), so each has a fallback where it's shown: no date sorts
 * last and shows none, no cover shows no picture, no excerpt shows the title alone.
 */
export const journalFields = {
	date: date({ label: 'Date', help: 'The label on the post and its order. A post goes live when it’s published, whatever its date.' }),
	tags: list(reference({ to: 'tags', label: 'Tag' }), { label: 'Tags' }),
	// As a case study's cover (case-studies.ts): across the post's card at 3:2.
	cover: media({ only: 'image', label: 'Cover image' }),
	excerpt: text({ multiline: true, label: 'Excerpt', help: 'A sentence or two under the title on the post’s card.', max: 200 }),
};

export const journal = {
	kind: 'sections',
	folder: 'content/journal',
	heldBy: 'pages',
	fields: journalFields,
	// Decision 13: the editor's table opens newest first, with the date and tags beside the title.
	columns: ['date', 'tags', 'edited'],
	sort: { column: 'date', order: 'desc' },
} satisfies SectionsCollectionConfig;

export type PostData = BlockData<typeof journalFields>;

/** A post as the listings use it: a journal document read through `cms.read` (or a route's reader). */
export interface Post {
	path: string;
	url: string | null;
	title: string;
	data: PostData;
	/** The document as read, for marking what a card draws as the post's (`cms.of(post.entry)`). */
	entry: ReadEntry;
}

export const asPost = (r: ReadEntry): Post => ({ path: r.path, url: r.url, title: r.title, data: r.data as PostData, entry: r });

// The package's own order for labels (its content.ts), made again here: it isn't exported.
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Decision 7, the post order everywhere (the Posts block, tag pages, previous / next): newest
 * date first, undated after every dated post, ties (the same day, or both undated) by title, A to Z.
 */
export function postOrder(a: Post, b: Post): number {
	const da = a.data.date ?? '';
	const db = b.data.date ?? '';
	if (da !== db) return !da ? 1 : !db ? -1 : db < da ? -1 : 1;
	return collator.compare(a.title, b.title) || collator.compare(a.path, b.path);
}

/** Every post in the post order; with a tag (its path), only the posts that have it. */
export async function journalPosts(read: DocumentReader, tag: string | null = null): Promise<Post[]> {
	const posts = (await read.documents('journal')).map(asPost);
	return (tag ? posts.filter((p) => p.data.tags.includes(tag)) : posts).sort(postOrder);
}

/** A post's tags that exist, in its order, with their titles and addresses (a deleted tag is null in the data, and dropped). */
export async function postTags(read: DocumentReader, post: Pick<Post, 'data'>): Promise<{ title: string; url: string | null; entry: ReadEntry }[]> {
	const found = await Promise.all(post.data.tags.map((path) => (path ? read.document('tags', path) : null)));
	// `entry`: the tag as read, so a tag link can mark itself as the tag's (`cms.of(entry)`).
	return found.filter((t) => t !== null).map((t) => ({ title: t.title, url: t.url, entry: t }));
}

/** A post's page fields from the page component's `data` (render data; a missing field reads as empty). */
export const asPostData = (data: Record<string, unknown>): PostData => ({
	date: typeof data.date === 'string' ? data.date : null,
	tags: Array.isArray(data.tags) ? (data.tags as (string | null)[]) : [],
	cover: (data.cover ?? null) as PostData['cover'],
	excerpt: typeof data.excerpt === 'string' ? data.excerpt : '',
});

/**
 * What a post's page draws around its blocks (Decision 11): its date and tags, and its neighbours
 * in the post order: `older` is the next post down the list (the next-older, or an undated one
 * after the oldest dated), `newer` the one above, found by the post's address (the page component's
 * `path`; the Journal page holds the posts, so their addresses follow it). Null for a post the reader
 * doesn't hold (a preview of a post not yet published reads from the drafts, so it's there).
 */
export async function postFrame(read: DocumentReader, data: PostData, address: string | null) {
	const tags = await postTags(read, { data });
	const posts = await journalPosts(read);
	const at = address === null ? -1 : posts.findIndex((p) => p.url === address);
	return {
		date: data.date,
		tags,
		older: at >= 0 ? (posts[at + 1] ?? null) : null,
		newer: at > 0 ? posts[at - 1]! : null,
	};
}
