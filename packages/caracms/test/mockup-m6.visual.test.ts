// M6 (carrier B): every M6 state of the mockup (the inbox, Search and sharing, the Form block,
// Site Settings' publish-time fields) against /admin, in local mode on the in-memory
// submissions store and media, as a test (test/mockup-diff.ts has the how; mockup-diff-m6.ts
// has the states and the accepted differences).
// The full visual pass (`pnpm --filter caracms test:visual`) runs the groups' files side by
// side, each in its own process. To see the report, or one state:
//
//   node --experimental-strip-types test/mockup-diff.ts [state…] [--m6] [--all]
//   node --test --experimental-strip-types test/mockup-m6.visual.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { browserSkip } from './helpers/dev-site.ts';
import { report, runMockupDiff } from './mockup-diff.ts';
import { STATES_M6 } from './mockup-diff-m6.ts';

describe('the editor against the mockup', { skip: browserSkip }, () => {
	test('every M6 state matches, or differs only as accepted', { timeout: 900000 }, async () => {
		const results = await runMockupDiff({ group: 'M6' });
		assert.equal(results.length, STATES_M6.length, 'every M6 state was compared');
		assert.ok(results.length >= 18, `the M6 states are all there (${results.length})`);
		const { text, unexplained } = report(results);
		assert.equal(unexplained, 0, text);
	});
});
