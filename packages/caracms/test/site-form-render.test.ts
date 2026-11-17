// M7 Decision 2: moved from starter/test. It checks a package feature through a site, so it runs on the
// package's fixture site (test/fixtures/demo-site, the pre-M7 demo) and pinned content (helpers/site-render.ts).
// Port parity G6: a form field's placeholder and prefix, as the public form draws them
// (caracms/components/Form.astro, through Astro's container as fields-render.test.ts does).
// The demo's own forms have neither, so a pinned copy gets one more form in its copied
// src/forms.ts; the demo's file is untouched.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const copy = pinnedSite('form-render');
const formsFile = join(copy.root, 'src/forms.ts');
const QUOTE = `
	quote: {
		label: 'Quote',
		email: { subject: 'Quote request' },
		fields: {
			name: { label: 'Your name', placeholder: ' Jane Doe ' },
			email: { label: 'Email', type: 'email', placeholder: 'name@example.com' },
			budget: { label: 'Budget', prefix: '$', placeholder: '5000', help: 'Roughly.' },
			phone: { label: 'Phone', type: 'tel', prefix: '+353', optional: true },
			message: { label: 'Message', type: 'textarea', placeholder: 'Tell us about it' },
			notes: { label: 'Notes', type: 'textarea', optional: true, rows: 3 },
		},
	},
`;
const original = readFileSync(formsFile, 'utf8');
const withQuote = original.replace(/\n\} satisfies Record<string, FormConfig>;/, () => `${QUOTE}} satisfies Record<string, FormConfig>;`);
assert.notEqual(withQuote, original, 'the quote form was added to the copy');
writeFileSync(formsFile, withQuote);
// A 0.10.0 site's Site Settings: no form words (the pinned content seeds Contact's sent heading).
const settingsFile = join(copy.root, 'content/site-settings.json');
const { formWords: _seeded, ...settings } = JSON.parse(readFileSync(settingsFile, 'utf8'));
writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

let r: Renderer;
let html = '';
let hooked = '';
let contact = '';
before(async () => {
	r = await startRenderer(copy.root);
	html = await r.component('caracms/components/Form.astro', { form: 'quote' });
	hooked = await r.component('caracms/components/Form.astro', {
		form: 'quote',
		class: 'contact-form',
		submitClass: 'btn btn-primary',
		thanks: 'Thanks — we’ll be in touch.',
		failed: 'That didn’t send.',
		errors: { email: 'Please check your email.', textarea: 'Say a little more.' },
		actions: true,
		labelPlaceholders: true,
		'data-reveal': true,
		'data-delay': '2',
		action: '/elsewhere',
		'data-caracms-form': 'other',
	});
	contact = await r.component('caracms/components/Form.astro', { form: 'contact' });
});
after(async () => {
	await r?.close();
	copy.close();
});

/** One field's wrapper, by name. */
const field = (name: string) => {
	const m = new RegExp(`<div class="cms-form-field" data-type="[a-z]+">\\s*<label class="cms-form-label" for="cms-form-quote-${name}">[\\s\\S]*?<p class="cms-form-error"[^>]*>[^<]*</p>\\s*</div>`).exec(html);
	assert.ok(m, `field ${name} rendered`);
	return m[0];
};

describe('G6: placeholders and prefixes on the public form', () => {
	test('a placeholder goes on the input or textarea, trimmed, and the label stays', () => {
		assert.match(field('name'), /<label class="cms-form-label" for="cms-form-quote-name">\s*Your name/);
		assert.match(field('name'), /<input id="cms-form-quote-name" type="text" name="name" required placeholder="Jane Doe"/);
		assert.match(field('email'), /<input id="cms-form-quote-email" type="email" name="email" required placeholder="name@example.com"/);
		assert.match(field('message'), /<textarea id="cms-form-quote-message" name="message" rows="6" required placeholder="Tell us about it"/);
	});

	test('a prefix is its own element, wrapped with the input, and the input is described by it first', () => {
		const budget = field('budget');
		assert.match(
			budget,
			/<div class="cms-form-prefixed">\s*<span class="cms-form-prefix" id="cms-form-quote-budget-prefix">\s*\$\s*<\/span>\s*<input id="cms-form-quote-budget" type="text" name="budget" required placeholder="5000" aria-describedby="cms-form-quote-budget-prefix cms-form-quote-budget-help cms-form-quote-budget-error">\s*<\/div>/,
		);
		assert.doesNotMatch(budget, /aria-hidden/, 'the prefix is read, not hidden');
		assert.match(field('phone'), /<span class="cms-form-prefix" id="cms-form-quote-phone-prefix">\s*\+353\s*<\/span>\s*<input id="cms-form-quote-phone" type="tel" name="phone" aria-describedby="cms-form-quote-phone-prefix cms-form-quote-phone-error">/);
	});

	test('a field without them draws as before: no placeholder, no wrapper', () => {
		assert.doesNotMatch(field('phone'), /placeholder=/);
		assert.equal((html.match(/cms-form-prefixed/g) ?? []).length, 2, 'only the two prefixed fields are wrapped');
		assert.doesNotMatch(field('email'), /cms-form-prefix/);
	});
});

describe('M9 port friction 10: hooks for a site that draws its own look', () => {
	const formTag = (h: string) => /<form[^>]*>/.exec(h)![0];
	const fieldIn = (h: string, name: string) => new RegExp(`<div class="cms-form-field"[^>]*>\\s*<label[^>]*for="cms-form-quote-${name}">[\\s\\S]*?</div>`).exec(h)![0];

	test('left out, the form renders as before: no actions wrapper, no data-thanks, the textarea 6 rows, the button its one class', () => {
		for (const h of [html, contact]) {
			assert.doesNotMatch(h, /cms-form-actions|data-thanks|data-failed/);
			assert.match(h, /<button type="submit" class="cms-form-submit">/);
			assert.match(h, /<\/button>\s*<p class="cms-form-status" role="status" aria-live="polite" data-caracms-form-status><\/p>\s*<\/form>/);
		}
		assert.match(contact, /<textarea id="cms-form-contact-message" name="message" rows="6"/);
		assert.doesNotMatch(fieldIn(html, 'phone'), /placeholder=/, 'no label placeholder unless asked');
		assert.match(fieldIn(html, 'email'), /Please enter your email address, like name@example.com\./);
	});

	test('class and pass-through attributes go on the <form>; its own attributes stay its own', () => {
		const tag = formTag(hooked);
		assert.match(tag, /class="cms-form contact-form"/);
		assert.match(tag, /data-reveal(="")?[\s>]/);
		assert.doesNotMatch(tag, /data-reveal="true"/);
		assert.match(tag, /data-delay="2"/);
		assert.match(tag, /action="\/_caracms\/form"/);
		assert.doesNotMatch(tag, /elsewhere|data-caracms-form="other"/);
		assert.equal((tag.match(/data-caracms-form=/g) ?? []).length, 1);
	});

	test('submitClass, thanks, failed, and actions wrapping the button and the status line', () => {
		assert.match(formTag(hooked), /data-thanks="Thanks — we’ll be in touch\."/);
		assert.match(formTag(hooked), /data-failed="That didn’t send\."/);
		assert.match(hooked, /<div class="cms-form-actions">\s*<button type="submit" class="cms-form-submit btn btn-primary">\s*Send\s*<\/button>\s*<p class="cms-form-status"[^>]*data-caracms-form-status><\/p>\s*<\/div>\s*<\/form>/);
	});

	test('errors replace the wording by type; a field\'s own error still wins', () => {
		assert.match(fieldIn(hooked, 'email'), /<p class="cms-form-error"[^>]*>Please check your email\.<\/p>/);
		assert.match(fieldIn(hooked, 'message'), /<p class="cms-form-error"[^>]*>Say a little more\.<\/p>/);
		assert.match(fieldIn(hooked, 'name'), /<p class="cms-form-error"[^>]*>Please fill this in\.<\/p>/, 'a type left out keeps the package wording');
	});

	test('labelPlaceholders: the label is the placeholder where the field sets none; its own placeholder wins', () => {
		assert.match(fieldIn(hooked, 'phone'), /<input[^>]*placeholder="Phone"/);
		assert.match(fieldIn(hooked, 'notes'), /<textarea[^>]*placeholder="Notes"/);
		assert.match(fieldIn(hooked, 'name'), /<input[^>]*placeholder="Jane Doe"/);
		assert.match(fieldIn(hooked, 'phone'), /<label class="cms-form-label"/, 'the label stays');
	});

	test('a textarea field\'s rows', () => {
		assert.match(fieldIn(html, 'notes'), /<textarea[^>]*rows="3"/);
		assert.match(fieldIn(html, 'message'), /<textarea[^>]*rows="6"/);
	});
});
