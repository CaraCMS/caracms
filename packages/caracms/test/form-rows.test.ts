// Form rows and sourced selects: the config's
// checks, the documents a sourced select offers, the endpoint's rows and sentences on a site whose
// content is on disk (so a document added after the build counts), the stored list, the email's
// lines and the inbox's titles. Acceptance 1–5, 7–16, 19 and 23–24 (the config and words parts).
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { CaracmsConfigError, list, resolveSite, select, toggle, type FormConfig, type ResolvedSite, type SiteConfig } from '../src/config.ts';
import { diskSource } from '../src/content.ts';
import { buildNotification, formSettingsFrom } from '../src/forms/email.ts';
import { handleForm, vetRows, type FormContext } from '../src/forms/endpoint.ts';
import { handleSubmissions, type SubmissionResponse } from '../src/forms/inbox.ts';
import { memoryLimiter } from '../src/forms/rate-limit.ts';
import { isBlankRow, plainRowLines, rowsLines, type ResolvedFormField } from '../src/forms/rules.ts';
import { formReader, readFormSources } from '../src/forms/sources.ts';
import { MemoryBackend, storeOver, type StoredSubmission } from '../src/forms/store.ts';
import { resolveFormWords, storedWordsOf } from '../src/forms/words.ts';
import { readFormWords } from '../src/read.ts';
import { fixtures, variant } from './helpers/site.ts';

const SESSIONS = [
	{ value: 'morning', label: 'Morning' },
	{ value: 'afternoon', label: 'Afternoon' },
];

const workshops = {
	kind: 'fields' as const,
	folder: 'content/workshops',
	order: 'manual' as const,
	component: 'Block.astro',
	fields: {
		open: toggle({ label: 'Open for booking' }),
		sessions: list(select({ options: SESSIONS })),
		notes: list({ line: select({ options: SESSIONS }) }),
	},
};

const FORMS: Record<string, FormConfig> = {
	booking: {
		label: 'Booking',
		email: { subject: 'New booking' },
		fields: {
			name: { label: 'Your name', autocomplete: 'name' },
			email: { label: 'Email', type: 'email' },
			job: { label: 'Applying for', type: 'select', optional: true, options: [{ value: 'general', label: 'General application' }], source: { collection: 'workshops', where: 'open' } },
			bookings: {
				label: 'Bookings',
				type: 'rows',
				rowLabel: 'Booking',
				max: 3,
				columns: {
					workshop: { label: 'Workshop', type: 'select', source: { collection: 'workshops', where: 'open' } },
					places: { label: 'Places', type: 'number' },
					session: { label: 'Session', type: 'select', options: SESSIONS, from: { column: 'workshop', field: 'sessions' } },
				},
			},
			extras: {
				label: 'Extras',
				type: 'rows',
				optional: true,
				columns: { item: { label: 'Item' }, unit: { label: 'Unit', type: 'select', options: [{ value: 'tin', label: '5L Tin' }, { value: 'l', label: 'L' }] }, amount: { label: 'Amount', type: 'number' } },
			},
		},
	},
};

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A site on disk: the fixture's Block.astro, three workshops (one open mornings only, one open naming none, one closed) and a broken one. */
function makeSite(forms: Record<string, FormConfig> = FORMS): ResolvedSite {
	// The fixture's text style measures ../fonts from the site's root, so the site sits in a folder beside a copy of them.
	const outer = mkdtempSync(join(tmpdir(), 'caracms-form-rows-'));
	roots.push(outer);
	cpSync(join(fixtures, 'fonts'), join(outer, 'fonts'), { recursive: true });
	const root = join(outer, 'site');
	cpSync(join(fixtures, 'site/Block.astro'), join(root, 'Block.astro'));
	mkdirSync(join(root, 'content/workshops'), { recursive: true });
	mkdirSync(join(root, 'content/pages'), { recursive: true });
	const doc = (path: string, data: Record<string, unknown>) => writeFileSync(join(root, 'content/workshops', `${path}.json`), JSON.stringify(data));
	doc('riso-basics', { title: 'Riso basics', open: true, sessions: ['morning'] });
	doc('two-colour', { title: 'Two-colour posters', open: true, sessions: [] });
	doc('zine', { title: 'Zine binding', open: false, sessions: ['afternoon'] });
	// Fields documents have no "hidden" (only pages do); a broken file is the one documents() leaves out here.
	writeFileSync(join(root, 'content/workshops/secret.json'), '{ "title": "Secret", "open": tru');
	writeFileSync(join(root, 'content/site-settings.json'), JSON.stringify({ title: 'Site Settings', brand: { name: 'CaraCMS' }, collectionOrder: { workshops: ['two-colour', 'riso-basics', 'zine', 'secret'] } }));
	return resolveSite(variant({ collections: { ...variant({}).collections, workshops } as SiteConfig['collections'], forms, timeZone: 'Europe/Dublin' }), root);
}

const refused = (forms: Record<string, FormConfig>, pattern: RegExp) =>
	assert.throws(() => makeSite(forms), (e: Error) => e instanceof CaracmsConfigError && pattern.test(e.message), `expected ${pattern}`);
const withField = (name: string, field: FormConfig['fields'][string]): Record<string, FormConfig> => ({
	booking: { ...FORMS.booking!, fields: { name: FORMS.booking!.fields.name!, email: FORMS.booking!.fields.email!, [name]: field } },
});
const rowsWith = (columns: Record<string, unknown>, extra: Record<string, unknown> = {}) => withField('lines', { label: 'Lines', type: 'rows', columns, ...extra } as never);

describe('the config (Acceptance 5, 14, 24)', () => {
	test('a source names a collection the site has; where is a toggle of it; a select needs options, a source or both', () => {
		refused(withField('job', { label: 'Job', type: 'select', source: { collection: 'jobs' } }), /form "booking", field "job": source names the collection "jobs", which the site doesn't have/);
		refused(withField('job', { label: 'Job', type: 'select', source: { collection: 'workshops', where: 'sessions' } }), /field "job": source's where must name a toggle field of the collection "workshops"/);
		refused(withField('job', { label: 'Job', type: 'select' }), /field "job": a select needs options, .*a source, .*or both/);
		refused(withField('job', { label: 'Job', source: { collection: 'workshops' } } as never), /field "job": only a select takes a source \(this one is text\)/);
		refused(rowsWith({ item: { label: 'Item', source: { collection: 'workshops' } } }), /column "item": only a select takes a source/);
		const site = makeSite(withField('job', { label: 'Job', type: 'select', source: { collection: 'workshops' } }));
		assert.deepEqual(site.forms.booking!.fields.find((f) => f.name === 'job')!.source, { collection: 'workshops' });
	});

	test('a rows field: columns, their types and names, from, else, max, and never "email"', () => {
		refused(rowsWith({}), /field "lines": a rows field needs columns/);
		refused(rowsWith({ when: { label: 'When', type: 'date' } }), /column "when": a column's type must be one of select, number, text/);
		refused(rowsWith(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`c${i}`, { label: `C${i}` }]))), /at most 20 columns/);
		refused(rowsWith({ '2nd': { label: 'Second' } }), /column "2nd": a column's name must start with a letter/);
		const narrowed = (from: unknown, extra: Record<string, unknown> = {}) => ({ w: { label: 'W', type: 'select', source: { collection: 'workshops' } }, s: { label: 'S', type: 'select', options: SESSIONS, from, ...extra } });
		refused(rowsWith({ w: { label: 'W', type: 'select', options: SESSIONS }, s: { label: 'S', type: 'select', options: SESSIONS, from: { column: 'w', field: 'sessions' } } }), /column "s": from's column must be a select column of this rows field with a source/);
		refused(rowsWith(narrowed({ column: 'nope', field: 'sessions' })), /from's column must be a select column/);
		refused(rowsWith(narrowed({ column: 'w', field: 'colour' })), /from's field "colour" isn't a field of the collection "workshops"/);
		refused(rowsWith(narrowed({ column: 'w', field: 'open' })), /from's field "open" must be a list of select or of text/);
		refused(rowsWith(narrowed({ column: 'w', field: 'notes' })), /from's field "notes" must be a list of select or of text/);
		refused(rowsWith(narrowed({ column: 'w', field: 'sessions' }, { source: { collection: 'workshops' } })), /column "s": a column that takes its choices from another can't have a source of its own/);
		refused(rowsWith({ w: { label: 'W', type: 'select', source: { collection: 'workshops' } }, s: { label: 'S', type: 'select', source: { collection: 'workshops' }, from: { column: 'w', field: 'sessions' } } }), /can't have a source of its own/);
		refused(rowsWith(narrowed({ column: 'w', field: 'sessions', else: ['evening'] })), /from's else names "evening", which isn't one of the column's options/);
		// Review fix 6: an empty else passed and then refused every row naming none with "… is one of: .".
		refused(rowsWith(narrowed({ column: 'w', field: 'sessions', else: [] })), /column "s": from's else can't be empty/);
		refused(rowsWith({ n: { label: 'N', type: 'number', from: { column: 'w', field: 'sessions' } } }), /only a select column can take its choices from another/);
		for (const max of [0, 51, 2.5]) refused(rowsWith({ item: { label: 'Item' } }, { max }), /field "lines": max must be a whole number from 1 to 50/);
		refused(withField('email', { label: 'Email', type: 'rows', columns: { item: { label: 'Item' } } } as never), /field "email": the "email" field is the visitor's address, so it can't be a rows field/);
		refused(rowsWith({ item: { label: 'Item' } }, { placeholder: 'x' }), /a rows field takes no placeholder of its own/);
		refused(rowsWith({ item: { label: 'Item' } }, { prefix: '$' }), /only a text or tel field takes a prefix \(this one is rows\)/);
		refused(withField('note', { label: 'Note', max: 3 } as never), /field "note": only a rows field takes max/);
		const site = makeSite(rowsWith(narrowed({ column: 'w', field: 'sessions' })));
		const field = site.forms.booking!.fields.find((f) => f.name === 'lines')!;
		assert.equal(field.max, 10, 'max defaults to 10');
		assert.deepEqual(field.columns!.find((c) => c.name === 's')!.from, { column: 'w', field: 'sessions', else: ['morning', 'afternoon'] }, 'no else: every option');
	});

	test('suffix on text and tel only; a select takes a placeholder', () => {
		refused(withField('note', { label: 'Note', type: 'textarea', suffix: 'x' }), /field "note": only a text or tel field takes a suffix \(this one is textarea\)/);
		const site = makeSite(withField('budget', { label: 'Budget', prefix: '$', suffix: ' USD ' }));
		assert.equal(site.forms.booking!.fields.find((f) => f.name === 'budget')!.suffix, 'USD');
	});
});

describe('what a sourced select offers (Acceptance 1, 2, 6, 23)', () => {
	test('the collection\'s own order, open ones only, never a broken one; fixed options first, a fixed value listed once', async () => {
		const site = makeSite();
		const sources = await readFormSources(formReader(site), site.forms.booking!);
		assert.deepEqual(sources.job!.map((d) => [d.value, d.label]), [['two-colour', 'Two-colour posters'], ['riso-basics', 'Riso basics']]);
		const words = resolveFormWords(site.forms.booking!, {}, {}, sources);
		assert.deepEqual(words.fields.job!.choices, [{ value: 'general', label: 'General application' }, { value: 'two-colour', label: 'Two-colour posters' }, { value: 'riso-basics', label: 'Riso basics' }]);
		assert.deepEqual(Object.keys(words.fields.job!.options), ['general'], 'a sourced choice has no word');
		const dup = resolveFormWords({ ...site.forms.booking!, fields: [{ ...site.forms.booking!.fields.find((f) => f.name === 'job')!, options: [{ value: 'riso-basics', label: 'Riso (fixed)' }] }] }, {}, {}, { job: sources.job! });
		assert.deepEqual(dup.fields.job!.choices!.map((c) => c.label), ['Riso (fixed)', 'Two-colour posters']);
	});

	test('cms.formWords: a rows field\'s words with their Site Settings fields, choices, allowed and else (Contracts)', async () => {
		const site = makeSite();
		const w = (await readFormWords(site, diskSource, 'booking'))!;
		const b = w.fields.bookings!;
		assert.deepEqual(
			[b.rowLabel, b.add, b.remove, b.atMost],
			[
				{ value: 'Booking', field: 'formWords.booking.fields.bookings.rowLabel' },
				{ value: 'Add another', field: 'formWords.booking.fields.bookings.add' },
				{ value: 'Remove', field: 'formWords.booking.fields.bookings.remove' },
				{ value: 'That’s the most this form takes.', field: 'formWords.booking.fields.bookings.atMost' },
			],
		);
		assert.deepEqual(b.columns!.places!.label, { value: 'Places', field: 'formWords.booking.fields.bookings.columns.places.label' });
		assert.deepEqual(b.columns!.workshop!.choices!.map((c) => c.value), ['two-colour', 'riso-basics']);
		assert.deepEqual(b.columns!.session!.options.morning, { value: 'Morning', field: 'formWords.booking.fields.bookings.columns.session.options.morning' });
		assert.equal(b.columns!.session!.placeholder, null, 'a narrowed column has no blank first choice');
		assert.deepEqual(b.columns!.session!.allowed, { 'two-colour': ['morning', 'afternoon'], 'riso-basics': ['morning'] });
		assert.deepEqual(b.columns!.session!.else, ['morning', 'afternoon']);
		assert.equal(b.placeholder, null);
		assert.equal(b.error.field, null, 'a rows field has no error word of its own in Site Settings');
		// Stored words win, in the paths the Contracts fix.
		const stored = storedWordsOf({ booking: { fields: { bookings: { rowLabel: 'Line', columns: { places: { label: 'Seats' }, session: { options: { morning: 'AM' } } } } } } }, 'booking');
		const again = resolveFormWords(site.forms.booking!, stored);
		assert.equal(again.fields.bookings!.rowLabel!.value, 'Line');
		assert.equal(again.fields.bookings!.columns!.places!.label.value, 'Seats');
		assert.equal(again.fields.bookings!.columns!.session!.choices![0]!.label, 'AM');
		// Form rows Decision 15: a select's blank first choice.
		assert.deepEqual(w.fields.job!.placeholder, { value: 'Choose…', field: 'formWords.booking.fields.job.placeholder' });
		assert.equal(resolveFormWords(site.forms.booking!, {}, { labelPlaceholders: true }).fields.job!.placeholder!.value, 'Choose…', 'labelPlaceholders leaves a select alone');
		assert.equal(resolveFormWords(site.forms.booking!, storedWordsOf({ booking: { choose: 'Pick…' } }, 'booking')).fields.job!.placeholder!.value, 'Pick…');
	});
});

describe('the endpoint (Acceptance 3, 4, 8–15)', () => {
	let backend: MemoryBackend;
	let site: ResolvedSite;
	let logs: string[];
	beforeEach(() => {
		backend = new MemoryBackend();
		site = makeSite();
		logs = [];
	});
	const ctx = (patch: Partial<FormContext> = {}): FormContext => ({
		site,
		env: {},
		store: storeOver(backend),
		limiter: memoryLimiter(),
		log: (line) => logs.push(line),
		readSettings: async () => formSettingsFrom({ brand: { name: 'CaraCMS' }, formRecipients: {} }),
		...patch,
	});
	const URL_ = 'http://site.test/_caracms/form';
	const base = { form: 'booking', return: '/workshop', name: 'Aoife', email: 'aoife@example.com' };
	const post = (fields: Record<string, string>) =>
		handleForm(new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ ...base, ...fields }).toString() }), ctx());
	const postJson = (body: Record<string, unknown>) => handleForm(new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...base, ...body }) }), ctx());
	const postMultipart = async (fields: Record<string, string>) => {
		const data = new FormData();
		for (const [k, v] of Object.entries({ ...base, ...fields })) data.append(k, v);
		const encoded = new Response(data);
		return handleForm(new Request(URL_, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': encoded.headers.get('content-type')! }, body: await encoded.arrayBuffer() }), ctx());
	};
	const row = (i: number, workshop: string, places: string, session: string) => ({ [`bookings[${i}][workshop]`]: workshop, [`bookings[${i}][places]`]: places, [`bookings[${i}][session]`]: session });
	const stored = async () => (await storeOver(backend).list()).items;
	const error = async (res: Response) => ((await res.json()) as { error: string }).error;

	test('urlencoded, multipart and JSON store the same list, in index order with gaps; JSON numbers read as text', async () => {
		const want = [
			{ workshop: 'riso-basics', places: '2', session: 'morning' },
			{ workshop: 'two-colour', places: '1.5', session: 'afternoon' },
		];
		const r1 = await post({ ...row(5, 'two-colour', '1.5', 'afternoon'), ...row(0, 'riso-basics', '2', 'morning') });
		assert.equal(r1.status, 200, await r1.clone().text());
		const r2 = await postMultipart({ ...row(0, 'riso-basics', '2', 'morning'), ...row(2, 'two-colour', '1.5', 'afternoon') });
		assert.equal(r2.status, 200);
		const r3 = await postJson({ bookings: [{ workshop: 'riso-basics', places: 2, session: 'morning' }, { workshop: 'two-colour', places: '1.5', session: 'afternoon', extra: 'x' }] });
		assert.equal(r3.status, 200, await r3.clone().text());
		const all = await stored();
		assert.equal(all.length, 3);
		for (const s of all) {
			assert.deepEqual(s.fields.bookings, want);
			assert.deepEqual(s.fields.extras, [], 'an optional rows field with no rows stores []');
		}
	});

	test('a blank row is dropped; only blank rows on a required field is missing; blank rows don\'t count towards max', async () => {
		let res = await post({ ...row(0, 'riso-basics', '2', 'morning'), ...row(1, '', '', 'afternoon'), ...row(2, 'two-colour', '1', 'morning'), ...row(3, '', '', ''), ...row(4, 'two-colour', '3', 'afternoon') });
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal((await stored())[0]!.fields.bookings!.length, 3);
		res = await post({ ...row(0, '', '', 'morning') });
		assert.equal(res.status, 400);
		assert.equal(await error(res), 'Missing: Bookings.');
		res = await post({});
		assert.equal(await error(res), 'Missing: Bookings.');
		res = await post({ ...row(0, 'riso-basics', '1', 'morning'), ...row(1, 'riso-basics', '1', 'morning'), ...row(2, 'riso-basics', '1', 'morning'), ...row(3, 'riso-basics', '1', 'morning') });
		assert.equal(res.status, 400);
		assert.equal(await error(res), 'Bookings: 3 at most.');
	});

	test('number cells: 2, 2.5 and .5 pass; 0, -1 and abc are refused; a blank one is missing; each sentence names its row', async () => {
		for (const ok of ['2', '2.5', '.5']) assert.equal((await post({ ...row(0, 'riso-basics', ok, 'morning') })).status, 200, ok);
		for (const bad of ['0', '-1', 'abc']) {
			const res = await post({ ...row(0, 'riso-basics', '1', 'morning'), ...row(1, 'two-colour', bad, 'morning') });
			assert.equal(await error(res), 'Booking 2: Places must be a number above 0, like 2 or 2.5.', bad);
		}
		const res = await post({ ...row(0, 'riso-basics', '', 'morning') });
		assert.equal(await error(res), 'Booking 1: Places is missing.');
	});

	test('a sourced value: offered is accepted; toggled off, broken or missing is refused and nothing is stored; one added on disk after the build is accepted', async () => {
		for (const bad of ['zine', 'secret', 'nope', '../site-settings']) {
			const res = await post({ job: bad, ...row(0, 'riso-basics', '1', 'morning') });
			assert.equal(res.status, 400, bad);
			assert.equal(await error(res), 'Applying for: choose one of the options.');
			const cell = await post({ ...row(0, bad, '1', 'morning') });
			assert.equal(await error(cell), 'Booking 1: Workshop: choose one of the options.', bad);
		}
		assert.equal((await stored()).length, 0);
		assert.equal((await post({ job: 'general', ...row(0, 'riso-basics', '1', 'morning') })).status, 200);
		assert.equal((await post({ job: 'two-colour', ...row(0, 'riso-basics', '1', 'morning') })).status, 200);
		writeFileSync(join(site.root, 'content/workshops/screen.json'), JSON.stringify({ title: 'Screen printing', open: true }));
		assert.equal((await post({ job: 'screen', ...row(0, 'screen', '1', 'afternoon') })).status, 200, 'read at each submission (Acceptance 4)');
		rmSync(join(site.root, 'content/workshops'), { recursive: true });
		const gone = await post({ job: 'screen', ...row(0, 'riso-basics', '1', 'morning') });
		assert.equal(gone.status, 400, 'a missing folder offers nothing');
	});

	test('a narrowed column: the picked document\'s list, else every option; a mismatch names the row and the choices that apply', async () => {
		let res = await post({ ...row(0, 'riso-basics', '1', 'afternoon') });
		assert.equal(res.status, 400);
		assert.equal(await error(res), 'Booking 1: Session for Riso basics is one of: Morning.');
		assert.equal((await post({ ...row(0, 'two-colour', '1', 'afternoon') })).status, 200, 'a workshop naming no sessions: every option');
		res = await post({ ...row(0, 'riso-basics', '1', 'evening') });
		assert.equal(await error(res), 'Booking 1: Session: choose one of the options.');
	});

	test('else applies when the list names none of the options; a listed value that isn\'t an option is ignored', () => {
		const field: ResolvedFormField = {
			name: 'lines',
			label: 'Order',
			type: 'rows',
			optional: false,
			rowLabel: 'Product',
			max: 10,
			columns: [
				{ name: 'product', label: 'Product', type: 'select', source: { collection: 'products' } },
				{ name: 'unit', label: 'Unit', type: 'select', options: [{ value: 'tin', label: '5L Tin' }, { value: 'l', label: 'L' }, { value: 'pack', label: 'Pack' }], from: { column: 'product', field: 'units', else: ['l', 'pack'] } },
			],
		};
		const sources = { 'lines.product': [{ value: 'paint', label: 'Paint', data: { units: ['pallet'] } }, { value: 'primer', label: 'Primer', data: { units: ['tin'] } }] };
		assert.deepEqual(vetRows(field, [{ product: 'paint', unit: 'tin' }], sources).problems, ['Product 1: Unit for Paint is one of: L, Pack.']);
		assert.deepEqual(vetRows(field, [{ product: 'paint', unit: 'pack' }, { product: 'primer', unit: 'tin' }], sources).problems, []);
	});

	test('a column named like an Object.prototype member (constructor, toString, valueOf) is read as the row\'s own cell, never a 500 (review fix 5)', async () => {
		const odd: FormConfig = {
			label: 'Odd',
			email: { subject: 'Odd' },
			fields: {
				name: { label: 'Your name' },
				email: { label: 'Email', type: 'email' },
				lines: { label: 'Lines', type: 'rows', rowLabel: 'Line', columns: { constructor: { label: 'Item' }, toString: { label: 'Amount', type: 'number' as const }, valueOf: { label: 'Unit', type: 'select' as const, options: SESSIONS } } },
			},
		};
		site = makeSite({ ...FORMS, odd });
		const cells = (i: number, item: string, amount: string, unit: string) => ({ [`lines[${i}][constructor]`]: item, [`lines[${i}][toString]`]: amount, [`lines[${i}][valueOf]`]: unit });
		let res = await post({ form: 'odd', ...cells(0, 'Paper', '2', 'morning') });
		assert.equal(res.status, 200, await res.clone().text());
		assert.deepEqual((await stored())[0]!.fields.lines, [{ constructor: 'Paper', toString: '2', valueOf: 'morning' }]);
		// Only some cells posted: the missing ones are blank (missing sentences), never Object's own members.
		res = await post({ form: 'odd', 'lines[0][toString]': '2' });
		assert.equal(res.status, 400);
		assert.match(await error(res), /Line 1: Item is missing\./);
		// No cells at all on a required rows field: missing, not a 500.
		res = await post({ form: 'odd' });
		assert.equal(res.status, 400);
		res = await postJson({ form: 'odd', lines: [{ toString: 2, valueOf: 'morning' }] });
		assert.equal(res.status, 400);
		assert.match(await error(res), /Line 1: Item is missing\./);
		res = await postJson({ form: 'odd', lines: [{ constructor: 'Paper', toString: 2, valueOf: 'afternoon' }] });
		assert.equal(res.status, 200);
		// The helpers, on plain rows that lack the cells.
		const field = site.forms.odd!.fields.find((f) => f.name === 'lines')!;
		assert.equal(isBlankRow(field, {}), true);
		assert.deepEqual(vetRows(field, [{ toString: '1' }]).problems, ['Line 1: Item is missing.', 'Line 1: Unit is missing.']);
		assert.deepEqual(rowsLines(field, [{ toString: '3' }, { constructor: 'Ink', valueOf: 'morning' }]), ['3', 'Ink — Morning']);
	});

	test('an address already at the limit gets the 429 before the sourced collection is read; everyone else is read per submission (review fix 7)', async () => {
		let reads = 0;
		const readSources = async (form: Parameters<NonNullable<FormContext['readSources']>>[0]) => {
			reads++;
			return readFormSources(formReader(site), form);
		};
		const over = await handleForm(
			new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ ...base, ...row(0, 'riso-basics', '1', 'morning') }).toString() }),
			ctx({ readSources, limiter: { peek: async () => true, hit: async () => true } }),
		);
		assert.equal(over.status, 429);
		assert.equal(reads, 0, 'no disk read for an address at the limit');
		const ok = await handleForm(
			new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ ...base, ...row(0, 'riso-basics', '1', 'morning') }).toString() }),
			ctx({ readSources }),
		);
		assert.equal(ok.status, 200);
		assert.equal(reads, 1, 'read at the submission (Decision 3)');
	});

	test('the email shows the rows as lines, with titles, labels and the × rule; no rows leaves the field out', async () => {
		const res = await post({ job: 'two-colour', ...row(0, 'riso-basics', '2', 'morning'), ...row(1, 'two-colour', '4', 'afternoon'), 'extras[0][item]': 'Primer', 'extras[0][amount]': '4', 'extras[0][unit]': 'tin' });
		assert.equal(res.status, 200);
		const submission = (await stored())[0]!;
		const form = site.forms.booking!;
		const titles = { workshops: { 'riso-basics': 'Riso basics', 'two-colour': 'Two-colour posters' } };
		const { text } = buildNotification({ submission, form, brandName: 'CaraCMS', siteUrl: null, timeZone: 'Europe/Dublin', titles });
		assert.match(text, /Applying for: Two-colour posters\n/);
		assert.match(text, /Bookings:\nRiso basics — 2 Morning\nTwo-colour posters — 4 Afternoon\n/);
		assert.match(text, /Extras:\nPrimer — 5L Tin 4\n/);
		const empty = buildNotification({ submission: { ...submission, fields: { ...submission.fields, extras: [] } }, form, brandName: 'CaraCMS', siteUrl: null, timeZone: 'Europe/Dublin', titles });
		assert.doesNotMatch(empty.text, /Extras/);
		assert.match(empty.text, /Bookings:/);
		// The "×" rule: a value after a number that starts with a digit.
		const order = { columns: [{ name: 'p', label: 'P', type: 'text' as const }, { name: 'n', label: 'N', type: 'number' as const }, { name: 'u', label: 'U', type: 'select' as const, options: [{ value: 'tin', label: '5L Tin' }] }] };
		assert.deepEqual(rowsLines(order, [{ p: 'Primer', n: '4', u: 'tin' }, { p: 'Paint', n: '2.5', u: 'L' }]), ['Primer — 4 × 5L Tin', 'Paint — 2.5 L']);
	});

	test('a stored list the form doesn\'t declare as rows is never [object Object] in the email (Acceptance 19)', () => {
		const lines = [{ product: 'paint', amount: '2', unit: 'l' }];
		const submission: StoredSubmission = { v: 1, id: '2026-11-11T10-00-00-000Z_abc123', form: 'booking', receivedAt: '2026-11-11T10:00:00.000Z', readAt: null, fields: { name: 'Aoife', email: 'a@b.test', job: lines as never, orderLines: lines } };
		const { text } = buildNotification({ submission, form: site.forms.booking!, brandName: 'CaraCMS', siteUrl: null, timeZone: 'Europe/Dublin' });
		assert.doesNotMatch(text, /object Object/);
		assert.match(text, /Applying for:\nproduct: paint, amount: 2, unit: l\n/);
		assert.match(text, /orderLines:\nproduct: paint, amount: 2, unit: l\n/);
		assert.deepEqual(plainRowLines([{ a: '1' }, 'x']), ['a: 1', 'x']);
	});

	test('the inbox names sourced values by title, still when toggled off; a deleted document shows as stored (Acceptance 7, 17, 18)', async () => {
		assert.equal((await post({ job: 'riso-basics', ...row(0, 'riso-basics', '2', 'morning'), ...row(1, 'two-colour', '1', 'afternoon') })).status, 200);
		const [submission] = await stored();
		const open = async () => {
			const res = await handleSubmissions(new Request(`http://site.test/_caracms/submissions/${submission!.id}`), { site, mode: 'local', person: null, store: storeOver(backend), readWords: async () => undefined });
			return (await res.json()) as SubmissionResponse;
		};
		assert.deepEqual((await open()).titles, { workshops: { 'riso-basics': 'Riso basics', 'two-colour': 'Two-colour posters' } });
		writeFileSync(join(site.root, 'content/workshops/riso-basics.json'), JSON.stringify({ title: 'Riso basics', open: false }));
		assert.equal((await open()).titles.workshops!['riso-basics'], 'Riso basics', 'closed since: still its title');
		rmSync(join(site.root, 'content/workshops/two-colour.json'));
		const answer = await open();
		assert.equal(answer.titles.workshops!['two-colour'], undefined, 'gone: shown as stored');
		const bookings = answer.form!.fields.find((f) => f.name === 'bookings')!;
		assert.deepEqual(rowsLines(bookings, answer.submission.fields.bookings, answer.titles), ['Riso basics — 2 Morning', 'two-colour — 1 Afternoon']);
	});
});
