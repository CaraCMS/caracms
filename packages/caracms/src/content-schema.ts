/**
 * The generated JSON Schemas (M8 Decision 14): one per collection, plus Site Settings and
 * shared blocks, written to `schemas/` (`caracms schemas`, `init`, `validate --fix`, and
 * `astro dev` at start). Each content file names its own with `$schema` (schema-key.ts),
 * so an agent's or a person's editor checks and completes the file as it's typed.
 *
 * They describe the stored shapes (fields.ts, media-value.ts, rich-text.ts, seo.ts),
 * strictly: a key the config doesn't know is refused, as `validate` reports it. They're a
 * help for editing, never the check: `validate` judges content by the config itself
 * (validate.ts), so a stale schema can't pass bad content. JSON Schema draft 2020-12.
 *
 * Pure (no file access): the CLI and the integration write what `siteSchemas` returns.
 */
import type { ResolvedCollection, ResolvedSite } from './config.ts';
import type { Field, Fields } from './fields.ts';
import { siteCollections } from './config.ts';
import { SCHEMA_KEY, schemaFileName } from './schema-key.ts';

type Schema = Record<string, unknown>;

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const string: Schema = { type: 'string' };
const strings: Schema = { type: 'array', items: string };
const size: Schema = { type: 'number', exclusiveMinimum: 0 };
const focal: Schema = { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: 2, maxItems: 2 };

const described = (schema: Schema, field: { label?: string; help?: string }): Schema => ({
	...(field.label ? { title: field.label } : {}),
	...(field.help ? { description: field.help } : {}),
	...schema,
});

/** An object with exactly these keys allowed. */
const closed = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
	type: 'object',
	properties,
	...(required.length ? { required } : {}),
	additionalProperties: false,
});

const image: Schema = closed({ key: { type: 'string', minLength: 1 }, alt: string, decorative: { type: 'boolean' }, focal, w: size, h: size }, ['key']);
const clip: Schema = closed(
	{ video: { type: 'string', minLength: 1 }, play: { enum: ['loop', 'player'] }, poster: { type: 'number', minimum: 0 }, name: string, duration: size, w: size, h: size },
	['video'],
);
/** An image slot with no alt (the brand's logo and icon, the share image). */
const plainImage: Schema = closed({ key: { type: 'string', minLength: 1 }, w: size, h: size, focal }, ['key']);
const seo: Schema = closed({ title: string, description: string, image: plainImage });

function richText(headings: readonly string[], lists = true): Schema {
	const kinds = ['p', ...headings];
	const unit: Schema[] = [
		...kinds.map((k) => closed({ [k]: string }, [k])),
		// M9 Decision 11: a heading rich-text field is paragraphs only.
		...(lists ? ['ul', 'ol'] : []).map((k) => closed({ [k]: strings }, [k])),
	];
	// A plain string reads as rich text too (rich-text.ts → "A plain string is read as rich text").
	return { anyOf: [string, { type: 'array', items: { oneOf: unit } }] };
}

/** A field's stored value (fields.ts → parseField reads it; fieldToJson writes it). */
export function fieldSchema(field: Field): Schema {
	switch (field.kind) {
		case 'text':
			return described(string, field);
		case 'lockup':
			// Decision 10 (M2): the plain list, or `{ lines, phone }` once it has phone lines.
			return described({ anyOf: [strings, closed({ lines: strings, phone: strings }, ['lines'])] }, field);
		case 'select':
			return described({ enum: field.options.map((o) => o.value) }, field);
		case 'richText':
			return described(richText(field.headings, !field.heading), field);
		case 'link':
			return described(field.addressOnly ? closed({ href: string }) : closed({ label: string, href: string }), field);
		case 'buttons':
			return described({ type: 'array', items: closed({ label: string, href: string, style: { enum: field.styles.map((s) => s.value) } }) }, field);
		case 'toggle':
			return described({ type: 'boolean' }, field);
		case 'number':
			return described({ type: ['number', 'null'] }, field);
		case 'date':
			return described({ anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }] }, field);
		case 'reference':
			return described({ type: ['string', 'null'], description: `The path of a document in "${field.to}".` }, field);
		case 'media': {
			const kinds = field.only === 'image' ? [image] : field.only === 'video' ? [clip] : [image, clip];
			return described({ anyOf: [...kinds, { type: 'null' }] }, field);
		}
		case 'list': {
			const items = field.item ? fieldSchema(field.item) : fieldsObject(field.fields ?? {});
			return described({ type: 'array', items }, field);
		}
		case 'group':
			return described(fieldsObject(field.fields), field);
	}
}

/** Fields stored as one object (a group, a list item of several fields), every key optional. */
function fieldsObject(fields: Fields): Schema {
	return closed(Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, fieldSchema(f)])));
}

function blockDefs(site: Pick<ResolvedSite, 'blocks'>): Record<string, Schema> {
	const defs: Record<string, Schema> = {};
	for (const block of Object.values(site.blocks)) {
		const properties: Record<string, Schema> = { type: { const: block.type } };
		for (const [key, f] of Object.entries(block.fields)) properties[key] = fieldSchema(f);
		defs[`block:${block.type}`] = { title: block.label, ...(block.help ? { description: block.help } : {}), ...closed(properties, ['type']) };
	}
	return defs;
}

/** Any of the site's blocks: `{ "type", …its fields }`. */
const anyBlock = (site: Pick<ResolvedSite, 'blocks'>): Schema => ({ anyOf: Object.keys(site.blocks).map((type) => ({ $ref: `#/$defs/block:${type}` })) });

/** A page's entry for a shared block (M5a Decision 8). */
const sharedEntry: Schema = { description: 'A shared block, by its path in content/shared.', ...closed({ shared: { type: 'string', minLength: 1 }, type: string }, ['shared']) };

function document(collection: ResolvedCollection, properties: Record<string, Schema>, required: string[], defs?: Record<string, Schema>): Schema {
	return {
		$schema: DRAFT,
		title: collection.label,
		...closed({ [SCHEMA_KEY]: string, title: string, ...properties }, required),
		...(defs ? { $defs: defs } : {}),
	};
}

/**
 * Edit in context, Decision 3: a page's own header and footer picks, and a slot block's default, on a
 * site whose blocks fill slots (a site with none keeps the schema it had).
 */
function slotProperties(site: Pick<ResolvedSite, 'blocks'>): { frame?: Schema; default?: Schema } {
	const slots = [...new Set(Object.values(site.blocks).map((b) => b.slot).filter((s): s is NonNullable<typeof s> => !!s))];
	if (!slots.length) return {};
	return {
		frame: { description: "The page's own picks for its frame, each a shared block's path; a slot it doesn't name gets the site's default.", ...closed(Object.fromEntries(slots.map((s) => [s, { type: 'string', minLength: 1 }]))) },
		default: { description: "This shared block is its slot's default: pages that don't pick one get it.", const: true },
	};
}

/** A collection's schema (`schemas/<collection>.schema.json`, or the reserved two's names). */
export function collectionSchema(site: Pick<ResolvedSite, 'blocks'> & Partial<Pick<ResolvedSite, 'collections'>>, collection: ResolvedCollection): Schema {
	const own = Object.fromEntries(Object.entries(collection.fields ?? {}).map(([key, f]) => [key, fieldSchema(f)]));
	const { frame, default: isDefault } = slotProperties(site);
	switch (collection.kind) {
		case 'sections':
			// M9 Decision 7: `hidden: true` keeps the page off the site; absent, it's shown.
			const hidden: Schema = { description: 'Hidden from the site: not served, not in the sitemap, still edited in /admin.', const: true };
			// Collections under pages (Decision 5): a page of a collection some collection's heldBy names may hold one of them.
			const holdable = Object.values(site.collections ?? {}).filter((c) => c.heldBy === collection.name).map((c) => c.name);
			const holds: Schema | null = holdable.length ? { description: 'The collection this page holds: its documents are at this page\'s address + their slug.', enum: holdable } : null;
			return document(collection, { hidden, ...(holds ? { holds } : {}), ...(frame ? { frame } : {}), ...own, blocks: { type: 'array', items: { anyOf: [{ $ref: '#/$defs/shared' }, anyBlock(site)] } }, seo }, ['title', 'blocks'], { shared: sharedEntry, ...blockDefs(site) });
		case 'fields':
			return document(collection, { ...(frame ? { frame } : {}), ...own, seo }, ['title']);
		case 'shared':
			return document(collection, { ...(isDefault ? { default: isDefault } : {}), block: anyBlock(site) }, ['title', 'block'], blockDefs(site));
		case 'settings':
			return document(
				collection,
				{
					editors: { ...strings, description: 'The email addresses of the people who can sign in to the editor.' },
					brand: closed({ name: string, accent: string, logo: { anyOf: [plainImage, { type: 'null' }] }, icon: { anyOf: [plainImage, { type: 'null' }] } }),
					seo,
					googleTag: string,
					formRecipients: { type: 'object', additionalProperties: strings },
					redirects: { type: 'array', items: closed({ from: string, to: string }, ['from', 'to']) },
					pageOrder: { type: 'object', additionalProperties: strings, description: "The Pages tree's order in the editor: a parent's path (\"\" for the top level) → its children's slugs. Written by Arrange pages." },
					pageFolders: {
						type: 'object',
						additionalProperties: { type: 'array', items: closed({ id: string, name: { type: 'string', minLength: 1, maxLength: 60 }, pages: strings }, ['id', 'name', 'pages']) },
						description: "The Pages tree's folders in the editor (they never change an address): a level's path (\"\" for the top level) → its folders, each { id, name, pages }. A folder's place is \"(<id>)\" in that level's pageOrder list. Written by Arrange pages.",
					},
					collectionOrder: { type: 'object', additionalProperties: strings, description: "The hand order of each collection with order: 'manual': its name → its documents' paths, first to last. Written by dragging in the editor's list." },
					...own,
				},
				['title'],
			);
	}
}

/** Every schema file's name and schema, in the site's collection order, then shared blocks and Site Settings. */
export function siteSchemas(site: Pick<ResolvedSite, 'blocks' | 'collections'>): Map<string, Schema> {
	const out = new Map<string, Schema>();
	for (const c of siteCollections(site)) out.set(schemaFileName(c), collectionSchema(site, c));
	for (const c of Object.values(site.collections)) if (c.kind === 'shared' || c.kind === 'settings') out.set(schemaFileName(c), collectionSchema(site, c));
	return out;
}

/** A schema file's text. */
export const schemaText = (schema: Schema): string => `${JSON.stringify(schema, null, 2)}\n`;
