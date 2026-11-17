// How live mode shows times and people (M4 Decision 16: the site's time zone, absolute
// times, the zone named once in history; Decision 5's naming rule for people).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clock, colourOf, initialOf, joinNames, samePerson, when, zoneLine } from '../src/editor/client/live/format.ts';

const DUBLIN = 'Europe/Dublin';

describe('times are absolute, in the site\'s time zone (Decision 16)', () => {
	test('Dublin in summer time is an hour ahead of UTC; in winter, the same', () => {
		assert.equal(clock('2026-10-14T13:20:00Z', DUBLIN), '14:20', '14 Oct 2026 is IST');
		assert.equal(clock('2026-12-01T13:20:00Z', DUBLIN), '13:20', '1 Dec is GMT');
		assert.equal(clock('2026-10-25T00:30:00Z', DUBLIN), '01:30', 'before the clocks go back (02:00 on 25 Oct)');
		assert.equal(clock('2026-10-25T01:30:00Z', DUBLIN), '01:30', 'and an hour later it reads 01:30 again');
	});

	test('the zone is the site\'s, not the browser\'s: New Zealand and UTC read the same instant differently', () => {
		const at = '2026-10-14T12:00:00Z';
		assert.equal(clock(at, 'UTC'), '12:00');
		assert.equal(clock(at, 'Pacific/Auckland'), '01:00');
		assert.equal(clock(at, 'America/New_York'), '08:00');
	});

	test('a zone that is not one falls back to UTC rather than throwing', () => {
		assert.equal(clock('2026-10-14T12:00:00Z', 'Mars/Olympus'), '12:00');
		assert.equal(when('2026-10-14T12:00:00Z', '', '2026-10-14T13:00:00Z'), 'Today 12:00');
	});

	test('"Today" is the site\'s day, which can differ from the UTC day', () => {
		// 23:30 UTC on the 14th is 00:30 on the 15th in Dublin.
		assert.equal(when('2026-10-14T23:30:00Z', DUBLIN, '2026-10-15T08:00:00Z'), 'Today 00:30');
		assert.equal(when('2026-10-14T23:30:00Z', 'UTC', '2026-10-15T08:00:00Z'), '14 Oct, 23:30');
		assert.equal(when('2026-10-14T13:20:00Z', DUBLIN, '2026-10-14T13:25:00Z'), 'Today 14:20');
	});

	test('other days say the day and month, and another year adds it', () => {
		const now = '2026-10-14T12:00:00Z';
		assert.equal(when('2026-10-13T08:30:00Z', DUBLIN, now), '13 Oct, 09:30');
		assert.equal(when('2026-03-01T09:30:00Z', DUBLIN, now), '1 Mar, 09:30');
		assert.equal(when('2025-10-12T08:30:00Z', DUBLIN, now), '12 Oct 2025, 09:30');
		assert.equal(when('2027-01-02T08:30:00Z', DUBLIN, now), '2 Jan 2027, 08:30');
	});

	test('history names the zone once, in words and by its IANA name', () => {
		assert.equal(zoneLine('UTC'), 'Times are UTC.');
		assert.equal(zoneLine('Mars/Olympus'), 'Times are UTC.');
		assert.match(zoneLine(DUBLIN), /^Times are .+ \(Europe\/Dublin\)\.$/);
		assert.match(zoneLine('Pacific/Auckland'), /Pacific\/Auckland/);
	});
});

describe('people', () => {
	test('a list of names reads as a sentence', () => {
		assert.equal(joinNames([]), '');
		assert.equal(joinNames(['Home']), 'Home');
		assert.equal(joinNames(['Home', 'About']), 'Home and About');
		assert.equal(joinNames(['Home', 'About', 'Contact']), 'Home, About and Contact');
	});

	test('one person is one colour everywhere, whatever the case of their address', () => {
		const a = { email: 'Aoife@Example.com' };
		assert.equal(colourOf(a), colourOf({ email: 'aoife@example.com', name: 'Someone Else' }));
		assert.match(colourOf(a), /^var\(--p-(niamh|aoife|ciaran)\)$/);
	});

	test('the initial is the name\'s, else the address\'s first letter', () => {
		assert.equal(initialOf({ email: 'aoife@example.com' }), 'A');
		assert.equal(initialOf({ email: 'x@y.test', name: 'ciarán' }), 'C');
		assert.equal(initialOf({ email: 'x@y.test', name: '  ' }), 'X');
	});

	test('the same person is the same address in any case; nobody is nobody', () => {
		assert.equal(samePerson({ email: 'A@x.test' }, { email: 'a@X.TEST' }), true);
		assert.equal(samePerson({ email: 'a@x.test' }, { email: 'b@x.test' }), false);
		assert.equal(samePerson(null, null), false);
		assert.equal(samePerson({ email: 'a@x.test' }, undefined), false);
	});
});
