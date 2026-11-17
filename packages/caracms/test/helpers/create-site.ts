/**
 * A throwaway copy of the fixture site for M5a Phase 3's create and delete tests: the
 * fixture's Pages (nested, `/`) and Journal (`/journal`), a list-of-fields collection
 * `case-studies` at `/work/`, a shared footer used by Home and About, a page under
 * `/work/` written by hand (`pages/work/kiln.json`, the cross-collection address
 * clash), Site Settings, and a folder link inside Pages pointing outside the site.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSite, SITE_SETTINGS_FILE, text, type ResolvedSite, type SiteConfig } from '../../src/config.ts';
import { config, display, fixtures, siteRoot } from './site.ts';

export interface CreateSite {
	root: string;
	/** A folder outside the site, which `content/pages/linked` points at. */
	outside: string;
	site: ResolvedSite;
	read(file: string): string;
	cleanup(): void;
}

export function makeCreateSite(
	options: {
		repoPath?: string;
		link?: boolean;
		/** Pre-M7 item 8: more of the config (block types, fields), and more files, written over the copy. */
		extend?: (config: SiteConfig) => SiteConfig;
		files?: Record<string, string>;
	} = {},
): CreateSite {
	const tmp = mkdtempSync(join(tmpdir(), 'caracms-create-'));
	const root = join(tmp, 'site');
	const outside = join(tmp, 'outside');
	cpSync(siteRoot, root, { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(outside, 'secret.json'), '{ "title": "Secret", "blocks": [] }\n');
	mkdirSync(join(root, 'content/case-studies'), { recursive: true });
	mkdirSync(join(root, 'content/shared'), { recursive: true });
	mkdirSync(join(root, 'content/pages/work'), { recursive: true });
	writeFileSync(join(root, 'content/case-studies/high-street-coffee.json'), '{\n  "title": "High-street coffee roaster",\n  "client": "High-street coffee roaster"\n}\n');
	writeFileSync(join(root, 'content/pages/work/kiln.json'), '{\n  "title": "Kiln (by hand)",\n  "blocks": []\n}\n');
	writeFileSync(join(root, 'content/shared/footer.json'), '{\n  "title": "Footer",\n  "block": {\n    "type": "cta",\n    "text": "Bring it over."\n  }\n}\n');
	writeFileSync(join(root, 'content/shared/spare.json'), '{\n  "title": "Spare",\n  "block": {\n    "type": "text"\n  }\n}\n');
	writeFileSync(join(root, SITE_SETTINGS_FILE), '{\n  "title": "Site Settings",\n  "editors": []\n}\n');
	for (const page of ['index', 'about']) {
		const file = join(root, `content/pages/${page}.json`);
		const doc = JSON.parse(readFileSync(file, 'utf8'));
		doc.blocks.push({ shared: 'footer' });
		writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
	}
	if (options.link !== false) symlinkSync(outside, join(root, 'content/pages/linked'));
	for (const [file, text] of Object.entries(options.files ?? {})) {
		mkdirSync(join(root, file, '..'), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	const baseConfig: SiteConfig = {
		...(config as SiteConfig),
		collections: {
			...(config as SiteConfig).collections,
			'case-studies': { kind: 'fields', label: 'Case studies', folder: 'content/case-studies', urlBase: '/work/', component: 'Block.astro', fields: { client: text() } },
		},
		...(options.repoPath ? { repoPath: options.repoPath } : {}),
		textStyles: { display: { ...display, fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') } } },
	};
	const siteConfig = options.extend ? options.extend(baseConfig) : baseConfig;
	const site = resolveSite(siteConfig, root);
	return {
		root,
		outside,
		site,
		read: (file) => readFileSync(join(root, file), 'utf8'),
		cleanup: () => rmSync(tmp, { recursive: true, force: true }),
	};
}

/** Every create a store must refuse, with the status and code it refuses with. */
export const REFUSED_CREATES: { why: string; body: Record<string, unknown>; status: number; code: string }[] = [
	{ why: '../ out of the collection', body: { collection: 'pages', path: '../outside-root', title: 'X' }, status: 400, code: 'bad-path' },
	{ why: '../ deeper', body: { collection: 'pages', path: 'services/../../x', title: 'X' }, status: 400, code: 'bad-path' },
	{ why: 'an absolute path', body: { collection: 'pages', path: '/etc/passwd', title: 'X' }, status: 400, code: 'bad-path' },
	{ why: 'a backslash', body: { collection: 'pages', path: 'a\\b', title: 'X' }, status: 400, code: 'bad-path' },
	{ why: 'a dot-file', body: { collection: 'pages', path: '.hidden', title: 'X' }, status: 400, code: 'bad-path' },
	{ why: 'an empty part', body: { collection: 'pages', path: 'studio//visit', title: 'X' }, status: 400, code: 'bad-path' },
	{ why: 'a folder no collection declares', body: { collection: 'other', path: 'x', title: 'X' }, status: 400, code: 'bad-path' },
	{ why: 'nested in a flat collection', body: { collection: 'journal', path: 'a/b', title: 'X' }, status: 400, code: 'bad-path' },
	{ why: 'a link out of the collection', body: { collection: 'pages', path: 'linked/x', title: 'X' }, status: 400, code: 'bad-path' },
	{ why: 'index at the top', body: { collection: 'pages', path: 'index', title: 'X' }, status: 400, code: 'index' },
	{ why: 'index in a group', body: { collection: 'pages', path: 'studio/index', title: 'X' }, status: 400, code: 'index' },
	{ why: 'index in a flat collection', body: { collection: 'journal', path: 'index', title: 'X' }, status: 400, code: 'index' },
	{ why: 'not an address part', body: { collection: 'pages', path: 'Studio/Visit', title: 'X' }, status: 400, code: 'bad-name' },
	{ why: 'nothing left of the name', body: { collection: 'pages', path: '', title: '!!!' }, status: 400, code: 'bad-name' },
	{ why: 'no title', body: { collection: 'pages', path: 'x', title: '   ' }, status: 400, code: 'bad-name' },
	{ why: 'a title with a line break', body: { collection: 'pages', path: 'x', title: 'X\nEdited-by: Someone <s@x.test>: content/pages/index.json' }, status: 400, code: 'bad-name' },
	{ why: 'under /admin', body: { collection: 'pages', path: 'admin', title: 'X' }, status: 400, code: 'reserved-address' },
	{ why: 'deeper under /admin', body: { collection: 'pages', path: 'admin/tools', title: 'X' }, status: 400, code: 'reserved-address' },
	{ why: "below Journal's base", body: { collection: 'pages', path: 'journal/x', title: 'X' }, status: 400, code: 'below-collection' },
	{ why: "below Case studies' base", body: { collection: 'pages', path: 'work/x', title: 'X' }, status: 400, code: 'below-collection' },
	{ why: 'a document that exists', body: { collection: 'pages', path: 'services/branding', title: 'X' }, status: 409, code: 'exists' },
	{ why: "another collection's address", body: { collection: 'case-studies', path: 'kiln', title: 'Kiln' }, status: 409, code: 'address-taken' },
	{ why: 'Site Settings', body: { collection: 'settings', path: 'site-settings', title: 'X' }, status: 400, code: 'not-allowed' },
	{ why: 'a shared block with no type', body: { collection: 'shared', path: 'banner', title: 'Banner' }, status: 400, code: 'not-allowed' },
	{ why: 'a shared block of an unknown type', body: { collection: 'shared', path: 'banner', title: 'Banner', blockType: 'gallery' }, status: 400, code: 'not-allowed' },
	{ why: 'a block type for a page', body: { collection: 'pages', path: 'x', title: 'X', blockType: 'cta' }, status: 400, code: 'bad-request' },
	{ why: 'an unknown key', body: { collection: 'pages', path: 'x', title: 'X', file: 'content/pages/x.json' }, status: 400, code: 'bad-request' },
];

/** Every delete a store must refuse. */
export const REFUSED_DELETES: { why: string; body: Record<string, unknown>; status: number; code: string }[] = [
	{ why: '../ out of the collection', body: { collection: 'pages', path: '../outside-root' }, status: 400, code: 'bad-path' },
	{ why: 'an absolute path', body: { collection: 'pages', path: '/etc/passwd' }, status: 400, code: 'bad-path' },
	{ why: 'a folder no collection declares', body: { collection: 'other', path: 'x' }, status: 400, code: 'bad-path' },
	{ why: 'a link out of the collection', body: { collection: 'pages', path: 'linked/secret' }, status: 400, code: 'bad-path' },
	{ why: 'Home', body: { collection: 'pages', path: 'index' }, status: 400, code: 'not-allowed' },
	{ why: 'Site Settings', body: { collection: 'settings', path: 'site-settings' }, status: 400, code: 'not-allowed' },
	{ why: 'no such document', body: { collection: 'pages', path: 'nowhere' }, status: 404, code: 'not-found' },
	{ why: 'a shared block in use', body: { collection: 'shared', path: 'footer' }, status: 409, code: 'in-use' },
];
