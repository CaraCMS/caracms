/**
 * The three-way merge (M4 Decisions 6 and 7), pure: text in, text out.
 *
 * One rule for every merge in live mode: committing an autosave (the autosave's
 * base, the autosave, the file in `drafts` now), merging `main` into `drafts` (the
 * merge base, `drafts`, `main`), and held edits re-sent after a sign-in. One side is
 * always **the draft**, and the draft wins a conflict.
 *
 * - **A JSON object file** merges per top-level key: a key changed on one side takes
 *   that side; a key changed on both takes the draft; a key added or removed on one
 *   side follows that side.
 * - **Anything else** (not JSON on any side, not an object, a file deleted on one
 *   side and changed on the other, or a caller saying it isn't a content file) falls
 *   back to the whole file, the draft winning.
 * - **Byte-preserving** (M3 Decision 7's rule): the result is built on the draft's
 *   text. Untouched keys keep their text and position exactly. A member taken from
 *   the other side has its value's text spliced in at the draft member's span; a key
 *   new on the other side is appended at the end, in that side's order, with its
 *   text as written there; a key the other side removed is cut out with its comma.
 *   Never `JSON.stringify`, never `applyEdits` (which only knows a title and blocks).
 *
 * "Changed" compares values, not text: a key re-indented but equal isn't a change.
 */
import { member, parseSource, slice, type MemberNode, type ObjectNode, type ParsedSource } from '../json-source.ts';

export interface MergeInput {
	/** The common ancestor's text; null when the file didn't exist there. */
	base: string | null;
	/** The draft's text (it wins conflicts); null when the draft deleted it. */
	draft: string | null;
	/** The other side's text; null when that side deleted it. */
	other: string | null;
	/** False forces the whole-file rule (a non-content file). Default true. */
	perKey?: boolean;
}

export interface MergeResult {
	/** The merged text, or null for "the file is deleted". */
	text: string | null;
	/** Some key, or the whole file, was changed on both sides and decided for the draft: show the notice. */
	keptDraft: boolean;
	/** The keys decided for the draft (empty for a whole-file decision). */
	conflicts: string[];
	/** How it was decided. */
	how: 'same' | 'draft' | 'other' | 'keys' | 'whole-file';
}

export function mergeFile({ base, draft, other, perKey = true }: MergeInput): MergeResult {
	if (draft === other) return { text: draft, keptDraft: false, conflicts: [], how: 'same' };
	if (draft === base) return { text: other, keptDraft: false, conflicts: [], how: 'other' };
	if (other === base) return { text: draft, keptDraft: false, conflicts: [], how: 'draft' };

	const whole: MergeResult = { text: draft, keptDraft: true, conflicts: [], how: 'whole-file' };
	if (!perKey || draft === null || other === null) return whole;
	const d = objectSource(draft);
	const o = objectSource(other);
	// An added-on-both-sides file merges as if the ancestor were `{}`.
	const b = base === null ? EMPTY : objectSource(base);
	if (!d || !o || !b) return whole;

	const value = (s: Parsed, key: string) => (Object.hasOwn(s.value, key) ? { v: s.value[key] } : null);
	const same = (x: { v: unknown } | null, y: { v: unknown } | null) => (x === null || y === null ? x === y : equal(x.v, y.v));

	const conflicts: string[] = [];
	const replace: { member: MemberNode; text: string }[] = [];
	const remove: string[] = [];
	const append: string[] = [];
	const keys = [...new Set([...unique(d.root), ...unique(o.root), ...unique(b.root)])];
	for (const key of keys) {
		const dv = value(d, key);
		const ov = value(o, key);
		const bv = value(b, key);
		if (same(dv, ov)) continue; // the same on both sides
		if (same(ov, bv)) continue; // only the draft changed it: the draft has it
		if (same(dv, bv)) {
			// Only the other side changed it: take that side's.
			if (ov === null) remove.push(key);
			else if (dv === null) append.push(key);
			else replace.push({ member: member(d.root, key)!, text: slice(o.source, member(o.root, key)!.value) });
			continue;
		}
		conflicts.push(key); // changed on both: the draft's stays
	}
	if (replace.length === 0 && remove.length === 0 && append.length === 0) {
		return { text: draft, keptDraft: conflicts.length > 0, conflicts, how: 'keys' };
	}
	return { text: spliceMembers(d, o, replace, remove, append), keptDraft: conflicts.length > 0, conflicts, how: 'keys' };
}

interface Parsed {
	source: ParsedSource;
	root: ObjectNode;
	value: Record<string, unknown>;
}

const EMPTY: Parsed = (() => {
	const source = parseSource('{}');
	return { source, root: source.root as ObjectNode, value: {} };
})();

function objectSource(text: string): Parsed | null {
	let source: ParsedSource;
	try {
		source = parseSource(text);
	} catch {
		return null;
	}
	if (source.root.kind !== 'object') return null;
	return { source, root: source.root, value: source.value as Record<string, unknown> };
}

/** Keys in the order they first appear. */
const unique = (root: ObjectNode) => [...new Set(root.members.map((m) => m.key))];

/** Deep equality of JSON values; object key order doesn't matter. */
function equal(x: unknown, y: unknown): boolean {
	if (x === y) return true;
	if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
	if (Array.isArray(x) !== Array.isArray(y)) return false;
	if (Array.isArray(x)) {
		const ys = y as unknown[];
		return x.length === ys.length && x.every((v, i) => equal(v, ys[i]));
	}
	const xk = Object.keys(x);
	const yk = Object.keys(y);
	return xk.length === yk.length && xk.every((k) => Object.hasOwn(y, k) && equal((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]));
}

/** Where each member's key starts (its opening quote): parseSource records only values. */
function keyStarts(source: ParsedSource, root: ObjectNode): number[] {
	const text = source.text;
	const skip = (i: number) => {
		while (i < text.length && /\s/.test(text[i]!)) i++;
		return i;
	};
	return root.members.map((_, k) => {
		if (k === 0) return skip(root.start + 1);
		return skip(skip(root.members[k - 1]!.value.end) + 1); // past the comma
	});
}

/**
 * The draft's text with members replaced (value spans), removed (with their comma)
 * and appended (the other side's member text, in its order). Edits run from the end
 * of the text back, so earlier offsets stay true.
 */
function spliceMembers(d: Parsed, o: Parsed, replace: { member: MemberNode; text: string }[], remove: string[], append: string[]): string {
	const text = d.source.text;
	const members = d.root.members;
	const starts = keyStarts(d.source, d.root);
	const edits: { from: number; to: number; text: string }[] = [];

	for (const r of replace) edits.push({ from: r.member.value.start, to: r.member.value.end, text: r.text });

	// Removing a key removes every member with it (JSON.parse keeps the last; all go).
	const removing = new Set(remove);
	const kept = members.map((m) => !removing.has(m.key));
	for (let k = 0; k < members.length; k++) {
		if (kept[k]) continue;
		const next = kept.indexOf(true, k + 1) === -1 ? -1 : k + 1;
		if (next !== -1) {
			// Cut from this key to the next member's key: the member, its comma and the gap.
			edits.push({ from: starts[k]!, to: starts[k + 1]!, text: '' });
		} else {
			// The last kept members are before it: cut from the end of the previous member.
			const prev = k - 1;
			const from = prev >= 0 ? members[prev]!.value.end : starts[k]!;
			edits.push({ from, to: members[k]!.value.end, text: '' });
		}
	}

	if (append.length) {
		const oStarts = keyStarts(o.source, o.root);
		const memberText = (key: string) => {
			const k = o.root.members.findLastIndex((m) => m.key === key);
			return o.source.text.slice(oStarts[k]!, o.root.members[k]!.value.end);
		};
		const order = unique(o.root).filter((k) => append.includes(k));
		const lastKept = kept.lastIndexOf(true);
		if (lastKept === -1) {
			// No members left in the draft: lay them out with the other side's gaps.
			const gap = o.source.text.slice(o.root.start + 1, oStarts[0]);
			const close = o.source.text.slice(o.root.members.at(-1)!.value.end, o.root.end - 1);
			edits.push({ from: d.root.start + 1, to: d.root.end - 1, text: gap + order.map(memberText).join(`,${gap}`) + close });
		} else {
			// The gap before the draft's members (`\n  `), so new keys line up with them.
			const gap = lastKept > 0 ? text.slice(text.indexOf(',', members[lastKept - 1]!.value.end) + 1, starts[lastKept]) : text.slice(d.root.start + 1, starts[0]);
			const at = members[lastKept]!.value.end;
			edits.push({ from: at, to: at, text: order.map((k) => `,${gap}${memberText(k)}`).join('') });
		}
	}

	edits.sort((a, b) => b.from - a.from || b.to - a.to);
	let out = text;
	for (const e of edits) out = out.slice(0, e.from) + e.text + out.slice(e.to);
	return out;
}
