// A new site's /admin before any page exists (caracms-cloud adversarial review, editor
// wording note): an empty state that names the file to add and links to the README's Start
// section, never back to /admin.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { DocumentError } from '../src/content.ts';
import { adminProps } from '../src/editor/server/admin-props.ts';
import type { DraftsStore } from '../src/editor/server/drafts-store.ts';
import { emptySitePage, START_URL } from '../src/editor/server/empty-site.ts';
import { resolveSite } from '../src/config.ts';
import { config, siteRoot } from './helpers/site.ts';

const site = resolveSite(config, siteRoot);
const tokensCss = readFileSync(new URL('../src/editor/styles/tokens.css', import.meta.url), 'utf8');

/** A store with no documents at all, as right after `caracms init`. */
const emptyStore = {
	list: async () => [],
	read: async (collection: string, path: string) => {
		throw new DocumentError('not-found', `${site.collections[collection]!.label}: no document "${path}".`);
	},
} as unknown as DraftsStore;

const propsAt = (path: string) => adminProps({ site, store: emptyStore, url: new URL(`http://localhost:4326${path}`), cookie: () => undefined });

describe('editor wording note: /admin with no pages yet', () => {
	test('/admin (and /admin/) answers the empty state, naming Home\'s file', async () => {
		for (const path of ['/admin', '/admin/']) {
			const r = await propsAt(path);
			assert.equal(r.ok, false);
			assert.ok(!r.ok && r.empty, path);
			assert.equal(!r.ok && r.empty?.file, 'content/pages/index.json');
		}
	});

	test('another address with nothing there keeps the plain not-found', async () => {
		const r = await propsAt('/admin/pages/about');
		assert.ok(!r.ok && !r.empty);
	});

	test('the page says what is missing and the next step, and links to the README, not to itself', () => {
		const page = emptySitePage({ file: 'content/pages/index.json' }, tokensCss);
		assert.match(page, /<h1>This site has no pages yet<\/h1>/);
		assert.match(page, /Add <code>content\/pages\/index\.json<\/code>/);
		assert.match(page, /caracms-adopt/);
		const links = [...page.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
		assert.deepEqual(links, [START_URL]);
		assert.equal(START_URL, 'https://www.npmjs.com/package/caracms#start');
		assert.doesNotMatch(page, /href="\/admin"/);
	});

	test('a file name is escaped', () => {
		assert.match(emptySitePage({ file: 'content/<x>/index.json' }, ''), /content\/&lt;x&gt;\/index\.json/);
	});
});
