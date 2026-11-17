/**
 * Every document has an address in /admin (Decision 19): `/admin` opens Home, and
 * `/admin/<collection>/<path>` opens a document (`/admin/pages/services/branding`,
 * `/admin/journal/<slug>`, `/admin/case-studies/<slug>`). The server's admin route and
 * the browser share this.
 *
 * The reserved collections (M5a Decision 8): a shared block is `/admin/shared/<name>`
 * (the same rule), and Site Settings, one document, is `/admin/settings`.
 */
import { isSubmissionId } from '../forms/rules.ts';
import { SETTINGS_PATH } from '../reserved.ts';
import { sameDoc, type DocRef } from './types.ts';

export const ADMIN = '/admin';
/** Site Settings' address (M5a). */
export const SETTINGS_ADDRESS = `${ADMIN}/settings`;
/** The inbox's address (M6 Decision 9); a submission is `/admin/submissions/<id>` (the email's link). */
export const SUBMISSIONS_ADDRESS = `${ADMIN}/submissions`;

/**
 * The inbox an address names: `{ id: null }` for `/admin/submissions`, `{ id }` for
 * `/admin/submissions/<id>` (an id the store mints), `'bad'` for anything else under it,
 * null for an address that isn't the inbox's.
 */
export function inboxFromAddress(pathname: string): { id: string | null } | 'bad' | null {
	const trimmed = pathname.replace(/\/+$/, '');
	if (trimmed === SUBMISSIONS_ADDRESS) return { id: null };
	if (!trimmed.startsWith(`${SUBMISSIONS_ADDRESS}/`)) return null;
	const rest = trimmed.slice(SUBMISSIONS_ADDRESS.length + 1);
	return isSubmissionId(rest) ? { id: rest } : 'bad';
}

/** Arrange pages' address (Decision 15): the screen, with nothing arranged on a reload. */
export const ARRANGE_ADDRESS = `${ADMIN}/arrange`;

export const isArrangeAddress = (pathname: string): boolean => pathname.replace(/\/+$/, '') === ARRANGE_ADDRESS;

export const inboxAddress =(id: string | null): string => (id ? `${SUBMISSIONS_ADDRESS}/${encodeURIComponent(id)}` : SUBMISSIONS_ADDRESS);

export function addressOf(ref: DocRef, home: DocRef): string {
	if (sameDoc(ref, home)) return ADMIN;
	if (ref.collection === 'settings') return SETTINGS_ADDRESS;
	return `${ADMIN}/${encodeURIComponent(ref.collection)}/${ref.path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The document an address names: `home` for `/admin`, a ref for
 * `/admin/<collection>/<path>` (one of `collections`, or `shared`), Site Settings for
 * `/admin/settings`, or null when the address isn't one (an unknown collection, no
 * path). Whether the document exists is the reader's to say.
 */
export function refFromAddress(pathname: string, collections: readonly string[], home: DocRef): DocRef | null {
	const trimmed = pathname.replace(/\/+$/, '');
	if (trimmed === ADMIN || trimmed === '') return home;
	if (trimmed === SETTINGS_ADDRESS) return { collection: 'settings', path: SETTINGS_PATH };
	if (!trimmed.startsWith(`${ADMIN}/`)) return null;
	let segments: string[];
	try {
		segments = trimmed.slice(ADMIN.length + 1).split('/').map(decodeURIComponent);
	} catch {
		return null;
	}
	const [collection, ...rest] = segments;
	if (!collection || !(collections.includes(collection) || collection === 'shared') || rest.length === 0) return null;
	return { collection, path: rest.join('/') };
}
