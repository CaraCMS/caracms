/**
 * M6c's test-only site (test/port-readiness.browser.test.ts): the demo copy's changes, made
 * before its dev server starts (helpers/dev-site.ts → `edit`). The fixture demo site is untouched.
 * The journal gets page fields (G2) and the page component shows its tagline; a `team`
 * collection has no urlBase (G1); the text block, its heading, the journal's tagline and a
 * credit's role get help (G8); the text block gets an address-only link (G9).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function edit(root: string) {
	const configFile = join(root, 'caracms.config.ts');
	let config = readFileSync(configFile, 'utf8');
	config = config.replace("import { defineSite } from 'caracms/config';", "import { defineSite, select, text } from 'caracms/config';");
	config = config.replace(
		"journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: journalFields },",
		"journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: { tagline: text({ help: 'Under the title on the journal cards.' }), side: select({ options: ['left', 'right'] }) } },",
	);
	config = config.replace(
		"'case-studies': caseStudies,",
		"'case-studies': caseStudies,\n\t\tteam: { kind: 'fields', folder: 'content/team', component: 'src/collections/Person.astro', fields: { role: text() } },",
	);
	writeFileSync(configFile, config);
	const textFile = join(root, 'src/blocks/text.ts');
	writeFileSync(
		textFile,
		readFileSync(textFile, 'utf8')
			.replace("label: 'Text',", "label: 'Text',\n\thelp: 'A heading and a few paragraphs, on a plain band.',")
			.replace("background: background(),", "background: background(),\n\t\tmore: link({ label: 'More', addressOnly: true }),")
			.replace("import { richText, text,", "import { link, richText, text,")
			.replace("heading: text({ label: 'Heading', heading: true })", "heading: text({ label: 'Heading', heading: true, help: 'Optional. The first heading on a page is its h1.' })"),
	);
	const casesFile = join(root, 'src/collections/case-studies.ts');
	writeFileSync(casesFile, readFileSync(casesFile, 'utf8').replace("role: text({ label: 'Role' })", "role: text({ label: 'Role', help: 'What they did, in a word or two.' })"));
	writeFileSync(
		join(root, 'src/collections/Person.astro'),
		"---\nimport Block from 'caracms/components/Block.astro';\nimport Text from 'caracms/components/Text.astro';\nconst { document, cms } = Astro.props;\n---\n\n<Block cms={cms} as=\"article\"><p data-test-person>{document.title}</p><Text cms={cms} field=\"role\" value={document.role} /></Block>\n",
	);
	mkdirSync(join(root, 'content/team'), { recursive: true });
	writeFileSync(join(root, 'content/team/aoife.json'), '{\n  "title": "Aoife",\n  "role": "Designer"\n}\n');
	const pageFile = join(root, 'src/components/Page.astro');
	let page = readFileSync(pageFile, 'utf8');
	page = page.replace('const { document, collection, preview = false } = Astro.props;', 'const { document, collection, preview = false, data } = Astro.props;');
	page = page.replace('<main class:list={[{ solo }]}>', '<main class:list={[{ solo }]}>\n\t\t\t{data?.tagline ? <p data-test-tagline>{String(data.tagline)}</p> : null}');
	writeFileSync(pageFile, page);
}
