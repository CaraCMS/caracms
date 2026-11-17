/**
 * The lockup field's rules (M2 → Rules, "Keys" and "Phone lines"; Spec → Text),
 * as pure functions so they can be tested without a browser (Phase 3 → Verify 5).
 * LockupField.tsx calls these and nothing else decides what a key does.
 *
 *   lineKey(set, key, at)        what a key does in a line: split, join, move, refuse, or pass
 *   splitLine(lines, set, at)    Enter: split the line at the caret (Phone lines: only between words)
 *   joinUp(lines, line)          ⌫ at a line's start: join it to the line above
 *   splitEvenly(lines)           "Give Phone its own lines": the longest line split at the most even space
 *   reflowPhone(main, phone)     the main lines' words changed: keep the phone breaks if the word count holds
 *   withMainLines(value, lines)  a lockup's value after its main lines changed (phone lines kept or dropped)
 *   withoutPhone(value)          "Use main lines": no phone lines, so the file holds the plain list (Decision 10)
 *
 * Phone lines are the same words as the main lines, broken differently: in Phone
 * lines only Enter (between words) and ⌫ (at a line's start) work, so the words
 * can't change there. Words change in the main lines.
 */
import type { LockupValue } from '../../../fields.ts';

export type LineSet = 'main' | 'phone';

/** Where the caret is: a line, and a character in it. */
export interface LineCaret {
	line: number;
	caret: number;
}

export interface LineEdit {
	lines: string[];
	/** Where the caret goes after the edit. */
	focus: LineCaret;
}

/** The words of some lines, in order. */
export const wordsOf = (lines: readonly string[]): string[] => lines.join(' ').split(/\s+/).filter(Boolean);

export type LineKeyAction =
	/** Enter with a caret: split the line (splitLine). */
	| 'split'
	/** ⌫ at the start of a line below the first: join it up (joinUp). */
	| 'join'
	/** ↑/↓: the line above or below. */
	| 'up'
	| 'down'
	/** Swallowed with a nudge: a key that would change Phone lines' words, or Enter over a selection. */
	| 'refuse'
	/** Left to the input. */
	| 'pass';

/**
 * What a key does in a lockup line (M2's keys rule). `at.start`/`at.end` are the
 * input's selectionStart/End; `at.line` the line's index.
 */
export function lineKey(
	set: LineSet,
	key: string,
	at: { line: number; start: number; end: number; length?: number },
	modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean } = {},
): LineKeyAction {
	const collapsed = at.start === at.end;
	if (key === 'Enter') return collapsed ? 'split' : 'refuse';
	if (key === 'Backspace' && collapsed && at.start === 0 && at.line > 0) return 'join';
	if (key === 'ArrowUp') return 'up';
	if (key === 'ArrowDown') return 'down';
	if (set === 'phone') {
		// Shortcuts (copy, select all, undo…) and caret movement pass; anything that types or deletes doesn't.
		if (modifiers.meta || modifiers.ctrl) return key.toLowerCase() === 'x' || key.toLowerCase() === 'v' || key.toLowerCase() === 'z' ? 'refuse' : 'pass';
		if (key.length === 1 || key === 'Backspace' || key === 'Delete') return 'refuse';
	}
	return 'pass';
}

/**
 * Enter in a line: the text before the caret stays, the text after it starts the
 * next line (spaces at the break dropped). Main lines split anywhere, an empty line
 * included. Phone lines split only between two words, never inside one, so their
 * words stay the same: null means refused.
 */
export function splitLine(lines: readonly string[], set: LineSet, at: LineCaret): LineEdit | null {
	const line = lines[at.line];
	if (line === undefined) return null;
	const caret = Math.max(0, Math.min(line.length, at.caret));
	const left = line.slice(0, caret).trimEnd();
	const right = line.slice(caret).trimStart();
	if (set === 'phone') {
		if (!left || !right) return null;
		if (line[caret - 1] !== ' ' && line[caret] !== ' ') return null;
	}
	const out = [...lines];
	out.splice(at.line, 1, left, right);
	return { lines: out, focus: { line: at.line + 1, caret: 0 } };
}

/** ⌫ at the start of a line: it joins the line above, with one space between. The caret lands at the join. */
export function joinUp(lines: readonly string[], line: number): LineEdit | null {
	if (line <= 0 || line >= lines.length) return null;
	const above = lines[line - 1]!.trimEnd();
	const below = lines[line]!.trimStart();
	const joined = above && below ? `${above} ${below}` : above || below;
	const out = [...lines];
	out.splice(line - 1, 2, joined);
	return { lines: out, focus: { line: line - 1, caret: above.length + (above && below ? 1 : 0) } };
}

/**
 * "Give Phone its own lines": a copy of the main lines with the longest one split
 * in two at the space that makes the halves most even (the shorter of the two
 * longer halves; the first such space on a tie). A longest line with no space is
 * left as it is. Blank lines are dropped, as the lockup drops them.
 *
 *   ["Building a better mousetrap", "For You"] → ["Building a", "better mousetrap", "For You"]
 */
export function splitEvenly(lines: readonly string[]): string[] {
	const clean = lines.map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
	if (clean.length === 0) return [];
	let longest = 0;
	clean.forEach((l, i) => {
		if (l.length > clean[longest]!.length) longest = i;
	});
	const text = clean[longest]!;
	let best: { a: string; b: string; worst: number } | null = null;
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== ' ') continue;
		const a = text.slice(0, i);
		const b = text.slice(i + 1);
		const worst = Math.max(a.length, b.length);
		if (!best || worst < best.worst) best = { a, b, worst };
	}
	if (!best) return clean;
	const out = [...clean];
	out.splice(longest, 1, best.a, best.b);
	return out;
}

/**
 * The main lines' words changed while phone lines exist. If the number of words
 * holds, the phone lines keep their breaks, filled with the new words in order;
 * otherwise null: the phone lines drop (and the field says so).
 */
export function reflowPhone(main: readonly string[], phone: readonly string[]): string[] | null {
	const words = wordsOf(main);
	const counts = phone.map((l) => wordsOf([l]).length);
	if (counts.reduce((a, b) => a + b, 0) !== words.length) return null;
	let k = 0;
	return counts
		.map((count) => {
			const line = words.slice(k, k + count).join(' ');
			k += count;
			return line;
		})
		.filter(Boolean);
}

/**
 * A lockup's value once its main lines are `lines`. Phone lines are re-filled with
 * the new words if the word count holds (reflowPhone), else dropped: `dropped`.
 */
export function withMainLines(value: LockupValue, lines: string[]): { value: LockupValue; dropped: boolean } {
	if (!value.phone) return { value: { lines, phone: null }, dropped: false };
	const phone = reflowPhone(lines, value.phone);
	return phone ? { value: { lines, phone }, dropped: false } : { value: { lines, phone: null }, dropped: true };
}

/** A lockup with its own phone lines, split from the main lines (splitEvenly). */
export function withPhone(value: LockupValue): LockupValue {
	return { lines: value.lines, phone: splitEvenly(value.lines) };
}

/** "Use main lines": the phone lines go, and the file holds the plain list again (Decision 10). */
export function withoutPhone(value: LockupValue): LockupValue {
	return { lines: value.lines, phone: null };
}

/** The value as the store holds it, from whatever the block's data has. */
export function lockupValue(raw: unknown): LockupValue {
	if (raw && typeof raw === 'object' && Array.isArray((raw as LockupValue).lines)) {
		const v = raw as LockupValue;
		return { lines: v.lines.map(String), phone: Array.isArray(v.phone) && v.phone.length > 0 ? v.phone.map(String) : null };
	}
	return { lines: [], phone: null };
}
