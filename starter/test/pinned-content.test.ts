// M7 Acceptance 3 (Decision 2): the starter's tests read the starter's own pinned content
// (test/fixtures/content), and the package-feature tests that used to sit here now run in
// the package's suite. The round-trip test is the one exception: it reads the live
// `starter/content`, since whatever is published must round-trip.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureContent } from './helpers/render.ts';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const packageTests = join(testDir, '../../packages/caracms/test');
const own = [...readdirSync(testDir), ...readdirSync(join(testDir, 'helpers')).map((f) => `helpers/${f}`)].filter((f) => f.endsWith('.ts'));
/** A test's code, comments out. */
const text = (file: string) => readFileSync(join(testDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Acceptance 3: the starter\'s tests read their own pinned content', () => {
	test('the pinned content is a copy of the starter\'s, with pages, shared blocks and Site Settings', () => {
		assert.equal(fixtureContent, join(testDir, 'fixtures/content'));
		for (const part of ['pages/index.json', 'shared/start-a-project.json', 'site-settings.json']) assert.ok(existsSync(join(fixtureContent, part)), part);
	});

	test('no test but the round-trip one reads starter/content or the package\'s pinned content', () => {
		const reading = own
			.filter((f) => f !== 'content-round-trip.test.ts' && f !== 'pinned-content.test.ts')
			.filter((f) => /demo-content|starter\/content|\.\.\/content['"`/]|'\.\.', 'content'/.test(text(f)));
		assert.deepEqual(reading, []);
		const roundTrip = text('content-round-trip.test.ts');
		assert.match(roundTrip, /resolveSite\(config, root\)/, 'the round-trip test resolves the real starter, with its live content');
		assert.doesNotMatch(roundTrip, /fixtureContent|pinnedSite/);
	});

	test('the package-feature tests moved to the package: each is there, and none is left here', () => {
		for (const moved of ['render', 'fields-render', 'columns-render', 'file-links-render', 'form-render', 'media-render', 'media-build', 'port-readiness-build', 'build-variants']) {
			assert.ok(existsSync(join(packageTests, `site-${moved}.test.ts`)), `site-${moved}.test.ts`);
			assert.ok(!own.includes(`${moved}.test.ts`), `${moved}.test.ts is still in starter/test`);
		}
		assert.ok(existsSync(join(packageTests, 'helpers/site-render.ts')), 'the helper that builds the fixture site went with them');
	});
});
