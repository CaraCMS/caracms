/**
 * Locomotive Scroll: Lenis smooth scroll plus the `data-scroll` attributes (in-view
 * classes, `--progress`, parallax speed), lifted from the Tina template (M7 Decision
 * 20). A page-level singleton: Locomotive owns the window's scroll for the life of the
 * document, so anything that scrolls the window on a public page goes through its
 * `scrollTo` (`smoothScroll()` below returns the instance).
 *
 * No per-`pathname` re-sync: every page is a full load, so each one builds a fresh
 * instance at the right position. The scroll stylesheet is vendored beside this file
 * (locomotive.css); Page.astro starts this on every page.
 *
 * In the editor's preview (Decision 21) the wheel is native, so the frame scrolls as
 * the editor expects (it scrolls frames to blocks), while in-view classes and
 * `--progress` still work. After each redraw (`caracms:rendered`, fired on the frame's
 * document after a morph) Locomotive picks up the `data-scroll` elements the morph
 * added, drops the ones it removed, and ScrollTrigger refreshes. Nothing is rebuilt,
 * so the frame doesn't jump and nothing already in view leaves and re-enters it.
 */
import LocomotiveScroll from 'locomotive-scroll';

import { gsap, ScrollTrigger } from './gsap.ts';
import { prefersReducedMotion } from './motion.ts';

let instance: LocomotiveScroll | null = null;

/** The page's Locomotive instance, once started (null before, or off the public page's script). */
export function smoothScroll(): LocomotiveScroll | null {
	return instance;
}

export function initSmoothScroll({ preview = false }: { preview?: boolean } = {}): void {
	if (instance) return;

	// Reduced motion still starts Locomotive, but with the wheel left native: a page
	// styled to reveal on `is-inview` must still get its classes, or its content stays
	// hidden. Parallax is cut in locomotive.css instead, since Locomotive itself doesn't
	// read the preference. A preview frame is native for the editor's sake.
	const native = preview || prefersReducedMotion();

	instance = new LocomotiveScroll({
		lenisOptions: native
			? { smoothWheel: false }
			: {
					duration: 1.1,
					// Exponential ease-out: quick pickup, long settle.
					easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
				},
		// ScrollTrigger is driven BY Lenis, not by the native scroll event, or every
		// pinned section jitters a frame behind the content. Same reason the loop is
		// GSAP's ticker rather than Locomotive's own requestAnimationFrame: one clock.
		scrollCallback: () => ScrollTrigger.update(),
		initCustomTicker: (render) => gsap.ticker.add(render),
		destroyCustomTicker: (render) => gsap.ticker.remove(render),
	});
	gsap.ticker.lagSmoothing(0);

	if (preview) followRedraws(instance);
}

/**
 * Decision 21's re-scan, with Locomotive 5's own API (`addScrollElements`,
 * `removeScrollElements`). Both take a container and query `[data-scroll]` (and
 * `[data-scroll-to]`) inside it, so each gets a stand-in container that answers with
 * exactly the elements that are new, or gone: a container of the whole body would add
 * every element a second time. (`removeScrollElements` also skips the element after
 * each one it removes when given several, so the gone ones go one at a time.)
 */
function followRedraws(scroll: LocomotiveScroll): void {
	const known = new Set<Element>(document.querySelectorAll('[data-scroll]'));
	const only = (elements: Element[]) =>
		({ querySelectorAll: (selector: string) => elements.filter((el) => el.matches(selector)) }) as unknown as HTMLElement;

	document.addEventListener('caracms:rendered', () => {
		const now = new Set<Element>(document.querySelectorAll('[data-scroll]'));
		const gone = [...known].filter((el) => !now.has(el));
		const added = [...now].filter((el) => !known.has(el));
		for (const el of gone) {
			scroll.removeScrollElements(only([el]));
			known.delete(el);
		}
		if (added.length > 0) {
			scroll.addScrollElements(only(added));
			for (const el of added) known.add(el);
		}
		scroll.resize();
		ScrollTrigger.refresh();
	});
}
