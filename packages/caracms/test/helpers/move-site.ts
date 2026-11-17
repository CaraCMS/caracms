/**
 * Pre-M7 item 8's site: the create-site copy (create-site.ts), with a block of links
 * (a link, buttons and rich text), case studies that reference each other, a Visit page
 * to move, and Site Settings with two redirects. move.test.ts and move-live.test.ts.
 */
import { buttons, link, list, reference, richText, SITE_SETTINGS_FILE, text, type SiteConfig } from '../../src/config.ts';
import { makeCreateSite, type CreateSite } from './create-site.ts';

export const makeMoveSiteConfig = (c: SiteConfig): SiteConfig => ({
	...c,
	blocks: { ...c.blocks, links: { component: 'Block.astro', fields: { link: link(), buttons: buttons({ styles: ['primary'] }), body: richText() } } },
	collections: {
		...c.collections,
		'case-studies': {
			kind: 'fields',
			label: 'Case studies',
			folder: 'content/case-studies',
			urlBase: '/work/',
			component: 'Block.astro',
			fields: { client: text(), body: richText(), related: list(reference({ to: 'case-studies' })) },
		},
	} as SiteConfig['collections'],
});

export const MOVE_FILES: Record<string, string> = {
	'content/pages/visit.json': '{\n  "title": "Visit",\n  "blocks": [\n    { "type": "links", "link": { "label": "Back home", "href": "/" }, "body": [{ "p": "This is [us](/visit)." }] }\n  ]\n}\n',
	'content/pages/index.json':
		'{\n  "title": "Home",\n  "blocks": [\n    {\n      "type": "links",\n      "link": { "label": "Visit us", "href": "/visit" },\n      "buttons": [{ "label": "Hours", "href": "/visit#hours", "style": "primary" }, { "label": "Elsewhere", "href": "/visitors", "style": "primary" }],\n      "body": [{ "p": "See [the studio](/visit/?m=1) or [the team](/about/team)." }]\n    },\n    { "type": "text", "heading": "/visit", "body": "Plain words." }\n  ]\n}\n',
	'content/case-studies/high-street-coffee.json': '{\n  "title": "High-street coffee roaster",\n  "client": "high-street-coffee",\n  "related": ["tiny"]\n}\n',
	'content/case-studies/tiny.json': '{\n  "title": "Tiny",\n  "body": [{ "p": "Like [the roaster](/work/high-street-coffee)." }],\n  "related": ["high-street-coffee", "nobody"]\n}\n',
	[SITE_SETTINGS_FILE]: '{\n  "title": "Site Settings",\n  "editors": [],\n  "redirects": [\n    { "from": "/old-visit", "to": "/visit" },\n    { "from": "/studio/visit", "to": "/elsewhere" }\n  ]\n}\n',
};

export function makeMoveSite(options: { repoPath?: string } = {}): CreateSite {
	return makeCreateSite({
		...options,
		link: false,
		extend: makeMoveSiteConfig,
		files: MOVE_FILES,
	});
}

/**
 * Collections under pages (carrier B): the move site with case studies held by the Work
 * page (`heldBy`, no `urlBase`), a page under Work beside them (`work/kiln`, from the
 * create site), and Home linking to a case study. holder-move.test.ts.
 */
export function makeHolderSite(options: { repoPath?: string; files?: Record<string, string> } = {}): CreateSite {
	return makeCreateSite({
		...(options.repoPath ? { repoPath: options.repoPath } : {}),
		link: false,
		extend: (c) => {
			const moved = makeMoveSiteConfig(c);
			const { urlBase: _, ...caseStudies } = moved.collections['case-studies'] as unknown as Record<string, unknown>;
			return { ...moved, collections: { ...moved.collections, 'case-studies': { ...caseStudies, heldBy: 'pages' } } as unknown as SiteConfig['collections'] };
		},
		files: {
			...MOVE_FILES,
			'content/pages/work.json': '{\n  "title": "Work",\n  "holds": "case-studies",\n  "blocks": []\n}\n',
			'content/pages/index.json':
				'{\n  "title": "Home",\n  "blocks": [\n    {\n      "type": "links",\n      "link": { "label": "Our work", "href": "/work" },\n      "buttons": [{ "label": "Harbour", "href": "/work/high-street-coffee", "style": "primary" }],\n      "body": [{ "p": "See [Kiln](/work/kiln) and [Visit](/visit)." }]\n    }\n  ]\n}\n',
			...(options.files ?? {}),
		},
	});
}
