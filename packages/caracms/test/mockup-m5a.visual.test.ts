// M5a Phase 6: every M5a state of the mockup against /admin (most local, some live), as
// a test (test/mockup-diff.ts has the how; mockup-diff-m5a.ts has the states and the
// accepted differences).
// The full visual pass (`pnpm --filter caracms test:visual`) runs the three groups' files
// side by side, each in its own process. To see the report, or one state:
//
//   node --experimental-strip-types test/mockup-diff.ts [state…] [--m5a] [--all]
//   node --test --experimental-strip-types test/mockup-m5a.visual.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { browserSkip } from './helpers/dev-site.ts';
import { report, runMockupDiff } from './mockup-diff.ts';
import { STATES_M5A } from './mockup-diff-m5a.ts';

describe('the editor against the mockup', { skip: browserSkip }, () => {
	test('every M5a state matches, or differs only as accepted', { timeout: 900000 }, async () => {
		const results = await runMockupDiff({ group: 'M5a' });
		assert.equal(results.length, STATES_M5A.length, 'every M5a state was compared');
		assert.ok(results.length >= 35, `the M5a states are all there (${results.length})`);
		const { text, unexplained } = report(results);
		assert.equal(unexplained, 0, text);
	});
});
