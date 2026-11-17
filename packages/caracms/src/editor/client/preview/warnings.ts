/**
 * The lockups' sizes as the phone iframe computed them (M1 → E7; Decision 13): read
 * after every morph and when the phone iframe loads. The Phone toggle's warning dot
 * comes from these; Phase 3's field warning and "Give Phone its own lines" read them
 * too (driver → status → warnings).
 *
 * Markers come from the package's Lockup in preview renders (Lockup.astro): on the
 * heading `data-cms-field`, `data-cms-min-size`; on each line set `data-cms-lines`
 * and, when some characters aren't in the font, `data-cms-uncovered`. The visible
 * set is the one whose computed display isn't none (phone lines below the site's
 * phone-lines width, the main lines otherwise); its size is its `.cms-lockup-fit`'s
 * computed font size, in px.
 */
import { blockIndexOf, blockRootOf } from './markers.ts';

export interface LockupWarning {
	/** The block's index in the rendered document (`data-cms-block`). */
	block: number;
	field: string;
	/** Which set the phone shows. */
	set: 'main' | 'phone';
	/** The size it computed at 375, px. */
	px: number;
	/** The style's minimum, px. */
	minPx: number;
	/** px below the minimum: "Too long for mobile". */
	tooLong: boolean;
	/** Characters the font doesn't cover (Decision 15), in the visible set. */
	uncovered: string[];
}

export function readLockups(doc: Document, win: Window): LockupWarning[] {
	const out: LockupWarning[] = [];
	for (const heading of doc.querySelectorAll<HTMLElement>('[data-cms-kind="lockup"][data-cms-field]')) {
		const blockEl = blockRootOf(heading);
		if (!blockEl) continue;
		const set = [...heading.querySelectorAll<HTMLElement>('[data-cms-lines]')].find((s) => win.getComputedStyle(s).display !== 'none');
		const fit = set?.querySelector<HTMLElement>('.cms-lockup-fit');
		if (!set || !fit) continue;
		const px = parseFloat(win.getComputedStyle(fit).fontSize);
		const minPx = Number(heading.dataset.cmsMinSize);
		if (!Number.isFinite(px) || !Number.isFinite(minPx)) continue;
		let uncovered: string[] = [];
		try {
			uncovered = set.dataset.cmsUncovered ? (JSON.parse(set.dataset.cmsUncovered) as string[]) : [];
		} catch {
			/* none */
		}
		out.push({
			block: blockIndexOf(blockEl),
			field: heading.dataset.cmsField!,
			set: set.dataset.cmsLines === 'phone' ? 'phone' : 'main',
			px,
			minPx,
			// A hair of tolerance for sub-pixel layout (the mockup's 0.05).
			tooLong: px < minPx - 0.05,
			uncovered,
		});
	}
	return out;
}
