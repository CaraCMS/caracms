/**
 * The date field's words (pre-M7 polish: fields/date.ts): what the box shows for a
 * stored day, and what it reads back from what's typed (day first).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dateToDay, dayToDate, formatDay, readTypedDay, todayIn } from '../src/editor/client/fields/date.ts';

describe('the date field', () => {
	test('a stored day shows in words; anything else shows empty', () => {
		assert.equal(formatDay('2026-05-02'), '2 May 2026');
		assert.equal(formatDay('2026-02-31'), '');
		assert.equal(formatDay(null), '');
		assert.equal(formatDay(20260502), '');
	});

	test('typed days are read day first, in words or numbers; an empty box clears', () => {
		for (const typed of ['2026-05-02', '2026-5-2', '2/5/2026', '02/05/2026', '2.5.2026', '2-5-2026', '2/5/26', '2 May 2026', '2 may 2026', '2nd May 2026', '2 May, 2026', 'May 2, 2026', 'May 2 2026', '  2   May   2026 ']) {
			assert.equal(readTypedDay(typed), '2026-05-02', typed);
		}
		assert.equal(readTypedDay('2 Sept 2026'), '2026-09-02');
		assert.equal(readTypedDay(''), null);
		assert.equal(readTypedDay('   '), null);
	});

	test("what isn't a real day is undefined (the field keeps it, with a warning)", () => {
		for (const typed of ['31/2/2026', '2026-13-01', 'tomorrow', '2 Ma 2026', '2/5', '12345', 'May 2026']) {
			assert.equal(readTypedDay(typed), undefined, typed);
		}
	});

	test('the calendar works in local dates; today is in the site\'s time zone', () => {
		assert.equal(dateToDay(dayToDate('2026-10-17')!), '2026-10-17');
		assert.equal(dayToDate('nope'), undefined);
		const late = new Date('2026-10-17T23:30:00Z');
		assert.equal(todayIn('Europe/Dublin', late), '2026-10-18');
		assert.equal(todayIn('America/Los_Angeles', late), '2026-10-17');
		assert.match(todayIn('Not/AZone', late), /^\d{4}-\d{2}-\d{2}$/);
	});
});
