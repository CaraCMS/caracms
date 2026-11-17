/**
 * Layout tweaks made in the editor after its milestones (2026-10-20, 2026-10-24), against the mockups, for
 * every state in every group (mockup-diff.ts adds this list to whichever group's ALLOW a state
 * uses, as it does the copy scrub's). The mockups are not edited.
 */
import type { Allow } from './mockup-diff.ts';

export const ALLOW_TWEAKS: Allow[] = [
	// Discard changes (2026-10-27, after every mockup): each waiting document in the Publish panel has its own Discard…, a subtle link under its line, which asks first.
	{ root: 'pops', kind: 'extra', key: /ul\.wlist > li\.wi > div\.wi-acts$/, reason: 'Discard changes: a waiting document\'s own Discard… (a subtle link under its line; it asks first), which the frozen mockups predate' },
	// Collections under pages (Decision 15): the demo's Journal and Work pages hold their collections, so each has a row under it (Decision 4) the M3 mockup never drew.
	{ key: /section\.grp > div\.tnode > button\.coll\.drow(\.is-held)?\.t$/, kind: 'extra', reason: 'collections under pages (Decisions 4 and 15): a held collection\'s row under its holder page (Journal · 3, Case studies · 6)' },
	// Page folders (Decision 2): a group's row in the sidebar shows its address (`/services/…`) so a group and a folder read apart; the older mockups' group rows draw none.
	{ root: 'side', kind: 'extra', key: /section\.grp > div\.tnode > button\.drow\.is-group\.t > span\.meta > span\.gaddr$/, reason: "page folders (Decision 2): the sidebar's group row shows its address in its meta, so it reads apart from a folder" },
	// Arrange pages (Decision 2): the Pages tree's header gains "Arrange pages…" (and the 6px spacer after it); the older mockups' documents levels never drew it (the arrange mockup does: mockup-diff-ap.ts, ap-entry).
	{ key: /section\.grp > div\.grp-h > button\.linkbtn\.subtle$/, kind: 'extra', reason: 'Arrange pages (Decision 2): the Pages tree header\'s "Arrange pages…"' },
	{ key: /section\.grp > div\.grp-h > span$/, kind: 'extra', reason: 'Arrange pages: the 6px spacer after the header\'s "Arrange pages…" button' },
	// An open list row's fields take its full width: no indent under the drag handle, as its image never had one.
	{ kind: 'style', prop: /^padding-left$/, key: /div\.item-b$/, reason: "an open row's fields are inset the same each side (10px), not indented 28px under the drag handle: the indent squeezed nested fields such as a card's button" },
	// A button's style picker has its own full-width row under the button's name.
	{ kind: 'missing', key: /btnf[.\w-]* > div\.btnf-h > div\.mini-seg$/, reason: "the button's style picker moved out of its header row to a full-width row of its own (three styles squeezed the name and the × in a nested card)" },
	{ kind: 'extra', key: /btnf[.\w-]* > div\.mini-seg$/, reason: "the button's style picker sits on its own full-width row under the header" },
	{ kind: 'style', prop: /^margin-left$/, key: /btnf-h > button\.ib$/, reason: "with the style picker gone from the header row, the × is pushed to the right edge itself" },
	// M9 Decision 7: the page settings' Hidden toggle, which no mockup has (M9's spec has none: it follows the existing toggles).
	{ kind: 'extra', root: 'side', key: /div\.side-body > div\.page-hidden$/, reason: 'M9 Decision 7: a page settings toggle, "Hidden from the site", that the frozen mockups predate' },

	// 2026-10-24 (0.3.3), tweaks on a live site: the bar is one bar, the sidebar's button is at its top.
	{ root: 'bar', kind: 'missing', key: /div\.bar-l > (span\.bar-name|span\.bar-sep|button\.ib\.side-toggle)$/, reason: "the bar keeps the logo and the document button: the site's name is the sidebar's, at its top, and so is the sidebar's button (SideToggle.tsx)" },
	{ root: 'bar', kind: 'style', prop: /^border-right-(width|style)$/, key: /\(root\) > div\.bar-l$/, reason: 'no divider after the document button: the bar reads as one bar' },
	{ root: 'side', kind: 'missing', key: /div\.side-foot > span\.lbl$/, reason: 'the Recent strip has no visible label (its chips are a group named "Recent" for screen readers)' },
	{ root: 'side', kind: 'missing', key: /div\.trail > button\.lv > span(\.n)?$/, reason: "the documents level's tab is the site's name alone: \"· Documents\" and the count said nothing" },
	{ root: 'side', kind: 'style', prop: /^padding-right$/, key: /div\.trail > div\.cur > div\.cur-row$/, reason: "a header with no tabs above it leaves room at its end for the sidebar's button" },
	// The header: no kind chip; the state chips and the path (no host) on the sub line.
	{ root: 'side', kind: 'missing', key: /div\.cur-title > span\.(t|sub) > span\.chip\.(kind|shared)$/, reason: 'no kind chip in a header: the crumb and the tabs say what kind of document it is' },
	{ root: 'side', kind: 'missing', key: /div\.cur-title > span\.t > span\.chip\.lock$/, reason: 'Read-only moved to the sub line, where a chip never clips the title' },
	{ root: 'side', kind: 'extra', key: /div\.cur-title > span\.sub > span(\.chip\.lock)?$/, reason: "the state chips moved to the sub line; a shared block's \"Footer · Used on 4 pages\" is a span beside them" },
	{ root: 'side', kind: 'style', prop: /^(display|row-gap|column-gap|align-items)$/, key: /div\.cur-title > span\.sub( > span\.mono)?$/, reason: 'a sub line is a flex row only when it has chips, which moved there from the title line' },
	// The pages tree: no twisty column; the twisty at the row's end; a 16px indent.
	{ root: 'side', kind: 'missing', key: /button\.drow(\.is-current)?\.t > span\.tw$/, reason: "no twisty column: a page's icon lines up with the site-wide rows'" },
	{ root: 'side', kind: 'extra', key: /div\.tnode > button\.drow\.has-kids\.t$/, reason: "a page with pages under it keeps room at its end for its twisty" },
	{ root: 'side', kind: 'style', prop: /^padding-left$/, key: /div\.tnode > button\.drow(\.is-current)?\.t$/, reason: 'no twisty column, and one step of indent is 16px, not 24px' },
	{ root: 'side', kind: 'style', prop: /^(position|border-(top|bottom)-(left|right)-radius)$/, key: /button\.drow\.is-group\.t > span\.tw$/, reason: "a group's twisty sits at the row's end, shaped as the parent pages' twisty button" },
	{ root: 'side', kind: 'style', prop: /^padding-right$/, key: /div\.tnode > button\.drow\.is-group\.t$/, reason: "a group row keeps room at its end for its twisty and, left of it, its menu" },
	{ root: 'side', kind: 'order', key: /div\.tnode > button\.drow\.is-group\.t$/, reason: "a group's twisty comes last in its row, at the row's end" },
	// Site Settings: an exact address has no line under it (its tile says what it is).
	{ root: 'side', kind: 'missing', key: /div\.eds > div\.ed(\.is-confirm)? > span\.t > small$/, reason: 'an exact address has no line under it, its envelope tile says it; a domain says "Everyone at …"' },
];
