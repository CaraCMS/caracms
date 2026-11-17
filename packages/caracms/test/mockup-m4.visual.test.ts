// M4 Phase 5 → Verify 1: every M4 state of the mockup against /admin in live mode, as a
// test (test/mockup-diff.ts has the how; mockup-diff-m4.ts has the states and the
// accepted differences). On the in-memory GitHub and the Redis stand-in.
// The full visual pass (`pnpm --filter caracms test:visual`) runs the three groups' files
// side by side, each in its own process. To see the report, or one state:
//
//   node --experimental-strip-types test/mockup-diff.ts [state…] [--m4] [--all]
//   node --test --experimental-strip-types test/mockup-m4.visual.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { browserSkip } from './helpers/dev-site.ts';
import { report, runMockupDiff } from './mockup-diff.ts';
import { STATES_M4 } from './mockup-diff-m4.ts';

describe('the editor against the mockup', { skip: browserSkip }, () => {
	test('every M4 state (and the states M4 adds) matches, or differs only as accepted', { timeout: 900000 }, async () => {
		// 33 since M5b: the mockup's `blocked` is `publish-alt`, compared in M5b's group.
		const results = await runMockupDiff({ group: 'M4' });
		assert.equal(results.length, STATES_M4.length, 'every M4 state was compared');
		assert.ok(results.length >= 33, `the M4 states are all there (${results.length})`);
		const { text, unexplained } = report(results);
		assert.equal(unexplained, 0, text);
	});
});
