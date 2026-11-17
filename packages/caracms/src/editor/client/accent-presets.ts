/**
 * Site Settings' accent presets (editor restyle, Decision 12): presets only, no free hex.
 * The hexes are tokens (`--preset-<id>` in styles/tokens.css, M2 Decision 7), read through
 * `read`: brand.ts reads tokens.css (ACCENT_PRESETS) and /admin's props carry the table to
 * the browser (`EditorSite.presets`), so the server renders the picker too. All six are dark,
 * so each takes `--on-fill` as its label and itself as its border, which is what
 * brandColours() gives them (test/accent-presets.test.ts holds it to that).
 */
export const ACCENT_PRESET_IDS = [
	['navy', 'Navy'],
	['slate', 'Slate'],
	['petrol', 'Petrol'],
	['plum', 'Plum'],
	['walnut', 'Walnut'],
	['ink', 'Ink'],
] as const;

export type AccentPreset = { id: string; name: string; hex: string; ink: string; edge: string };

export function accentPresets(read: (token: string) => string): AccentPreset[] {
	const ink = read('--on-fill').trim().toLowerCase();
	return ACCENT_PRESET_IDS.map(([id, name]) => {
		const hex = read(`--preset-${id}`).trim().toLowerCase();
		return { id, name, hex, ink, edge: hex };
	});
}

export const presetOf = (presets: AccentPreset[], hex: string | null | undefined): AccentPreset | undefined =>
	presets.find((p) => p.hex === String(hex ?? '').toLowerCase());
