// Posts and tags, Acceptance 12: moving a tag keeps every post's reference to it. A post's tags are a
// list of references on a section builder's page field (Decision 6), so this is the existing relink
// reaching a page field of a section builder, not only a list-of-fields collection's.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { list, reference, text, type SiteConfig } from '../src/config.ts';
import { handleMove } from '../src/editor/server/move.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import type { CreateDeleteRefusal, MoveResponse } from '../src/editor/types.ts';
import { makeCreateSite, type CreateSite } from './helpers/create-site.ts';

const ORIGIN = 'http://site.test';
const POST = '{\n  "title": "A post",\n  "tags": ["print", "field"],\n  "blocks": []\n}\n';

describe('posts and tags: moving a tag (Acceptance 12)', () => {
	let s: CreateSite;
	before(() => {
		s = makeCreateSite({
			link: false,
			extend: (c) => ({
				...c,
				collections: {
					...c.collections,
					journal: { ...c.collections.journal, fields: { tags: list(reference({ to: 'tags' })) } },
					tags: { kind: 'fields', label: 'Tags', folder: 'content/tags', urlBase: '/tags/', component: 'Block.astro', fields: { description: text() } },
				} as SiteConfig['collections'],
			}),
			files: {
				'content/tags/print.json': '{\n  "title": "Print"\n}\n',
				'content/tags/field.json': '{\n  "title": "Field"\n}\n',
				'content/journal/a-post.json': POST,
				'content/journal/untagged.json': '{\n  "title": "Untagged",\n  "blocks": []\n}\n',
			},
		});
	});
	after(() => s.cleanup());

	test('a tag moved to a new address: every post that has it now points at the new one, byte for byte, and the other tags stay', async () => {
		const request = new Request(`${ORIGIN}/_caracms/move`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ collection: 'tags', path: 'print', to: 'prints' }) });
		const response = await handleMove(request, localDraftsStore(s.site));
		const body = (await response.json()) as MoveResponse & CreateDeleteRefusal;
		assert.equal(response.status, 200, JSON.stringify(body));
		assert.equal(body.url, '/tags/prints');
		assert.deepEqual(body.relinked.map((d) => d.title), ['A post']);
		assert.equal(s.read('content/journal/a-post.json'), POST.replace('"print"', '"prints"'));
		assert.match(s.read('content/journal/untagged.json'), /"title": "Untagged"/);
	});
});
