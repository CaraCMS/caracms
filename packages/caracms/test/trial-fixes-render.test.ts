// M8 Exit step 11: the cold trial's render fixes (the M8 trial's findings),
// through Astro's container on a copy of the fixture site with a probe block added.
//
// - Item 4: an attribute passed through `<Block>`, `<Text>` or `<Link>` renders as on a plain
//   element: written bare it's bare, `false` is none; `aria-*` keeps its "true".
// - Item 5: a `<Link>`'s slot keeps its whitespace exactly as a plain `<a>` would.
// - Item 2: a link field holding `#` renders `href="#"`.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const demo = pinnedSite('trial-fixes');
const root = demo.root;
let r: Renderer;
let site: any;
let parseDocumentText: (text: string, site: unknown) => { document: any };

const PROBE = `---
import Block from 'caracms/components/Block.astro';
import Link from 'caracms/components/Link.astro';
import Text from 'caracms/components/Text.astro';
import Wrap from './Wrap.astro';
const { block, cms } = Astro.props;
---

<Block cms={cms} as="div" class="probe" data-flag data-off={false} aria-hidden={true} hidden={false} data-name="x">
	<Text cms={cms} field="title" value={block.title} data-t data-u={false} />
	<Link cms={cms} field="go" value={block.go} class="one">VIEW ALL <span>&rarr;</span></Link>
	<a class="one-plain">VIEW ALL <span>&rarr;</span></a>
	<Link cms={cms} field="go" value={block.go} class="two">
		VIEW ALL
		<span>x</span>
	</Link>
	<Wrap class="two-wrap">
		VIEW ALL
		<span>x</span>
	</Wrap>
	<a class="two-plain">
		VIEW ALL
		<span>x</span>
	</a>
	<Link cms={cms} field="go" value={block.go} class="three">{block.go.label} <span>&rarr;</span></Link>
	<a class="three-plain">{block.go.label} <span>&rarr;</span></a>
	<Wrap class="three-wrap">{block.go.label} <span>&rarr;</span></Wrap>
	<Link cms={cms} field="go" value={block.go} class="four">{block.go.label}{' '}<span>&rarr;</span></Link>
	<Link cms={cms} field="top" value={block.top} class="top" data-bare />
</Block>
<Block cms={cms} as="form" class="bools" novalidate data-x>
	<Text cms={cms} field="title" value={block.title} as="p" class="hid" hidden />
	<Link cms={cms} field="top" value={block.top} class="dl" download />
	<Block cms={cms} as="details" class="opened" open><summary>More</summary></Block>
	<Block cms={cms} as="input" class="req" required disabled />
</Block>
`;

before(async () => {
	writeFileSync(join(root, 'src/blocks/Probe.astro'), PROBE);
	// Any component's slot, for comparison: what Astro hands a component, untouched.
	writeFileSync(join(root, 'src/blocks/Wrap.astro'), '---\nconst { class: c } = Astro.props;\n---\n<a class={c}><slot /></a>\n');
	const config = join(root, 'caracms.config.ts');
	writeFileSync(
		config,
		`import { link as probeLink, text as probeText } from 'caracms/config';\n${readFileSync(config, 'utf8').replace(
			'\tblocks: {\n',
			"\tblocks: {\n\t\tprobe: { component: 'src/blocks/Probe.astro', fields: { title: probeText(), go: probeLink(), top: probeLink() } },\n",
		)}`,
	);
	r = await startRenderer(root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseDocumentText } = await r.load('caracms/document'));
});
after(async () => {
	await r.close();
	demo.close();
});

const render = async () => {
	const { document } = parseDocumentText(
		JSON.stringify({ title: 'Probe', blocks: [{ type: 'probe', title: 'Hello', go: { label: 'All work', href: '/work' }, top: { label: 'Back to top', href: '#' } }] }),
		site,
	);
	return r.page('caracms/components/RenderDocument.astro', { document, collection: 'pages', preview: false });
};
/** An element's opening tag, by its class. */
const openTag = (html: string, cls: string) => html.match(new RegExp(`<[a-z]+[^>]*class="${cls}"[^>]*>`))?.[0] ?? '';
/** An element's inner HTML, by its class (no nesting of the same tag inside). */
const inner = (html: string, tag: string, cls: string) => html.match(new RegExp(`<${tag}[^>]*class="${cls}"[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;

describe('trial item 4: booleans through the components', () => {
	test('<Block>: bare is bare, false is none, aria keeps "true", text passes', async () => {
		const tag = openTag(await render(), 'probe');
		assert.match(tag, / data-flag(?=[ >])/, tag);
		assert.doesNotMatch(tag, /data-flag=/, tag);
		assert.doesNotMatch(tag, /data-off/, tag);
		assert.doesNotMatch(tag, / hidden/, tag);
		assert.match(tag, / aria-hidden="true"/, tag);
		assert.match(tag, / data-name="x"/, tag);
	});

	test('<Text> and <Link> too', async () => {
		const html = await render();
		const p = html.match(/<p[^>]*data-t[^>]*>Hello<\/p>/)?.[0] ?? '';
		assert.match(p, / data-t(?=[ >])/, html);
		assert.doesNotMatch(p, /data-t=|data-u/, p);
		const top = openTag(html, 'top');
		assert.match(top, / data-bare(?=[ >])/, top);
		assert.doesNotMatch(top, /data-bare=/, top);
	});
});

describe('HTML boolean attributes pass through bare (weekend-bikes: <Block as="form" novalidate>)', () => {
	test('novalidate, hidden, download, open, required and disabled render bare; data-* still bare', async () => {
		const html = await render();
		assert.match(openTag(html, 'bools'), /^<form[^>]* novalidate(?=[ >])/, html);
		assert.match(openTag(html, 'bools'), / data-x(?=[ >])/);
		assert.match(openTag(html, 'hid'), / hidden(?=[ >])/, html);
		assert.match(openTag(html, 'dl'), / download(?=[ >])/, html);
		assert.match(openTag(html, 'opened'), / open(?=[ >])/, html);
		assert.match(openTag(html, 'req'), / required(?=[ >])/, html);
		assert.match(openTag(html, 'req'), / disabled(?=[ />])/, html);
		for (const cls of ['bools', 'hid', 'dl', 'opened', 'req']) assert.doesNotMatch(openTag(html, cls), / (novalidate|hidden|download|open|required|disabled)=/, cls);
	});
});

describe('trial item 5: a <Link> slot keeps its whitespace', () => {
	test('inline: the space before the <span> stays, as in a plain <a>', async () => {
		const html = await render();
		assert.equal(inner(html, 'a', 'one'), inner(html, 'a', 'one-plain'));
		assert.match(inner(html, 'a', 'one') ?? '', /^VIEW ALL <span>/);
	});

	// Not <Link>'s doing: Astro's compiler (compiler-rs 0.5.1) drops the whitespace between an
	// expression and an element in any component's children, before the component sees them
	// (`{a} <span>` compiles to `${a}<span>` in a slot, `${a} <span>` in a plain element). So
	// the space is written as an expression of its own, as the trial did.
	test('after an expression: Astro drops the space in a slot; `{" "}` keeps it', async () => {
		const html = await render();
		assert.equal(inner(html, 'a', 'three-plain'), 'All work <span>&rarr;</span>');
		assert.equal(inner(html, 'a', 'three'), inner(html, 'a', 'three-wrap'), "<Link> renders its slot as any component's");
		assert.equal(inner(html, 'a', 'three'), 'All work<span>&rarr;</span>', 'if Astro fixes its compiler, this matches the plain <a>: drop this assertion');
		assert.equal(inner(html, 'a', 'four'), inner(html, 'a', 'three-plain'));
	});

	test('across lines: the slot\'s text exactly as Astro gives it, never trimmed', async () => {
		const html = await render();
		assert.equal(inner(html, 'a', 'two'), inner(html, 'a', 'two-wrap'), "<Link> renders its slot as any component's");
		assert.match(inner(html, 'a', 'two') ?? '', /^\n\t\tVIEW ALL\n\t\t<span>x<\/span>/);
	});
});

describe('trial item 2: a fragment-only link renders', () => {
	test('`#` is href="#"', async () => {
		const html = await render();
		assert.match(openTag(html, 'top'), /^<a href="#"/);
		assert.match(html, />Back to top<\/a>/);
	});
});
