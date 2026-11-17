/**
 * The chrome's icons: the mockup's SVG sprite, lifted as is (packages/caracms/test/mockups/m2-editor.html).
 * The sprite renders once in the shell; <Icon name="grip" /> uses a symbol from it.
 * `i-*` are interface icons; `b-*` are block-type icons.
 */
const SYMBOLS = [
	'<symbol id="i-chev-l" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></symbol>',
	'<symbol id="i-chev-r" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></symbol>',
	'<symbol id="i-chev-d" viewBox="0 0 16 16"><path d="m3.5 6 4.5 4.5L12.5 6"/></symbol>',
	'<symbol id="i-chev-u" viewBox="0 0 16 16"><path d="m3.5 10 4.5-4.5 4.5 4.5"/></symbol>',
	'<symbol id="i-sidebar" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6.5 3v10"/></symbol>',
	'<symbol id="i-up" viewBox="0 0 16 16"><path d="M8 13V3M4 7l4-4 4 4"/></symbol>',
	'<symbol id="i-down" viewBox="0 0 16 16"><path d="M8 3v10M4 9l4 4 4-4"/></symbol>',
	'<symbol id="i-page" viewBox="0 0 16 16"><path d="M4 1.5h5.5L12.5 4.5v10H4z"/><path d="M9.5 1.5v3h3"/></symbol>',
	'<symbol id="i-folder" viewBox="0 0 16 16"><path d="M1.5 4.2a1 1 0 0 1 1-1h3.4l1.6 1.8h6a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></symbol>',
	// Page folders (Decision 2): a group's folder carries a "/", because it's in the address.
	'<symbol id="i-folder-addr" viewBox="0 0 16 16"><path d="M1.5 4.2a1 1 0 0 1 1-1h3.4l1.6 1.8h6a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="m9.3 7.1-2.6 4.8"/></symbol>',
	'<symbol id="i-case" viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="13" height="9" rx="1.5"/><path d="M5.5 4.5v-2h5v2"/></symbol>',
	'<symbol id="i-journal" viewBox="0 0 16 16"><path d="M3.5 1.5h9v13h-9z"/><path d="M6 5h4.5M6 7.5h4.5M6 10h3"/></symbol>',
	// M6c (G5): the List / Grid switch, and a clip card's play mark
	'<symbol id="i-list" viewBox="0 0 16 16"><path d="M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5"/><path d="M2 4h1M2 8h1M2 12h1"/></symbol>',
	'<symbol id="i-grid" viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></symbol>',
	// Review gaps (Decision 3): a view sorted another way than Site order
	'<symbol id="i-sort" viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h7.5M2.5 12h4"/></symbol>',
	// Review gaps (Decision 7): a block's states, on its level
	'<symbol id="i-layers" viewBox="0 0 16 16"><path d="m8 2 6 3.2-6 3.2-6-3.2z"/><path d="m2 8.4 6 3.2 6-3.2"/><path d="m2 11.2 6 3.2 6-3.2"/></symbol>',
	'<symbol id="i-play" viewBox="0 0 10 10"><path d="M2 1.2v7.6L8.6 5z"/></symbol>',
	'<symbol id="i-shared" viewBox="0 0 16 16"><path d="M6.6 9.4a2.9 2.9 0 0 0 4.1 0l2.2-2.2a2.9 2.9 0 0 0-4.1-4.1l-.7.7"/><path d="M9.4 6.6a2.9 2.9 0 0 0-4.1 0L3.1 8.8a2.9 2.9 0 0 0 4.1 4.1l.7-.7"/></symbol>',
	'<symbol id="i-bolt" viewBox="0 0 16 16"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/></symbol>',
	'<symbol id="i-gear" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"/></symbol>',
	'<symbol id="i-lock" viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></symbol>',
	'<symbol id="i-check" viewBox="0 0 16 16"><path d="m3 8.5 3.2 3L13 4.5"/></symbol>',
	'<symbol id="i-warn" viewBox="0 0 16 16"><path d="M8 2 14.8 13.6H1.2z"/><path d="M8 6.3v3.4M8 11.6v.1"/></symbol>',
	'<symbol id="i-x" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></symbol>',
	'<symbol id="i-plus" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></symbol>',
	'<symbol id="i-grip" viewBox="0 0 16 16"><g fill="currentColor" stroke="none"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></g></symbol>',
	'<symbol id="i-more" viewBox="0 0 16 16"><g fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></g></symbol>',
	'<symbol id="i-search" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.6 3.6"/></symbol>',
	'<symbol id="i-phone" viewBox="0 0 16 16"><rect x="4.5" y="1.5" width="7" height="13" rx="1.6"/><path d="M7 12.3h2"/></symbol>',
	'<symbol id="i-image" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.2"/><path d="m2 12 3.8-3.8 3 3 2-2 3.6 3.6"/></symbol>',
	'<symbol id="i-clock" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.3"/><path d="M8 4.6V8l2.4 1.5"/></symbol>',
	'<symbol id="i-undo" viewBox="0 0 16 16"><path d="M5 3 2 6l3 3"/><path d="M2 6h7.5a4 4 0 0 1 0 8H7"/></symbol>',
	'<symbol id="i-ext" viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4"/></symbol>',
	'<symbol id="i-trash" viewBox="0 0 16 16"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 10h6.6L12 4"/></symbol>',
	'<symbol id="i-offline" viewBox="0 0 16 16"><path d="M4.4 12.5h7.1a3 3 0 0 0 .5-6 4.4 4.4 0 0 0-8.1-.9A3.4 3.4 0 0 0 4.4 12.5z"/><path d="m2 2 12 12"/></symbol>',
	'<symbol id="i-target" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></symbol>',
	'<symbol id="i-history" viewBox="0 0 16 16"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.7"/><path d="M2.5 2.5v3.2h3.2M8 5v3l2 1.3"/></symbol>',
	'<symbol id="i-signout" viewBox="0 0 16 16"><path d="M6 2.5H3v11h3M10 5l3 3-3 3M13 8H6"/></symbol>',
	// Rename….
	'<symbol id="i-pencil" viewBox="0 0 16 16"><path d="M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3L5.5 12.6l-3 .9.9-3z"/><path d="m9.6 3.9 2.5 2.5"/></symbol>',
	// Pre-M7 item 8: Change address…, and a redirect's "from → to".
	'<symbol id="i-arrow-r" viewBox="0 0 16 16"><path d="M2.5 8h11M9.5 4l4 4-4 4"/></symbol>',
	'<symbol id="i-copy" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></symbol>',
	'<symbol id="i-upload" viewBox="0 0 16 16"><path d="M8 10.5V2.5M4.8 5.7 8 2.5l3.2 3.2"/><path d="M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/></symbol>',
	'<symbol id="i-film" viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M6.5 6v4l3.5-2z"/></symbol>',
	'<symbol id="i-media" viewBox="0 0 16 16"><rect x="4.5" y="1.5" width="10" height="9" rx="1.2"/><path d="M11.5 13.5h-9a1 1 0 0 1-1-1v-7"/><path d="m5 10 3-3 2.2 2.2 1.3-1.3 3 3"/></symbol>',
	'<symbol id="i-mail" viewBox="0 0 16 16"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="m2 4.5 6 4.5 6-4.5"/></symbol>',
	// M6: the inbox
	'<symbol id="i-inbox" viewBox="0 0 16 16"><path d="M1.5 9.5 3.6 3a1 1 0 0 1 .95-.7h6.9a1 1 0 0 1 .95.7l2.1 6.5v3.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M1.5 9.5h3.7l1 1.7h3.6l1-1.7h3.7"/></symbol>',
	'<symbol id="i-download" viewBox="0 0 16 16"><path d="M8 2.5v8M4.8 7.3 8 10.5l3.2-3.2"/><path d="M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/></symbol>',
	'<symbol id="i-reply" viewBox="0 0 16 16"><path d="M6.5 3.5 2.5 7.5l4 4"/><path d="M2.5 7.5h6.8a4.2 4.2 0 0 1 4.2 4.2v.8"/></symbol>',
	'<symbol id="i-attach" viewBox="0 0 16 16"><path d="m13.2 7.6-5.5 5.5a3.2 3.2 0 0 1-4.6-4.6l5.8-5.8a2.1 2.1 0 0 1 3 3l-5.6 5.6a1 1 0 0 1-1.5-1.5l5.1-5.1"/></symbol>',
	'<symbol id="i-unread" viewBox="0 0 16 16"><path d="M14.5 8.5v3.5a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V5A1.5 1.5 0 0 1 3 3.5h6"/><path d="m2 4.5 6 4.5 2.4-1.8"/><circle cx="13" cy="4" r="1.8" fill="currentColor" stroke="none"/></symbol>',
	'<symbol id="b-hero" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4 6.5h6.5M4 9h4"/></symbol>',
	'<symbol id="b-head" viewBox="0 0 16 16"><path d="M2.5 4h9M2.5 7h7M2.5 11h11M2.5 13.5h8"/></symbol>',
	'<symbol id="b-tm" viewBox="0 0 16 16"><rect x="1.5" y="3.5" width="6" height="9" rx="1"/><path d="M9.5 5.5h5M9.5 8h5M9.5 10.5h3"/></symbol>',
	'<symbol id="b-cases" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="5.5" height="5" rx="1"/><rect x="9" y="2.5" width="5.5" height="5" rx="1"/><rect x="1.5" y="9.5" width="5.5" height="4" rx="1"/><rect x="9" y="9.5" width="5.5" height="4" rx="1"/></symbol>',
	'<symbol id="b-cta" viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="1"/><rect x="5" y="8.8" width="6" height="2.2" rx="1.1"/><path d="M4.5 6h7"/></symbol>',
	'<symbol id="b-footer" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 9.5h13M4 11.5h3"/></symbol>',
	'<symbol id="b-team" viewBox="0 0 16 16"><circle cx="5" cy="6" r="2"/><circle cx="11" cy="6" r="2"/><path d="M1.5 13a3.5 3.5 0 0 1 7 0M7.5 13a3.5 3.5 0 0 1 7 0"/></symbol>',
	'<symbol id="b-quote" viewBox="0 0 16 16"><path d="M3 10.5c0-3 1-5 3.5-6M9 10.5c0-3 1-5 3.5-6"/><path d="M3 10.5h2.5v2.5H3zM9 10.5h2.5v2.5H9z"/></symbol>',
	'<symbol id="b-gallery" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="8" height="11" rx="1"/><rect x="11" y="2.5" width="3.5" height="5" rx="1"/><rect x="11" y="8.5" width="3.5" height="5" rx="1"/></symbol>',
	'<symbol id="b-video" viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M6.5 6v4l3.5-2z"/></symbol>',
	'<symbol id="b-form" viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="3" rx="1"/><rect x="2" y="7" width="12" height="3" rx="1"/><rect x="2" y="11.5" width="5" height="2.5" rx="1"/></symbol>',
	'<symbol id="b-faq" viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><path d="m11 3 1.2 1.1L11 5.2"/></symbol>',
	'<symbol id="b-unknown" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1" stroke-dasharray="2 1.8"/><path d="M6.6 6.7a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9v.2M8 10.9v.1"/></symbol>',
].join('');

export function IconSprite() {
	return (
		<svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
			<defs dangerouslySetInnerHTML={{ __html: SYMBOLS }} />
		</svg>
	);
}

/** `name` without the `i-` prefix for interface icons (`grip`, `chev-r`), with `b-` for block icons. */
export function Icon({ name, size }: { name: string; size?: 'sm' | 'xs' }) {
	const href = `#${name.startsWith('b-') ? name : `i-${name}`}`;
	return (
		<svg className={size ? `i i-${size}` : 'i'} aria-hidden="true">
			<use href={href} />
		</svg>
	);
}
