/**
 * The lockup's CSS, generated per site because the phone-lines switch is a media
 * query at the site's configured width (Decision 11), and a media query can't read
 * a custom property. Served as `virtual:caracms/lockup.css`, which Lockup.astro
 * imports, so any page that renders a lockup gets it (inlined or linked by Astro).
 *
 * Structure (Lockup.astro):
 *   <h1 class="cms-lockup [cms-lockup--has-phone]" style="--cms-size…">        one heading
 *     <span class="cms-lockup-set cms-lockup-main" style="--longest-line: …">   a size container
 *       <span class="cms-lockup-fit">                                            font-size: the fit
 *         <span class="cms-lockup-line">…</span> <span class="cms-lockup-line">…</span>
 *     <span class="cms-lockup-set cms-lockup-phone" style="--longest-line: …">  only with phone lines
 *
 * Each set is its own container with its own `--longest-line` (Decision 11; M1 →
 * E5: `cqi` resolves against the nearest container ancestor, so the fit sits inside
 * the set). The inactive set is `display: none`, so screen readers, copying and
 * crawlers see one set of lines.
 */
export function lockupCss(phoneLinesWidth: number): string {
	return `/* caracms: lockups (Spec → Text). Phone lines below ${phoneLinesWidth}px (Decision 11). */
.cms-lockup {
	margin: 0;
}
.cms-lockup-set {
	display: block;
	container-type: inline-size;
}
.cms-lockup-fit {
	display: block;
	font-family: var(--cms-family);
	font-weight: var(--cms-weight);
	font-variation-settings: var(--cms-variation);
	font-optical-sizing: none;
	font-kerning: normal;
	letter-spacing: var(--cms-tracking);
	line-height: var(--cms-leading);
	text-transform: var(--cms-transform);
	/* The fit. No floor, on purpose (Spec → Text). */
	font-size: min(var(--cms-size), calc(100cqi / var(--longest-line)));
}
.cms-lockup-line {
	display: block;
	white-space: nowrap;
	width: fit-content;
}
.cms-lockup-phone {
	display: none;
}
@media (width < ${phoneLinesWidth}px) {
	.cms-lockup-phone {
		display: block;
	}
	.cms-lockup--has-phone > .cms-lockup-main {
		display: none;
	}
}
`;
}
