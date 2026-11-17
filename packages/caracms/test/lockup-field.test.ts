// The lockup field's key rules and the phone-lines word rule (Phase 3 → Verify 5;
// M2 → Rules: keys, phone lines; Decision 10).
//
//   node --test --experimental-strip-types test/lockup-field.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fieldToJson, lockup } from '../src/fields.ts';
import {
	joinUp,
	lineKey,
	lockupValue,
	reflowPhone,
	splitEvenly,
	splitLine,
	withMainLines,
	withoutPhone,
	withPhone,
	wordsOf,
} from '../src/editor/client/fields/lockup-rules.ts';

const MOUSETRAP = ['Building a better mousetrap', 'For You'];

describe('lineKey: what a key does in a lockup line', () => {
	test('Enter splits; over a selection it does nothing', () => {
		assert.equal(lineKey('main', 'Enter', { line: 0, start: 3, end: 3 }), 'split');
		assert.equal(lineKey('phone', 'Enter', { line: 0, start: 3, end: 3 }), 'split');
		assert.equal(lineKey('main', 'Enter', { line: 0, start: 1, end: 4 }), 'refuse');
	});

	test('⌫ at the start of a line below the first joins it up; anywhere else it is the input\'s', () => {
		assert.equal(lineKey('main', 'Backspace', { line: 1, start: 0, end: 0 }), 'join');
		assert.equal(lineKey('phone', 'Backspace', { line: 1, start: 0, end: 0 }), 'join');
		assert.equal(lineKey('main', 'Backspace', { line: 0, start: 0, end: 0 }), 'pass');
		assert.equal(lineKey('main', 'Backspace', { line: 1, start: 2, end: 2 }), 'pass');
		assert.equal(lineKey('main', 'Backspace', { line: 1, start: 0, end: 3 }), 'pass');
	});

	test('↑ and ↓ move between lines', () => {
		assert.equal(lineKey('main', 'ArrowUp', { line: 1, start: 0, end: 0 }), 'up');
		assert.equal(lineKey('phone', 'ArrowDown', { line: 0, start: 0, end: 0 }), 'down');
	});

	test('in Phone lines only Enter and ⌫-at-start work: typing, deleting, cutting and pasting are refused', () => {
		const mid = { line: 1, start: 2, end: 2 };
		for (const key of ['a', ' ', 'Z', '1', 'Backspace', 'Delete']) assert.equal(lineKey('phone', key, mid), 'refuse', key);
		assert.equal(lineKey('phone', 'Backspace', { line: 0, start: 0, end: 0 }), 'refuse', '⌫ at the first line\'s start');
		assert.equal(lineKey('phone', 'x', mid, { meta: true }), 'refuse');
		assert.equal(lineKey('phone', 'v', mid, { ctrl: true }), 'refuse');
		// Moving the caret and copying are fine.
		for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab']) assert.equal(lineKey('phone', key, mid), 'pass', key);
		assert.equal(lineKey('phone', 'c', mid, { meta: true }), 'pass');
		assert.equal(lineKey('phone', 'a', mid, { meta: true }), 'pass');
	});

	test('in the main lines typing is the input\'s', () => {
		for (const key of ['a', ' ', 'Backspace', 'Delete']) assert.equal(lineKey('main', key, { line: 1, start: 2, end: 2 }), 'pass', key);
	});
});

describe('splitLine (Enter)', () => {
	test('main lines split at the caret, spaces at the break dropped', () => {
		assert.deepEqual(splitLine(MOUSETRAP, 'main', { line: 0, caret: 10 }), {
			lines: ['Building a', 'better mousetrap', 'For You'],
			focus: { line: 1, caret: 0 },
		});
		assert.deepEqual(splitLine(MOUSETRAP, 'main', { line: 0, caret: 11 })?.lines, ['Building a', 'better mousetrap', 'For You']);
	});

	test('main lines split inside a word, and at the end start an empty line', () => {
		assert.deepEqual(splitLine(['Mousetrap'], 'main', { line: 0, caret: 5 })?.lines, ['Mouse', 'trap']);
		assert.deepEqual(splitLine(['For You'], 'main', { line: 0, caret: 7 }), { lines: ['For You', ''], focus: { line: 1, caret: 0 } });
	});

	test('phone lines split only between two words', () => {
		const phone = ['Building a better', 'mousetrap'];
		assert.deepEqual(splitLine(phone, 'phone', { line: 0, caret: 10 })?.lines, ['Building a', 'better', 'mousetrap']);
		assert.deepEqual(splitLine(phone, 'phone', { line: 0, caret: 11 })?.lines, ['Building a', 'better', 'mousetrap']);
		assert.equal(splitLine(phone, 'phone', { line: 0, caret: 4 }), null, 'inside a word');
		assert.equal(splitLine(phone, 'phone', { line: 0, caret: 0 }), null, 'at the start');
		assert.equal(splitLine(phone, 'phone', { line: 1, caret: 9 }), null, 'at the end');
	});

	test('a split in Phone lines never changes the words', () => {
		const phone = ['Building a better mousetrap', 'For You'];
		for (let caret = 0; caret <= phone[0]!.length; caret++) {
			const edit = splitLine(phone, 'phone', { line: 0, caret });
			if (edit) assert.deepEqual(wordsOf(edit.lines), wordsOf(phone));
		}
	});
});

describe('joinUp (⌫ at a line\'s start)', () => {
	test('joins with one space, caret just after it', () => {
		assert.deepEqual(joinUp(['Building a', 'better mousetrap', 'For You'], 1), {
			lines: ['Building a better mousetrap', 'For You'],
			focus: { line: 0, caret: 11 },
		});
	});

	test('an empty line just goes', () => {
		assert.deepEqual(joinUp(['For You', ''], 1), { lines: ['For You'], focus: { line: 0, caret: 7 } });
		assert.deepEqual(joinUp(['', 'For You'], 1), { lines: ['For You'], focus: { line: 0, caret: 0 } });
	});

	test('not on the first line', () => {
		assert.equal(joinUp(MOUSETRAP, 0), null);
	});

	test('then split again gives the lines back (the round trip a designer does)', () => {
		const lines = ['Building a', 'better mousetrap', 'For You'];
		const joined = joinUp(lines, 1)!;
		assert.deepEqual(splitLine(joined.lines, 'phone', joined.focus)?.lines, lines);
	});
});

describe('splitEvenly ("Give Phone its own lines")', () => {
	test('the longest line, at the most even space', () => {
		assert.deepEqual(splitEvenly(MOUSETRAP), ['Building a', 'better mousetrap', 'For You']);
		assert.deepEqual(splitEvenly(['Play Hard', 'Work Hard Every Day']), ['Play Hard', 'Work Hard', 'Every Day']);
	});

	test('the first longest line on a tie; the first most even space on a tie', () => {
		assert.deepEqual(splitEvenly(['ab cd', 'ef gh']), ['ab', 'cd', 'ef gh']);
		assert.deepEqual(splitEvenly(['a bb c']), ['a', 'bb c']);
	});

	test('a single word stays one line; blanks drop; the words are the same', () => {
		assert.deepEqual(splitEvenly(['Mousetrap', 'For']), ['Mousetrap', 'For']);
		assert.deepEqual(splitEvenly(['  ', 'Worried?', '', 'Why Wait?']), ['Worried?', 'Why', 'Wait?']);
		assert.deepEqual(splitEvenly([]), []);
		const lines = ['Tell us what you are making', 'today'];
		assert.deepEqual(wordsOf(splitEvenly(lines)), wordsOf(lines));
	});
});

describe('the phone-lines word rule', () => {
	const phone = ['Building a', 'better mousetrap', 'For You'];

	test('same word count: the phone lines keep their breaks, with the new words', () => {
		assert.deepEqual(reflowPhone(['Building a better rattrap', 'For You'], phone), ['Building a', 'better rattrap', 'For You']);
		// Words moved between main lines: still the same count.
		assert.deepEqual(reflowPhone(['Building a better', 'mousetrap For You'], phone), phone);
		// A trailing space while typing isn't a word.
		assert.deepEqual(reflowPhone(['Building a better mousetrap ', 'For You'], phone), phone);
	});

	test('a word more or fewer: the phone lines drop', () => {
		assert.equal(reflowPhone(['Building a better mousetrap', 'For You Now'], phone), null);
		assert.equal(reflowPhone(['Building a mousetrap', 'For You'], phone), null);
		assert.equal(reflowPhone(['Building a better mouse trap', 'For You'], phone), null);
	});

	test('withMainLines keeps or drops, and says which', () => {
		const value = { lines: MOUSETRAP, phone };
		assert.deepEqual(withMainLines(value, ['Building a better rattrap', 'For You']), {
			value: { lines: ['Building a better rattrap', 'For You'], phone: ['Building a', 'better rattrap', 'For You'] },
			dropped: false,
		});
		assert.deepEqual(withMainLines(value, ['Building a better mousetrap', 'For You All']), {
			value: { lines: ['Building a better mousetrap', 'For You All'], phone: null },
			dropped: true,
		});
		// No phone lines: nothing to drop.
		assert.deepEqual(withMainLines({ lines: MOUSETRAP, phone: null }, ['New']), { value: { lines: ['New'], phone: null }, dropped: false });
	});
});

describe('phone lines in the file (Decision 10)', () => {
	const field = lockup({ style: 'display' });

	test('giving Phone its own lines writes the object form', () => {
		const value = withPhone({ lines: MOUSETRAP, phone: null });
		assert.deepEqual(fieldToJson(field, value), { lines: MOUSETRAP, phone: ['Building a', 'better mousetrap', 'For You'] });
	});

	test('removing them writes the plain list again', () => {
		const value = withoutPhone({ lines: MOUSETRAP, phone: ['Building a', 'better mousetrap', 'For You'] });
		assert.deepEqual(value, { lines: MOUSETRAP, phone: null });
		assert.deepEqual(fieldToJson(field, value), MOUSETRAP);
	});

	test('phone lines dropped by the word rule write the plain list too', () => {
		const { value } = withMainLines({ lines: MOUSETRAP, phone: ['Building a', 'better mousetrap', 'For You'] }, ['A new heading']);
		assert.deepEqual(fieldToJson(field, value), ['A new heading']);
	});

	test('lockupValue reads the store\'s value, and anything else as empty', () => {
		assert.deepEqual(lockupValue({ lines: ['A'], phone: ['A'] }), { lines: ['A'], phone: ['A'] });
		assert.deepEqual(lockupValue({ lines: ['A'], phone: [] }), { lines: ['A'], phone: null });
		assert.deepEqual(lockupValue(undefined), { lines: [], phone: null });
		assert.deepEqual(lockupValue(['A']), { lines: [], phone: null });
	});
});
