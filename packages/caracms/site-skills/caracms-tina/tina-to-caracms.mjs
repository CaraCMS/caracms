#!/usr/bin/env node
/**
 * Tina → caracms: the content conversion (the reference script of the caracms-tina skill).
 *
 * Copy this file into the site's own `scripts/`, adapt the table under "ADAPT HERE", and
 * run it from the site's root against a **built** checkout of the Tina site's `main`:
 *
 *   node scripts/tina-to-caracms.mjs --from <a built Tina checkout> [--to .]
 *        [--recipients <address>] [--scaffold-config [--force]]
 *
 * - `--from` must hold `content/` and `tina/__generated__/_schema.json` (Tina generates the
 *   schema when the site builds: `pnpm build:local` there, or the site's own build).
 * - `--to` is the caracms site's root (default: the current directory). It needs caracms
 *   installed: the script borrows the package's upload key rule, image sniffer and S3 signer
 *   (bin/media.mjs).
 * - `--recipients <address>`: every form's recipients in Site Settings become this one
 *   address. For a branch environment whose test submissions mustn't reach the client.
 *   The run at the switch leaves it out.
 * - `--scaffold-config`: also write a starting `caracms.config.ts` from Tina's schema, with
 *   Tina's labels and help, over `caracms init`'s starting config. It refuses any other
 *   existing config unless `--force`. Do it once: after that the config and the block
 *   components are the site's own, hand-maintained, and a normal run never touches them.
 *   A collection whose template has a page at its base (`pages/products.json` for a `products`
 *   collection) is held by that page only if the adapt table `SITE.holders` says so
 *   (`products: 'products'`): then the scaffold writes `heldBy: 'pages'` in place of `urlBase`,
 *   and every run writes `"holds": "products"` on the page. Not in the table: the collection
 *   keeps `urlBase: '/products/'` (a prefix in code), and the script only prints a hint line
 *   for each sections collection that has a same-named page, saying what to add.
 *
 * WHAT IT OWNS: `content/`, nothing else. Each run deletes `content/` and writes it again
 * from Tina's files, so the same input gives byte-identical output, and a run on newer
 * Tina content leaves nothing of an older run behind. Files are laid out the way the
 * editor saves them (two-space JSON, a media value on one line, rich text one block per
 * line, a list of strings on one line), so `caracms validate` finds nothing to reformat.
 * Beside `content/` it only ever adds to two things:
 *   - `scripts/tina-media-keys.json`, the key map (commit it): each Tina bucket key the
 *     content uses (an image, or a file link's object) → its caracms key, with an image's
 *     `w`/`h`, and the ETag and size its bytes were read at. It's read first; a key missing
 *     from it is read from the bucket once and the file is rewritten, sorted. Tina replaces a
 *     file in place under the same key, so a run with S3_* settings HEADs each mapped key:
 *     when its ETag or size moved (or the entry has none yet), the bytes are read and hashed
 *     again, and a new hash gets a new caracms key and copy. With every key in the map and no
 *     S3_* settings, a run needs no bucket at all (and can't see a replaced file);
 *   - the media bucket: each object is copied to its caracms key,
 *     `uploads/<first 12 hex of the bytes' SHA-256>/<slugified name>.<ext>` (the upload
 *     route's shape, the only one `caracms media push` and the cloud take). A copy is
 *     skipped when its key exists; nothing is ever deleted or overwritten. A run with S3_*
 *     settings checks every copy is there. A key the content uses whose bytes can't be read
 *     (missing from the bucket, or no S3_* settings and not in the map) fails the run, named,
 *     and nothing is written.
 *
 * What the adapt table adds on every run, so a re-run at the switch keeps it: shared blocks
 * (`content/shared/`, moved out of Site Settings or holding words the Tina site's code drew),
 * Site Settings › Forms words (`formWords`), and `redirects` (each old `/files/<name>` to its
 * new file address, and the table's own). `--scaffold-config` also writes the config's
 * `forms` from the Tina site's forms config, each field with its on-page label.
 *
 * How each Tina field kind maps: `field-kinds.md` beside this script (the skill's mapping
 * table). Everything is driven by Tina's schema; nothing below is written per block.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── ADAPT HERE: the site's own choices (everything below this table is generic) ──────────

/**
 * @typedef {object} SharedField One field of a shared block, in the block's order:
 *   `{ from: '<Site Settings path>' }` moves a Site Settings field into the block (its value and,
 *   in a scaffolded config, its field), out of Site Settings;
 *   `{ text: '<words>', label?, help?, lines?, multiline? }` is a word the Tina site had in its
 *   code, now a text field holding it;
 *   `{ link: { label: '<words>', href?: '<address>', hrefFrom?: '<Site Settings path>' }, label?, help? }`
 *   is a link whose words were code and whose address was code or a Site Settings field (moved).
 * @typedef {object} SharedBlock A shared block the Tina site drew from Site Settings or its code.
 * @property {string} title The shared block's title in the editor.
 * @property {string} type Its block key (the config's `blocks`).
 * @property {string} [label] The block's label in a scaffolded config (default: `title`).
 * @property {string} [slot] `header` or `footer`: a frame slot, and this block is its default.
 * @property {Record<string, SharedField>} fields
 * @typedef {object} SiteTable
 * @property {Record<string, string>} blockRenames
 * @property {Record<string, unknown>} fieldDefaults
 * @property {string[]} addressFields
 * @property {string[]} headingFields
 * @property {string[]} docTitleAlt
 * @property {{ pattern: RegExp, sourceKey: (name: string) => string }} fileLinks
 * @property {string} homeFile
 * @property {Record<string, string>} holders
 * @property {Record<string, SharedBlock>} shared
 * @property {Record<string, unknown>} formWords
 * @property {{ from: string, to: string }[]} redirects
 * @property {{ file: string, export: string } | null} formsConfig
 */

/** @type {SiteTable} */
export const SITE = {
	/** Tina template → caracms block key, where it differs from the camelCase → kebab-case rule (`textMedia` → `text-media`). The approved block table. */
	blockRenames: {
		// features: 'steps',
	},
	/**
	 * Values Tina's files leave out but the site's mapper code reads as set (the trial's
	 * TOGGLE_DEFAULT_ON, a per-block background default that isn't the first option).
	 * By schema path: `blocks.<template>.<field>`, `<collection>.<field>`, `siteSettings.<field>`,
	 * nested with dots. Filled into the content when blank, and the select's or toggle's
	 * `default` in a scaffolded config.
	 */
	fieldDefaults: {
		// 'blocks.textMedia.background': 'light',
		// 'jobs.live': true,
	},
	/** Strings that are an address with no words (`link({ addressOnly: true })`), by schema path. A string named `href` always is. */
	addressFields: [
		// 'siteSettings.socials.instagram',
	],
	/** Text fields, by name, whose text is a heading (`heading: true`: it may hold the page's h1). Scaffold only. */
	headingFields: ['heading'],
	/** Images with no `…Alt` sibling that take the document's title as their alt (a client's logo is its name), by schema path. Others are decorative. */
	docTitleAlt: [
		// 'clientLogos.logo',
	],
	/** A file link the Tina site serves itself (`/files/<name>`), and the bucket key it serves it from. */
	fileLinks: { pattern: /^\/files\/([^/?#]+)$/, sourceKey: (name) => `uploads/${name}` },
	/** Tina's home page file (it becomes `index`). */
	homeFile: 'home',
	/**
	 * The collections held by a page (collection key → page file name, without `.json`):
	 * this table is the only source, with no default from names (`products: 'products'`,
	 * `posts: 'blog'`). The scaffold's `heldBy` and every run's `"holds"` both come from it, so
	 * a site ported without an entry is never given a `holds` its config doesn't expect.
	 * The script suggests candidates: a sections collection with a same-named page that isn't
	 * listed here is printed as a line saying what to add.
	 */
	holders: {
		// posts: 'blog',
	},
	/**
	 * Shared blocks (`content/shared/<name>.json`), written on every run: what the Tina site kept
	 * in Site Settings but is one piece's own (a header's menu, a footer's columns), and the words
	 * its code drew that an editor could want to change (each a field holding the code's words).
	 * Moved Site Settings fields leave Site Settings (a group left with nothing goes too).
	 */
	shared: {
		// footer: {
		// 	title: 'Footer',
		// 	type: 'site-footer',
		// 	slot: 'footer',
		// 	fields: {
		// 		columns: { from: 'footer.columns' },
		// 		privacyLink: { link: { label: 'Privacy policy', hrefFrom: 'newsletter.privacyLink' } },
		// 		contactHeading: { text: 'Contact', help: 'Email and phone.' },
		// 	},
		// },
	},
	/**
	 * Site Settings › Forms (`formWords`): only the words the Tina site's code said differently
	 * from caracms's defaults, by form id, in caracms's shape
	 * (`{ fields: { <name>: { label, placeholder, help, error } }, submit, sending, sent: { heading, line }, failed, choose }`).
	 */
	formWords: {
		// contact: { submit: 'Send a message', sent: { line: "Thanks, we'll be in touch." } },
	},
	/**
	 * Redirects for addresses the Tina site served that caracms doesn't, besides each file link's
	 * (written for you). The template's sitemap is `/sitemap-index.xml` (@astrojs/sitemap);
	 * caracms's is `/sitemap.xml`.
	 */
	redirects: [{ from: '/sitemap-index.xml', to: '/sitemap.xml' }],
	/** The Tina site's forms config (the template's `forms.config.mjs`, its `FORMS`), read by `--scaffold-config` for the config's `forms` (null: none). */
	formsConfig: { file: 'forms.config.mjs', export: 'FORMS' },
};

// ── The template's conventions (the same in every site made from it) ────────────────────

const SETTINGS = 'siteSettings';
/** Site Settings' fields that are caracms's own keys, not site fields. */
const OWN_SETTINGS = new Set(['formNotifications', 'adminAccess', 'adminBranding', 'defaultSeo', 'googleTag', 'submissionsLink']);
const KEYS_FILE = 'scripts/tina-media-keys.json';

// ── Names ──────────────────────────────────────────────────────────────────────────────

/** camelCase (or anything else) → kebab-case: `jumpLinks` → `jump-links`, `CTA2` → `cta2`. */
export function kebab(name) {
	return String(name)
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
		.replace(/[^A-Za-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
}

/** A Tina template's caracms block key. */
export const blockKey = (template, site = SITE) => site.blockRenames[template] ?? kebab(template);

/**
 * A Tina-served file link → the bucket key it serves (`sourceKey`) and its name, or null when
 * it isn't one. Its caracms key and address come from the key map once the bytes are read.
 */
export function fileLink(href, site = SITE) {
	if (typeof href !== 'string') return null;
	const m = site.fileLinks.pattern.exec(href);
	if (!m) return null;
	let name;
	try {
		name = decodeURIComponent(m[1]);
	} catch {
		return null;
	}
	if (name.lastIndexOf('.') <= 0) return null;
	return { sourceKey: site.fileLinks.sourceKey(name), name };
}

/** A caracms file key (`uploads/<hash>/<name>.<ext>`) → its address (`/files/<hash>/<name>.<ext>`), as the files route serves it. */
export const fileAddress = (key) => {
	const [, hash, file] = /^uploads\/([0-9a-f]{12})\/(.+)$/.exec(key) ?? [];
	return hash ? `/files/${hash}/${encodeURIComponent(file)}` : null;
};

// ── The field kinds (Tina field → caracms field), from the schema ─────────────────────────

const fieldNames = (f) => (f.fields ?? []).map((g) => g.name);
const optionValues = (f) => f.options.map((o) => (typeof o === 'string' ? o : o.value));
const isImagePair = (f, siblings) => f.type === 'image' && siblings.some((g) => g.name === `${f.name}Alt` && g.type === 'string' && !g.list);
const hasLinkPair = (siblings) => siblings.some((f) => f.name === 'linkLabel' && f.type === 'string') && siblings.some((f) => f.name === 'href' && f.type === 'string');

/**
 * Tina's fields at one level → caracms's, in order: each a spec `{ name, kind, tina, … }`.
 * `at` is the schema path of the level (`blocks.columns.items`). The pairs merge here: an
 * image with its `…Alt` becomes one media field (the alt field goes), and `linkLabel` +
 * `href` become one `link` field where `linkLabel` stood.
 */
export function compileFields(fields, at, site = SITE) {
	const out = [];
	const pair = hasLinkPair(fields);
	for (const f of fields) {
		if (f.type === 'displayOnly' || f.isTitle) continue;
		if (fields.some((g) => isImagePair(g, fields) && f.name === `${g.name}Alt`)) continue;
		if (pair && f.name === 'href') continue;
		if (pair && f.name === 'linkLabel') {
			out.push({ name: 'link', kind: 'link', label: 'Link', pair: true, at: `${at}.link` });
			continue;
		}
		out.push(compileField(f, fields, `${at}.${f.name}`, site));
	}
	return out;
}

/** One Tina field → its spec. */
export function compileField(f, siblings, at, site = SITE) {
	const base = { name: f.name, tina: f, at, label: f.label ?? f.name, help: f.description };
	if (f.type === 'image') {
		const alt = isImagePair(f, siblings) ? `${f.name}Alt` : null;
		return { ...base, kind: 'media', only: 'image', alt, titleAlt: site.docTitleAlt.includes(at) };
	}
	if (f.type === 'object' && !f.list && f.fields?.some((g) => g.name === 'kind') && f.fields?.some((g) => g.name === 'src' && g.type === 'image')) {
		const clips = f.fields.some((g) => g.name === 'playbackId');
		return { ...base, kind: 'media', object: true, only: clips ? undefined : 'image' };
	}
	if (f.type === 'rich-text') {
		const o = f.overrides;
		const headings = o?.headingLevels ? o.headingLevels.map((h) => (typeof h === 'number' ? `h${h}` : String(h))).filter((h) => h === 'h2' || h === 'h3') : ['h2', 'h3'];
		const links = o?.toolbar ? o.toolbar.includes('link') : true;
		return { ...base, kind: 'richText', headings, links };
	}
	if (f.type === 'reference') return { ...base, kind: 'reference', to: f.collections?.[0] };
	if (f.type === 'boolean') return { ...base, kind: 'toggle', default: site.fieldDefaults[at] };
	if (f.type === 'number') return { ...base, kind: 'number' };
	if (f.type === 'datetime') return { ...base, kind: 'date' };
	if (f.type === 'string') {
		if (f.options && f.list) return { ...base, kind: 'list', item: { kind: 'select', options: f.options } };
		if (f.options) return { ...base, kind: 'select', options: f.options, default: site.fieldDefaults[at] };
		if (f.list) return { ...base, kind: 'list', item: { kind: 'text' } };
		if (f.name === 'href' || site.addressFields.includes(at)) return { ...base, kind: 'address' };
		return { ...base, kind: 'text', multiline: f.ui?.component === 'textarea', heading: site.headingFields.includes(f.name) && at.startsWith('blocks.') };
	}
	if (f.type === 'object' && f.list && !f.templates) {
		const names = fieldNames(f).join();
		if (names === 'label,href,style' && f.fields[2].options) return { ...base, kind: 'buttons', styles: optionValues(f.fields[2]) };
		if (names === 'label,href') return { ...base, kind: 'list', item: { kind: 'link' } };
		const inner = compileFields(f.fields, at, site);
		// A list of one-field objects is a list of that field: [{ line: 'a' }] → ['a'].
		if (inner.length === 1 && ['text', 'reference', 'media'].includes(inner[0].kind) && !inner[0].object) return { ...base, kind: 'list', item: inner[0], unwrap: inner[0].name };
		return { ...base, kind: 'list', fields: inner };
	}
	if (f.type === 'object' && !f.list && !f.templates) return { ...base, kind: 'group', fields: compileFields(f.fields, at, site) };
	throw new Error(`${at}: no caracms field for Tina's "${f.type}"${f.list ? ' list' : ''}`);
}

// ── Values ─────────────────────────────────────────────────────────────────────────────

/** An image URL → its bucket key (`uploads/x.jpg`), the part after `s3://<bucket>/`; null when it isn't one. */
export function imageKey(src) {
	if (typeof src !== 'string' || src.trim() === '') return null;
	const m = src.match(/\/plain\/s3:\/\/[^/]+\/([^?#]+)$/) ?? src.match(/^s3:\/\/[^/]+\/([^?#]+)$/);
	if (!m) return null;
	try {
		return decodeURI(m[1]);
	} catch {
		return m[1];
	}
}

/** Tina's inline Markdown → caracms's: Tina's escapes undone (caracms escapes only * [ ] \), its line breaks as `\n`, `_`/`__` as `*`/`**`. */
export function inlineMarkdown(s) {
	return (
		s
			// Tina's two forms of a line break: a trailing backslash, or two spaces.
			.replace(/(?:\\| {2,})\n/g, '\n')
			// Tina escapes punctuation Markdown would read (`Q\&A`, `mailto\:`).
			// Left to right, so an escaped backslash (`\\`) stays one escape.
			.replace(/\\([^\n])/g, (pair, c) => ('*[]\\'.includes(c) ? pair : c))
			.replace(/(^|[^\w\\*])__(?=\S)([^\n]*?\S)__(?!\w)/g, '$1**$2**')
			.replace(/(^|[^\w\\*])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1*$2*')
			.trim()
	);
}

/**
 * One Tina rich-text value (Markdown) → caracms's stored rich text: `[{ "p": … }, { "ul": [ … ] }, { "h2": … }]`.
 * `rewriteHref` turns each link's address (a Tina file link becomes a caracms one).
 */
/** @param {unknown} md @param {{ rewriteHref?: (href: string) => string, warn?: (message: string) => void }} [options] */
export function richText(md, { rewriteHref = (h) => h, warn = () => {} } = {}) {
	if (typeof md !== 'string') return [];
	const out = [];
	const links = (s) => s.replace(/\]\(([^)\s]+)\)/g, (_, href) => `](${rewriteHref(href)})`);
	const unit = (s) => links(inlineMarkdown(s));
	for (const chunk of md.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
		const lines = chunk.split('\n');
		let para = [];
		let list = null;
		const flushPara = () => {
			const text = unit(para.join('\n'));
			if (text) out.push({ p: text });
			para = [];
		};
		const flushList = () => {
			if (list && list.items.length) out.push({ [list.kind]: list.items });
			list = null;
		};
		for (const line of lines) {
			const bullet = /^(\s*)[*+-]\s+(.*)$/.exec(line);
			const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
			const heading = /^(#{1,6})\s+(.*)$/.exec(line);
			if (heading) {
				flushPara();
				flushList();
				const level = heading[1].length;
				if (level === 2 || level === 3) out.push({ [`h${level}`]: unit(heading[2]) });
				else {
					warn(`an h${level} in rich text, kept as a paragraph`);
					out.push({ p: unit(heading[2]) });
				}
			} else if (bullet || numbered) {
				flushPara();
				const kind = bullet ? 'ul' : 'ol';
				const m = bullet ?? numbered;
				if (m[1].length > 0) warn('a nested list item, flattened into its list (caracms has no nested lists)');
				if (list && list.kind !== kind) flushList();
				list ??= { kind, items: [] };
				const item = unit(m[2]);
				if (item) list.items.push(item);
			} else if (list && /^\s+\S/.test(line)) {
				// A list item's continuation line.
				list.items[list.items.length - 1] = unit(`${list.items[list.items.length - 1]}\n${line.trim()}`);
			} else {
				flushList();
				if (line.trim() !== '' || para.length) para.push(line);
			}
		}
		flushPara();
		flushList();
	}
	return out.filter((b) => {
		const v = Object.values(b)[0];
		return Array.isArray(v) ? v.length > 0 : v !== '';
	});
}

/** A media value in caracms's key order (media-value.ts → mediaToJson). */
function imageValue(key, alt, { decorative = false, focal } = {}) {
	const out = { key, alt: decorative ? '' : (alt ?? '') };
	if (decorative) out.decorative = true;
	if (focal) out.focal = focal;
	return out;
}

/**
 * Convert documents, by their compiled specs. One converter per run: it collects the
 * media keys it uses (for the key map) and each file link's old address (for the redirects) as it goes.
 */
/**
 * A "where" label one level down, as `caracms validate` prints one: the file, ` › `, then the
 * path in it (`content/pages/home.json › sections[0].heading`, `content/products/tee.json › shot`).
 */
export const at = (where, key) => (where.includes(' › ') ? `${where}.${key}` : `${where} › ${key}`);

export function converter({ collections, keys = {}, site = SITE }) {
	const warnings = [];
	/** Every bucket key the content uses → `{ kind: 'image' | 'file', name, where }`, for the key map. */
	const media = new Map();
	/** Each file link's old address → its Tina key, for the redirects. */
	const fileHrefs = new Map();
	const warn = (where, message) => warnings.push(`${where}: ${message}`);
	const use = (key, kind, name, where) => {
		if (!media.has(key)) media.set(key, { kind, name, where });
	};

	/** A Tina file link → its caracms address (the key map's); until the map has it, the link as it was. */
	const rewriteHref = (href, where = '') => {
		const f = fileLink(href, site);
		if (!f) return href;
		use(f.sourceKey, 'file', f.name, where);
		const mapped = keys[f.sourceKey];
		if (!mapped) return href;
		fileHrefs.set(href, f.sourceKey);
		return fileAddress(mapped.key) ?? href;
	};

	/** A reference (`content/products/x.json`) → the document's path in its collection (`x`). */
	const refPath = (value, to, where) => {
		if (typeof value !== 'string' || !value) return undefined;
		const c = collections[to];
		const folder = c ? `${c.tina.path.replace(/\/+$/, '')}/` : '';
		let rel = value.startsWith(folder) ? value.slice(folder.length) : path.posix.basename(value);
		rel = rel.replace(/\.[^./]+$/, '');
		if (c?.sections && rel === site.homeFile) rel = 'index';
		if (!c) warn(where, `a reference to "${value}" in an unknown collection`);
		return rel;
	};

	const image = (src, alt, where, opts) => {
		const key = imageKey(src);
		if (!key) {
			if (typeof src === 'string' && src.trim()) warn(where, `"${src}" isn't an image in the media bucket, so it's left out`);
			return undefined;
		}
		use(key, 'image', path.posix.basename(key), where);
		const mapped = keys[key];
		const value = imageValue(mapped?.key ?? key, alt, opts);
		if (mapped?.w && mapped?.h) Object.assign(value, { w: mapped.w, h: mapped.h });
		return value;
	};

	function value(spec, raw, parent, where, doc) {
		const at = spec.at;
		if (spec.kind === 'link' && spec.pair) {
			const label = parent?.linkLabel ?? '';
			const href = parent?.href ?? '';
			if (!label && !href) return undefined;
			return { label, href: rewriteHref(href, where) };
		}
		if (raw === undefined || raw === null || (raw === '' && spec.kind !== 'text')) {
			const fallback = site.fieldDefaults[at];
			if (fallback !== undefined && (spec.kind === 'select' || spec.kind === 'toggle' || spec.kind === 'text' || spec.kind === 'number')) return fallback;
			if (spec.kind === 'richText' && raw === '') return [];
			return undefined;
		}
		switch (spec.kind) {
			case 'text':
				if (typeof raw !== 'string') warn(where, `expected text, found ${JSON.stringify(raw)}`);
				return raw;
			case 'select': {
				const ok = optionValues({ options: spec.options }).includes(raw);
				if (!ok) {
					warn(where, `"${raw}" isn't one of the options, so it's left out (the field's default applies)`);
					return undefined;
				}
				return raw;
			}
			case 'toggle':
			case 'number':
			case 'date':
				return raw;
			case 'address':
				return { href: rewriteHref(String(raw), where) };
			case 'richText':
				return richText(raw, { rewriteHref: (h) => rewriteHref(h, where), warn: (m) => warn(where, m) });
			case 'reference':
				return refPath(raw, spec.to, where);
			case 'buttons':
				return Array.isArray(raw) ? raw.map((b) => ({ label: b?.label ?? '', href: rewriteHref(b?.href ?? '', where), style: b?.style ?? spec.styles[0] })) : undefined;
			case 'media': {
				if (spec.object) return mediaObject(raw, where);
				const alt = spec.alt ? (parent?.[spec.alt] ?? '') : spec.titleAlt ? (doc.title ?? '') : '';
				return image(raw, alt, where, { decorative: !spec.alt && !spec.titleAlt });
			}
			case 'list': {
				if (!Array.isArray(raw)) return undefined;
				if (spec.item?.kind === 'link') return raw.map((r) => ({ label: r?.label ?? '', href: rewriteHref(r?.href ?? '', where) }));
				// The unwrap comes first (M9 port friction 9): a list of one-text-field objects
				// (`facts: [{ label: 'size M' }]`) has a text item too, and isn't a list of strings.
				if (spec.unwrap) {
					return raw.map((r, i) => value(spec.item, r?.[spec.unwrap], r, `${where}[${i}]`, doc)).filter((v) => v !== undefined && v !== '');
				}
				if (spec.item?.kind === 'select' || spec.item?.kind === 'text') return raw.filter((s) => typeof s === 'string');
				return raw.map((r, i) => object(spec.fields, r, `${where}[${i}]`, doc));
			}
			case 'group':
				return object(spec.fields, raw, where, doc);
			default:
				throw new Error(`${at}: no conversion for "${spec.kind}"`);
		}
	}

	function mediaObject(raw, where) {
		if (!raw || typeof raw !== 'object') return undefined;
		const kind = raw.kind ?? (raw.src ? 'image' : raw.playbackId ? 'video' : undefined);
		if (kind === 'image') {
			const focal = Number.isFinite(raw.focusX) && Number.isFinite(raw.focusY) ? [raw.focusX / 100, raw.focusY / 100] : undefined;
			return image(raw.src, raw.alt ?? '', where, { focal });
		}
		if (kind === 'video' && raw.playbackId) {
			const out = { video: raw.playbackId, play: raw.playAs === 'player' ? 'player' : 'loop' };
			if (Number.isFinite(raw.posterTime) && raw.posterTime >= 0) out.poster = raw.posterTime;
			if (raw.name) out.name = raw.name;
			if (Number.isFinite(raw.duration) && raw.duration > 0) out.duration = raw.duration;
			if (raw.mono) warn(where, 'a black-and-white clip: caracms has no mono, so it plays in colour');
			return out;
		}
		return undefined;
	}

	/** One level of fields → caracms's object, keys in schema order. Unknown keys in Tina's file are dropped with a warning. */
	function object(specs, raw, where, doc) {
		const out = {};
		for (const spec of specs) {
			const v = value(spec, raw?.[spec.name], raw, at(where, spec.name), doc);
			if (v !== undefined) out[spec.name] = v;
		}
		if (raw && typeof raw === 'object') {
			const known = new Set(specs.flatMap((s) => [s.name, ...(s.pair ? ['linkLabel', 'href'] : []), ...(s.alt ? [s.alt] : [])]));
			for (const k of Object.keys(raw)) if (!known.has(k) && k !== '_template' && raw[k] !== null) warn(where, `"${k}" isn't in Tina's schema any more, so it's left out`);
		}
		return out;
	}

	return { warnings, warn, media, fileHrefs, object, value, rewriteHref, image };
}

// ── Layout: the editor's save (serialize.ts → savedForm, toJson), written out again ──────

const pad = (depth) => '  '.repeat(depth);
const objectText = (members, depth) => (members.length === 0 ? '{}' : `{\n${members.map(([k, v]) => `${pad(depth + 1)}${JSON.stringify(k)}: ${v}`).join(',\n')}\n${pad(depth)}}`);
const arrayText = (items, depth) => (items.length === 0 ? '[]' : `[\n${items.map((v) => pad(depth + 1) + v).join(',\n')}\n${pad(depth)}]`);

/** Canonical JSON: two-space indent, one member per line, a list of strings on one line. */
export function toJson(value, depth = 0) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		if (value.every((v) => typeof v === 'string')) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
		return arrayText(value.map((v) => toJson(v, depth + 1)), depth);
	}
	return objectText(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toJson(v, depth + 1)]), depth);
}

function inlineText(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(inlineText).join(', ')}]`;
	const entries = Object.entries(value);
	return entries.length ? `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inlineText(v)}`).join(', ')} }` : '{}';
}

const PLAIN = { kind: 'plain' };
const INLINE = { kind: 'inline' };

/** How a field's value is laid out (serialize.ts → shapeOf). */
export function shapeOf(spec) {
	switch (spec.kind) {
		case 'media':
			return INLINE;
		case 'richText':
			return { kind: 'rich' };
		case 'group':
			return { kind: 'object', keys: shapesOf(spec.fields) };
		case 'list':
			if (spec.item) return spec.item.kind === 'media' ? { kind: 'list', item: INLINE } : spec.item.kind === 'richText' ? { kind: 'list', item: { kind: 'rich' } } : PLAIN;
			return { kind: 'list', item: { kind: 'object', keys: shapesOf(spec.fields) } };
		default:
			return PLAIN;
	}
}
export const shapesOf = (specs) => new Map(specs.map((s) => [s.name, shapeOf(s)]));

/** A value laid out by its shape (serialize.ts → layout). A list's `item` may be a function of the item (a block's shape is its type's). */
export function layout(value, shape, depth = 0) {
	if (value === null || typeof value !== 'object') return toJson(value, depth);
	switch (shape.kind) {
		case 'inline':
			return inlineText(value);
		case 'rich':
			if (!Array.isArray(value)) return toJson(value, depth);
			return arrayText(value.map((e) => (e && typeof e === 'object' && !Array.isArray(e) ? `{ ${Object.entries(e).map(([k, v]) => `${JSON.stringify(k)}: ${toJson(v)}`).join(', ')} }` : toJson(e))), depth);
		case 'list': {
			if (!Array.isArray(value)) return toJson(value, depth);
			const item = typeof shape.item === 'function' ? shape.item : () => shape.item;
			return arrayText(value.map((v) => layout(v, item(v), depth + 1)), depth);
		}
		case 'object':
			if (Array.isArray(value)) return toJson(value, depth);
			return objectText(Object.entries(value).map(([k, v]) => [k, layout(v, shape.keys.get(k) ?? PLAIN, depth + 1)]), depth);
		default:
			return toJson(value, depth);
	}
}

// ── Reading Tina's schema and content ──────────────────────────────────────────────────

/**
 * Tina's schema → what the conversion and the scaffold need: each collection (sections
 * or fields) with its compiled fields, the blocks by caracms key, and Site Settings.
 */
export function readSchema(schema, site = SITE) {
	/** @type {Record<string, any>} */
	const collections = {};
	const blocks = new Map(); // key → { template, label, specs }
	const warnings = [];
	for (const c of schema.collections) {
		if (c.name === SETTINGS) continue;
		const folder = c.path.replace(/^content\/?/, '').replace(/\/+$/, '');
		const key = kebab(folder);
		const templates = c.fields.find((f) => f.type === 'object' && f.list && f.templates);
		const own = c.fields.filter((f) => f !== templates && !f.isTitle && !(templates && (f.name === 'seo' || (f.name === 'hidden' && f.type === 'boolean'))) && !(!templates && f.name === 'seo'));
		const entry = {
			tina: c,
			key,
			label: c.label ?? c.name,
			sections: !!templates,
			blocksField: templates?.name,
			titleField: c.fields.find((f) => f.isTitle)?.name,
			hasSeo: c.fields.some((f) => f.name === 'seo' && f.type === 'object'),
			hasHidden: !!templates && c.fields.some((f) => f.name === 'hidden' && f.type === 'boolean'),
			specs: compileFields(own, c.name, site),
			blockKeys: [],
		};
		if (templates) {
			for (const t of templates.templates) {
				const k = blockKey(t.name, site);
				const description = templateDescription(t);
				const specs = withoutBlockDescription(compileFields(t.fields, `blocks.${t.name}`, site), description);
				if (specs.some((s) => s.name === 'type')) throw new Error(`blocks.${t.name}: a field named "type" clashes with caracms's block type`);
				const known = blocks.get(k);
				if (known && known.template !== t.name) throw new Error(`Tina templates "${known.template}" and "${t.name}" both become the block "${k}": rename one in SITE.blockRenames`);
				if (known && JSON.stringify(known.specs.map(strip)) !== JSON.stringify(specs.map(strip))) warnings.push(`blocks.${t.name}: its fields differ between collections; the first one's are used`);
				if (!known) blocks.set(k, { template: t.name, label: t.label ?? t.name, help: blockHelp(description), specs });
				entry.blockKeys.push(k);
			}
		}
		collections[c.name] = entry;
	}
	const settings = schema.collections.find((c) => c.name === SETTINGS);
	const allSettingsSpecs = settings ? compileFields(settings.fields.filter((f) => !OWN_SETTINGS.has(f.name)), SETTINGS, site) : [];
	const sharedBlocks = readShared(allSettingsSpecs, blocks, site);
	const settingsSpecs = withoutPaths(allSettingsSpecs, sharedBlocks.flatMap((b) => b.moved));
	/** @type {string[]} Hint lines `findHolders` fills in. */
	const holderCandidates = [];
	return { collections, blocks, settings, settingsSpecs, sharedBlocks, warnings, holderCandidates };
}

/** The spec at a dotted path in one level's specs (`newsletter.heading`), or undefined. */
export function specAt(specs, dotted) {
	const [head, ...rest] = dotted.split('.');
	const spec = specs.find((s) => s.name === head);
	if (!spec || rest.length === 0) return spec;
	return spec.kind === 'group' ? specAt(spec.fields, rest.join('.')) : undefined;
}

/** The specs without the dotted paths; a group left with no fields goes too. */
export function withoutPaths(specs, paths) {
	const out = [];
	for (const s of specs) {
		if (paths.includes(s.name)) continue;
		const inner = paths.filter((p) => p.startsWith(`${s.name}.`)).map((p) => p.slice(s.name.length + 1));
		if (s.kind === 'group' && inner.length) {
			const fields = withoutPaths(s.fields, inner);
			if (fields.length) out.push({ ...s, fields });
			continue;
		}
		out.push(s);
	}
	return out;
}

/** The value at a dotted path, or undefined. */
export const valueAt = (raw, dotted) => dotted.split('.').reduce((o, k) => (o && typeof o === 'object' && !Array.isArray(o) ? o[k] : undefined), raw);

/** A copy of Tina's object without the dotted paths; an object left with no keys goes too. */
export function withoutValues(raw, paths) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
	const out = {};
	for (const [k, v] of Object.entries(raw)) {
		if (paths.includes(k)) continue;
		const inner = paths.filter((p) => p.startsWith(`${k}.`)).map((p) => p.slice(k.length + 1));
		if (inner.length && v && typeof v === 'object' && !Array.isArray(v)) {
			const kept = withoutValues(v, inner);
			if (Object.keys(kept).length) out[k] = kept;
			continue;
		}
		out[k] = v;
	}
	return out;
}

/**
 * The adapt table's shared blocks → `{ name, title, type, label, slot, specs, moved }`: each field's
 * spec, a moved Site Settings field keeping its own (and its schema path, so the address and
 * default rules still find it), a word a text or link spec holding the code's words.
 */
export function readShared(settingsSpecs, blocks, site = SITE) {
	return Object.entries(site.shared ?? {}).map(([name, b]) => {
		if (blocks.has(b.type)) throw new Error(`SITE.shared.${name}: "${b.type}" is already a block from Tina's templates`);
		const moved = [];
		const specs = Object.entries(b.fields).map(([field, f]) => {
			const at = `shared.${name}.${field}`;
			if (f.from) {
				const spec = specAt(settingsSpecs, f.from);
				if (!spec) throw new Error(`SITE.shared.${name}.${field}: Site Settings has no field "${f.from}" in Tina's schema`);
				moved.push(f.from);
				return { ...spec, name: field, from: f.from, ...(f.label ? { label: f.label } : {}), ...(f.help ? { help: f.help } : {}) };
			}
			const label = f.label ?? titleCase(field);
			if (typeof f.text === 'string') return { name: field, at, label, help: f.help, kind: 'text', multiline: !!f.multiline, lines: !!f.lines, heading: !!f.lines || site.headingFields.includes(field), word: f.text };
			if (f.link && typeof f.link.label === 'string') {
				if (f.link.hrefFrom) {
					if (!specAt(settingsSpecs, f.link.hrefFrom)) throw new Error(`SITE.shared.${name}.${field}: Site Settings has no field "${f.link.hrefFrom}" in Tina's schema`);
					moved.push(f.link.hrefFrom);
				}
				return { name: field, at, label, help: f.help, kind: 'link', word: f.link };
			}
			throw new Error(`SITE.shared.${name}.${field}: give it \`from\`, \`text\` or \`link\``);
		});
		return { name, title: b.title, type: b.type, label: b.label ?? b.title, slot: b.slot, specs, moved };
	});
}

/** `contactHeading` → `Contact heading`. */
const titleCase = (key) => {
	const words = kebab(key).split('-').join(' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
};
/** A Tina template's own description (`ui.description`, or `description`), or ''. */
const templateDescription = (t) => String(t.ui?.description ?? t.description ?? '').trim();

/**
 * A template's description → the block's help (M6c G8): its first sentence, and the next
 * while the two stay short, since the block's help sits at the top of its sidebar level.
 * Undefined when the template has none.
 */
export function blockHelp(description) {
	const text = String(description ?? '').replace(/\s+/g, ' ').trim();
	if (!text) return undefined;
	const sentences = text.match(/[^.!?]+(?:[.!?]+["”’)]*|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
	let help = sentences[0];
	if (sentences[1] && help.length + sentences[1].length + 1 <= 160) help = `${help} ${sentences[1]}`;
	return help;
}

/**
 * A template's fields with the template's description taken out of their help. Some Tina
 * sites (the template's \`aboutText\`) put it in front of the first field's own
 * description ("About this block: <description> <the field's help>"), the only place
 * Tina's editor showed it; in caracms it's the block's help, so each field keeps its own.
 */
export function withoutBlockDescription(specs, description) {
	if (!description) return specs;
	return specs.map((spec) => {
		const at = typeof spec.help === 'string' ? spec.help.indexOf(description) : -1;
		if (at < 0) return spec;
		const own = spec.help.slice(at + description.length).trim();
		const { help: _h, ...rest } = spec;
		return own ? { ...rest, help: own } : rest;
	});
}

const strip = ({ tina: _t, at: _a, ...rest }) => JSON.stringify(rest, (k, v) => (k === 'tina' || k === 'at' ? undefined : v));

/** Every `.json` file under a folder, as posix paths relative to it, sorted. */
function jsonFiles(root, rel = '') {
	const dir = path.join(root, rel);
	if (!existsSync(dir)) return [];
	const out = [];
	for (const name of readdirSync(dir).sort()) {
		const r = rel ? `${rel}/${name}` : name;
		if (statSync(path.join(root, r)).isDirectory()) out.push(...jsonFiles(root, r));
		else if (name.endsWith('.json')) out.push(r);
	}
	return out;
}

const seoOf = (raw, conv, where) => {
	if (!raw || typeof raw !== 'object') return undefined;
	const out = {};
	if (raw.metaTitle) out.title = raw.metaTitle;
	if (raw.metaDescription) out.description = raw.metaDescription;
	if (raw.ogImage) {
		const image = conv.image(raw.ogImage, raw.ogImageAlt ?? '', at(where, 'ogImage'));
		if (image) out.image = image;
	}
	return Object.keys(out).length ? out : undefined;
};
const SEO_SHAPE = { kind: 'object', keys: new Map([['image', INLINE]]) };

/**
 * The collections held by a page (collections under pages). The source is the adapt table
 * `SITE.holders` (collection key → page file name) and nothing else: a collection the table
 * names, whose page exists in the pages folder, is held by that page. The scaffold writes
 * `heldBy: 'pages'` (and no `urlBase`) for it, and the conversion writes `"holds": "<key>"`
 * on the page, both from this one decision. A collection the table doesn't name is a prefix
 * in code and keeps its `urlBase` (so a site ported before this change, with an empty table,
 * comes out the same). Sets `holder` (the page's file name) on each collection it finds;
 * Home never holds one. A table entry naming a page that doesn't exist is a warning in
 * `read.warnings`. `read.holderCandidates` lists the *sections* collections that aren't in
 * the table but have a same-named page, as hint lines (a fields collection is never
 * suggested). Returns the page name → collection key map.
 */
export function findHolders(read, from, site = SITE) {
	const holders = new Map();
	read.holderCandidates.length = 0;
	const pages = Object.values(read.collections).find((c) => c.key === 'pages' && c.sections);
	if (!pages) return holders;
	const names = new Set(jsonFiles(path.join(from, pages.tina.path)).map((f) => f.replace(/\.json$/, '')));
	for (const c of Object.values(read.collections)) {
		if (c === pages || c.key === 'pages') continue;
		const page = site.holders?.[c.key];
		if (page === undefined) {
			if (c.sections && names.has(c.key) && c.key !== site.homeFile && c.key !== 'index') {
				read.holderCandidates.push(`${c.key} has a page at ${pages.tina.path}/${c.key}.json: to have that page hold it, add ${c.key}: '${c.key}' to SITE.holders, then re-run with --scaffold-config --force`);
			}
			continue;
		}
		if (!names.has(page)) {
			read.warnings.push(`SITE.holders: ${c.key} is held by the page "${page}", but there's no ${pages.tina.path}/${page}.json, so it isn't held`);
			continue;
		}
		if (page === site.homeFile || page === 'index' || holders.has(page)) continue;
		c.holder = page;
		holders.set(page, c.key);
	}
	return holders;
}

/**
 * Convert every document. Returns `{ read, conv, docs }`; nothing is written.
 * `keys`: the key map (Tina bucket key → `{ key, w, h }`); a key it lacks is kept as Tina's,
 * and `conv.media` lists every key used, so the run can fill the map and convert again.
 * `recipients`: the `--recipients` address, or undefined.
 * @param {{ from: string, schema: any, keys?: Record<string, { key: string, w?: number, h?: number }>, site?: SiteTable, recipients?: string }} args
 */
export function convertAll({ from, schema, keys = {}, site = SITE, recipients }) {
	const read = readSchema(schema, site);
	const holders = findHolders(read, from, site);
	const conv = converter({ collections: read.collections, keys, site });
	conv.warnings.push(...read.warnings);
	const docs = []; // { rel, data, shape }

	for (const c of Object.values(read.collections)) {
		const folder = path.join(from, c.tina.path);
		for (const file of jsonFiles(folder)) {
			const where = `${c.tina.path}/${file}`;
			const raw = JSON.parse(readFileSync(path.join(folder, file), 'utf8'));
			let name = file.replace(/\.json$/, '');
			if (c.sections && name === site.homeFile) name = 'index';
			const rel = `content/${c.key}/${name}.json`;
			const title = (c.titleField ? raw[c.titleField] : undefined) ?? name;
			const doc = { title };
			const data = { $schema: `${'../'.repeat(rel.split('/').length - 1)}schemas/${c.key}.schema.json`, title };
			if (c.hasHidden && raw.hidden === true) {
				if (name === 'index') conv.warn(where, "the home page can't be hidden in caracms, so it's shown");
				else data.hidden = true;
			}
			// The page that holds a collection says so, after its title and hidden (the editor's order).
			if (c.key === 'pages' && holders.has(name)) data.holds = holders.get(name);
			const own = Object.fromEntries(Object.entries(raw).filter(([k]) => ![c.titleField, c.blocksField, ...(c.hasSeo ? ['seo'] : []), ...(c.hasHidden ? ['hidden'] : [])].includes(k)));
			Object.assign(data, conv.object(c.specs, own, where, doc));
			if (c.sections) {
				const blocksRaw = raw[c.blocksField] ?? [];
				data.blocks = blocksRaw.map((b, i) => {
					const w = at(where, `${c.blocksField}[${i}]`);
					const key = blockKey(b?._template, site);
					const block = read.blocks.get(key);
					if (!block) throw new Error(`${w}: no template "${b?._template}" in Tina's schema`);
					return { type: key, ...conv.object(block.specs, b, w, doc) };
				});
			}
			const seo = c.hasSeo ? seoOf(raw.seo, conv, at(where, 'seo')) : undefined;
			if (seo) data.seo = seo;
			const keys = shapesOf(c.specs);
			keys.set('seo', SEO_SHAPE);
			if (c.sections) keys.set('blocks', { kind: 'list', item: (b) => ({ kind: 'object', keys: shapesOf(read.blocks.get(b.type)?.specs ?? []) }) });
			docs.push({ rel, data, shape: { kind: 'object', keys } });
		}
	}

	const settingsFile = read.settings ? jsonFiles(path.join(from, read.settings.path))[0] : undefined;
	const settingsWhere = settingsFile ? `${read.settings.path}/${settingsFile}` : 'Site Settings';
	const settingsRaw = settingsFile ? JSON.parse(readFileSync(path.join(from, read.settings.path, settingsFile), 'utf8')) : {};

	// The shared blocks: moved Site Settings fields converted as they were, and the code's words.
	for (const b of read.sharedBlocks) {
		const where = `content/shared/${b.name}.json`;
		const block = { type: b.type };
		for (const spec of b.specs) {
			let v;
			if (spec.from) {
				const parentPath = spec.from.split('.').slice(0, -1).join('.');
				const parent = parentPath ? valueAt(settingsRaw, parentPath) : settingsRaw;
				v = conv.value(spec, valueAt(settingsRaw, spec.from), parent, `${settingsWhere}.${spec.from}`, { title: b.title });
			} else if (spec.kind === 'text') v = spec.word;
			else {
				const href = spec.word.hrefFrom ? valueAt(settingsRaw, spec.word.hrefFrom) : spec.word.href;
				v = { label: spec.word.label, href: conv.rewriteHref(typeof href === 'string' ? href : '', where) };
			}
			if (v !== undefined) block[spec.name] = v;
		}
		const data = { $schema: '../../schemas/shared.schema.json', title: b.title };
		if (b.slot) data.default = true;
		data.block = block;
		docs.push({ rel: where, data, shape: { kind: 'object', keys: new Map([['block', { kind: 'object', keys: shapesOf(b.specs) }]]) } });
	}

	if (settingsFile) {
		const where = settingsWhere;
		const raw = withoutValues(settingsRaw, read.sharedBlocks.flatMap((b) => b.moved));
		const rows = (list, key) => (Array.isArray(list) ? list.map((r) => r?.[key]).filter((v) => typeof v === 'string' && v.trim() !== '') : []);
		const forms = raw.formNotifications && typeof raw.formNotifications === 'object' ? raw.formNotifications : {};
		const brand = { name: raw.adminBranding?.name || raw.defaultSeo?.metaTitle?.trim() || 'Site' };
		if (raw.adminBranding?.accent) brand.accent = raw.adminBranding.accent;
		if (raw.adminBranding?.logo || raw.adminBranding?.favicon) conv.warn(where, "the editor branding's logo and favicon aren't carried over: upload them in the editor (Site Settings → Brand)");
		const data = {
			$schema: '../schemas/site-settings.schema.json',
			title: 'Site Settings',
			editors: rows(raw.adminAccess?.allow, 'entry'),
			brand,
		};
		const seo = seoOf(raw.defaultSeo, conv, at(where, 'defaultSeo'));
		if (seo) data.seo = seo;
		if (raw.googleTag) data.googleTag = raw.googleTag;
		data.formRecipients = Object.fromEntries(Object.keys(forms).sort().map((form) => [form, recipients ? [recipients] : rows(forms[form], 'address')]));
		const own = conv.object(read.settingsSpecs, Object.fromEntries(Object.entries(raw).filter(([k]) => !OWN_SETTINGS.has(k))), where, { title: 'Site Settings' });
		// Every file link's old address goes to its new one (the whole site's links are converted by now), then the table's own.
		const fileRedirects = [...conv.fileHrefs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([href, sourceKey]) => ({ from: href, to: fileAddress(keys[sourceKey].key) }));
		const redirects = [...fileRedirects, ...(site.redirects ?? [])];
		if (redirects.length) data.redirects = redirects;
		Object.assign(data, own);
		if (site.formWords && Object.keys(site.formWords).length) data.formWords = site.formWords;
		const shapes = shapesOf(read.settingsSpecs);
		shapes.set('seo', SEO_SHAPE);
		shapes.set('brand', { kind: 'object', keys: new Map([['logo', INLINE], ['icon', INLINE]]) });
		shapes.set('redirects', { kind: 'list', item: INLINE });
		docs.push({ rel: 'content/site-settings.json', data, shape: { kind: 'object', keys: shapes } });
	}
	return { read, conv, docs };
}

/** The documents' text. */
export const renderDocs = (docs) => new Map(docs.map((d) => [d.rel, `${layout(d.data, d.shape, 0)}\n`]));

// ── The key map and the bucket copies (the only network the script does) ───────────────

function readKeys(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return {};
	}
}

/** The key map's text: sorted by Tina key, one entry per line. */
export const keysText = (map) => `{\n${Object.keys(map).sort().map((k) => `  ${JSON.stringify(k)}: ${inlineText(map[k])}`).join(',\n')}\n}\n`;

/** An S3 ETag without its quotes (and a weak one's `W/`), or undefined when there's none. */
const etagOf = (res) => res.headers.get('etag')?.replace(/^W\//, '').replace(/"/g, '') || undefined;

/** One object's bytes from the bucket, with its ETag, or null when it can't be read. */
async function readObject(key, tools, creds) {
	try {
		const signed = tools.signS3(creds, { method: 'GET', key });
		const res = await fetch(signed.url, { headers: signed.headers, signal: AbortSignal.timeout(120_000) });
		if (!res.ok) return null;
		return { bytes: new Uint8Array(await res.arrayBuffer()), etag: etagOf(res) };
	} catch {
		return null;
	}
}

/** One object's ETag and size from a HEAD: null when it isn't there, and a throw on any other failure. */
async function headObject(key, tools, creds) {
	const signed = tools.signS3(creds, { method: 'HEAD', key });
	const res = await fetch(signed.url, { method: 'HEAD', headers: signed.headers, signal: AbortSignal.timeout(60_000) });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`checking ${key} in the bucket failed: ${res.status}`);
	const size = Number(res.headers.get('content-length'));
	return { etag: etagOf(res), size: Number.isFinite(size) ? size : undefined };
}

/**
 * An object's caracms key from its bytes, by the upload route's rule (bin/media.mjs): an
 * image's `uploads/<hash>/<name>.<the sniffed type>` with its `w`/`h`, a file's
 * `uploads/<hash>/<name>.<its extension>`. Null when an image's bytes aren't an image.
 */
export function keyFromBytes(bytes, { kind, name }, tools) {
	if (kind === 'image') {
		const k = tools.keyFor(bytes, name);
		return k.ok ? { key: k.key, w: k.sniffed.w, h: k.sniffed.h } : null;
	}
	const clean = tools.cleanName(name);
	const dot = clean.lastIndexOf('.');
	const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
	return { key: `uploads/${hash}/${tools.keyName(clean, 'file')}.${clean.slice(dot + 1).toLowerCase()}` };
}

/** A map entry from an object's bytes, with the ETag and size it was read at (null: not an image where one is used). */
function entryFromObject(obj, media, tools) {
	const entry = keyFromBytes(obj.bytes, media, tools);
	if (!entry) return null;
	if (obj.etag) entry.etag = obj.etag;
	entry.size = obj.bytes.length;
	return entry;
}

/**
 * Fill the key map for every key the content uses: the map's entry, else the bucket's bytes.
 * With S3_* settings, a key the map has is checked too, since Tina replaces a file in place
 * under the same key: a HEAD, against the ETag and size in its entry. When they match,
 * nothing more is read. When they don't (or the entry has none yet), the bytes are read and
 * hashed again: the same key just gains the ETag and size (`stamped`), a new one replaces the
 * entry (`rekeyed`). Without S3_* settings the map is used as it is, so a run reads nothing.
 * Then, with S3_* settings and every key known, make each copy within the bucket: skipped when
 * the key exists, never a delete or an overwrite (an old copy stays where it is). `unreadable`
 * lists the keys whose bytes couldn't be read (or weren't an image); the run stops on any.
 */
export async function resolveKeys(media, map, tools, creds) {
	const learned = [];
	const unreadable = [];
	const rekeyed = [];
	const stamped = [];
	for (const old of [...media.keys()].sort()) {
		const had = map[old];
		if (had && !creds) continue;
		if (had) {
			const head = await headObject(old, tools, creds);
			if (!head) {
				unreadable.push(old);
				continue;
			}
			if (had.etag && head.etag === had.etag && head.size === had.size) continue;
		}
		const obj = creds ? await readObject(old, tools, creds) : null;
		const entry = obj && entryFromObject(obj, media.get(old), tools);
		if (!entry) {
			unreadable.push(old);
			continue;
		}
		map[old] = entry;
		if (!had) learned.push(old);
		else if (entry.key !== had.key || entry.w !== had.w || entry.h !== had.h) rekeyed.push(old);
		else stamped.push(old);
	}
	const copied = [];
	const kept = [];
	if (creds && unreadable.length === 0) {
		for (const old of [...media.keys()].sort()) {
			const { key, etag } = map[old];
			if (copied.includes(key) || kept.includes(key)) continue;
			if (await headObject(key, tools, creds)) {
				kept.push(key);
				continue;
			}
			// The copy is of the bytes the key was hashed from: if the source changed since, it fails.
			const source = `/${creds.S3_BUCKET}/${old.split('/').map(encodeURIComponent).join('/')}`;
			const headers = { 'x-amz-copy-source': source, ...(etag ? { 'x-amz-copy-source-if-match': `"${etag}"` } : {}) };
			const put = tools.signS3(creds, { method: 'PUT', key, headers });
			const res = await fetch(put.url, { method: 'PUT', headers: put.headers });
			const text = await res.text();
			if (!res.ok || /<Error>/.test(text)) throw new Error(`copying ${old} to ${key} failed: ${res.status} ${text.slice(0, 300)}`);
			copied.push(key);
		}
	}
	return { learned, unreadable, rekeyed, stamped, copied, kept };
}

/** The installed caracms's plain-JS tools (bin/media.mjs): keyFor, keyName, cleanName, signS3, readS3Env. */
async function caracmsTools(root) {
	const require = createRequire(path.join(root, 'package.json'));
	let entry;
	try {
		entry = require.resolve('caracms');
	} catch {
		throw new Error(`caracms isn't installed in ${root}. Run this from the site's root after \`caracms init --write\` and an install.`);
	}
	const pkg = path.resolve(path.dirname(entry), '..');
	const media = await import(pathToFileURL(path.join(pkg, 'bin/media.mjs')).href);
	return { ...media, packageRoot: pkg };
}

// ── The scaffold: a starting caracms.config.ts from the same specs ─────────────────────

const q = (s) => JSON.stringify(s);
const pascal = (key) => key.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

function optionsText(options) {
	return `[${options.map((o) => (typeof o === 'string' ? q(o) : `{ value: ${q(o.value)}, label: ${q(o.label ?? o.value)} }`)).join(', ')}]`;
}

/** One spec → its caracms field helper call, as TypeScript. */
export function fieldConfig(spec, read, used, indent) {
	const common = [`label: ${q(spec.label)}`];
	if (spec.help) common.push(`help: ${q(spec.help)}`);
	const opts = (...extra) => `{ ${[...extra, ...common].join(', ')} }`;
	const use = (name) => (used.add(name), name);
	switch (spec.kind) {
		case 'text': {
			const extra = [];
			// `lines` takes several lines on its own (text() makes it multiline).
			if (spec.lines) extra.push('lines: true');
			else if (spec.multiline) extra.push('multiline: true');
			if (spec.heading) extra.push('heading: true');
			return `${use('text')}(${opts(...extra)})`;
		}
		case 'select':
			return `${use('select')}(${opts(`options: ${optionsText(spec.options)}`, ...(spec.default !== undefined ? [`default: ${q(spec.default)}`] : []))})`;
		case 'toggle':
			return `${use('toggle')}(${opts(...(spec.default !== undefined ? [`default: ${q(spec.default)}`] : []))})`;
		case 'number':
			return `${use('number')}(${opts()})`;
		case 'date':
			return `${use('date')}(${opts()})`;
		case 'address':
			return `${use('link')}(${opts('addressOnly: true')})`;
		case 'link':
			return `${use('link')}(${opts()})`;
		case 'richText':
			return `${use('richText')}(${opts(`headings: ${q(spec.headings)}`, `links: ${spec.links}`)})`;
		case 'reference':
			return `${use('reference')}(${opts(`to: ${q(read.collections[spec.to]?.key ?? spec.to)}`)})`;
		case 'media':
			return `${use('media')}(${opts(...(spec.only ? [`only: '${spec.only}'`] : []))})`;
		case 'buttons':
			return `${use('buttons')}(${opts(`styles: ${q(spec.styles)}`)})`;
		case 'group':
			return `${use('group')}(${fieldsConfig(spec.fields, read, used, indent)}, ${opts()})`;
		case 'list': {
			if (spec.item) {
				const item =
					spec.item.kind === 'link'
						? `${use('link')}()`
						: spec.item.kind === 'select'
							? `${use('select')}({ options: ${optionsText(spec.item.options)} })`
							: spec.item.kind === 'text' && !spec.item.label
								? `${use('text')}()`
								: fieldConfig(spec.item, read, used, indent);
				return `${use('list')}(${item}, ${opts()})`;
			}
			const label = spec.fields.find((s) => s.kind === 'text')?.name;
			return `${use('list')}(${fieldsConfig(spec.fields, read, used, indent)}, ${opts(...(label ? [`itemLabel: ${q(label)}`] : []))})`;
		}
		default:
			throw new Error(`${spec.at}: no field helper for "${spec.kind}"`);
	}
}

function fieldsConfig(specs, read, used, indent) {
	if (specs.length === 0) return '{}';
	return `{\n${specs.map((s) => `${indent}\t${s.name}: ${fieldConfig(s, read, used, `${indent}\t`)},`).join('\n')}\n${indent}}`;
}

/**
 * The Tina site's forms config → caracms's form definitions. Each field keeps its on-page
 * `label` (a separate `emailLabel` goes: the email and the inbox use the page's), and the keys
 * caracms's forms take; anything else is named in `notes`, for a person to place.
 *
 * Form rows and sourced selects (Decision 16): a select's `source: '<name>'` becomes
 * `source: { collection: '<name>' }` (the converted collection of that name), with no `where`:
 * the template filtered in code, so a note names the toggle to add (the collection's own toggle
 * when it has one) and says a blank one read as on there. A field's `watermark` becomes
 * `suffix`; `placeholder` carries over (a select's is its blank first choice). A field whose
 * type caracms doesn't have (the template's `orderLines`) is left out, with a note naming
 * `rows` and showing the template's field.
 *
 * @param {unknown} list the template's `FORMS`
 * @param {Record<string, { toggles: string[] }>} [collections] the converted collections by key, each with its toggle fields' names
 */
export function formsFromTina(list, collections = {}) {
	const notes = [];
	const FIELD_KEYS = ['label', 'type', 'optional', 'options', 'help', 'autocomplete', 'error', 'placeholder', 'prefix', 'rows'];
	const TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'files'];
	const forms = (Array.isArray(list) ? list : []).map((f) => {
		for (const k of Object.keys(f)) if (!['id', 'label', 'email', 'fields'].includes(k)) notes.push(`${f.id}.${k} has no place in caracms's form definition, so it's left out${k === 'onSubmit' ? ' (a form\'s own server step: carry it over by hand)' : ''}`);
		const fields = [];
		for (const field of f.fields ?? []) {
			if (field.type !== undefined && !TYPES.includes(field.type)) {
				notes.push(
					`${f.id}.${field.name} is a "${field.type}" field, which caracms doesn't have, so it's left out. If it's rows of a few columns, declare it as a rows field (type: 'rows', with columns: select, number or text; a column can narrow its choices by another's pick with from), as the caracms-blocks skill's Forms section shows. The template's field: ${JSON.stringify(field)}`,
				);
				continue;
			}
			const out = Object.fromEntries(FIELD_KEYS.filter((k) => field[k] !== undefined && !(k === 'type' && field[k] === 'text')).map((k) => [k, field[k]]));
			for (const k of Object.keys(field)) {
				if (k === 'name' || FIELD_KEYS.includes(k)) continue;
				if (k === 'emailLabel') {
					if (field.emailLabel !== field.label) notes.push(`${f.id}.${field.name}: the email's label "${field.emailLabel}" goes; the on-page "${field.label}" names it everywhere`);
				} else if (k === 'watermark' && typeof field.watermark === 'string') {
					out.suffix = field.watermark;
				} else if (k === 'source' && typeof field.source === 'string') {
					out.source = { collection: field.source };
					const known = Object.hasOwn(collections, field.source) ? collections[field.source] : null;
					const toggles = known?.toggles ?? [];
					notes.push(
						known
							? `${f.id}.${field.name} lists every document of "${field.source}". The template filtered them in code; if it offered only some, add ${toggles.length ? `where: ${toggles.map((t) => `'${t}'`).join(' or ')}` : `a toggle to "${field.source}" and where: '<its name>'`} to the source, and give the toggle a default of on (a blank one read as on in the template)`
							: `${f.id}.${field.name}'s source "${field.source}" isn't a collection the conversion made: point source.collection at the right one by hand`,
					);
				} else notes.push(`${f.id}.${field.name}.${k} has no place in caracms's form field, so it's left out`);
			}
			fields.push([field.name, out]);
		}
		return { id: f.id, label: f.label ?? f.id, subject: f.email?.subject ?? `New ${String(f.label ?? f.id).toLowerCase()} submission`, fields };
	});
	return { forms, notes };
}

/** The Tina site's forms config (the adapt table's `formsConfig`), read from the `--from` checkout, as caracms's forms; `read` names the collections a select's source can be. */
async function readForms(from, site = SITE, read = null) {
	if (!site.formsConfig) return { forms: [], notes: [] };
	const file = path.join(from, site.formsConfig.file);
	if (!existsSync(file)) return { forms: [], notes: [`no ${site.formsConfig.file} in the Tina checkout, so the config has no forms`] };
	const mod = await import(pathToFileURL(file).href);
	const collections = Object.fromEntries(Object.values(read?.collections ?? {}).map((c) => [c.key, { toggles: (c.specs ?? []).filter((spec) => spec.kind === 'toggle').map((spec) => spec.name) }]));
	return formsFromTina(mod[site.formsConfig.export], collections);
}

/** The config's `forms`, as TypeScript. */
function formsText(forms) {
	if (!forms.length) return '';
	const value = (v) =>
		Array.isArray(v) ? `[${v.map((o) => `{ value: ${q(o.value)}, label: ${q(o.label)} }`).join(', ')}]` : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${q(x)}`).join(', ')} }` : q(v);
	const lines = forms.map((f) => {
		const fields = f.fields.map(([name, field]) => `\t\t\t\t${name}: { ${Object.entries(field).map(([k, v]) => `${k}: ${value(v)}`).join(', ')} },`).join('\n');
		return `\t\t${f.id}: {\n\t\t\tlabel: ${q(f.label)},\n\t\t\temail: { subject: ${q(f.subject)} },\n\t\t\tfields: {\n${fields}\n\t\t\t},\n\t\t},`;
	});
	return `\tforms: {\n${lines.join('\n')}\n\t},\n`;
}

/**
 * The starting caracms.config.ts.
 * @param {any} read
 * @param {{ forms?: ReturnType<typeof formsFromTina>['forms'], services?: string }} [options] the config's forms, and init's hosting mode to keep
 */
export function scaffoldConfig(read, { forms = [], services } = {}) {
	const used = new Set(['defineSite']);
	const allBlocks = [...read.blocks.keys()];
	const cols = Object.values(read.collections).map((c) => {
		const parts = [`label: ${q(c.label)}`];
		if (c.sections) {
			// A page at the collection's base holds it (heldBy); with no page the prefix stays in code (urlBase).
			parts.push(`kind: 'sections'`, `folder: ${q(`content/${c.key}`)}`, c.holder ? `heldBy: 'pages'` : `urlBase: ${q(c.key === 'pages' ? '/' : `/${c.key}/`)}`);
			if (c.key === 'pages') parts.push('nested: true');
			if (c.blockKeys.length !== allBlocks.length) parts.push(`blocks: ${q(c.blockKeys)}`);
			if (c.specs.length) parts.push(`fields: ${fieldsConfig(c.specs, read, used, '\t\t\t')}`);
		} else {
			parts.push(`kind: 'fields'`, `folder: ${q(`content/${c.key}`)}`, ...(c.holder ? [`heldBy: 'pages'`] : []), `component: ${q(`src/components/caracms/${pascal(c.key)}.astro`)}`, `fields: ${fieldsConfig(c.specs, read, used, '\t\t\t')}`);
		}
		return `\t\t${/^[a-z][a-z0-9]*$/.test(c.key) ? c.key : q(c.key)}: {\n\t\t\t${parts.join(',\n\t\t\t')},\n\t\t},`;
	});
	const blocks = [...read.blocks.entries()].map(([key, b]) => {
		const name = /^[a-z][a-z0-9]*$/.test(key) ? key : q(key);
		const help = b.help ? `\t\t\thelp: ${q(b.help)},\n` : '';
		return `\t\t${name}: {\n\t\t\tlabel: ${q(b.label)},\n${help}\t\t\tcomponent: ${q(`src/blocks/${pascal(key)}.astro`)},\n\t\t\tfields: ${fieldsConfig(b.specs, read, used, '\t\t\t')},\n\t\t},`;
	});
	for (const b of read.sharedBlocks ?? []) {
		const name = /^[a-z][a-z0-9]*$/.test(b.type) ? b.type : q(b.type);
		const slot = b.slot ? `\t\t\tslot: ${q(b.slot)},\n` : '';
		blocks.push(`\t\t${name}: {\n\t\t\tlabel: ${q(b.label)},\n${slot}\t\t\tcomponent: ${q(`src/blocks/${pascal(b.type)}.astro`)},\n\t\t\tfields: ${fieldsConfig(b.specs, read, used, '\t\t\t')},\n\t\t},`);
	}
	const settings = read.settingsSpecs.length ? `\tsettings: { fields: ${fieldsConfig(read.settingsSpecs, read, used, '\t')} },\n` : '';
	return `import { ${[...used].sort().join(', ')} } from 'caracms/config';

/**
 * caracms's config for this site, first scaffolded from Tina's schema by
 * scripts/tina-to-caracms.mjs --scaffold-config (Tina's labels and help carried over).
 * From here on it's the site's own: edit it by hand. The conversion never writes it again.
 *
 * Still to do by hand: each block's component (src/blocks/*.astro, drawn through Text,
 * RichText, Media and Block), heading options, page-wide rules in the page component,
 * the text styles. Trim Tina's longer help as you go.
 */
export default defineSite({
${services ? `\tservices: ${q(services)},\n` : ''}	collections: {
${cols.join('\n')}
	},
	blocks: {
${blocks.join('\n')}
	},
${formsText(forms)}${settings}	textStyles: {},
	page: 'src/components/caracms/Page.astro',
});
`;
}

// ── The run ────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
	const out = { flags: new Set() };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--scaffold-config' || a === '--force') out.flags.add(a.slice(2));
		else if (a === '--from' || a === '--to' || a === '--recipients') out[a.slice(2)] = argv[++i];
		else throw new Error(`Unknown argument: ${a}`);
	}
	return out;
}

const USAGE = 'Usage: node scripts/tina-to-caracms.mjs --from <a built Tina checkout> [--to .] [--recipients <address>] [--scaffold-config [--force]]';

async function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`${error.message}\n${USAGE}`);
		return 2;
	}
	if (!args.from) {
		console.error(USAGE);
		return 2;
	}
	const FROM = path.resolve(args.from);
	const TO = path.resolve(args.to ?? '.');
	if (FROM === TO) {
		console.error('--from and --to are the same folder: the run would delete the Tina content it reads. Run it from the caracms site against a separate checkout.');
		return 2;
	}
	if (args.recipients !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.recipients)) {
		console.error(`--recipients takes one email address, not "${args.recipients}".`);
		return 2;
	}
	const schemaFile = path.join(FROM, 'tina/__generated__/_schema.json');
	if (!existsSync(schemaFile)) {
		console.error(`No ${schemaFile}: build the Tina checkout first (its build generates the schema).`);
		return 1;
	}
	const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
	const tools = await caracmsTools(TO);
	const { values: creds, missing: credsMissing } = tools.readS3Env(process.env, TO);
	const s3 = credsMissing.length === 0 ? creds : null;

	// Two passes: the first finds every bucket key the content uses, the key map is filled
	// (from the bucket's bytes for a key it lacks), and the second converts with the new keys.
	const keysFile = path.join(TO, KEYS_FILE);
	const map = readKeys(keysFile);
	const first = convertAll({ from: FROM, schema, keys: map, recipients: args.recipients });
	const keys = await resolveKeys(first.conv.media, map, tools, s3);
	if (keys.unreadable.length) {
		const why = s3 ? "can't be read from the bucket (missing, or not an image where an image is used)" : `aren't in ${KEYS_FILE}, and there are no S3_* settings (${credsMissing.join(', ')}) to read them`;
		console.error(`These media keys ${why}, so nothing was written. Fix them in the Tina content, or run with the bucket's S3_* settings:\n  ${keys.unreadable.map((k) => `${k} (${first.conv.media.get(k).where})`).join('\n  ')}`);
		return 1;
	}
	if (keys.learned.length || keys.rekeyed.length || keys.stamped.length) writeFileSync(keysFile, keysText(map));

	const { read, conv, docs } = convertAll({ from: FROM, schema, keys: map, recipients: args.recipients });

	if (args.flags.has('scaffold-config')) {
		const file = path.join(TO, 'caracms.config.ts');
		const starting = readFileSync(path.join(tools.packageRoot, 'bin/templates/caracms.config.ts.txt'), 'utf8');
		// init writes its starting config with the hosting mode in it: that line aside, it's the same.
		if (existsSync(file) && readFileSync(file, 'utf8').replace(/^\s*services:.*\n/m, '') !== starting.replace(/^\s*services:.*\n/m, '') && !args.flags.has('force')) {
			console.error("caracms.config.ts isn't caracms init's starting config, so --scaffold-config leaves it (it's the site's own now). Add --force to replace it.");
			return 1;
		}
		const forms = await readForms(FROM, SITE, read);
		// init's hosting mode (`services: 'cloud'`) is kept.
		const services = existsSync(file) ? /^\s*services:\s*['"]([a-z-]+)['"]/m.exec(readFileSync(file, 'utf8'))?.[1] : undefined;
		writeFileSync(file, scaffoldConfig(read, { ...forms, services }));
		console.log('Wrote caracms.config.ts from Tina\'s schema.');
		for (const note of forms.notes) console.log(`Forms: ${note}.`);
	}

	const texts = renderDocs(docs);
	rmSync(path.join(TO, 'content'), { recursive: true, force: true });
	for (const [rel, text] of texts) {
		mkdirSync(path.dirname(path.join(TO, rel)), { recursive: true });
		writeFileSync(path.join(TO, rel), text);
	}

	const counts = {};
	for (const rel of texts.keys()) {
		const c = rel.split('/').length > 2 ? rel.split('/')[1] : 'site settings';
		counts[c] = (counts[c] ?? 0) + 1;
	}
	console.log(`Wrote content/: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
	const kinds = [...conv.media.values()];
	console.log(`Media: ${kinds.filter((m) => m.kind === 'image').length} images and ${kinds.filter((m) => m.kind === 'file').length} files by their bytes' keys; ${keys.learned.length} new in ${KEYS_FILE}.`);
	if (s3) {
		console.log(`Bucket: every source checked against its ETag: ${keys.rekeyed.length} replaced in Tina and re-keyed by their new bytes, ${keys.stamped.length} unchanged with their ETag recorded; ${keys.copied.length} copied to their caracms keys, ${keys.kept.length} already there.`);
		if (keys.rekeyed.length) console.log(`Re-keyed (the old copy stays in the bucket):\n  ${keys.rekeyed.map((k) => `${k} → ${map[k].key}`).join('\n  ')}`);
	}
	else console.log(`Bucket: not checked (no S3_* settings: ${credsMissing.join(', ')}). Every key was in ${KEYS_FILE}; run with them to make any copy still missing and to notice a file replaced in Tina.`);
	const held = Object.values(read.collections).filter((c) => c.holder);
	if (held.length) console.log(`Held by a page: ${held.map((c) => `${c.key} (the ${c.holder} page says "holds": "${c.key}")`).join(', ')}.`);
	for (const line of read.holderCandidates ?? []) console.log(`Hint: ${line}.`);
	if (read.sharedBlocks.length) console.log(`Shared: ${read.sharedBlocks.map((b) => `${b.name}${b.moved.length ? ` (from Site Settings: ${b.moved.join(', ')})` : ''}`).join(', ')}.`);
	if (args.recipients) console.log(`Form recipients: every form's are ${args.recipients} (--recipients).`);
	if (conv.warnings.length) console.log(`Warnings:\n  ${conv.warnings.join('\n  ')}`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		},
	);
}
