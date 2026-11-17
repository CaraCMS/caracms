/**
 * `/admin` on a site with no page yet (caracms-cloud adversarial review, editor wording note):
 * right after `caracms init`, before any page is in `content/`, the editor has nothing to
 * open. Instead of a bare "no document" line whose link went back to `/admin` itself, a page
 * that says what's missing and what to do next, linking to the README's Start section.
 * `init` doesn't write pages (the `caracms-adopt` skill brings them in), so it isn't offered
 * as the way to make one. Styled like the sign-in pages' narrow note (`.nw`, on the
 * editor's tokens), with no script.
 */
import { html, LOGIN_CSS } from '../../live/auth/views.ts';
import type { EmptySite } from './admin-props.ts';

/** The package README's getting-started section, on npm. */
export const START_URL = 'https://www.npmjs.com/package/caracms#start';

const EMPTY_CSS = `.nw code{font-family:var(--font-mono);font-size:var(--text-sm);padding:1px 5px;border-radius:var(--radius-sm);background:var(--surface);border:1px solid var(--border);color:var(--text);overflow-wrap:anywhere}
.nw a{color:var(--select-strong);font-weight:var(--weight-medium)}`;

/** The whole page. `tokensCss`: the editor's tokens (styles/tokens.css), as text. */
export function emptySitePage(empty: EmptySite, tokensCss: string): string {
	const body = html`<main class="nw" data-empty-site=""><div class="nw-in"><h1>This site has no pages yet</h1><p>The editor opens on the home page, and there isn't one. Add <code>${empty.file}</code> (a title and no blocks is enough: <code>{ "title": "Home", "blocks": [] }</code>), then reload this page.</p><p>To bring a page the site already has into the editor, ask your coding agent to use the <code>caracms-adopt</code> skill.</p><p class="fine"><a href="${START_URL}">Getting started with caracms</a></p></div></main>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>No pages yet</title><style>${tokensCss}${LOGIN_CSS}${EMPTY_CSS}</style></head><body>${body}</body></html>`;
}
