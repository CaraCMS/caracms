import assert from 'node:assert/strict';
import { test } from 'node:test';
import { llmsFullTxt, llmsTxt, markdownUrl, warnWriterNotes } from '../../src/starlight-kit/llms.ts';
import { fakeReader } from './fake-reader.ts';

const read = fakeReader([
	{ path: 'index', title: 'Help', description: 'Guides for the product.' },
	{ path: 'getting-started', title: 'Getting Started', description: 'Up and running.' },
	{ path: 'getting-started/sign-up', title: 'Signing Up' },
	{ path: 'guides', title: 'Guides' },
	{ path: 'guides/secret', title: 'Secret', hidden: true },
	{ path: 'privacy', title: 'Privacy', description: 'Your data.' },
]);

test('.md addresses: the page address plus .md, Home at /index.md', () => {
	assert.equal(markdownUrl('/'), '/index.md');
	assert.equal(markdownUrl('/guides/adding-pictures-to-guides'), '/guides/adding-pictures-to-guides.md');
});

test('llms.txt: Home as title and summary, loose top-level pages (Guides: its only child is hidden) first, then one section per sidebar group, hidden pages left out', async () => {
	assert.equal(
		await llmsTxt(read),
		[
			'# Help',
			'',
			'> Guides for the product.',
			'',
			'- [Help](/index.md): Guides for the product.',
			'- [Guides](/guides.md)',
			'- [Privacy](/privacy.md): Your data.',
			'',
			'## Getting Started',
			'',
			'- [Getting Started](/getting-started.md): Up and running.',
			'- [Signing Up](/getting-started/sign-up.md)',
			'',
		].join('\n'),
	);
});

test('llms-full.txt: every public page, Home first, then sidebar order', async () => {
	const full = await llmsFullTxt(read, (entry) => `# ${entry.title}\n`);
	assert.equal(full, ['# Help', '# Getting Started', '# Signing Up', '# Guides', '# Privacy'].join('\n\n---\n\n') + '\n');
});

test('llms.txt: brackets in a title are escaped, and a description is one line', async () => {
	const tricky = fakeReader([
		{ path: 'index', title: 'Help', description: 'Line one.\n  Line two.' },
		{ path: 'faq', title: 'FAQ [old] ] and [', description: 'First\n\nSecond   part' },
	]);
	const txt = await llmsTxt(tricky);
	assert.match(txt, /^> Line one\. Line two\.$/m);
	assert.match(txt, /^- \[FAQ \\\[old\\\] \\\] and \\\[\]\(\/faq\.md\): First Second part$/m);
});

test('writer notes are printed once per page and message, naming the page', () => {
	const warnings: string[] = [];
	const entry = (path: string) => ({ path: path, url: `/${path}`, title: 'T' }) as never;
	const note = { block: 1, kind: 'cell-list-flattened' as const, detail: 'a list in a table cell is written as lines' };
	warnWriterNotes(entry('guides/a'), (m) => warnings.push(m))(note);
	warnWriterNotes(entry('guides/a'), (m) => warnings.push(m))(note);
	warnWriterNotes(entry('guides/b'), (m) => warnings.push(m))(note);
	assert.deepEqual(warnings, [
		'[markdown] /guides/a: a list in a table cell is written as lines (block 2, cell-list-flattened)',
		'[markdown] /guides/b: a list in a table cell is written as lines (block 2, cell-list-flattened)',
	]);
});
