/**
 * Motion utilities.
 *
 * No React effect lifecycle and no Astro `onPage()` here. There's no ClientRouter
 * (M7 Decision 20: full page loads, no client-side router), so every
 * page is a full load, and every script runs once per page. There's no re-init
 * and no teardown. Per-instance scoping is `hostEffect()` in `./hosts`.
 */

/**
 * True when the visitor has asked for reduced motion. Read it when an effect
 * starts or runs, never at module scope, as the originals do.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The gate every desktop scrub effect on the site shares (parallax, drift,
 * capabilities). `gsap.matchMedia()` reverts the inline transforms when the
 * query stops matching — e.g. a resize down to tablet.
 */
export const DESKTOP_MOTION = '(min-width: 1024px) and (prefers-reduced-motion: no-preference)';
