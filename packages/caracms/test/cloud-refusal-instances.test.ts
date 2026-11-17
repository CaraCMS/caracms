// A CloudRefusal thrown by another copy of src/live/cloud.ts (Vite's dev SSR graph can hold
// two) is still the cloud's refusal: the media handler answers with its sentence as sent,
// not "Something went wrong with the media library." Found on `astro dev` in the caracms-cloud
// M3 walk, where `error instanceof CloudRefusal` was false for a real `upload_limit`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { defineSite, media, resolveSite, text, type SiteConfig } from '../src/config.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import type { Bucket } from '../src/editor/server/media/bucket.ts';
import { handleMedia, type MediaContext } from '../src/editor/server/media/handler.ts';
import { libraryFor } from '../src/editor/server/media/library.ts';
import { CloudRefusal, isCloudRefusal } from '../src/live/cloud.ts';

/** A query makes Node load cloud.ts again as a separate module, as Vite's second SSR copy is. */
const SECOND = '../src/live/cloud.ts?second-instance';
const secondInstance = async () => (await import(SECOND)) as typeof import('../src/live/cloud.ts');

const SENTENCE = 'This site has reached its storage limit in CaraCMS Cloud (0.1 GB). Ask CaraCMS to raise it.';

describe('a cloud refusal from a second module instance', () => {
	const root = mkdtempSync(join(tmpdir(), 'caracms-refusal-'));
	writeFileSync(join(root, 'Block.astro'), '---\n---\n');
	after(() => rmSync(root, { recursive: true, force: true }));
	const site = resolveSite(
		defineSite({
			collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } },
			blocks: { hero: { label: 'Hero', component: 'Block.astro', fields: { heading: text({ heading: true }), media: media() } } },
			page: 'Block.astro',
		} as unknown as SiteConfig),
		root,
	);
	const ctx = (log: (line: string) => void): MediaContext => ({ site, store: localDraftsStore(site), mode: 'local', person: null, env: { CARACMS_MEDIA: 'memory' }, production: false, log });

	test('is recognised by the brand, not the class', async () => {
		const other = await secondInstance();
		assert.notEqual(other.CloudRefusal, CloudRefusal, 'a real second instance of the module');
		const foreign = new other.CloudRefusal('upload_limit', SENTENCE);
		assert.equal(foreign instanceof CloudRefusal, false, 'which instanceof cannot see');
		assert.ok(isCloudRefusal(foreign) && other.isCloudRefusal(new CloudRefusal('x', 'y')));
		assert.equal(isCloudRefusal(Object.assign(new Error(SENTENCE), { error: 'upload_limit' })), false, 'a look-alike error is not one');
		assert.equal(isCloudRefusal(null) || isCloudRefusal('upload_limit') || isCloudRefusal(undefined), false);
	});

	test('reaches the editor as the cloud\'s sentence, status 502, through the media handler', async () => {
		const other = await secondInstance();
		const refuse = async (): Promise<never> => {
			throw new other.CloudRefusal('upload_limit', SENTENCE);
		};
		// The libraries live on globalThis, keyed by id: seed the memory one with a bucket that refuses.
		libraryFor('memory', (): Bucket => ({ list: refuse, first: refuse, head: refuse, get: refuse, put: refuse }));
		const logged: string[] = [];
		const res = await handleMedia(new Request('http://localhost/_caracms/media/images', { headers: { origin: 'http://localhost' } }), ctx((l) => logged.push(l)));
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: SENTENCE });
		assert.ok(logged.some((l) => l.includes('upload_limit') && l.includes(SENTENCE)));
	});
});
