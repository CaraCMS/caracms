// Rich text's format (M5a Decision 3): reading is forgiving, writing is strict, and
// a value the writer wrote reads back to itself byte for byte.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	normaliseRuns,
	parseInline,
	parseRichText,
	readRichText,
	fileLinkAttributes,
	NEW_TAB_NOTE_HTML,
	richTextHtml,
	serializeInline,
	serializeRichText,
	type RichTextOptions,
	type TextRun,
} from '../src/rich-text.ts';

const all: RichTextOptions = { headings: ['h2', 'h3'], links: true };
const plain: RichTextOptions = { headings: [], links: true };

describe('inline markup', () => {
	test('bold, italic, links and breaks read as runs', () => {
		assert.deepEqual(parseInline('We drew the letters from the old **ferry signs**, see [the print work](/services/print).'), [
			{ text: 'We drew the letters from the old ' },
			{ text: 'ferry signs', bold: true },
			{ text: ', see ' },
			{ text: 'the print work', href: '/services/print' },
			{ text: '.' },
		]);
		assert.deepEqual(parseInline('*soft*\nnext'), [{ text: 'soft', italic: true }, { text: '\nnext' }]);
	});

	test('bold and italic nest in each other and in a link\'s text', () => {
		assert.deepEqual(parseInline('**bold *both* bold**'), [
			{ text: 'bold ', bold: true },
			{ text: 'both', bold: true, italic: true },
			{ text: ' bold', bold: true },
		]);
		assert.deepEqual(parseInline('*it **both** it*'), [
			{ text: 'it ', italic: true },
			{ text: 'both', bold: true, italic: true },
			{ text: ' it', italic: true },
		]);
		assert.deepEqual(parseInline('[a **b** *c*](/x)'), [
			{ text: 'a ', href: '/x' },
			{ text: 'b', bold: true, href: '/x' },
			{ text: ' ', href: '/x' },
			{ text: 'c', italic: true, href: '/x' },
		]);
	});

	test('reading is forgiving: an unpaired * or [ is literal text', () => {
		assert.deepEqual(parseInline('5 * 3 = 15'), [{ text: '5 * 3 = 15' }]);
		assert.deepEqual(parseInline('Stray **bold'), [{ text: 'Stray **bold' }]);
		assert.deepEqual(parseInline('See [the notes'), [{ text: 'See [the notes' }]);
		assert.deepEqual(parseInline('a] b'), [{ text: 'a] b' }]);
		assert.deepEqual(parseInline('[text] (not a link)'), [{ text: '[text] (not a link)' }]);
		assert.deepEqual(parseInline('[no close](/x'), [{ text: '[no close](/x' }]);
	});

	test('flanking: a * run followed by whitespace can\'t open, one preceded by whitespace can\'t close', () => {
		assert.deepEqual(parseInline('A * stray star, and the **ferry signs**.'), [
			{ text: 'A * stray star, and the ' },
			{ text: 'ferry signs', bold: true },
			{ text: '.' },
		]);
		assert.deepEqual(parseInline('a * b * c'), [{ text: 'a * b * c' }]);
		assert.deepEqual(parseInline('**bold **'), [{ text: '**bold **' }]);
		assert.deepEqual(parseInline('* x*'), [{ text: '* x*' }]);
		assert.deepEqual(parseInline('** bold**'), [{ text: '** bold**' }]);
		assert.deepEqual(parseInline('**  **'), [{ text: '**  **' }]);
		assert.deepEqual(parseInline('2 ** 3 ** 4'), [{ text: '2 ** 3 ** 4' }]);
		// Flanking looks at the whole run: `***x***` still pairs, and an escaped * isn't part of a run.
		assert.deepEqual(parseInline('***x***'), [{ text: 'x', bold: true, italic: true }]);
		assert.deepEqual(parseInline('**x\\***'), [{ text: 'x*', bold: true }]);
	});

	test('a link can\'t hold a link: the inner [ is literal', () => {
		assert.deepEqual(parseInline('[a [b](/x)'), [{ text: 'a [b', href: '/x' }]);
	});

	test('escapes: \\ before *, [, ] or \\ makes it literal; anything else keeps the backslash', () => {
		assert.deepEqual(parseInline('2 \\* 3 \\[x\\] \\\\ done'), [{ text: '2 * 3 [x] \\ done' }]);
		assert.deepEqual(parseInline('C:\\Users'), [{ text: 'C:\\Users' }]);
		assert.deepEqual(parseInline('[a](/b\\)c)'), [{ text: 'a', href: '/b)c' }]);
	});

	test('writing is strict: literal *, [, ], \\ escaped; ) and \\ escaped in an href', () => {
		assert.equal(serializeInline([{ text: '5 * 3 [x] \\' }]), '5 \\* 3 \\[x\\] \\\\');
		assert.equal(serializeInline([{ text: 'a', href: '/b)c\\' }]), '[a](/b\\)c\\\\)');
		assert.equal(serializeInline([{ text: 'line\nbreak' }]), 'line\nbreak');
	});

	test('writing: the longer mark is the outer one; marks close at a link\'s edges', () => {
		assert.equal(
			serializeInline([
				{ text: 'it ', italic: true },
				{ text: 'both', bold: true, italic: true },
			]),
			'*it **both***',
		);
		assert.equal(
			serializeInline([
				{ text: 'a ', bold: true },
				{ text: 'b', bold: true, href: '/x' },
				{ text: ' c', bold: true },
			]),
			'**a** [**b**](/x) **c**',
		);
	});

	test('writing: bold or italic never opens before whitespace or closes after it; the space moves outside the mark', () => {
		assert.equal(serializeInline([{ text: 'bold ', bold: true }, { text: 'x' }]), '**bold** x');
		assert.equal(serializeInline([{ text: ' lead', italic: true }]), ' *lead*');
		assert.equal(serializeInline([{ text: 'a', bold: true, italic: true }, { text: ' b', italic: true }]), '***a** b*');
		assert.equal(serializeInline([{ text: 'a', bold: true }, { text: '\n', bold: true, italic: true }, { text: 'b', bold: true }]), '**a\nb**');
		assert.deepEqual(normaliseRuns([{ text: 'x ', bold: true }]), [{ text: 'x', bold: true }, { text: ' ' }]);
	});

	test('a hand-written spelling reads to the same runs as the strict one', () => {
		assert.deepEqual(parseInline('**a [b](/x) c**'), parseInline('**a** [**b**](/x) **c**'));
	});

	test('round trip: what the writer wrote reads back to its own runs and writes the same text (random runs)', () => {
		let seed = 7;
		const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
		const texts = ['a', 'b c', ' ', '  ', ' x ', '*', '**', '* ', ' *', '[x]', ']', '(', ')', '\\', '\n', '\n ', 'd)', '](/y)'];
		for (let n = 0; n < 20000; n++) {
			const runs: TextRun[] = [];
			const count = 1 + Math.floor(rnd() * 6);
			for (let j = 0; j < count; j++) {
				const r: TextRun = { text: pick(texts) };
				if (rnd() < 0.5) r.bold = true;
				if (rnd() < 0.5) r.italic = true;
				if (rnd() < 0.3) r.href = pick(['/x', 'y)z', '', 'https://e.test/a_(b)']);
				runs.push(r);
			}
			const want = normaliseRuns(runs);
			const written = serializeInline(want);
			const read = parseInline(written);
			assert.deepEqual(read, want, `runs ${JSON.stringify(want)} wrote ${JSON.stringify(written)}`);
			assert.equal(serializeInline(read), written);
		}
	});

	test('a long or pathological unit reads quickly and never throws', () => {
		for (const s of ['* '.repeat(400), '[ '.repeat(500), '**a *b [c '.repeat(200), '\\*'.repeat(5000), 'word **bold** '.repeat(300)]) {
			const started = performance.now();
			assert.doesNotThrow(() => parseInline(s));
			assert.ok(performance.now() - started < 2000, `${s.slice(0, 20)}… took too long`);
		}
	});
});

describe('blocks', () => {
	test('the stored form reads as blocks; a list\'s items each a unit', () => {
		const value = parseRichText(
			[{ p: 'Hello **there**' }, { h2: 'From the harbour wall\noutward' }, { ul: ['One', 'Two *2*'] }, { ol: ['First'] }],
			all,
		);
		assert.deepEqual(value, [
			{ kind: 'p', runs: [{ text: 'Hello ' }, { text: 'there', bold: true }] },
			{ kind: 'h2', runs: [{ text: 'From the harbour wall\noutward' }] },
			{ kind: 'ul', items: [[{ text: 'One' }], [{ text: 'Two ' }, { text: '2', italic: true }]] },
			{ kind: 'ol', items: [[{ text: 'First' }]] },
		]);
	});

	test('round trip: stored → value → stored is identical for strictly written text', () => {
		const stored = [
			{ p: 'The roaster started as a cart on the quay. 5 \\* 3, \\[sic\\], C:\\\\path' },
			{ h2: 'From the harbour wall\noutward' },
			{ h3: '*Small* print' },
			{ p: 'We drew the letters from the old **ferry signs**, see [the print work](/services/print).' },
			{ ul: ['First point', 'Second **point**'] },
			{ ol: ['[Call](tel:+353210000000)'] },
		];
		assert.deepEqual(serializeRichText(parseRichText(stored, all), all), stored);
		// And the value's own form reads back to itself.
		const value = parseRichText(stored, all);
		assert.deepEqual(parseRichText(value, all), value);
	});

	test('never h1, and a kind the field doesn\'t allow reads as p, with an issue; written as p', () => {
		const raw = [{ h1: 'Big' }, { h2: 'Section' }, { h3: 'Sub' }, { blockquote: 'Quote' }];
		const { value, issues } = readRichText(raw, { headings: ['h2'], links: true });
		assert.deepEqual(
			value.map((b) => b.kind),
			['p', 'h2', 'p', 'p'],
		);
		assert.deepEqual(issues, [
			{ code: 'disallowed-kind', block: 0, kind: 'h1' },
			{ code: 'disallowed-kind', block: 2, kind: 'h3' },
			{ code: 'disallowed-kind', block: 3, kind: 'blockquote' },
		]);
		assert.deepEqual(serializeRichText(value, { headings: ['h2'], links: true }), [{ p: 'Big' }, { h2: 'Section' }, { p: 'Sub' }, { p: 'Quote' }]);
		// With headings off, an h2 is a paragraph too.
		assert.deepEqual(parseRichText([{ h2: 'x' }], plain), [{ kind: 'p', runs: [{ text: 'x' }] }]);
	});

	test('a link where links are off reads as its text, with an issue; written as text', () => {
		const off: RichTextOptions = { headings: [], links: false };
		const { value, issues } = readRichText([{ p: 'See [the work](/work).' }, { ul: ['[a](/a)', 'b'] }], off);
		assert.deepEqual(value, [
			{ kind: 'p', runs: [{ text: 'See the work.' }] },
			{ kind: 'ul', items: [[{ text: 'a' }], [{ text: 'b' }]] },
		]);
		assert.deepEqual(issues, [
			{ code: 'link-off', block: 0 },
			{ code: 'link-off', block: 1 },
		]);
		assert.deepEqual(serializeRichText(value, off), [{ p: 'See the work.' }, { ul: ['a', 'b'] }]);
	});

	test('a plain string reads as rich text with its characters literal: paragraphs on blank lines, breaks on single newlines', () => {
		const value = parseRichText('An *old* text field\nwith a break\n\n  \n[Second] paragraph\\', all);
		assert.deepEqual(value, [
			{ kind: 'p', runs: [{ text: 'An *old* text field\nwith a break' }] },
			{ kind: 'p', runs: [{ text: '[Second] paragraph\\' }] },
		]);
		// The first edit writes it escaped, in the list form.
		assert.deepEqual(serializeRichText(value, all), [{ p: 'An \\*old\\* text field\nwith a break' }, { p: '\\[Second\\] paragraph\\\\' }]);
	});

	test('empty paragraphs, items and lists are dropped; breaks and spaces at a unit\'s ends trimmed', () => {
		const value = parseRichText([{ p: '' }, { p: '\n\n  ' }, { ul: ['', '  ', 'kept'] }, { ol: [] }, { ol: [''] }, { h2: '\nTitle\n' }], all);
		assert.deepEqual(value, [
			{ kind: 'ul', items: [[{ text: 'kept' }]] },
			{ kind: 'h2', runs: [{ text: 'Title' }] },
		]);
	});

	test('wrong shapes never throw: unreadable entries dropped with an issue, anything else empty', () => {
		for (const raw of [undefined, null, 3, true, { p: 'x' }]) assert.deepEqual(parseRichText(raw, all), []);
		const { value, issues } = readRichText([7, 'loose', { p: 1 }, { p: 'a', h2: 'b' }, { ul: 'x' }, { p: 'ok' }, { ul: ['a', 2, null] }], all);
		assert.deepEqual(value, [
			{ kind: 'p', runs: [{ text: 'ok' }] },
			{ kind: 'ul', items: [[{ text: 'a' }]] },
		]);
		assert.deepEqual(
			issues.map((i) => [i.code, i.block]),
			[
				['unreadable', 0],
				['unreadable', 1],
				['unreadable', 2],
				['unreadable', 3],
				['unreadable', 4],
			],
		);
	});
});

describe('the render', () => {
	test('semantic HTML, no classes: p, h2 with a break as <br>, lists, strong, em, a', () => {
		const html = richTextHtml(
			parseRichText(
				[
					{ p: 'Hello **bold *both*** and [the work](/work).' },
					{ h2: 'From the harbour wall\noutward' },
					{ ul: ['One', 'Two'] },
					{ ol: ['First'] },
				],
				all,
			),
		);
		assert.equal(
			html,
			'<p>Hello <strong>bold <em>both</em></strong> and <a href="/work">the work</a>.</p>' +
				'<h2>From the harbour wall<br>outward</h2>' +
				'<ul><li>One</li><li>Two</li></ul>' +
				'<ol><li>First</li></ol>',
		);
		assert.doesNotMatch(html, /class=|<script/);
	});

	test('a link whose href fails the link rule renders as its text; text is escaped', () => {
		const html = richTextHtml(parseRichText([{ p: 'Go [there](javascript:alert(1)) <b>&</b>' }], all));
		assert.equal(html, '<p>Go there) &lt;b&gt;&amp;&lt;/b&gt;</p>');
		const html2 = richTextHtml(parseRichText([{ p: '[ok](https://example.com/?a=1&b="2")' }], all));
		assert.equal(html2, '<p><a href="https://example.com/?a=1&amp;b=&quot;2&quot;">ok</a></p>');
	});

	test('a disallowed kind renders as a paragraph', () => {
		assert.equal(richTextHtml(parseRichText([{ h1: 'Never' }, { h3: 'No h3 here' }], { headings: ['h2'], links: true })), '<p>Never</p><p>No h3 here</p>');
	});
});

describe('M6c Decision 11: file links in the render', () => {
	const pdf = '/files/0123456789ab/rulebook.pdf';
	const value = parseRichText([{ p: `[a](${pdf}) [b](${pdf}?download) [c](/files/0123456789ab/terms.docx) [d](/brochure.pdf) [e](${pdf}#page=2)` }], all);

	test('off by default (the editor seeds and mirrors from this HTML): no attributes, no note', () => {
		assert.equal(
			richTextHtml(value),
			`<p><a href="${pdf}">a</a> <a href="${pdf}?download">b</a> <a href="/files/0123456789ab/terms.docx">c</a> <a href="/brochure.pdf">d</a> <a href="${pdf}#page=2">e</a></p>`,
		);
	});

	test('with fileLinks: a PDF opens in a new tab with the hidden note; ?download and other types download; public/ files unchanged', () => {
		assert.equal(
			richTextHtml(value, { fileLinks: true }),
			`<p><a href="${pdf}" target="_blank" rel="noopener">a${NEW_TAB_NOTE_HTML}</a> <a href="${pdf}?download" download>b</a> ` +
				`<a href="/files/0123456789ab/terms.docx" download>c</a> <a href="/brochure.pdf">d</a> <a href="${pdf}#page=2" target="_blank" rel="noopener">e${NEW_TAB_NOTE_HTML}</a></p>`,
		);
		assert.match(NEW_TAB_NOTE_HTML, /^<span style="[^"]*clip:rect\(0,0,0,0\)[^"]*"> \(opens in a new tab\)<\/span>$/);
	});

	test('in a list item too', () => {
		assert.equal(richTextHtml(parseRichText([{ ul: [`[x](${pdf}?download)`] }], all), { fileLinks: true }), `<ul><li><a href="${pdf}?download" download>x</a></li></ul>`);
	});

	test('fileLinkAttributes: the answer for a site\'s own markup', () => {
		assert.deepEqual(fileLinkAttributes(pdf), { attributes: { target: '_blank', rel: 'noopener' }, newTab: true });
		assert.deepEqual(fileLinkAttributes(` ${pdf}?download `), { attributes: { download: '' }, newTab: false });
		assert.deepEqual(fileLinkAttributes('/brochure.pdf'), { attributes: {}, newTab: false });
		assert.deepEqual(fileLinkAttributes('https://example.com/a.pdf'), { attributes: {}, newTab: false });
	});
});
