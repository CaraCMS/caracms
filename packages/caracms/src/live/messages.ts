/**
 * The commit messages live mode writes, and reading them back (M4 Decisions 5, 8, 10).
 * **The formats are a contract**: the waiting list, who changed what, the merge
 * notices and the publish history are all rebuilt from them if Redis is flushed
 * ("everything in it either expires or can be rebuilt from git"). Commits have no
 * author, so GitHub signs them (M1 → G1); people go in the message.
 *
 * A draft commit (the sweep), one per batch:
 *
 *     Draft: Home, About
 *
 *     Edited-by: Aoife <aoife@example.com>: content/pages/index.json, content/pages/about.json
 *     Edited-by: Ciarán <ciaran@example.com>: content/pages/about.json
 *     Draft-kept: content/pages/about.json
 *
 * One `Edited-by` per editor, paths relative to the site's folder (Decision 3). A
 * name is the part of the address before `@` when the person has no other name.
 * `Draft-kept` is there only when the merge (merge.ts) decided a key or a file for
 * the draft: the notice's data.
 *
 * Merging `main` into `drafts`:
 *
 *     Merge main into drafts
 *
 *     From-main: content/pages/about.json
 *     Draft-kept: content/pages/index.json
 *
 * A publish, the one squashed commit on `main`:
 *
 *     Published: Home, About — by Aoife
 *
 *     Published-by: Aoife <aoife@example.com>
 *     Published-files: content/pages/index.json, content/pages/about.json
 *
 * Discarding a document's unpublished changes (its files put back as `main` has them):
 *
 *     Discarded: About — by Aoife
 *
 *     Discarded-by: Aoife <aoife@example.com>
 *     Discarded-files: content/pages/about.json
 *
 * Publish holding documents back (caracms-cloud adversarial review, finding 15): the one
 * commit on `drafts`, on top of the publish, putting back what `main` didn't get. It says
 * again who changed each file, so they're still waiting with who changed them:
 *
 *     Held back: About
 *
 *     Held-back-files: content/pages/about.json
 *     Edited-by: Ciarán <ciaran@example.com>: content/pages/about.json
 *
 * Reading back, a discard ends what the commits before it said about those files: who
 * changed them and any `Draft-kept` (status.ts → `waitingFromCommits`).
 */

export interface Person {
	email: string;
	/** Shown instead of the address's local part when set. */
	name?: string | null;
}

/** The name a person goes by in messages: their name, or the address before `@`. */
export function displayName(person: Person): string {
	const name = person.name?.trim();
	return name || person.email.split('@')[0]!;
}

/** `Aoife <aoife@example.com>`, with anything that would break the trailer taken out. */
const ident = (p: Person) => `${displayName(p).replace(/[<>\n\r]/g, '').trim()} <${p.email.replace(/[<>\s]/g, '')}>`;

/**
 * "Home, About", or "Home, About, Work, Contact, Journal and 3 more". A title's line
 * breaks and control characters become spaces, so no title can start a trailer line.
 */
export function titleList(titles: string[]): string {
	const unique = [...new Set(titles.map((t) => t.replace(/\p{Cc}+/gu, ' ').trim()))];
	if (unique.length <= 5) return unique.join(', ');
	return `${unique.slice(0, 5).join(', ')} and ${unique.length - 5} more`;
}

export interface DraftEdit {
	/** Site-relative path. */
	file: string;
	title: string;
	editor: Person;
}

/** A draft commit's headline and body. Editors in the order they first appear; their files in batch order. */
export function draftMessage(edits: DraftEdit[], keptDraft: string[] = []): { headline: string; body: string } {
	const byEditor = new Map<string, { person: Person; files: string[] }>();
	for (const e of edits) {
		const key = e.editor.email.toLowerCase();
		const entry = byEditor.get(key) ?? { person: e.editor, files: [] };
		if (!entry.files.includes(e.file)) entry.files.push(e.file);
		byEditor.set(key, entry);
	}
	const lines = [...byEditor.values()].map(({ person, files }) => `Edited-by: ${ident(person)}: ${files.join(', ')}`);
	if (keptDraft.length) lines.push(`Draft-kept: ${[...new Set(keptDraft)].join(', ')}`);
	return { headline: `Draft: ${titleList(edits.map((e) => e.title))}`, body: lines.join('\n') };
}

export function mergeMessage(fromMain: string[], keptDraft: string[]): string {
	const lines = [];
	if (fromMain.length) lines.push(`From-main: ${fromMain.join(', ')}`);
	if (keptDraft.length) lines.push(`Draft-kept: ${keptDraft.join(', ')}`);
	return `Merge main into drafts${lines.length ? `\n\n${lines.join('\n')}` : ''}`;
}

/** A discard's commit on `drafts`: the document's files put back as `main` has them. */
export function discardMessage(titles: string[], files: string[], by: Person): string {
	return `Discarded: ${titleList(titles)} — by ${displayName(by)}\n\nDiscarded-by: ${ident(by)}\nDiscarded-files: ${files.join(', ')}`;
}

/** Finding 15: Publish's commit on `drafts` putting back the files it held back. `waiting`: who changed each, newest first (status.ts → waitingFromCommits). */
export function heldMessage(titles: string[], files: string[], waiting: { file: string; editors: { person: Person }[]; keptDraft: boolean }[]): string {
	const byEditor = new Map<string, { person: Person; files: string[] }>();
	// Oldest first, so reading back puts the newest editor in front again.
	for (const w of waiting)
		for (const e of [...w.editors].reverse()) {
			const key = e.person.email.toLowerCase();
			const entry = byEditor.get(key) ?? { person: e.person, files: [] };
			entry.files.push(w.file);
			byEditor.set(key, entry);
		}
	const lines = [`Held-back-files: ${files.join(', ')}`, ...[...byEditor.values()].map(({ person, files }) => `Edited-by: ${ident(person)}: ${files.join(', ')}`)];
	const kept = waiting.filter((w) => w.keptDraft).map((w) => w.file);
	if (kept.length) lines.push(`Draft-kept: ${kept.join(', ')}`);
	return `Held back: ${titleList(titles)}\n\n${lines.join('\n')}`;
}

export function publishMessage(titles: string[], files: string[], by: Person): string {
	return `Published: ${titleList(titles)} — by ${displayName(by)}\n\nPublished-by: ${ident(by)}\nPublished-files: ${files.join(', ')}`;
}

// ── Reading them back ─────────────────────────────────────────────────────────

export interface ParsedMessage {
	kind: 'draft' | 'merge' | 'publish' | 'discard' | 'other';
	/** Edited-by trailers: who changed which files. */
	edits: { person: Person; files: string[] }[];
	/** Draft-kept: files where the draft won a conflict. */
	keptDraft: string[];
	/** Published-by, for a publish. */
	publishedBy: Person | null;
	/** Published-files, for a publish. */
	publishedFiles: string[];
	/** The titles in a Draft or Published headline (without "and N more"). */
	titles: string[];
	/** Discarded-files, for a discard: what came before about these files no longer counts. */
	discardedFiles: string[];
}

const list = (value: string) =>
	value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

const parsePerson = (value: string): Person | null => {
	const m = /^(.*?)\s*<([^>]+)>$/.exec(value.trim());
	if (!m) return null;
	const name = m[1]!.trim();
	const email = m[2]!.trim();
	return { email, name: name && name !== email.split('@')[0] ? name : null };
};

/** Read a message written by the functions above. Anything else parses as `other` with no data. */
export function parseMessage(message: string): ParsedMessage {
	const [headline = '', ...rest] = message.split('\n');
	const out: ParsedMessage = { kind: 'other', edits: [], keptDraft: [], publishedBy: null, publishedFiles: [], titles: [], discardedFiles: [] };
	const titles = (s: string) => list(s.replace(/ and \d+ more$/, ''));
	if (headline.startsWith('Draft: ')) {
		out.kind = 'draft';
		out.titles = titles(headline.slice('Draft: '.length));
	} else if (headline === 'Merge main into drafts') out.kind = 'merge';
	else if (headline.startsWith('Published: ')) {
		out.kind = 'publish';
		out.titles = titles(headline.slice('Published: '.length).replace(/ — by .*$/, ''));
	} else if (headline.startsWith('Discarded: ')) {
		out.kind = 'discard';
		out.titles = titles(headline.slice('Discarded: '.length).replace(/ — by .*$/, ''));
	}
	for (const line of rest) {
		const m = /^([A-Za-z-]+): (.*)$/.exec(line.trim());
		if (!m) continue;
		const [, key, value] = m;
		if (key === 'Edited-by') {
			// `Name <email>: path, path`; the person ends at the first `>: `.
			const at = value!.indexOf('>: ');
			if (at === -1) continue;
			const person = parsePerson(value!.slice(0, at + 1));
			if (person) out.edits.push({ person, files: list(value!.slice(at + 3)) });
		} else if (key === 'Draft-kept') out.keptDraft.push(...list(value!));
		else if (key === 'Published-by') out.publishedBy = parsePerson(value!);
		else if (key === 'Published-files') out.publishedFiles = list(value!);
		else if (key === 'Discarded-files' && out.kind === 'discard') out.discardedFiles = list(value!);
	}
	return out;
}
