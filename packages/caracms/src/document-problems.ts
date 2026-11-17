/**
 * What makes a document one the reader won't open (caracms-cloud adversarial review,
 * finding 15), said the way the editor says it. One rule for three places, so they never
 * disagree: content.ts → `inspect` (the listing's "no title" warning), the editor's note on
 * the field while it's typed, and Publish, which holds a document like this back (it stays
 * waiting) and publishes the rest (live/git.ts → `publish`).
 *
 * Today that's the title: every kind of document needs one that isn't blank. Fields have no
 * "required" of their own, and a field's value of the wrong shape parses as empty, never
 * refused (document.ts → `parseAnyDocument`), so nothing else makes a document unreadable.
 * A file that isn't JSON can't be read at all; only a hand edit makes one.
 *
 * Browser-safe: the editor imports it.
 */

export interface DocumentProblem {
	/** Where it is: `title`, or `''` for the whole file. */
	path: string;
	/** The note on the field, in its own words: "This needs a title." */
	note: string;
	/** Why Publish held it back, after "<title> wasn't published: ": "its title is empty". */
	reason: string;
}

export const NO_TITLE: DocumentProblem = { path: 'title', note: 'This needs a title.', reason: 'its title is empty' };
const NOT_JSON: DocumentProblem = { path: '', note: "This file isn't valid JSON.", reason: "its file isn't valid JSON" };

/** A document's problems, from its plain value (a file's, or the editor's own). Empty: the reader opens it. */
export function documentProblems(document: unknown): DocumentProblem[] {
	const title = document && typeof document === 'object' && !Array.isArray(document) ? (document as { title?: unknown }).title : undefined;
	return typeof title === 'string' && title.trim() !== '' ? [] : [NO_TITLE];
}

/** A file's problems, from its text. */
export function textProblems(text: string): DocumentProblem[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return [NOT_JSON];
	}
	return documentProblems(value);
}

/** "About wasn't published: its title is empty." */
export function heldBackSentence(title: string, reason: string): string {
	return `${title} wasn't published: ${reason}.`;
}
