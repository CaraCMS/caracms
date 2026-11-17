// M5b Phase 5: every M5b state of the mockup against /admin (most local, two live), on the
// in-memory bucket and Mux, as a test (test/mockup-diff.ts has the how; mockup-diff-m5b.ts
// has the states and the accepted differences).
// The full visual pass (`pnpm --filter caracms test:visual`) runs the groups' files side by
// side, each in its own process. To see the report, or one state:
//
//   node --experimental-strip-types test/mockup-diff.ts [state…] [--m5b] [--all]
//   node --test --experimental-strip-types test/mockup-m5b.visual.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { browserSkip } from './helpers/dev-site.ts';
import { report, runMockupDiff } from './mockup-diff.ts';
import { STATES_M5B } from './mockup-diff-m5b.ts';

describe('the editor against the mockup', { skip: browserSkip }, () => {
	test('every M5b state matches, or differs only as accepted', { timeout: 900000 }, async () => {
		const results = await runMockupDiff({ group: 'M5b' });
		assert.equal(results.length, STATES_M5B.length, 'every M5b state was compared');
		assert.ok(results.length >= 36, `the M5b states are all there (${results.length})`);
		const { text, unexplained } = report(results);
		assert.equal(unexplained, 0, text);
	});
});
