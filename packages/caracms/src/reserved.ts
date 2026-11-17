/**
 * The names and paths the package reserves (M4 Decision 15, M5a Decisions 8 and 10).
 * Browser-safe (no imports): the editor's addresses read them too. config.ts
 * re-exports them.
 */

/** The Site Settings file, relative to the site (M4 Decision 15). */
export const SITE_SETTINGS_FILE = 'content/site-settings.json';
/** Site Settings' path in the reserved `settings` collection. */
export const SETTINGS_PATH = 'site-settings';
/** Where shared blocks live by default (M5a Decision 8). */
export const DEFAULT_SHARED_FOLDER = 'content/shared';
/**
 * The two collections the package reserves (M5a Decision 8): shared blocks and Site
 * Settings. A site can't name a collection either.
 */
export const RESERVED_COLLECTIONS = ['shared', 'settings'] as const;
/**
 * The keys of Site Settings the package owns (Decision 10); the site's own
 * `settings.fields` can't use them. M6 adds the search and sharing defaults, the
 * Google tag and the form emails' recipients (M6 Decision 14); pre-M7 item 8, the
 * redirects (redirects.ts); arrange pages (Decision 6), the Pages tree's saved order
 * (page-order.ts), which only the arrange screen writes, and its folders (page-folders.ts); review gaps (Decision 2), the hand
 * orders of the `order: 'manual'` collections (collection-order.ts); review gaps (Decision 9), each
 * form's words (forms/words.ts), whose fields resolveSite generates (Decision 9a).
 */
export const SETTINGS_KEYS = ['title', 'editors', 'brand', 'seo', 'googleTag', 'formRecipients', 'redirects', 'pageOrder', 'pageFolders', 'collectionOrder', 'formWords'] as const;
