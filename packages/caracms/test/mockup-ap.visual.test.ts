// Arrange pages (check 20): every state of
// packages/caracms/test/mockups/arrange-pages.html against /admin, in local mode, as a test (test/mockup-diff.ts
// has the how; mockup-diff-ap.ts has the states and the accepted differences).
// The full visual pass (`pnpm --filter caracms test:visual`) runs the groups' files side by
// side, each in its own process. To see the report, or one state:
//
//   node --experimental-strip-types test/mockup-diff.ts [state…] [--ap] [--all]
//   node --test --experimental-strip-types test/mockup-ap.visual.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { browserSkip } from './helpers/dev-site.ts';
import { report, runMockupDiff } from './mockup-diff.ts';
import { STATES_AP } from './mockup-diff-ap.ts';

describe('the arrange screen against the mockup', { skip: browserSkip }, () => {
	test('every arrange-pages state matches, or differs only as accepted', { timeout: 900000 }, async () => {
		const results = await runMockupDiff({ group: 'AP' });
		assert.equal(results.length, STATES_AP.length, 'every arrange-pages state was compared');
		assert.ok(results.length >= 23, `the arrange-pages states are all there (${results.length})`);
		const { text, unexplained } = report(results);
		assert.equal(unexplained, 0, text);
	});
});
