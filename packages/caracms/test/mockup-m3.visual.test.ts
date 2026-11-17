// M3 Phase 5 → Verify 1: every M3 state of the mockup against /admin in local mode, as
// a test (test/mockup-diff.ts has the how; its ALLOW lists the accepted differences,
// each with its reason).
// The full visual pass (`pnpm --filter caracms test:visual`) runs the three groups' files
// side by side, each in its own process. To see the report, or one state:
//
//   node --experimental-strip-types test/mockup-diff.ts [state…] [--m3] [--all]
//   node --test --experimental-strip-types test/mockup-m3.visual.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { browserSkip } from './helpers/dev-site.ts';
import { report, runMockupDiff } from './mockup-diff.ts';

describe('the editor against the mockup', { skip: browserSkip }, () => {
	test('every M3 state matches, or differs only as accepted', { timeout: 300000 }, async () => {
		const results = await runMockupDiff({ group: 'M3' });
		assert.equal(results.length, 28, 'every M3 state was compared');
		const { text, unexplained } = report(results);
		assert.equal(unexplained, 0, text);
	});
});
