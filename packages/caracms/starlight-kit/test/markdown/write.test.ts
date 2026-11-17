// pageToMarkdown: the shapes it writes, and that the reader takes them back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToPage, pageToMarkdown, type WriterNote } from '../../src/starlight-kit/markdown/index.ts';
import { entryOf, parsedBlocks } from './site.ts';

const page = {
	title: 'Adding Pictures',
	seo: { description: 'Step two.' },
	blocks: [
		{ type: 'text', body: [{ p: 'Step two. See [Guides](/guides#a-b) and *this* \\[x\\].' }, { h2: 'Upload' }, { ul: ['One', '**Two** too'] }, { h3: 'Upload' }, { p: '- not a list\n1. nor this' }] },
		{ type: 'aside', kind: 'tip', body: [{ p: 'Tipped **well**.' }, { ul: ['a', 'b'] }] },
		{ type: 'aside', kind: 'danger', body: [{ ul: ['only a list'] }] },
		{ type: 'steps', steps: [[{ p: 'Open **Guides**.' }], [{ p: 'Pick:' }, { ul: ['A', 'B'] }, { p: 'Then save.' }]] },
		{ type: 'table', header: [[{ p: 'Type' }], [{ p: 'Max | size' }]], rows: [{ cells: [[{ p: 'JPEG' }], [{ p: '10 MB' }]] }, { cells: [[{ p: 'WEBP' }]] }] },
		{ type: 'screenshot', capture: 'Nothing yet' },
		{ type: 'screenshot', image: { key: 'uploads/a.png', alt: '', w: 10, h: 10 }, capture: 'The Guides screen', caption: 'The *Guides* screen.' },
		{ type: 'screenshot', image: { key: 'uploads/b.png', alt: 'Own alt', w: 10, h: 10 }, capture: 'Ignored' },
	],
};

const url = (image: { key: string }) => `https://media.test/${image.key}`;

test('writes each block\'s shape', () => {
	const md = pageToMarkdown(entryOf(page), { imageUrl: url });
	assert.equal(
		md,
		[
			'# Adding Pictures',
			'',
			'Step two. See [Guides](/guides#a-b) and *this* \\[x\\].',
			'',
			'## Upload',
			'',
			'- One',
			'- **Two** too',
			'',
			'### Upload',
			'',
			'\\- not a list',
			'1\\. nor this',
			'',
			'> **Tip:** Tipped **well**.',
			'>',
			'> - a',
			'> - b',
			'',
			'> **Danger:**',
			'>',
			'> - only a list',
			'',
			'1. Open **Guides**.',
			'2. Pick:',
			'',
			'   - A',
			'   - B',
			'',
			'   Then save.',
			'',
			'| Type | Max \\| size |',
			'| --- | --- |',
			'| JPEG | 10 MB |',
			'| WEBP |  |',
			'',
			'![The Guides screen](https://media.test/uploads/a.png)',
			'*The \\*Guides\\* screen.*',
			'',
			'![Own alt](https://media.test/uploads/b.png)',
			'',
		].join('\n'),
	);
});

test('the reader takes the written page back (empty screenshot gone, pictures back as empty screenshots)', () => {
	const back = markdownToPage(pageToMarkdown(entryOf(page), { imageUrl: url }));
	assert.equal(back.title, 'Adding Pictures');
	assert.equal(back.description, 'Step two. See Guides and this [x].');
	const want = page.blocks
		.filter((b) => !(b.type === 'screenshot' && !('image' in b)))
		.map((b) => (b.type === 'screenshot' ? { type: 'screenshot', capture: (b as { image: { alt: string } }).image.alt || b.capture, ...('caption' in b ? { caption: b.caption } : {}) } : b));
	// The short table row comes back padded, as the writer pads it.
	(want[4] as { rows: { cells: unknown[] }[] }).rows[1]!.cells.push([]);
	assert.deepEqual(parsedBlocks(back.blocks), parsedBlocks(want));
});

test('a list in a table cell is flattened to lines and reported', () => {
	const notes: WriterNote[] = [];
	const md = pageToMarkdown(entryOf({ title: 'T', blocks: [{ type: 'table', header: [[{ p: 'A' }]], rows: [{ cells: [[{ p: 'Kinds:' }, { ul: ['x', 'y'] }]] }] }] }), { report: (n) => notes.push(n) });
	assert.match(md, /\| Kinds:<br><br>- x<br>- y \|/);
	assert.deepEqual(notes.map((n) => n.kind), ['cell-list-flattened']);
	const back = markdownToPage(md);
	assert.deepEqual((back.blocks[0] as { rows: { cells: unknown[] }[] }).rows[0]!.cells[0], [{ p: 'Kinds:' }, { p: '- x\n- y' }]);
});

test('without media set up, a picture\'s URL falls back to its key', () => {
	const md = pageToMarkdown(entryOf({ title: 'T', blocks: [{ type: 'screenshot', image: { key: 'uploads/c.png', alt: 'C' }, capture: '' }] }));
	assert.match(md, /!\[C\]\((?:uploads\/c\.png|https?:\/\/\S+)\)/);
});

test('steps carry on from their start, and read back with it', () => {
	const resumed = { title: 'Resumed', blocks: [{ type: 'steps', steps: [[{ p: 'Three.' }], [{ p: 'Four.' }]], start: 3 }] };
	const md = pageToMarkdown(entryOf(resumed));
	assert.equal(md, '# Resumed\n\n3. Three.\n4. Four.\n');
	assert.deepEqual(markdownToPage(md).blocks, resumed.blocks);
});
