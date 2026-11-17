// Form rows and sourced selects, the page (Acceptance 1, 20, 24): `<Form>` on the fixture's rows
// config (test/fixtures/demo-site/caracms.rows.config.ts: the workshops collection and the booking
// form), rendered through Astro's container as site-form-render.test.ts does. The script's part
// (Add, Remove, narrowing) is the browser's: Acceptance 21.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { rowsSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const copy = rowsSite('form-rows-render');
// One more field on the copy's booking form: a text field with a suffix, and a select with a placeholder.
const configFile = join(copy.root, 'caracms.rows.config.ts');
const original = readFileSync(configFile, 'utf8');
const edited = original.replace("\t\tnotes: { label: 'Anything we should know?', type: 'textarea', optional: true },", () => "\t\tbudget: { label: 'Budget', optional: true, prefix: '$', suffix: 'USD' },\n\t\tlevel: { label: 'Level', type: 'select', optional: true, placeholder: 'eg. Beginner', options: [{ value: 'new', label: 'New to it' }] },\n\t\tnotes: { label: 'Anything we should know?', type: 'textarea', optional: true },");
assert.notEqual(edited, original, 'the copy gained its two fields');
writeFileSync(configFile, edited);

let r: Renderer;
let html = '';
let preview = '';
before(async () => {
	r = await startRenderer(copy.root);
	html = await r.component('caracms/components/Form.astro', { form: 'booking' });
	preview = await r.component('caracms/components/Form.astro', { form: 'booking', preview: true, state: 'invalid' });
});
after(async () => {
	await r?.close();
	copy.close();
});

const rows = () => /<fieldset class="cms-form-field cms-form-rows"[\s\S]*?<\/fieldset>/.exec(html)?.[0] ?? '';

describe('a rows field as rendered (Acceptance 20)', () => {
	test('a fieldset with its legend, one row, each cell named <field>[0][<column>] and required', () => {
		const f = rows();
		assert.match(f, /<legend class="cms-form-label">Bookings<\/legend>/);
		assert.equal((f.match(/data-caracms-row(?=[\s>])/g) ?? []).length, 1, 'one row');
		assert.match(f, /<p class="cms-form-row-label" id="cms-form-booking-bookings-0-label"><span>Booking<\/span> <span class="cms-form-row-n" data-caracms-row-n>1<\/span><\/p>/);
		for (const column of ['workshop', 'places', 'session']) {
			assert.match(f, new RegExp(`name="bookings\\[0\\]\\[${column}\\]"[^>]*required|required[^>]*name="bookings\\[0\\]\\[${column}\\]"`), column);
			assert.match(f, new RegExp(`<label class="cms-form-label" for="cms-form-booking-bookings-0-${column}">`));
		}
		assert.match(f, /<p class="cms-form-error" id="cms-form-booking-bookings-0-places-error">Please enter a number above 0\.<\/p>/);
		assert.match(f, /<button type="button" class="cms-form-add" data-caracms-add hidden>Add another<\/button>/);
		assert.match(f, /<p class="cms-form-at-most" data-caracms-at-most hidden>That’s the most this form takes\.<\/p>/);
		assert.match(f, /data-max="4"/);
	});

	test('the sourced column lists the open workshops by title, in the hand order, after its blank choice', () => {
		const select = /<select id="cms-form-booking-bookings-0-workshop"[\s\S]*?<\/select>/.exec(rows())![0];
		assert.deepEqual([...select.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]), [
			['', 'Choose…'],
			['riso-basics', 'Riso basics'],
			['two-colour-posters', 'Two-colour posters'],
		]);
	});

	test('the narrowed column offers every option without JavaScript, no blank choice, and carries what each workshop allows', () => {
		const select = /<select id="cms-form-booking-bookings-0-session"[\s\S]*?<\/select>/.exec(rows())![0];
		assert.deepEqual([...select.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]), ['morning', 'afternoon']);
		assert.match(select, /data-from="workshop"/);
		const allowed = JSON.parse(/data-allowed="([^"]*)"/.exec(select)![1]!.replaceAll('&quot;', '"'));
		assert.deepEqual(allowed, { 'riso-basics': ['morning'], 'two-colour-posters': ['morning', 'afternoon'] });
		assert.match(select, /data-else="\[&quot;morning&quot;,&quot;afternoon&quot;\]"/);
	});

	test('a number cell is a decimal text box with its pattern and placeholder', () => {
		const input = /<input id="cms-form-booking-bookings-0-places"[^>]*>/.exec(rows())![0];
		assert.match(input, /type="text"/);
		assert.match(input, /inputmode="decimal"/);
		assert.match(input, /placeholder="e\.g\. 2"/);
		assert.match(input, /pattern="\(\?=\.\*\[1-9\]\)\(\?:\\d\+\(\?:\\\.\\d\+\)\?\|\\\.\\d\+\)"/);
	});
});

describe('a select\'s placeholder and a suffix (Acceptance 24)', () => {
	test('the select\'s blank first choice is its placeholder', () => {
		assert.match(html, /<select id="cms-form-booking-level"[^>]*>\s*<option value="">eg\. Beginner<\/option>/);
	});
	test('a suffix sits after the input, hidden from screen readers', () => {
		assert.match(html, /<div class="cms-form-prefixed cms-form-suffixed"><span class="cms-form-prefix" id="cms-form-booking-budget-prefix">\$<\/span><input id="cms-form-booking-budget"[^>]*><span class="cms-form-suffix" aria-hidden="true">USD<\/span><\/div>/);
	});
});

describe('in a preview (Acceptance 22)', () => {
	test('the row word, the column labels and errors and the add button are their Site Settings fields; invalid shows every column\'s error', () => {
		assert.match(preview, /data-cms-field="formWords\.booking\.fields\.bookings\.rowLabel"/);
		assert.match(preview, /data-cms-field="formWords\.booking\.fields\.bookings\.columns\.places\.label"/);
		assert.match(preview, /data-cms-field="formWords\.booking\.fields\.bookings\.columns\.session\.error"/);
		assert.match(preview, /data-cms-field="formWords\.booking\.fields\.bookings\.add"/);
		// Review fix 4: Remove and the at-most line are typed on the page too (Decision 14).
		assert.match(preview, /<span[^>]*class="cms-form-row-remove"[^>]*data-cms-field="formWords\.booking\.fields\.bookings\.remove"|<span[^>]*data-cms-field="formWords\.booking\.fields\.bookings\.remove"[^>]*class="cms-form-row-remove"/);
		assert.match(preview, /data-cms-field="formWords\.booking\.fields\.bookings\.atMost"/);
		assert.doesNotMatch(html, /formWords\.booking/, 'the public page carries no word marks');
		assert.match(preview, /<fieldset class="cms-form-field cms-form-rows cms-form-invalid"/);
		assert.match(preview, /name="bookings\[0\]\[places\]"[^>]*aria-invalid="true"/);
	});
});
