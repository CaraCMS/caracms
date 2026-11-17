// M7 Decision 2: moved from starter/test. It checks a package feature through a site, so it runs on the
// package's fixture site (test/fixtures/demo-site, the pre-M7 demo) and pinned content (helpers/site-render.ts).
// M5b Decision 5: a build that renders an image without the media variables fails with
// one sentence naming them; a build with no image needs none of them.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { pinnedSite, root } from './helpers/site-render.ts';

const env = { ...process.env };
for (const name of ['CARACMS_MEDIA', 'CARACMS_MEDIA_URL', 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'S3_BUCKET']) delete env[name];

/** `astro build` as the deploy runs it, in its own process (a failed build leaves Astro's handles open in this one). */
const astroBuild = (at: string) => spawnSync(join(root, 'node_modules/.bin/astro'), ['build', '--root', at], { env, encoding: 'utf8', timeout: 120_000 });

describe('a build without the media variables', () => {
	const sites: { close(): void }[] = [];
	after(() => sites.forEach((s) => s.close()));

	test('with an image in the content, it fails with the sentence naming them', async () => {
		const copy = pinnedSite('media-unset');
		sites.push(copy);
		const run = astroBuild(copy.root);
		assert.notEqual(run.status, 0, 'the build fails');
		assert.match(`${run.stdout}\n${run.stderr}`, /Images can't be built without CARACMS_MEDIA_URL, IMGPROXY_KEY, IMGPROXY_SALT and S3_BUCKET/);
	});

	test('with no image in the content, it succeeds', async () => {
		const copy = pinnedSite('media-none');
		sites.push(copy);
		// The pinned content's only media: the Visit page and High-street coffee roaster's cover.
		rmSync(join(copy.root, 'content/pages/visit.json'));
		const file = join(copy.root, 'content/case-studies/high-street-coffee.json');
		const json = JSON.parse(readFileSync(file, 'utf8'));
		delete json.cover;
		writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
		const run = astroBuild(copy.root);
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
		assert.match(readFileSync(join(copy.root, 'dist/client/work/high-street-coffee/index.html'), 'utf8'), /<h1/);
	});
});
