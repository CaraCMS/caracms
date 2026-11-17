// On-page rich text, Phase 4: every RT state of the mockup (the formatting bar, its
// style menu and the link popover on the page) against /admin, as a test (test/mockup-diff.ts
// has the how; mockup-diff-rt.ts has the states and the accepted differences).
// The full visual pass (`pnpm --filter caracms test:visual`) runs the groups' files side by
// side, each in its own process. To see the report, or one state:
//
//   node --experimental-strip-types test/mockup-diff.ts [state…] [--rt] [--all]
//   node --test --experimental-strip-types test/mockup-rt.visual.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { browserSkip } from './helpers/dev-site.ts';
import { report, runMockupDiff } from './mockup-diff.ts';
import { STATES_RT } from './mockup-diff-rt.ts';

describe('the editor against the mockup', { skip: browserSkip }, () => {
	test('every RT state matches, or differs only as accepted', { timeout: 900000 }, async () => {
		const results = await runMockupDiff({ group: 'RT' });
		assert.equal(results.length, STATES_RT.length, 'every RT state was compared');
		assert.equal(results.length, 10, `the RT states are all there (${results.length})`);
		const { text, unexplained } = report(results);
		assert.equal(unexplained, 0, text);
	});
});
