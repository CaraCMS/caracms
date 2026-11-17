/**
 * M7's test-only site (test/nested-list.browser.test.ts): the demo copy's changes, made
 * before its dev server starts (helpers/dev-site.ts → `edit`). The fixture demo site is untouched.
 *
 * - Site Settings gets the site's own fields: the contract's `menu` (a list with an inner list
 *   of links) and `partners` (a list with an inner list of images), with content.
 * - The text block gets the same `menu`, its labels and inner links drawn with markers, and
 *   `columns` (an inner list of several fields, sidebar only); a page, `/nested`, has one,
 *   with an unknown key in an inner item of `columns`.
 * - The page component draws a stand-in for the shell from `settings` (the site's name and the
 *   menu's labels) and prints `settings` as JSON.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Used by the partners' first logo, with no alt text. */
export const LOGO = 'uploads/aaaaaaaaaaaa/harbour-logo.png';

const MENU = `list(
			{
				label: text({ label: 'Label' }),
				href: link({ label: 'Address', addressOnly: true, help: 'With dropdown links, this item opens them; its own address isn’t used.' }),
				links: list(link({ label: 'Link' }), { label: 'Dropdown links' }),
			},
			{ label: 'Menu', itemLabel: 'label' },
		)`;

function replace(text: string, from: string, to: string, file: string): string {
	if (!text.includes(from)) throw new Error(`${file}: "${from.slice(0, 60)}" isn't there to replace`);
	return text.replace(from, to);
}

export function edit(root: string) {
	const configFile = join(root, 'caracms.config.ts');
	let config = readFileSync(configFile, 'utf8');
	config = replace(config, "import { defineSite } from 'caracms/config';", "import { defineSite, link, list, media, text } from 'caracms/config';", configFile);
	config = replace(
		config,
		"\tpage: 'src/components/Page.astro',",
		`\tsettings: {
		fields: {
			menu: ${MENU},
			partners: list({ name: text({ label: 'Name' }), logos: list(media({ only: 'image', label: 'Logo' }), { label: 'Logos' }) }, { label: 'Partners' }),
		},
	},
	page: 'src/components/Page.astro',`,
		configFile,
	);
	writeFileSync(configFile, config);

	const textFile = join(root, 'src/blocks/text.ts');
	let schema = readFileSync(textFile, 'utf8');
	schema = replace(schema, "import { richText, text,", "import { link, list, richText, text,", textFile);
	schema = replace(
		schema,
		'background: background(),',
		`background: background(),\n\t\tmenu: ${MENU},\n\t\tcolumns: list({ heading: text({ label: 'Heading' }), rows: list({ name: text({ label: 'Name' }), note: text({ label: 'Note' }) }, { label: 'Rows' }) }, { label: 'Columns' }),`,
		textFile,
	);
	writeFileSync(textFile, schema);

	const textComponent = join(root, 'src/blocks/Text.astro');
	let component = readFileSync(textComponent, 'utf8');
	component = replace(component, "import Text from 'caracms/components/Text.astro';", "import Text from 'caracms/components/Text.astro';\nimport Link from 'caracms/components/Link.astro';", textComponent);
	component = replace(
		component,
		'<RichText cms={cms} field="body" value={block.body} class="text-body" />',
		`<RichText cms={cms} field="body" value={block.body} class="text-body" />
		{block.menu.length > 0 && (
			<nav class="text-menu" data-test-block-menu>
				{block.menu.map((m, i) => (
					<p>
						<Text cms={cms} field={\`menu.\${i}.label\`} value={m.label} as="span" />
						{m.links.map((l, j) => <Link cms={cms} field={\`menu.\${i}.links.\${j}\`} value={l} />)}
					</p>
				))}
			</nav>
		)}`,
		textComponent,
	);
	writeFileSync(textComponent, component);

	const pageFile = join(root, 'src/components/Page.astro');
	let page = readFileSync(pageFile, 'utf8');
	page = replace(page, 'const { document, collection, preview = false, cms, data } = Astro.props;', 'const { document, collection, preview = false, cms, data, settings } = Astro.props;\nconst shell = settings as { brand: { name: string }; menu: { label: string }[] };', pageFile);
	page = replace(
		page,
		'<main class:list={[{ solo }]}>',
		`<div data-test-shell>
			<span data-test-site-name>{shell.brand.name}</span>
			{shell.menu.map((m) => <span data-test-menu-item>{m.label}</span>)}
			<script type="application/json" data-test-settings set:html={JSON.stringify(settings)} />
		</div>
		<main class:list={[{ solo }]}>`,
		pageFile,
	);
	writeFileSync(pageFile, page);

	const settingsFile = join(root, 'content/site-settings.json');
	const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
	writeFileSync(
		settingsFile,
		`${JSON.stringify(
			{
				...settings,
				googleTag: 'G-TEST12345',
				menu: [
					{ label: 'About', href: { href: '/about' }, links: [] },
					{
						label: 'Services',
						href: { href: '' },
						links: [
							{ label: 'Branding', href: '/services/branding' },
							{ label: 'Websites', href: '/services/websites' },
						],
					},
				],
				partners: [{ name: 'High-street coffee roaster', logos: [{ key: LOGO, w: 400, h: 200 }] }],
			},
			null,
			2,
		)}\n`,
	);

	writeFileSync(
		join(root, 'content/pages/nested.json'),
		`${JSON.stringify(
			{
				title: 'Nested',
				blocks: [
					{
						type: 'text',
						heading: 'A list in a list',
						body: 'Each row has its own links.',
						background: 'light',
						menu: [
							{ label: 'Studio', href: { href: '/about' }, links: [] },
							{
								label: 'Services',
								href: { href: '' },
								links: [
									{ label: 'Branding', href: '/services/branding' },
									{ label: 'Websites', href: '/services/websites' },
								],
							},
						],
						columns: [{ heading: 'Studio', rows: [{ name: 'Aoife', note: 'Design', legacyId: 7 }] }],
					},
				],
			},
			null,
			2,
		)}\n`,
	);
}
