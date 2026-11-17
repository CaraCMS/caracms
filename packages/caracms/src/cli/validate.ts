/**
 * `caracms validate [--fix] [--json]` (M8 Decisions 15–16): the site's content checked
 * against its config itself (never the generated schema files, so a stale schema can't
 * pass bad content), from the site's root, with no server, network or environment.
 *
 * - **Errors** would break a build, lose data, or are files the editor couldn't open: JSON
 *   that doesn't parse, a file in no collection, a file the editor can't open (no title, a
 *   nested `index.json`), an unknown block type or field, a value of the wrong shape (rich
 *   text outside its grammar and a media value with no key among them), a missing required
 *   key (a document's `title`, a page's `blocks`, a shared block's `block`, a block's
 *   `type`), a reference to a document or shared block that isn't there, two documents at
 *   one URL, a document on a code route (Decision 10), a list inside a list inside a list.
 * - **Warnings** are what the editor itself only warns about (fields.ts → fieldWarnings:
 *   half links, links to no page, missing alt text, too many buttons, numbers out of
 *   range…), what renders with a fallback (an unknown select value or button style), a
 *   lockup line too long for its box, schema files out of date, a content file with no
 *   `$schema`, an image with no `w` or `h` (it renders, but can't keep its space while it
 *   loads), and a file the editor's next save would reformat (serialize.ts → savedForm).
 * - **`--fix`** runs `schemas`, then rewrites each content file a save would reformat in
 *   the form a save writes, changing only whitespace, and prints each one.
 *
 * - **Slots** (edit in context, Decisions 2 and 3): a page's `frame` is `{ "header"?, "footer"? }`,
 *   and a shared block's `default` is true or absent (errors otherwise); a pick that falls back to
 *   the default, a slot with no usable default (or two), and a body entry naming a slot's block
 *   (skipped on the page) are warnings, in the words the page's own warning uses (slots.ts).
 *
 * Exit 1 on errors only. Each finding is `file › path.in.the.json: what's wrong`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedCollection, ResolvedSite } from '../config.ts';
import { codeRouteAt, codeRouteMessage, leftBehindMessage, leftBehindRoutes, shadowingMessage, shadowingRoutes, type CodeRoute } from '../code-routes.ts';
import { heldBases } from '../held.ts';
import { pagesRoutes, readCodeRoutes, srcDirOf } from '../code-routes-disk.ts';
import { listDocuments, type DocumentEntry } from '../content.ts';
import { own } from '../document.ts';
import { fieldWarnings, parseDay, richTextOptions, type Field, type Fields, type WarningContext } from '../fields.ts';
import { measureLockup } from '../measure.ts';
import { isFileKey } from '../files.ts';
import { readRichText } from '../rich-text.ts';
import { applyKeyedEdits, savedForm } from '../serialize.ts';
import { isOrderedCollection, unknownOrderEntries, type PageOrder } from '../page-order.ts';
import { isMember, nodePaths, PAGE_FOLDERS_SHAPE, readPageFolders, tokenIdOf, type FolderShapeProblem, type PageFolder, type PageFolders } from '../page-folders.ts';
import { isManual, prunedCollectionOrder, unknownCollectionOrderEntries } from '../collection-order.ts';
import { SITE_SETTINGS_FILE } from '../reserved.ts';
import { SCHEMA_KEY, schemaRef } from '../schema-key.ts';
import { RESERVED_SLUG, sameAddress } from '../slug.ts';
import { hiddenDocuments, hiddenPages } from '../links.ts';
import { resolveSlot, slotDefault, slotEntryMessage, type SlotCandidate } from '../slots.ts';
import { SLOT_NAMES, type SlotName } from '../config.ts';
import { runSchemas, schemaFileChanges, schemasReport } from './schemas.ts';
import { jsonFilesUnder, loadSite } from './site.ts';
import { skillsWarning } from '../../bin/skills.mjs';

export interface Finding {
	/** Relative to the site's root. */
	file: string;
	/** The JSON path, in dot and bracket form (`blocks[2].heading`); `''` for the file itself. */
	path: string;
	message: string;
}

export interface Report {
	errors: Finding[];
	warnings: Finding[];
}

type Site = Pick<ResolvedSite, 'root' | 'collections' | 'blocks' | 'textStyles' | 'phoneLinesWidth'>;

const key = (path: string, k: string) => (path === '' ? k : `${path}.${k}`);
const at = (path: string, i: number) => `${path}[${i}]`;
/** fields.ts's dotted relative paths (`1.href`, `credits.0.name`) in dot and bracket form, under `base`. */
function fromDotted(base: string, dotted: string): string {
	if (dotted === '') return base;
	return dotted.split('.').reduce((p, part) => (/^\d+$/.test(part) ? at(p, Number(part)) : key(p, part)), base);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A value as a person would name it in a sentence. */
function what(v: unknown): string {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'a list';
	switch (typeof v) {
		case 'string':
			return `text (${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)})`;
		case 'number':
			return `the number ${v}`;
		case 'boolean':
			return v ? 'true' : 'false';
		default:
			return 'an object';
	}
}

const quoteList = (values: readonly string[]) => values.map((v) => JSON.stringify(v)).join(', ');

interface Context {
	file: string;
	site: Site;
	report: Report;
	warningContext: WarningContext;
	/** Whether a document exists, for references (and shared entries). */
	exists: (collection: string, path: string) => boolean;
	/** Edit in context: the shared blocks as the slot rules see them. */
	slots: readonly SlotCandidate[];
}

const error = (c: Context, path: string, message: string) => c.report.errors.push({ file: c.file, path, message });
const warning = (c: Context, path: string, message: string) => c.report.warnings.push({ file: c.file, path, message });

/** Keys of `raw` that `known` doesn't have, each an error. */
function unknownKeys(c: Context, raw: Record<string, unknown>, known: readonly string[], path: string, where: string) {
	for (const k of Object.keys(raw)) {
		if (!known.includes(k)) error(c, key(path, k), `"${k}" isn't a field of ${where}. Its fields are ${quoteList(known.filter((n) => n !== SCHEMA_KEY))}.`);
	}
}

const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * A field's stored value against its field: errors for a wrong shape (fields.ts's reader
 * would show it as empty, and the next save of that field would lose it), warnings for
 * what renders with a fallback. `inList`: how many lists this value sits inside.
 */
function checkValue(c: Context, field: Field, raw: unknown, path: string, inList: number) {
	if (raw === undefined) return;
	const wrong = (expected: string) => {
		if (Array.isArray(raw) && inList >= 2) error(c, path, `This is a list inside a list inside a list; lists nest one level at most. Expected ${expected}.`);
		else error(c, path, `Expected ${expected}, found ${what(raw)}.`);
	};
	switch (field.kind) {
		case 'text':
			if (typeof raw !== 'string') wrong('text (a string)');
			return;
		case 'lockup': {
			const plain = strings(raw);
			const withPhone = isObject(raw) && strings(raw.lines) && (raw.phone === undefined || strings(raw.phone)) && Object.keys(raw).every((k) => k === 'lines' || k === 'phone');
			if (!plain && !withPhone) return wrong('a lockup: a list of lines (["First line", "Second line"]), or { "lines": […], "phone": […] }');
			lockupWarnings(c, field.style, raw, path);
			return;
		}
		case 'select':
			if (typeof raw !== 'string') return wrong(`one of ${quoteList(field.options.map((o) => o.value))}`);
			if (!field.options.some((o) => o.value === raw)) {
				warning(c, path, `"${raw}" isn't one of this field's options (${quoteList(field.options.map((o) => o.value))}), so the page shows "${field.default}".`);
			}
			return;
		case 'richText': {
			if (typeof raw !== 'string' && !Array.isArray(raw)) return wrong('rich text: a list of { "p": "…" } entries, or a string');
			// The grammar (rich-text.ts): what the reader couldn't read is lost on the next save.
			const { issues } = readRichText(raw, richTextOptions(field));
			for (const issue of issues) {
				if (issue.code !== 'unreadable') continue;
				const allowed = ['p', ...field.headings, 'ul', 'ol'];
				error(c, at(path, issue.block), `This entry isn't rich text this field can read. Each entry is one of ${allowed.map((k) => `{ "${k}": ${k === 'ul' || k === 'ol' ? '[…]' : '"…"'} }`).join(', ')}.`);
			}
			return;
		}
		case 'link': {
			const keys = field.addressOnly ? ['href'] : ['label', 'href'];
			if (!isObject(raw)) return wrong(field.addressOnly ? 'a link: { "href": "…" }' : 'a link: { "label": "…", "href": "…" }');
			unknownKeys(c, raw, keys, path, 'a link');
			for (const k of keys) if (raw[k] !== undefined && typeof raw[k] !== 'string') error(c, key(path, k), `Expected text (a string), found ${what(raw[k])}.`);
			return;
		}
		case 'buttons': {
			if (!Array.isArray(raw)) return wrong('a list of buttons: [{ "label", "href", "style" }]');
			const styles = field.styles.map((s) => s.value);
			raw.forEach((b, i) => {
				const p = at(path, i);
				if (!isObject(b)) return error(c, p, `Expected a button ({ "label", "href", "style" }), found ${what(b)}.`);
				unknownKeys(c, b, ['label', 'href', 'style'], p, 'a button');
				for (const k of ['label', 'href', 'style']) if (b[k] !== undefined && typeof b[k] !== 'string') error(c, key(p, k), `Expected text (a string), found ${what(b[k])}.`);
				if (typeof b.style === 'string' && !styles.includes(b.style)) warning(c, key(p, 'style'), `"${b.style}" isn't one of the button styles (${quoteList(styles)}), so it shows as "${styles[0]}".`);
			});
			return;
		}
		case 'toggle':
			if (typeof raw !== 'boolean') wrong('true or false');
			return;
		case 'number':
			if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw))) wrong('a number');
			return;
		case 'date':
			if (raw !== null && parseDay(raw) === null) wrong('a date in the form 2026-10-15');
			return;
		case 'reference':
			if (raw === null) return;
			if (typeof raw !== 'string') return wrong(`the path of a document in ${field.to}`);
			if (raw.trim() !== '' && !c.exists(field.to, raw.trim())) error(c, path, `This points at "${raw}", which isn't a document in ${c.site.collections[field.to]?.label ?? field.to}.`);
			return;
		case 'media':
			checkMedia(c, raw, path, wrong);
			return;
		case 'list': {
			if (!Array.isArray(raw)) return wrong('a list');
			raw.forEach((item, i) => {
				const p = at(path, i);
				if (field.item) return checkValue(c, field.item, item, p, inList + 1);
				if (!isObject(item)) {
					if (Array.isArray(item) && inList >= 1) return error(c, p, 'This is a list inside a list inside a list; lists nest one level at most. Expected an item of fields.');
					return error(c, p, `Expected an item of fields (${quoteList(Object.keys(field.fields ?? {}))}), found ${what(item)}.`);
				}
				checkFields(c, field.fields ?? {}, item, p, 'this list\'s items', inList + 1);
			});
			return;
		}
		case 'group':
			if (!isObject(raw)) return wrong(`a group of fields (${quoteList(Object.keys(field.fields))})`);
			checkFields(c, field.fields, raw, path, 'this group', inList);
			return;
	}
}

const MEDIA_IMAGE_KEYS = ['key', 'alt', 'decorative', 'focal', 'w', 'h'];
const MEDIA_CLIP_KEYS = ['video', 'play', 'poster', 'name', 'duration', 'w', 'h'];

function checkMedia(c: Context, raw: unknown, path: string, wrong: (expected: string) => void) {
	if (raw === null) return;
	if (!isObject(raw)) return wrong('an image ({ "key", "alt", … }), a video ({ "video", … }) or null');
	const isClip = raw.video !== undefined && raw.key === undefined;
	if (isClip) {
		if (typeof raw.video !== 'string' || raw.video.trim() === '') error(c, key(path, 'video'), 'A video needs its Mux playback ID in "video".');
		unknownKeys(c, raw, MEDIA_CLIP_KEYS, path, 'a video');
		if (raw.play !== undefined && raw.play !== 'loop' && raw.play !== 'player') error(c, key(path, 'play'), `Expected "loop" or "player", found ${what(raw.play)}.`);
		return;
	}
	if (typeof raw.key !== 'string' || raw.key.trim() === '') return error(c, key(path, 'key'), 'This image has no "key": the bucket key of an image in the media library (`caracms media import` prints it).');
	unknownKeys(c, raw, MEDIA_IMAGE_KEYS, path, 'an image');
	if (raw.alt !== undefined && typeof raw.alt !== 'string') error(c, key(path, 'alt'), `Expected text (a string), found ${what(raw.alt)}.`);
	if (raw.decorative !== undefined && typeof raw.decorative !== 'boolean') error(c, key(path, 'decorative'), `Expected true or false, found ${what(raw.decorative)}.`);
	for (const k of ['w', 'h']) if (raw[k] !== undefined && (typeof raw[k] !== 'number' || !((raw[k] as number) > 0))) error(c, key(path, k), `Expected the size in pixels, found ${what(raw[k])}.`);
	sizeWarning(c, raw, path);
}

/**
 * An adoption trial, item 5: an image with no `w` or `h` still renders, but without its size the page
 * can't reserve its box (no width and height on the `<img>`, media.ts → fluidImage), so the
 * layout shifts as it loads. A file's key (a PDF in a media slot) has no size to give.
 */
function sizeWarning(c: Context, raw: Record<string, unknown>, path: string) {
	if (typeof raw.key !== 'string' || isFileKey(raw.key)) return;
	const missing = ['w', 'h'].filter((k) => raw[k] === undefined);
	if (!missing.length) return;
	const which = missing.length === 2 ? '"w" or "h"' : `"${missing[0]}"`;
	warning(c, path, `This image (${raw.key}) has no ${which}, its size in pixels, so the page can't keep its space while it loads. \`caracms media import <the image's file>\` prints its key with "w" and "h": add them here.`);
}

/** A lockup line that can't stay at its style's smallest size even across a whole phone (or, for main lines over phone lines, across the phone-lines width). */
function lockupWarnings(c: Context, styleName: string, raw: unknown, path: string) {
	const style = own(c.site.textStyles, styleName);
	if (!style) return;
	const lines = Array.isArray(raw) ? (raw as string[]) : ((raw as { lines: string[] }).lines ?? []);
	const phone = Array.isArray(raw) ? null : ((raw as { phone?: string[] }).phone ?? null);
	const sets: [string, string[], number][] = phone?.length ? [['lines', lines, c.site.phoneLinesWidth], ['phone', phone, 375]] : [['', lines, 375]];
	for (const [part, set, widthPx] of sets) {
		const measured = measureLockup(set, style);
		const p = part ? key(path, part) : path;
		if (measured.longest > 0 && widthPx / measured.longest < style.minSizePx) {
			warning(c, p, `The longest line is too long for its box: even ${widthPx}px wide it would be under ${style.minSizePx}px, ${style.name}'s smallest size. Break it into shorter lines${part === '' ? ' or add phone lines' : ''}.`);
		}
		const uncovered = measured.uncovered;
		if (uncovered.length) warning(c, p, `${quoteList(uncovered)} ${uncovered.length === 1 ? "isn't" : "aren't"} in ${style.name}'s font, so the line may not fit.`);
	}
}

/** An object of fields: unknown keys are errors; each field's value is checked, then the editor's own warnings. */
function checkFields(c: Context, fields: Fields, raw: Record<string, unknown>, path: string, where: string, inList: number, extra: readonly string[] = []) {
	unknownKeys(c, raw, [...extra, ...Object.keys(fields)], path, where);
	for (const [k, f] of Object.entries(fields)) {
		if (!Object.hasOwn(raw, k)) continue;
		checkValue(c, f, raw[k], key(path, k), inList);
		editorWarnings(c, f, raw[k], key(path, k));
	}
}

/** The editor's field warnings (fields.ts), minus what the shape checks already reported. */
function editorWarnings(c: Context, field: Field, raw: unknown, path: string) {
	// Nested fields are reached through their own checkFields call: only this field's own here.
	if (field.kind === 'group' || (field.kind === 'list' && !field.item)) {
		for (const w of fieldWarnings(field, raw, c.warningContext)) if (w.path === '' && (w.code === 'too-few' || w.code === 'too-many')) warning(c, path, w.message);
		return;
	}
	for (const w of fieldWarnings(field, raw, c.warningContext)) {
		const p = fromDotted(path, w.path);
		if (w.code === 'unreadable' || w.code === 'missing-reference') continue;
		// Rich text outside the field's grammar (an h1, a heading or a link the field doesn't take) is an error: Decision 15.
		if (w.code === 'disallowed-kind' || w.code === 'link-off' || w.code === 'italic-off') error(c, p, w.message);
		else warning(c, p, w.message);
	}
}

function checkBlock(c: Context, raw: unknown, path: string, collection: ResolvedCollection | null) {
	if (!isObject(raw)) return error(c, path, `Expected a block ({ "type": "…", … }), found ${what(raw)}.`);
	if (Object.hasOwn(raw, 'shared') && collection) {
		if (typeof raw.shared !== 'string' || raw.shared.trim() === '') return error(c, key(path, 'shared'), 'Expected the path of a shared block.');
		unknownKeys(c, raw, ['shared', 'type'], path, 'a shared block\'s entry');
		if (!c.exists('shared', raw.shared)) error(c, key(path, 'shared'), `There's no shared block "${raw.shared}" (content/shared/${raw.shared}.json).`);
		// Edit in context, Decision 2: a slot's block in the body is skipped on the page.
		const slotted = c.slots.find((s) => s.path === raw.shared && s.slot);
		if (slotted) warning(c, key(path, 'shared'), slotEntryMessage(slotted.title || slotted.path, slotted.slot!));
		return;
	}
	if (typeof raw.type !== 'string' || raw.type === '') return error(c, key(path, 'type'), `This block has no "type". The site's blocks are ${quoteList(Object.keys(c.site.blocks))}.`);
	const block = own(c.site.blocks, raw.type);
	if (!block) return error(c, key(path, 'type'), `There's no block type "${raw.type}". The site's blocks are ${quoteList(Object.keys(c.site.blocks))}.`);
	checkFields(c, block.fields, raw, path, `the ${block.label} block`, 0, ['type']);
}

const SEO_KEYS = ['title', 'description', 'image'];
function checkSeo(c: Context, raw: unknown, path: string) {
	if (raw === undefined) return;
	if (!isObject(raw)) return error(c, path, `Expected { "title", "description", "image" }, found ${what(raw)}.`);
	unknownKeys(c, raw, SEO_KEYS, path, 'seo');
	for (const k of ['title', 'description']) if (raw[k] !== undefined && typeof raw[k] !== 'string') error(c, key(path, k), `Expected text (a string), found ${what(raw[k])}.`);
	if (raw.image !== undefined && raw.image !== null) {
		if (!isObject(raw.image) || typeof raw.image.key !== 'string' || raw.image.key.trim() === '') error(c, key(path, 'image'), 'The share image needs the "key" of an image in the media library.');
	}
}

function checkDocument(c: Context, collection: ResolvedCollection, raw: unknown) {
	if (!isObject(raw)) return error(c, '', `Expected a JSON object, found ${what(raw)}.`);
	const own = collection.fields ?? {};
	if (raw[SCHEMA_KEY] !== undefined && typeof raw[SCHEMA_KEY] !== 'string') error(c, SCHEMA_KEY, 'Expected the relative path of its schema file.');
	if (raw.title !== undefined && typeof raw.title !== 'string') error(c, 'title', `Expected text (a string), found ${what(raw.title)}.`);
	switch (collection.kind) {
		case 'sections': {
			checkFields(c, own, raw, '', `a ${collection.label} page`, 0, [SCHEMA_KEY, 'title', 'hidden', 'holds', 'frame', 'blocks', 'seo']);
			checkFrame(c, raw.frame);
			// M9 Decision 7.
			if (raw.hidden !== undefined && raw.hidden !== true) error(c, 'hidden', `Expected true (hidden from the site) or no "hidden" at all, found ${what(raw.hidden)}.`);
			if (raw.holds !== undefined) checkHolds(c, collection, raw.holds);
			if (!Object.hasOwn(raw, 'blocks')) error(c, 'blocks', 'This page has no "blocks". Every page has a list of blocks, even an empty one ([]).');
			else if (!Array.isArray(raw.blocks)) error(c, 'blocks', `Expected a list of blocks, found ${what(raw.blocks)}.`);
			else raw.blocks.forEach((b, i) => checkBlock(c, b, at('blocks', i), collection));
			checkSeo(c, raw.seo, 'seo');
			return;
		}
		case 'fields':
			checkFields(c, own, raw, '', `a ${collection.label} document`, 0, [SCHEMA_KEY, 'title', 'frame', 'seo', 'holds']);
			checkFrame(c, raw.frame);
			if (raw.holds !== undefined) error(c, 'holds', HOLDS_ON_A_PAGE);
			checkSeo(c, raw.seo, 'seo');
			return;
		case 'shared':
			unknownKeys(c, raw, [SCHEMA_KEY, 'title', 'default', 'block', 'holds'], '', 'a shared block');
			if (raw.default !== undefined && raw.default !== true) error(c, 'default', `Expected true (its slot's default) or no "default" at all, found ${what(raw.default)}.`);
			if (raw.holds !== undefined) error(c, 'holds', HOLDS_ON_A_PAGE);
			if (!Object.hasOwn(raw, 'block')) error(c, 'block', 'This shared block has no "block".');
			else checkBlock(c, raw.block, 'block', null);
			return;
		case 'settings': {
			checkFields(c, own, raw, '', 'Site Settings', 0, [SCHEMA_KEY, 'title', 'editors', 'brand', 'seo', 'googleTag', 'formRecipients', 'redirects', 'pageOrder', 'pageFolders', 'collectionOrder', 'holds']);
			if (raw.holds !== undefined) error(c, 'holds', HOLDS_ON_A_PAGE);
			if (raw.editors !== undefined && !strings(raw.editors)) error(c, 'editors', `Expected a list of email addresses, found ${what(raw.editors)}.`);
			if (raw.brand !== undefined) {
				if (!isObject(raw.brand)) error(c, 'brand', `Expected { "name", "accent", "logo", "icon" }, found ${what(raw.brand)}.`);
				else {
					unknownKeys(c, raw.brand, ['name', 'accent', 'logo', 'icon'], 'brand', 'the brand');
					for (const k of ['name', 'accent']) if (raw.brand[k] !== undefined && typeof raw.brand[k] !== 'string') error(c, key('brand', k), `Expected text (a string), found ${what(raw.brand[k])}.`);
					for (const k of ['logo', 'icon']) {
						const v = raw.brand[k];
						if (v !== undefined && v !== null && (!isObject(v) || typeof v.key !== 'string' || v.key.trim() === '')) error(c, key('brand', k), 'Expected an image from the media library ({ "key", "w", "h" }) or null.');
						else if (isObject(v)) sizeWarning(c, v, key('brand', k));
					}
				}
			}
			checkSeo(c, raw.seo, 'seo');
			if (raw.googleTag !== undefined && typeof raw.googleTag !== 'string') error(c, 'googleTag', `Expected a tag ID (text), found ${what(raw.googleTag)}.`);
			if (raw.formRecipients !== undefined && !(isObject(raw.formRecipients) && Object.values(raw.formRecipients).every(strings))) {
				error(c, 'formRecipients', 'Expected { "<form id>": ["address", …] }.');
			}
			if (raw.redirects !== undefined && !(Array.isArray(raw.redirects) && raw.redirects.every((r) => isObject(r) && typeof r.from === 'string' && typeof r.to === 'string'))) {
				error(c, 'redirects', 'Expected a list of { "from": "/old", "to": "/new" }.');
			}
			if (raw.pageOrder !== undefined && !(isObject(raw.pageOrder) && Object.values(raw.pageOrder).every(strings))) {
				error(c, 'pageOrder', 'Expected { "<parent path>": ["slug", …] }.');
			}
			// Page folders (the spec's table, first row): a level with a bad shape is an error; the reader ignores that level's folders.
			if (Object.hasOwn(raw, 'pageFolders')) for (const p of readPageFolders(raw.pageFolders).problems) error(c, folderPath(p.level), folderShapeMessage(p));
			if (raw.collectionOrder !== undefined && !(isObject(raw.collectionOrder) && Object.values(raw.collectionOrder).every(strings))) {
				error(c, 'collectionOrder', 'Expected { "<collection>": ["path", …] }.');
			}
			return;
		}
	}
}

/**
 * Edit in context, Decision 3: a page's `frame`, `{ "header"?: "<shared path>", "footer"?: … }`; a
 * pick the page can't use (missing, unknown type, not of that slot) is a warning: it gets the default.
 */
function checkFrame(c: Context, frame: unknown) {
	if (frame === undefined) return;
	if (!isObject(frame)) return error(c, 'frame', `Expected { "header": "…", "footer": "…" } (the page's own picks), found ${what(frame)}.`);
	unknownKeys(c, frame, SLOT_NAMES, 'frame', "the page's frame");
	for (const slot of SLOT_NAMES) {
		const pick = frame[slot];
		if (pick === undefined) continue;
		if (typeof pick !== 'string' || pick === '') {
			error(c, key('frame', slot), `Expected the path of a shared ${slot} (text), found ${what(pick)}.`);
			continue;
		}
		for (const w of resolveSlot(slot, pick, c.slots).warnings) if (w.problem !== 'two-defaults' && w.problem !== 'no-default' && w.problem !== 'default-unusable') warning(c, key('frame', slot), w.message);
	}
}

/** Edit in context: the shared blocks as the slot rules see them, read from their files (unreadable ones left out). */
function slotCandidates(site: Site, entries: readonly DocumentEntry[]): SlotCandidate[] {
	const out: SlotCandidate[] = [];
	for (const e of entries) {
		if (e.collection !== 'shared' || e.warning) continue;
		try {
			const raw = JSON.parse(readFileSync(join(site.root, e.file), 'utf8')) as unknown;
			const block = isObject(raw) && isObject(raw.block) ? raw.block : {};
			const type = typeof block.type === 'string' ? block.type : '';
			const known = own(site.blocks, type);
			out.push({ path: e.path, title: e.title, type, known: !!known, slot: known?.slot, default: isObject(raw) && raw.default === true });
		} catch {
			/* reported as the file's own error */
		}
	}
	return out;
}

/** Collections under pages (Decision 13): `"holds"` on anything but a page. */
const HOLDS_ON_A_PAGE = '"holds" is for a page: it says which collection\'s documents sit under the page\'s address. Only a page of the collection that collection\'s heldBy names can hold one. Take it out.';

/**
 * Decision 13: a page's `"holds"` names a collection whose `heldBy` is this page's collection.
 * Home holding one, and two pages holding one, are the collection's problems (held.ts), reported on their files by validateSite.
 */
function checkHolds(c: Context, collection: ResolvedCollection, holds: unknown) {
	if (typeof holds !== 'string') return error(c, 'holds', `Expected a collection's key (text), like "journal", found ${what(holds)}.`);
	const held = own(c.site.collections, holds);
	if (!held || !held.heldBy) {
		const heldOnes = Object.values(c.site.collections).filter((h) => h.heldBy === collection.name).map((h) => `"${h.name}"`);
		return error(c, 'holds', `"holds" names "${holds}", which isn't a collection a page holds${heldOnes.length ? ` (a ${collection.label} page can hold ${heldOnes.join(' or ')})` : ''}. A collection is held when its config says heldBy: '${collection.name}'.`);
	}
	if (held.heldBy !== collection.name) error(c, 'holds', `${held.label} is held by a page of ${c.site.collections[held.heldBy]?.label ?? held.heldBy} (its heldBy), not of ${collection.label}. Move "holds" to a page there.`);
}

/** Every finding for the site's content. `codeRoutes`: the site's own (default: read from its src/pages). */
export async function validateSite(site: Site, codeRoutes: readonly CodeRoute[] = readCodeRoutes(site.root, srcDirOf(site.root), Object.values(site.collections))): Promise<Report> {
	const report: Report = { errors: [], warnings: [] };
	const entries = await listDocuments(site);
	const ids = new Set(entries.map((e) => `${e.collection}\0${e.path}`));
	const exists = (collection: string, path: string) => ids.has(`${collection}\0${path}`);
	const warningContext: WarningContext = { addresses: entries.map((e) => e.url), documentExists: exists, codeRoutes, hiddenPages: hiddenPages(entries), hiddenDocuments: hiddenDocuments(entries) };
	const slots = slotCandidates(site, entries);
	// Edit in context, Decisions 2 and 3: each slot the site's blocks fill has one usable default.
	const usedSlots = new Set(Object.values(site.blocks).map((b) => b.slot).filter((s): s is SlotName => !!s));
	for (const slot of SLOT_NAMES) {
		if (!usedSlots.has(slot)) continue;
		for (const w of slotDefault(slot, slots).warnings) {
			const holder = w.problem === 'no-default' ? null : slots.find((s) => s.default && (s.slot === slot || !s.known));
			const file = holder ? entries.find((e) => e.collection === 'shared' && e.path === holder.path)!.file : site.collections.shared!.folder;
			report.warnings.push({ file, path: holder ? 'default' : '', message: w.message });
		}
	}

	// Files in no collection: under content/ and every collection's folder.
	const listed = new Set(entries.map((e) => e.file));
	const scanned = new Set<string>();
	for (const dir of [join(site.root, 'content'), ...Object.values(site.collections).map((c) => c.dir)]) {
		for (const file of jsonFilesUnder(site.root, dir)) scanned.add(file);
	}
	for (const file of [...scanned].sort()) {
		if (!listed.has(file)) report.errors.push({ file, path: '', message: "This file isn't in any collection, so nothing reads it. Move it into a collection's folder, or delete it." });
	}

	// A second route with parameters at a collection's base hides its documents (code-routes.ts → one per base).
	const routes = pagesRoutes(site.root, srcDirOf(site.root));
	for (const s of shadowingRoutes(routes, Object.values(site.collections))) {
		report.errors.push({ file: s.route.file, path: '', message: shadowingMessage(s) });
	}

	// Collections under pages (Decision 13): a held collection with no addresses, its sentence on each file it names.
	const bases = heldBases(site.collections, entries);
	const held: { name: string; label: string; base: string; holder: string }[] = [];
	for (const base of Object.values(bases)) {
		const collection = site.collections[base.collection]!;
		if (base.base && base.holder) held.push({ name: collection.name, label: collection.label, base: base.base, holder: base.holder.label });
		if (!base.problem) continue;
		const holders = entries.filter((e) => e.collection === collection.heldBy && e.holds === collection.name).map((e) => e.file);
		for (const file of holders.length ? holders : [collection.folder]) report.errors.push({ file, path: holders.length ? 'holds' : '', message: base.problem });
	}
	// Decision 14: a route left at a held base serves those addresses ahead of the catch-all.
	const leftBehind = leftBehindRoutes(routes, held);
	for (const left of leftBehind) report.errors.push({ file: left.route.file, path: '', message: leftBehindMessage(left) });

	const urls = new Map<string, DocumentEntry>();
	for (const entry of entries) {
		const c: Context = { file: entry.file, site, report, warningContext, exists, slots };
		const collection = site.collections[entry.collection]!;
		if (entry.warning) {
			if (entry.warning.code === 'no-title') error(c, 'title', 'This document has no "title", so it has no page on the site. Add one.');
			else error(c, '', entry.warning.message);
			if (entry.warning.code !== 'no-title') continue;
		}
		let text: string;
		try {
			text = readFileSync(join(site.root, entry.file), 'utf8');
		} catch {
			continue;
		}
		const raw = JSON.parse(text) as unknown;
		checkDocument(c, collection, raw);
		// M9 Decision 7: as in Tina, the home page can't be hidden (content.ts reads it as shown).
		if (collection.kind === 'sections' && entry.path === 'index' && isObject(raw) && raw.hidden === true) warning(c, 'hidden', 'The home page can’t be hidden, so it’s shown. Remove "hidden".');
		if (isObject(raw) && raw[SCHEMA_KEY] === undefined) warning(c, '', `This file has no "$schema" (${JSON.stringify(schemaRef(collection, entry.file))}). \`caracms validate --fix\` adds it.`);
		const saved = savedForm(text, collection, site);
		if (saved !== null && saved !== text) warning(c, '', REFORMAT_MESSAGE);
		if (entry.url !== null) {
			const route = codeRouteAt(entry.url, codeRoutes);
			// A route left at a held base is reported once, on the route (above), not on every document under it.
			if (route && !leftBehind.some((l) => l.route.file === route.file)) error(c, '', `${codeRouteMessage(entry.url, route)} Delete ${route.file} if this document replaces it, or move the document.`);
			const same = sameAddress(entry.url);
			const first = urls.get(same);
			if (first) {
				// Decision 8: a clash is an error on both files (each names the other).
				error(c, '', `${first.file} is at ${entry.url} too. Two documents can't share an address: move one.`);
				report.errors.push({ file: first.file, path: '', message: `${entry.file} is at ${entry.url} too. Two documents can't share an address: move one.` });
			} else urls.set(same, entry);
		}
	}

	// Arrange pages (Decision 6) and page folders (the spec's table): what the saved order and folders name that the reader ignores.
	const layout = pageLayout(savedOrderOf(site), savedFoldersOf(site), orderedPaths(site, entries));
	for (const w of layout.warnings) report.warnings.push({ file: SITE_SETTINGS_FILE, ...w });

	// Review gaps (Decision 2): a hand order's entry that names no manual collection or no entry of it (the reader ignores it).
	const hand = savedOrderOf(site, 'collectionOrder');
	if (hand) {
		for (const u of unknownCollectionOrderEntries(hand, manualPaths(site, entries))) {
			const label = site.collections[u.collection]?.label;
			report.warnings.push({
				file: SITE_SETTINGS_FILE,
				path: `collectionOrder[${JSON.stringify(u.collection)}]`,
				message:
					u.path === null
						? `The hand order names "${u.collection}", which ${label ? `(${label}) has no order: 'manual'` : "isn't one of the site's collections"}. \`caracms validate --fix\` prunes it.`
						: `The order of ${label} names "${u.path}", which isn't one of its entries any more. \`caracms validate --fix\` prunes it.`,
			});
		}
	}

	for (const change of schemaFileChanges(site)) {
		report.warnings.push({
			file: change.file,
			path: '',
			message: change.text === null ? 'The config no longer makes this schema. `caracms schemas` removes it.' : change.before === null ? 'This schema file is missing. `caracms schemas` writes it.' : "This schema file is out of date with caracms.config.ts. `caracms schemas` rewrites it.",
		});
	}
	// The skills init copied in (bin/skills.mjs), when the installed caracms has newer ones. A warning: old docs never fail a pull request.
	const skills = skillsWarning(site.root);
	if (skills) report.warnings.push({ file: '.claude/skills', path: '', message: skills });
	return report;
}

/** The Pages collection's paths (page-order.ts → isOrderedCollection). */
const orderedPaths = (site: Pick<ResolvedSite, 'collections'>, entries: readonly DocumentEntry[]) =>
	entries.filter((e) => isOrderedCollection(site.collections[e.collection]!)).map((e) => e.path);

/** Each manual collection's paths (review gaps, Decision 1), for its hand order. */
function manualPaths(site: Pick<ResolvedSite, 'collections'>, entries: readonly DocumentEntry[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const c of Object.values(site.collections)) if (isManual(c)) out.set(c.name, []);
	for (const e of entries) out.get(e.collection)?.push(e.path);
	return out;
}

/** Site Settings' `pageOrder` (or `collectionOrder`) as the file has it, or null (no file, no key, or it doesn't parse). */
function savedOrderOf(site: Pick<ResolvedSite, 'root'>, key: 'pageOrder' | 'collectionOrder' = 'pageOrder'): Record<string, string[]> | null {
	try {
		const raw = JSON.parse(readFileSync(join(site.root, SITE_SETTINGS_FILE), 'utf8')) as unknown;
		const order = isObject(raw) ? raw[key] : undefined;
		if (!isObject(order) || !Object.values(order).every(strings)) return null;
		return order as Record<string, string[]>;
	} catch {
		return null;
	}
}

/** Site Settings' `pageFolders` as the file has it (undefined: no file, no key, or it doesn't parse). */
function savedFoldersOf(site: Pick<ResolvedSite, 'root'>): unknown {
	try {
		const raw = JSON.parse(readFileSync(join(site.root, SITE_SETTINGS_FILE), 'utf8')) as unknown;
		return isObject(raw) ? raw.pageFolders : undefined;
	} catch {
		return undefined;
	}
}

/** `pageFolders[""]`, `pageFolders["about"][0]`…: a level (null: the whole value), a folder in it, a member of that. */
function folderPath(level: string | null, folder?: number, member?: number): string {
	if (level === null) return 'pageFolders';
	let p = `pageFolders[${JSON.stringify(level)}]`;
	if (folder !== undefined) p = at(p, folder);
	if (member !== undefined) p = at(key(p, 'pages'), member);
	return p;
}

/** The error for a shape problem (the table's first row): the expected shape, then what's wrong. */
function folderShapeMessage(p: FolderShapeProblem): string {
	const detail = p.level === null ? `it ${p.message}` : `at ${whereIs(p.level)}, ${p.message}`;
	const ignored = p.level === null ? 'every folder' : 'this level’s folders';
	return `${PAGE_FOLDERS_SHAPE}; ${detail}. The editor ignores ${ignored} until it’s fixed.`;
}

const whereIs = (level: string) => (level === '' ? 'the top level' : `/${level}`);
const PRUNES = '`caracms validate --fix` prunes it.';

/** What `pageLayout` finds, and the order and folders with each of those pruned. */
export interface PageLayout {
	warnings: { path: string; message: string }[];
	/** The order with what was warned about pruned (null when there's no usable order). */
	order: PageOrder | null;
	/** The folders likewise (null when they can't be written back: none saved, or any shape error, which a write would lose). */
	folders: PageFolders | null;
	orderPruned: number;
	foldersPruned: number;
}

/**
 * Arrange pages (Decision 6) and page folders (the spec's table "What `validate` and the reader
 * do with `pageFolders`"): a warning for each thing the reader ignores, and the order and folders
 * with those things pruned (`--fix`). Shape errors are checkDocument's. A token naming a folder
 * (drawn or not, or at a level whose shape is wrong) is never pruned, except with its own folder
 * when that folder has nothing to show.
 */
export function pageLayout(order: PageOrder | null, rawFolders: unknown, paths: readonly string[]): PageLayout {
	const warnings: PageLayout['warnings'] = [];
	const { folders, problems } = readPageFolders(rawFolders);
	const wholeBroken = problems.some((p) => p.level === null);
	const known = nodePaths(paths);
	const child = (level: string, slug: string) => (level === '' ? slug : `${level}/${slug}`);

	// The folders, level by level: what each files that the reader ignores.
	const outFolders: PageFolders = {};
	let foldersPruned = 0;
	/** Per level: the slugs filed in a drawn folder (slug → its folder's name), and the ids of folders pruned for having nothing to show. */
	const filed = new Map<string, Map<string, string>>();
	const emptied = new Map<string, Set<string>>();
	for (const [level, list] of Object.entries(folders)) {
		if (level !== '' && !known.has(level)) {
			warnings.push({ path: folderPath(level), message: `Folders are saved for /${level}, where there are no pages, so the editor ignores them. \`caracms validate --fix\` prunes them.` });
			foldersPruned += list.length;
			continue;
		}
		const levelFiled = new Map<string, string>();
		const kept: PageFolder[] = [];
		list.forEach((f, i) => {
			const pages: string[] = [];
			f.pages.forEach((slug, j) => {
				const path = folderPath(level, i, j);
				let message: string | null = null;
				if (!isMember(slug)) message = `The folder "${f.name}" files ${JSON.stringify(slug.slice(0, 120))} in ${whereIs(level)}, which isn't one address part (it's empty or has a "/"), so it names nothing there and the editor ignores it. ${PRUNES}`;
				else if (slug === RESERVED_SLUG) message = `The folder "${f.name}" files "index", the home page, which is never filed, so the editor ignores it. ${PRUNES}`;
				else if (!known.has(child(level, slug))) message = `The folder "${f.name}" files "${slug}" in ${whereIs(level)}, where there's no page or group by that name. ${PRUNES}`;
				else if (levelFiled.has(slug)) message = `"${slug}" is in two folders in ${whereIs(level)}, "${levelFiled.get(slug)}" and "${f.name}"; the first keeps it, so the editor ignores it here. ${PRUNES}`;
				if (message) {
					warnings.push({ path, message });
					foldersPruned++;
					return;
				}
				levelFiled.set(slug, f.name);
				pages.push(slug);
			});
			if (pages.length) kept.push({ ...f, pages });
			else {
				warnings.push({ path: folderPath(level, i), message: `The folder "${f.name}" in ${whereIs(level)} has nothing to show, so the editor doesn't draw it. \`caracms validate --fix\` prunes it and its place in the order.` });
				foldersPruned++;
				let ids = emptied.get(level);
				if (!ids) emptied.set(level, (ids = new Set()));
				ids.add(f.id);
			}
		});
		filed.set(level, levelFiled);
		if (kept.length) outFolders[level] = kept;
	}

	// The order: entries naming nothing, tokens naming no folder, and a filed slug's own entry.
	let outOrder: PageOrder | null = null;
	let orderPruned = 0;
	if (order) {
		/** Every folder id at each level, drawn or not: a token naming one is never pruned (bar its emptied folder's, below). At a level whose shape is wrong (or when the whole value is), every token is left alone. */
		const ids = new Map<string, Set<string>>(Object.entries(folders).map(([level, list]) => [level, new Set(list.map((f) => f.id))]));
		const tokenKnown = (level: string, entry: string) => {
			const id = tokenIdOf(entry);
			return id !== null && (wholeBroken || problems.some((p) => p.level === level) || (ids.get(level)?.has(id) ?? false));
		};
		const asFolders: PageFolders = Object.fromEntries([...ids].map(([level, set]) => [level, [...set].map((id) => ({ id, name: id, pages: [] }))]));
		const drop = new Map<string, Set<string>>();
		const dropAt = (level: string, entry: string) => {
			let set = drop.get(level);
			if (!set) drop.set(level, (set = new Set()));
			set.add(entry);
		};
		const goneLevels = new Set<string>();
		for (const u of unknownOrderEntries(order, paths, asFolders)) {
			const path = `pageOrder[${JSON.stringify(u.key)}]`;
			if (u.slug === null) {
				goneLevels.add(u.key);
				warnings.push({ path, message: `The Pages tree's order names ${whereIs(u.key)}, where there are no pages. ${PRUNES}` });
				continue;
			}
			if (tokenKnown(u.key, u.slug)) continue;
			const id = tokenIdOf(u.slug);
			warnings.push({
				path,
				message:
					id !== null
						? `The Pages tree's order has the folder token "${u.slug}" in ${whereIs(u.key)}, where there's no folder with the id "${id}". ${PRUNES}`
						: `The Pages tree's order names "${u.slug}" in ${whereIs(u.key)}, where there's no page or group by that name. ${PRUNES}`,
			});
			dropAt(u.key, u.slug);
		}
		for (const [level, list] of Object.entries(order)) {
			if (goneLevels.has(level)) continue;
			const levelFiled = filed.get(level);
			const levelEmptied = emptied.get(level);
			for (const entry of new Set(list)) {
				const name = levelFiled?.get(entry);
				if (name !== undefined) {
					warnings.push({ path: `pageOrder[${JSON.stringify(level)}]`, message: `"${entry}" is in the folder "${name}" and listed in ${whereIs(level)}'s order too; the folder gives its place, so the editor ignores the list entry. ${PRUNES}` });
					dropAt(level, entry);
				}
				const id = tokenIdOf(entry);
				// An emptied folder's token goes with it (its warning is the folder's), when the folders can be written back.
				if (id !== null && problems.length === 0 && levelEmptied?.has(id)) dropAt(level, entry);
			}
		}
		outOrder = {};
		for (const [level, list] of Object.entries(order)) {
			if (goneLevels.has(level)) {
				orderPruned += list.length;
				continue;
			}
			const dropped = drop.get(level);
			const kept = dropped ? list.filter((e) => !dropped.has(e)) : list;
			orderPruned += list.length - kept.length;
			if (kept.length) outOrder[level] = kept;
		}
	}

	// Folders are written back only when every level's shape is right (the codec drops a bad level, which would lose it).
	const writable = rawFolders !== undefined && problems.length === 0;
	return { warnings, order: outOrder, folders: writable ? outFolders : null, orderPruned, foldersPruned: writable ? foldersPruned : 0 };
}

/** Arrange pages (Decision 6), page folders: `--fix` takes what the saved order and folders name that the reader ignores out of Site Settings, in one write. Returns how many of each went. */
export async function prunePageLayout(site: Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>): Promise<{ order: number; folders: number }> {
	const settings = Object.values(site.collections).find((c) => c.kind === 'settings');
	if (!settings) return { order: 0, folders: 0 };
	const layout = pageLayout(savedOrderOf(site), savedFoldersOf(site), orderedPaths(site, await listDocuments(site)));
	if (layout.orderPruned === 0 && layout.foldersPruned === 0) return { order: 0, folders: 0 };
	const data: Record<string, unknown> = {};
	if (layout.order && layout.orderPruned) data.pageOrder = layout.order;
	if (layout.folders && layout.foldersPruned) data.pageFolders = layout.folders;
	const file = join(site.root, SITE_SETTINGS_FILE);
	const text = readFileSync(file, 'utf8');
	const raw = JSON.parse(text) as Record<string, unknown>;
	writeFileSync(file, applyKeyedEdits(text, { title: typeof raw.title === 'string' ? raw.title : '', data }, settings));
	return { order: layout.orderPruned, folders: layout.foldersPruned };
}

/** Review gaps (Decision 2): `--fix` takes the hand orders' entries that name nothing out of Site Settings. Returns how many went. */
export async function pruneCollectionOrder(site: Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>): Promise<number> {
	const order = savedOrderOf(site, 'collectionOrder');
	const settings = Object.values(site.collections).find((c) => c.kind === 'settings');
	if (!order || !settings) return 0;
	const { order: kept, pruned } = prunedCollectionOrder(order, manualPaths(site, await listDocuments(site)));
	if (pruned === 0) return 0;
	const file = join(site.root, SITE_SETTINGS_FILE);
	const text = readFileSync(file, 'utf8');
	const raw = JSON.parse(text) as Record<string, unknown>;
	writeFileSync(file, applyKeyedEdits(text, { title: typeof raw.title === 'string' ? raw.title : '', data: { collectionOrder: kept } }, settings));
	return pruned;
}

const pruneReport = ({ order, folders }: { order: number; folders: number }) => {
	const lines = [
		...(order ? [`  pruned ${order} page-order ${order === 1 ? 'entry' : 'entries'} (${SITE_SETTINGS_FILE})`] : []),
		...(folders ? [`  pruned ${folders} page-folder ${folders === 1 ? 'entry' : 'entries'} (${SITE_SETTINGS_FILE})`] : []),
	];
	return lines.length ? `caracms validate --fix:\n${lines.join('\n')}\n` : '';
};
const handPruneReport = (n: number) => (n ? `caracms validate --fix:\n  pruned ${n} hand-order ${n === 1 ? 'entry' : 'entries'} (${SITE_SETTINGS_FILE})\n` : '');

const REFORMAT_MESSAGE = "This file isn't laid out the way the editor saves it (two-space JSON, a trailing newline), so the editor's next save would reformat it and mix the two. `caracms validate --fix` rewrites it the editor's way, changing no values.";

/**
 * An adoption trial, item 7: every content file the editor can open rewritten in the form a save
 * writes (serialize.ts → savedForm), only whitespace changing. Returns the files changed.
 */
export async function reformatContent(site: Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>): Promise<string[]> {
	const changed: string[] = [];
	for (const entry of await listDocuments(site)) {
		if (entry.warning) continue;
		const file = join(site.root, entry.file);
		let text: string;
		try {
			text = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const saved = savedForm(text, site.collections[entry.collection]!, site);
		if (saved === null || saved === text) continue;
		writeFileSync(file, saved);
		changed.push(entry.file);
	}
	return changed;
}

const reformatReport = (files: readonly string[]) =>
	files.length ? `caracms validate --fix:\n${files.map((f) => `  reformatted ${f} (as the editor saves it)`).join('\n')}\n` : '';

const line = (f: Finding) => `${f.file}${f.path ? ` › ${f.path}` : ''}: ${f.message}`;

/** The plain report: errors, then warnings, then a count. */
export function formatReport(report: Report): string {
	const parts: string[] = [];
	if (report.errors.length) parts.push(`Errors:\n${report.errors.map((f) => `  ${line(f)}`).join('\n')}`);
	if (report.warnings.length) parts.push(`Warnings:\n${report.warnings.map((f) => `  ${line(f)}`).join('\n')}`);
	const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
	parts.push(report.errors.length || report.warnings.length ? `caracms validate: ${count(report.errors.length, 'error')}, ${count(report.warnings.length, 'warning')}.` : 'caracms validate: no problems.');
	return `${parts.join('\n\n')}\n`;
}

/** The command's entry (bin/caracms.mjs loads this module through the site's Vite). */
export async function command(root: string, options: { fix?: boolean; json?: boolean } = {}): Promise<{ code: number; out: string; err?: string }> {
	const site = await loadSite(root);
	let fixed = '';
	if (options.fix) fixed = schemasReport(await runSchemas(site)) + reformatReport(await reformatContent(site)) + pruneReport(await prunePageLayout(site)) + handPruneReport(await pruneCollectionOrder(site));
	const report = await validateSite(site);
	const code = report.errors.length ? 1 : 0;
	if (options.json) return { code, out: `${JSON.stringify(report, null, 2)}\n`, err: options.fix ? fixed : undefined };
	return { code, out: `${options.fix ? `${fixed}\n` : ''}${formatReport(report)}` };
}
