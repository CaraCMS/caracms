/**
 * The differences the copy scrub (2026-10-20) left against the mockups, for every state in
 * every group (mockup-diff.ts adds this list to whichever group's ALLOW a state uses). The
 * scrub cut or shortened the editor's helper sentences; the mockups in packages/caracms/test/mockups still
 * draw them, so each cut line, and the box it sat in, shows as missing (and the few boxes
 * that shrank as a style). The mockups are not edited. Never put the copy back to clear a
 * line here: a line that no longer matches anything can be dropped (`--unused` lists them).
 */
import type { Allow } from './mockup-diff.ts';

const SCRUB = 'copy scrub 2026-10-20: helper text cut';

export const ALLOW_SCRUB: Allow[] = [
	// Hints under the side pane's fields and lists, and the pane's own footer hint.
	{ kind: 'missing', key: /(p|span)\.kb-hint( > kbd)?$/, reason: `${SCRUB} (the pane's "Click anything on the page", "Drag to reorder", "Drag, or ⌥↑⌥↓" and list-footer hints)` },
	{ kind: 'missing', key: /div\.lk-under(\.phone)? > span( > kbd)?$/, reason: `${SCRUB} (the heading's "Enter starts a new line")` },
	{ kind: 'missing', key: /p\.(field-help|rt-keys)$|p\.fp-help > span$/, reason: `${SCRUB} (a field's help line, the rich-text key line, the focal point's arrow-key line)` },
	{ kind: 'missing', key: /p\.field-hint(\.now)?$/, reason: `${SCRUB} (Site Settings' "Applies within a minute" and "Applies once it's published")` },
	{ kind: 'missing', key: /div\.note\.phone > div > b$|div\.note\.select > div > p$/, reason: `${SCRUB} (the Phone note's heading, the "published while you were editing" note's second line)` },
	{ kind: 'missing', key: /div\.media-prog > p$|div\.alt-used > small$/, reason: `${SCRUB} (the upload's "goes into the library too" and the library's "used on" help)` },
	// The pane header and the empty states.
	{ kind: 'missing', key: /div\.cur-title > span\.sub$/, reason: `${SCRUB} (the line under the title in the pane header)` },
	{ kind: 'style', prop: /^height$/, key: /^\(root\) > div\.trail$/, reason: `${SCRUB}: the pane header is one line shorter without the line under its title` },
	{ kind: 'missing', key: /div\.empty > span$/, reason: `${SCRUB} (an empty list's explanation)` },
	{ kind: 'missing', key: /div\.stage-aside > div\.in > p$|div\.stage-drop > p$|div\.sub-body > p\.sub-fine$/, reason: `${SCRUB} (the stage's aside text and the submission's "shown exactly as typed")` },
	// Dialogs and the sign-in card.
	{ kind: 'missing', key: /div\.scrim > div(\.danger|\.warn)?\.dialog > p$/, reason: `${SCRUB} (a dialog's explanation)` },
	{ kind: 'style', prop: /^margin-top$/, key: /div\.scrim > div(\.danger|\.warn)?\.dialog > p$/, reason: `${SCRUB}: the dialog's second paragraph went, and its margin with it` },
	{ kind: 'missing', key: /section\.si-card > p\.sub$/, reason: `${SCRUB} (the sign-in confirm page's "You asked for this link by email")` },
	// The rich-text bar's menus and the link popover's footer.
	{ kind: 'missing', key: /div\.(menu|cms-rtmenu) > div\.why$/, reason: `${SCRUB} (the style menu's "There's no Heading 1" line)` },
	{ kind: 'missing', key: /div\.(lpop-foot|cms-lpop-foot) > span\.mono$/, reason: `${SCRUB} (the link popover's list of address forms)` },
	// The Publish panel: the line under its title, the line and the wrapper under the button, the history's footer, the notes' second lines.
	{ root: 'pops', kind: 'missing', key: /div\.pop-h > div > p\.sub$/, reason: `${SCRUB} (the Publish panel's "Publish puts all of these live together")` },
	{ root: 'pops', kind: 'missing', key: /div\.pop-f > (div|span\.fine)$|div\.pop > div\.pop-f$/, reason: `${SCRUB} (the line under Publish, and its wrapper; the history's "The last 5 publishes"; the failed preview's "tries again")` },
	{ root: 'pops', kind: 'extra', key: /div\.pop-f > button\.btn\.lg\.publish$/, reason: `${SCRUB}: the Publish button is no longer wrapped with the line under it` },
	{ root: 'pops', kind: 'missing', key: /div\.pop-b > (div\.empty > span|div\.danger\.note > div > p|ul\.wlist > li\.wi > div\.chips > span\.chip)$/, reason: `${SCRUB} (the empty list's line, the failed publish's second line, "These don't stop a Publish")` },
];
