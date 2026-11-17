/**
 * `sizes` for an image in an even grid (site.css → `.grid-even`), from its CSS: one
 * per row below 768 (the content column, 100vw less 20px gutters), two from 768 (32px
 * gutters, a 24px gap), `perRow` from 1024 (48px gutters, 32px gaps), until the
 * content column's 1200px cap at 1296px wide.
 */
export function gridSizes(perRow: number): string {
	const gaps = (perRow - 1) * 32;
	const cap = Math.round((1200 - gaps) / perRow);
	return `(min-width: 1296px) ${cap}px, (min-width: 1024px) calc((100vw - ${96 + gaps}px) / ${perRow}), (min-width: 768px) calc((100vw - 88px) / 2), calc(100vw - 40px)`;
}

// Whole class names, so Tailwind finds them in this file.
const PER_ROW: Record<string, string> = { '2': 'per-row-2', '3': 'per-row-3', '4': 'per-row-4' };

/** The grid's class for a "Per row on desktop" value. */
export const perRowClass = (perRow: string): string => `grid-even ${PER_ROW[perRow] ?? PER_ROW['3']}`;
