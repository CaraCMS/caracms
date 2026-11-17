import { text, type BlockData, type FieldsCollectionConfig } from 'caracms/config';

/**
 * Tags (posts and tags, Decisions 2, 3, 8): a list-of-fields collection at /tags/<slug>, not
 * under /journal/ (the editor refuses an address under another collection's base). A post
 * picks its tags by reference, so a rename relinks them. A tag's page lists its posts.
 */
export const tags = {
	kind: 'fields',
	folder: 'content/tags',
	urlBase: '/tags/',
	component: 'src/collections/Tag.astro',
	fields: {
		description: text({ multiline: true, label: 'Description', help: 'Optional. Under the tag’s name on its page.' }),
	},
} satisfies FieldsCollectionConfig;

export type TagData = BlockData<typeof tags.fields>;
