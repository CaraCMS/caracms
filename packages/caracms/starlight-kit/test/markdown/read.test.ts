// markdownToPage: one test per conversion, and the report it gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToPage } from '../../src/starlight-kit/markdown/index.ts';

const kinds = (r: { report: { kind: string }[] }) => r.report.map((e) => e.kind);

test('H1 is the title; the first paragraph is the description and stays in the body', () => {
	const r = markdownToPage('# Adding **Pictures**\n\nStep 2 is **Add Picture**, see [this](x.md).\n\nMore.\n');
	assert.equal(r.title, 'Adding Pictures');
	assert.equal(r.description, 'Step 2 is Add Picture, see this.');
	assert.deepEqual(r.blocks, [{ type: 'text', body: [{ p: 'Step 2 is **Add Picture**, see [this](x.md).' }, { p: 'More.' }] }]);
});

test('a screenshot comment becomes an empty screenshot block', () => {
	const r = markdownToPage('# T\n\n<!-- screenshot: The "Add Picture" step -->\n');
	assert.deepEqual(r.blocks, [{ type: 'screenshot', capture: 'The "Add Picture" step' }]);
	assert.deepEqual(r.report.map((e) => [e.kind, e.line]), [['screenshot-placeholder', 3], ['no-description', 1]]);
});

test('an image becomes an empty screenshot with its alt as "What to capture"; the URL is reported', () => {
	const r = markdownToPage('# T\n\nIntro.\n\n![The guides screen](https://x.test/a.png)\n*The Guides screen.*\n');
	assert.deepEqual(r.blocks[1], { type: 'screenshot', capture: 'The guides screen', caption: 'The Guides screen.' });
	const e = r.report.find((x) => x.kind === 'image-not-fetched')!;
	assert.equal(e.line, 5);
	assert.match(e.became, /https:\/\/x\.test\/a\.png/);
});

test('blockquotes become asides by their lead-in', () => {
	const md = ['# T', '', '> **Tip:** Tipped.', '', '> **Caution:** Careful.', '', '> **Warning:** Hot.', '', '> **Danger:** Bad.', '', '> **Note:** Noted.', '', '> **Who can?** Admins.', '', '> Bare quote', '> on two lines.'].join('\n');
	const r = markdownToPage(md);
	assert.deepEqual(r.blocks, [
		{ type: 'aside', kind: 'tip', body: [{ p: 'Tipped.' }] },
		{ type: 'aside', kind: 'caution', body: [{ p: 'Careful.' }] },
		{ type: 'aside', kind: 'caution', body: [{ p: '**Warning:** Hot.' }] },
		{ type: 'aside', kind: 'danger', body: [{ p: 'Bad.' }] },
		{ type: 'aside', kind: 'note', body: [{ p: 'Noted.' }] },
		{ type: 'aside', kind: 'note', body: [{ p: '**Who can?** Admins.' }] },
		{ type: 'aside', kind: 'note', body: [{ p: 'Bare quote\non two lines.' }] },
	]);
	assert.equal(kinds(r).filter((k) => k === 'blockquote-to-aside').length, 7);
});

test('a numbered list becomes steps, with indented lists inside a step and loose items kept together', () => {
	const md = ['# T', '', '1. Open **Guides**.', '2. Choose:', '   - **Drag** it', '   - **Click** it', '', '3. Done.', '', 'After.'].join('\n');
	const r = markdownToPage(md);
	assert.deepEqual(r.blocks[0], {
		type: 'steps',
		steps: [[{ p: 'Open **Guides**.' }], [{ p: 'Choose:' }, { ul: ['**Drag** it', '**Click** it'] }], [{ p: 'Done.' }]],
	});
	assert.deepEqual(r.blocks[1], { type: 'text', body: [{ p: 'After.' }] });
});

test('a numbered list resumed after a screenshot starts a new steps block carrying on its number, reported', () => {
	const r = markdownToPage('# T\n\n1. One.\n2. Two.\n\n<!-- screenshot: x -->\n\n3. Three.\n');
	assert.deepEqual(r.blocks.map((b) => b.type), ['steps', 'screenshot', 'steps']);
	assert.equal('start' in r.blocks[0]!, false);
	assert.equal((r.blocks[2] as { start?: number }).start, 3);
	assert.equal(r.report.find((e) => e.kind === 'steps-renumbered')!.line, 8);
});

test('a section index\'s "Articles" list is dropped with its heading, reported', () => {
	const r = markdownToPage('# S\n\nIntro.\n\n## Articles\n\n1. **[A](1.1-a.md)** -- a\n2. **[B](1.2-b.md)** -- b\n\n## Next\n', { dropLists: ['Articles'] });
	assert.deepEqual(r.blocks, [{ type: 'text', body: [{ p: 'Intro.' }, { h2: 'Next' }] }]);
	assert.equal(r.report.find((e) => e.kind === 'list-dropped')!.line, 5);
});

test('bullets become a list; a nested list comes straight after its parent item; checkboxes become plain items', () => {
	const md = ['# T', '', '- **A** -- a', '- **B** -- b:', '  - **B1** one', '  - **B2** two', '- C', '- [ ] Do it', '- [x] Done'].join('\n');
	const r = markdownToPage(md);
	assert.deepEqual(r.blocks, [{ type: 'text', body: [{ ul: ['**A** -- a', '**B** -- b:'] }, { ul: ['**B1** one', '**B2** two'] }, { ul: ['C', 'Do it', 'Done'] }] }]);
	assert.deepEqual(r.report.filter((e) => e.kind !== 'no-description').map((e) => [e.kind, e.line]), [['nested-list', 5], ['checkbox', 8], ['checkbox', 9]]);
});

test('a table becomes a table block', () => {
	const r = markdownToPage('# T\n\n| Type | Max |\n|------|-----|\n| **JPEG** | 10 MB |\n| WEBP \\| AVIF | |\n');
	assert.deepEqual(r.blocks, [
		{
			type: 'table',
			header: [[{ p: 'Type' }], [{ p: 'Max' }]],
			rows: [{ cells: [[{ p: '**JPEG**' }], [{ p: '10 MB' }]] }, { cells: [[{ p: 'WEBP | AVIF' }], []] }],
		},
	]);
});

test('links are kept as written (the importer rewrites them)', () => {
	const r = markdownToPage('# T\n\nSee [Writing a Guide](2.1-writing-a-guide.md#step-1) and [x](https://x.test).\n');
	assert.equal((r.blocks[0] as { body: { p: string }[] }).body[0]!.p, 'See [Writing a Guide](2.1-writing-a-guide.md#step-1) and [x](https://x.test).');
});

test('#### and deeper become h3, reported', () => {
	const r = markdownToPage('# T\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n');
	assert.deepEqual(r.blocks, [{ type: 'text', body: [{ h2: 'Two' }, { h3: 'Three' }, { h3: 'Four' }, { h3: 'Five' }] }]);
	assert.deepEqual(r.report.filter((e) => e.kind === 'deep-heading').map((e) => e.line), [7, 9]);
});

test('inline code becomes plain text, reported', () => {
	const r = markdownToPage('# T\n\nUse `http://` or `a*b`.\n');
	assert.equal(r.description, 'Use http:// or a*b.');
	assert.equal((r.blocks[0] as { body: { p: string }[] }).body[0]!.p, 'Use http:// or a\\*b.');
	assert.equal(r.report.filter((e) => e.kind === 'inline-code').length, 2);
});

test('--- dividers are dropped; -- stays as typed', () => {
	const r = markdownToPage('# T\n\nA -- b.\n\n---\n\nC.\n');
	assert.deepEqual(r.blocks, [{ type: 'text', body: [{ p: 'A -- b.' }, { p: 'C.' }] }]);
	assert.deepEqual(kinds(r), ['divider-dropped']);
});

test('underscore emphasis becomes the stored *italic*; literal brackets are escaped', () => {
	const r = markdownToPage('# T\n\nClick **Make _N_ Copies** for snake_case.\n\n> **[Placeholder] note**\n');
	assert.equal((r.blocks[0] as { body: { p: string }[] }).body[0]!.p, 'Click **Make *N* Copies** for snake_case.');
	assert.deepEqual(r.blocks[1], { type: 'aside', kind: 'note', body: [{ p: '**\\[Placeholder\\] note**' }] });
});

test('a paragraph\'s lines stay as line breaks', () => {
	const r = markdownToPage('# T\n\n**Question?**\nAnswer.\n');
	assert.equal(r.description, 'Question? Answer.');
	assert.deepEqual(r.blocks, [{ type: 'text', body: [{ p: '**Question?**\nAnswer.' }] }]);
});

test('shapes the rules don\'t cover are kept as text and reported, never dropped', () => {
	const md = ['# T', '', 'Intro.', '', '<details>', '<summary>More</summary>', 'Hidden text', '</details>', '', 'Press <kbd>Ctrl</kbd>.', '', '```', 'code', '```', '', '<!-- a note to self -->'].join('\n');
	const r = markdownToPage(md);
	const body = (r.blocks[0] as { body: { p: string }[] }).body.map((b) => b.p);
	assert.ok(body.some((p) => p.includes('<details>') && p.includes('Hidden text')));
	assert.ok(body.some((p) => p === 'Press <kbd>Ctrl</kbd>.'));
	assert.ok(body.some((p) => p.includes('code')));
	assert.ok(body.some((p) => p.includes('a note to self')));
	assert.deepEqual(r.report.map((e) => [e.kind, e.line]), [['unhandled', 5], ['html-tag', 10], ['html-tag', 10], ['unhandled', 12], ['unhandled', 16]]);
});

test('reference-style links become normal links where defined; the definition lines go; both are reported', () => {
	const md = ['# T', '', 'Intro.', '', 'See [the guide][g], [Guide][] and [g] now.', '', '[g]: ./guide.md "The guide"', '[Guide]: https://x.test/a'].join('\n');
	const r = markdownToPage(md);
	assert.deepEqual(r.blocks, [{ type: 'text', body: [{ p: 'Intro.' }, { p: 'See [the guide](./guide.md), [Guide](https://x.test/a) and [g](./guide.md) now.' }] }]);
	assert.deepEqual(r.report.filter((e) => e.kind === 'reference-link').map((e) => [e.line, e.was]), [[5, '[the guide][g]'], [5, '[Guide][]'], [5, '[g]']]);
	assert.deepEqual(r.report.filter((e) => e.kind === 'reference-definition').map((e) => e.line), [7, 8]);
});

test('footnote markers and references with no definition stay as text and are reported', () => {
	const r = markdownToPage('# T\n\nIntro.\n\nNote[^1] and [a thing][nope] but [plain] stays.\n\n[^1]: The footnote.\n');
	const body = (r.blocks[0] as { body: { p: string }[] }).body;
	assert.equal(body[1]!.p, 'Note\\[^1\\] and \\[a thing\\]\\[nope\\] but \\[plain\\] stays.');
	assert.equal(body[2]!.p, '\\[^1\\]: The footnote.');
	assert.deepEqual(r.report.map((e) => [e.kind, e.line]), [['footnote', 5], ['unresolved-reference', 5], ['footnote', 7]]);
});

test('a setext heading is read as # / ## and reported', () => {
	const r = markdownToPage('Title\n=====\n\nIntro.\n\nSection\n-------\n\nBody.\n\nSecond\n======\n');
	assert.equal(r.title, 'Title');
	assert.equal(r.description, 'Intro.');
	assert.deepEqual(r.blocks, [{ type: 'text', body: [{ p: 'Intro.' }, { h2: 'Section' }, { p: 'Body.' }, { h2: 'Second' }] }]);
	assert.deepEqual(r.report.map((e) => [e.kind, e.line]), [['setext-heading', 1], ['setext-heading', 6], ['setext-heading', 11], ['extra-h1', 11]]);
	assert.ok(!r.report.some((e) => e.kind === 'divider-dropped'));
});

test('a closing # sequence is stripped from a heading only after a space', () => {
	const r = markdownToPage('# T\n\nIntro.\n\n## Learning C#\n\n## Closed ##\n\n### F# and C# ###\n');
	assert.deepEqual((r.blocks[0] as { body: unknown[] }).body.slice(1), [{ h2: 'Learning C#' }, { h2: 'Closed' }, { h3: 'F# and C#' }]);
});

test('~~strike~~ keeps its text without the tildes, reported', () => {
	const r = markdownToPage('# T\n\nWas ~~old~~ and **~~bold old~~** and ~ alone ~~ spaced ~~.\n');
	assert.equal(r.description, 'Was old and bold old and ~ alone ~~ spaced ~~.');
	assert.deepEqual(r.report.filter((e) => e.kind === 'strikethrough').map((e) => e.was), ['~~old~~', '~~bold old~~']);
});

test('a heading in a list item continuation is reported as the heading it became, and a level-1 one as extra-h1', () => {
	const r = markdownToPage('# T\n\nIntro.\n\n- item\n  # Not a title\n- other\n  ##### Deep\n');
	assert.deepEqual((r.blocks[0] as { body: unknown[] }).body.slice(1), [{ ul: ['item'] }, { h2: 'Not a title' }, { ul: ['other'] }, { h3: 'Deep' }]);
	const rows = r.report.map((e) => [e.kind, e.line, e.became]);
	assert.deepEqual(rows.map((x) => x.slice(0, 2)), [['extra-h1', 6], ['item-heading', 6], ['deep-heading', 8], ['item-heading', 8]]);
	assert.match(rows[0]![2] as string, /h2/);
	assert.match(rows[1]![2] as string, /h2 heading after the list/);
	assert.match(rows[3]![2] as string, /h3 heading after the list/);
	assert.ok(!r.report.some((e) => e.kind === 'item-paragraph'));
});
