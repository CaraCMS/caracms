// Site Settings' accent presets (editor restyle, Decision 12): the table /admin's props carry to
// the browser (brand.ts's ACCENT_PRESETS, from tokens.css) is what brandColours() gives each hex,
// so a pick paints the same ink and edge as the preset will have once it's kept.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ACCENT_PRESETS as presets, DEFAULT_ACCENT, brandColours } from '../src/editor/brand.ts';
import { presetOf } from '../src/editor/client/accent-presets.ts';

describe('the accent presets (Decision 12)', () => {
	test('are the six chosen, in order, navy first as the default accent', () => {
		assert.deepEqual(
			presets.map((p) => `${p.name} ${p.hex}`),
			['Navy #1f2f57', 'Slate #46607a', 'Petrol #1d4e63', 'Plum #6e2f72', 'Walnut #5c3d2a', 'Ink #2e2a24'],
		);
		assert.equal(presets[0]!.hex, DEFAULT_ACCENT.toLowerCase());
	});

	test("each one's ink and edge are brandColours()'s", () => {
		for (const p of presets) {
			const b = brandColours(p.hex);
			assert.deepEqual({ hex: p.hex, ink: p.ink, edge: p.edge }, { hex: b.accent, ink: b.accentInk.toLowerCase(), edge: b.accentEdge.toLowerCase() }, p.name);
		}
	});

	test('presetOf finds a stored hex in any case, and nothing for a colour from before the presets', () => {
		assert.equal(presetOf(presets, '#6E2F72')?.name, 'Plum');
		assert.equal(presetOf(presets, '#1f3a2e'), undefined);
		assert.equal(presetOf(presets, undefined), undefined);
	});
});
