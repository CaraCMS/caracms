/**
 * M9's test blocks, added to a copy of the fixture site (helpers/site-render.ts's `pinnedSite`,
 * helpers/dev-site.ts's `startDevSite({ edit })`), never to the fixture itself, so the editor's
 * block picker and the visual suite's states stay as pinned.
 *
 * - `lines`: a heading in the lines rendering (Decision 10), a PNG picture (Decision 8) and a
 *   WebP one beside it.
 * - `statement`: a heading rich-text field (Decision 11) as the block's only heading.
 *
 * And a page, `m9`, holding one of each, the statement first (so its heading is the page's h1).
 *
 * `addCards` (Decision 9): the page component wraps the `cards` page's blocks 1–3 in a band
 * (`<div class="band-of-cards">`) holding two cards (`<article class="card" id>`): blocks 1–2
 * in `story`, block 3 in `team`. Blocks 0 and 4 stay outside.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const M9_PAGE = 'm9';

const LINES_TS = `import { media, text, type BlockConfig, type BlockData } from 'caracms/config';

export const linesBlock = {
	label: 'Lines',
	component: 'src/blocks/Lines.astro',
	fields: {
		heading: text({ label: 'Heading', heading: true, lines: true }),
		art: media({ label: 'Art', only: 'image', format: 'png' }),
		photo: media({ label: 'Photo', only: 'image' }),
	},
} satisfies BlockConfig;

export type LinesData = BlockData<typeof linesBlock.fields>;
`;

const LINES_ASTRO = `---
import Block from 'caracms/components/Block.astro';
import Media from 'caracms/components/Media.astro';
import Text from 'caracms/components/Text.astro';
import type { BlockProps } from 'caracms/document';
import type { LinesData } from './lines.ts';

type Props = BlockProps<LinesData>;
const { block, cms } = Astro.props;
---

<Block cms={cms} class="band lines-block">
	<Text cms={cms} field="heading" value={block.heading} class="lines-heading" lineClass="block text-balance" />
	<Media cms={cms} field="art" value={block.art} sizes="50vw" class="lines-art" />
	<Media cms={cms} field="photo" value={block.photo} sizes="50vw" class="lines-photo" />
</Block>
`;

const STATEMENT_TS = `import { richText, type BlockConfig, type BlockData } from 'caracms/config';

export const statementBlock = {
	label: 'Statement',
	component: 'src/blocks/Statement.astro',
	fields: {
		statement: richText({ label: 'Statement', heading: true }),
	},
} satisfies BlockConfig;

export type StatementData = BlockData<typeof statementBlock.fields>;
`;

const STATEMENT_ASTRO = `---
import Block from 'caracms/components/Block.astro';
import RichText from 'caracms/components/RichText.astro';
import type { BlockProps } from 'caracms/document';
import type { StatementData } from './statement.ts';

type Props = BlockProps<StatementData>;
const { block, cms } = Astro.props;
---

<Block cms={cms} class="band statement-block">
	<RichText cms={cms} field="statement" value={block.statement} class="statement" />
</Block>
`;

export const M9_DOCUMENT = {
	title: 'M9',
	blocks: [
		{ type: 'statement', statement: [{ p: 'Play **hard**' }, { p: 'Win *softly*' }] },
		{
			type: 'lines',
			heading: 'First line\n\nSecond line',
			art: { key: 'uploads/0a1b2c3d4e5f/steps-dice.png', alt: 'Dice', w: 1200, h: 800 },
			photo: { key: 'uploads/0a1b2c3d4e5f/harbour.jpg', alt: 'Harbour', w: 1200, h: 800 },
		},
	],
};

/** Add the blocks, register them in the copy's config, and write the `m9` page. */
export function addM9(root: string): void {
	writeFileSync(join(root, 'src/blocks/lines.ts'), LINES_TS);
	writeFileSync(join(root, 'src/blocks/Lines.astro'), LINES_ASTRO);
	writeFileSync(join(root, 'src/blocks/statement.ts'), STATEMENT_TS);
	writeFileSync(join(root, 'src/blocks/Statement.astro'), STATEMENT_ASTRO);
	const config = join(root, 'caracms.config.ts');
	const text = readFileSync(config, 'utf8')
		.replace("import { tm } from './src/blocks/tm.ts';", "import { tm } from './src/blocks/tm.ts';\nimport { linesBlock } from './src/blocks/lines.ts';\nimport { statementBlock } from './src/blocks/statement.ts';")
		.replace('\t\tfooter,\n\t},', '\t\tfooter,\n\t\tlines: linesBlock,\n\t\tstatement: statementBlock,\n\t},');
	if (!text.includes('lines: linesBlock')) throw new Error('addM9: the fixture config changed shape');
	writeFileSync(config, text);
	writeFileSync(join(root, `content/pages/${M9_PAGE}.json`), `${JSON.stringify(M9_DOCUMENT, null, 2)}\n`);
}

export const CARDS_PAGE = 'cards';

const BAND_ASTRO = `---
const { label } = Astro.props;
---
<div class="band-of-cards" data-label={label}><slot /></div>
`;

const CARD_ASTRO = `---
const { id } = Astro.props;
---
<article class="card" id={id}><slot /></article>
`;

const text = (heading: string) => ({ type: 'text', heading, body: [{ p: `${heading}'s words.` }], background: 'light' });
export const CARDS_DOCUMENT = { title: 'Cards', blocks: [text('Before'), text('Story one'), text('Story two'), text('Team'), text('After')] };

/** The page component's rule for the cards page, and the page. */
export function addCards(root: string): void {
	writeFileSync(join(root, 'src/components/Band.astro'), BAND_ASTRO);
	writeFileSync(join(root, 'src/components/Card.astro'), CARD_ASTRO);
	const page = join(root, 'src/components/Page.astro');
	const text = readFileSync(page, 'utf8')
		.replace("import Blocks from 'caracms/components/Blocks.astro';", "import Blocks from 'caracms/components/Blocks.astro';\nimport Band from './Band.astro';\nimport Card from './Card.astro';\nimport type { WrapBlocks } from 'caracms/document';")
		.replace(
			'const { listPage } = Astro.props;',
			"const { listPage } = Astro.props;\nconst cardRuns: WrapBlocks = () => (document.title === 'Cards' ? [{ from: 1, to: 3, component: Band, props: { label: 'About us' }, runs: [{ from: 1, to: 2, component: Card, props: { id: 'story' } }, { from: 3, to: 3, component: Card, props: { id: 'team' } }] }] : []);",
		)
		.replace('<Blocks document={document} collection={collection} preview={preview} listPage={listPage} />', '<Blocks document={document} collection={collection} preview={preview} listPage={listPage} wrap={cardRuns} />');
	if (!text.includes('<Blocks document={document} collection={collection} preview={preview} listPage={listPage} wrap={cardRuns} />') || !text.includes('const cardRuns')) throw new Error('addCards: the fixture Page.astro changed shape');
	writeFileSync(page, text);
	writeFileSync(join(root, `content/pages/${CARDS_PAGE}.json`), `${JSON.stringify(CARDS_DOCUMENT, null, 2)}\n`);
}
