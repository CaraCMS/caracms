// Form rows, Acceptance 20's other half: a rows field's controls are `required` only when the
// field is required (form-rows-render.test.ts holds the required case). The rows config's booking
// form with its Bookings field made optional, rendered through Astro's container.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { rowsSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const copy = rowsSite('form-rows-optional-render');
const configFile = join(copy.root, 'caracms.rows.config.ts');
const original = readFileSync(configFile, 'utf8');
const edited = original.replace("\t\t\trowLabel: 'Booking',", "\t\t\toptional: true,\n\t\t\trowLabel: 'Booking',");
assert.notEqual(edited, original, 'the copy\'s Bookings field became optional');
writeFileSync(configFile, edited);

let r: Renderer;
let html = '';
before(async () => {
	r = await startRenderer(copy.root);
	html = await r.component('caracms/components/Form.astro', { form: 'booking' });
});
after(async () => {
	await r?.close();
	copy.close();
});

describe('an optional rows field as rendered (Acceptance 20)', () => {
	test('one row, none of its controls required', () => {
		const f = /<fieldset class="cms-form-field cms-form-rows"[\s\S]*?<\/fieldset>/.exec(html)?.[0] ?? '';
		assert.ok(f, 'the rows field is drawn');
		assert.equal((f.match(/data-caracms-row(?=[\s>])/g) ?? []).length, 1, 'one row');
		for (const column of ['workshop', 'places', 'session']) {
			const control = new RegExp(`<(?:input|select)[^>]*name="bookings\\[0\\]\\[${column}\\]"[^>]*>`).exec(f)?.[0] ?? '';
			assert.ok(control, `${column} is drawn`);
			assert.doesNotMatch(control, /\brequired\b/, `${column} isn't required`);
		}
		// The form's own required fields still are.
		assert.match(html, /<input[^>]*name="name"[^>]*required|<input[^>]*required[^>]*name="name"/);
	});
});
