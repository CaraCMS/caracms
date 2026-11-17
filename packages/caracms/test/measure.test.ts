// The measurement (lifted from M1, E4) and the uncovered-character report (Decision 15).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fittedSizePx, measureLine, measureLockup, uncoveredCharacters } from '../src/measure.ts';
import { site } from './helpers/site.ts';

const display = site.textStyles.display!;
const plain = { ...display, textTransform: 'none' as const, trackingEm: 0 };

describe('measure', () => {
	test('the same lines give the same em width every run', () => {
		const lines = ['Building a better mousetrap', 'For You'];
		const first = measureLockup(lines, display);
		for (let i = 0; i < 10; i++) assert.deepEqual(measureLockup(lines, display), first);
		assert.equal(first.longest, first.lines[0]!.em);
	});

	test('tracking is added after every character, the last one included', () => {
		const untracked = measureLine('WAIT', { ...plain, textTransform: 'uppercase' });
		const tracked = measureLine('WAIT', display);
		assert.ok(Math.abs(tracked - untracked - 4 * display.trackingEm) < 1e-9);
	});

	test('the transform is applied before shaping', () => {
		assert.equal(measureLine('play hard', display), measureLine('PLAY HARD', display));
		assert.ok(measureLine('play hard', display) > measureLine('play hard', plain));
	});

	test('blank lines are dropped and lines trimmed, as the lockup renders them', () => {
		assert.deepEqual(
			measureLockup(['', '  Play Hard ', '   ', 'Work Hard'], display).lines.map((l) => l.text),
			['Play Hard', 'Work Hard'],
		);
		assert.equal(measureLockup([], display).longest, 0);
	});

	test('the fit, as the CSS computes it: min(size, width / longest)', () => {
		assert.equal(fittedSizePx(10, 500, 96), 50);
		assert.equal(fittedSizePx(2, 500, 96), 96);
	});
});

describe('uncovered characters (Decision 15)', () => {
	test('a covered line reports none', () => {
		assert.deepEqual(uncoveredCharacters('Building a better mousetrap', display), []);
		assert.deepEqual(uncoveredCharacters('Ciarán’s café — “quoted”', display), []);
	});

	test('an emoji the font lacks is reported, once, as a whole grapheme', () => {
		assert.deepEqual(uncoveredCharacters('Hi ✨ there ✨', display), ['✨']);
		assert.deepEqual(uncoveredCharacters('Team 👩🏽‍💻', display), ['👩🏽‍💻']);
	});

	test('another script is reported character by character, in order', () => {
		assert.deepEqual(uncoveredCharacters('Tokyo 東京', display), ['東', '京']);
	});

	test('a lockup gathers its lines\' uncovered characters, per line too', () => {
		const m = measureLockup(['Play ✨', 'Work 東'], display);
		assert.deepEqual(m.uncovered, ['✨', '東']);
		assert.deepEqual(
			m.lines.map((l) => l.uncovered),
			[['✨'], ['東']],
		);
	});
});
