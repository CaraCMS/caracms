// Review gaps, a form's words and states as the package's form draws
// them (Decisions 9a, 10, 12–14; Acceptance 15–21's render side), on the package's fixture
// (helpers/site-render.ts), through Astro's container:
// - in a preview every word is its Site Settings field: typed words marked with `data-cms-source`, a
//   placeholder (and a select's first line) marked without its value; the form never sends or checks
//   itself (novalidate, controls readonly and out of the tab order, labels point at no input, a button
//   that isn't a submit); the missing-form sentence is `data-cms-fixed`;
// - a word set in Site Settings is on the page, public and preview;
// - the states: sent (the thanks line in the status line, or the sent panel when a heading resolves),
//   error (the couldn't-send line) and invalid (every required field's error showing);
// - `cms.formWords` (the reader's) gives the same words with their fields.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pinnedSite, root, startRenderer, type Renderer } from './helpers/site-render.ts';

const copy = pinnedSite('form-words');
const settingsFile = join(copy.root, 'content/site-settings.json');
const original = readFileSync(settingsFile, 'utf8');

let r: Renderer;
let site: any;
let parseAnyDocument: (raw: unknown, site: unknown, collection: unknown) => any;
let read: any;
before(async () => {
	r = await startRenderer(copy.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseAnyDocument } = await r.load('caracms/document'));
	read = await r.load(join(root, 'src/read.ts'));
});
after(async () => {
	await r?.close();
	copy.close();
});

/** Site Settings with these form words (or none), for the renders that follow. */
function setWords(formWords: unknown) {
	const settings = JSON.parse(original);
	if (formWords === undefined) delete settings.formWords;
	else settings.formWords = formWords;
	writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}
const contactPage = () => parseAnyDocument(JSON.parse(readFileSync(join(copy.root, 'content/pages/contact.json'), 'utf8')), site, site.collections.pages);
async function render(preview: boolean, state: { block: number; name: string } | null = null) {
	const locals: Record<string, unknown> = {};
	if (state) read.setRenderState(locals, state);
	return r.page('caracms/components/RenderDocument.astro', { document: contactPage(), collection: 'pages', preview, previewPath: 'contact' }, 'http://localhost/contact', locals);
}
const formOf = (html: string) => /<form[^>]*data-caracms-form="contact"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
/** One field's wrapper, by name: from the last field opening before its input to the next one. */
const fieldIn = (form: string, name: string) => {
	const at = form.indexOf(`id="cms-form-contact-${name}"`);
	const start = form.lastIndexOf('<div class="cms-form-field', at);
	const end = form.indexOf('<div class="cms-form-field', at);
	return at < 0 ? '' : form.slice(start, end < 0 ? undefined : end);
};

describe('a preview: every word is its field (Decision 12)', () => {
	before(() => setWords(undefined));

	test('labels, the error lines and the button are typed words of Site Settings', async () => {
		const form = formOf(await render(true));
		assert.match(form, /<span data-cms-field="formWords\.contact\.fields\.name\.label" data-cms-kind="text" contenteditable="plaintext-only" data-cms-source="settings">Your name<\/span>/);
		assert.match(form, /<span class="cms-form-optional"> <span data-cms-field="formWords\.contact\.fields\.phone\.optional"[^>]*>\(optional\)<\/span><\/span>/);
		assert.match(form, /<p class="cms-form-error" id="cms-form-contact-name-error" data-cms-field="formWords\.contact\.fields\.name\.error" data-cms-kind="text"/);
		assert.match(form, /<button type="button" tabindex="-1" class="cms-form-submit"><span data-cms-field="formWords\.contact\.submit"[^>]*>Send<\/span><\/button>/);
		assert.match(form, /<p class="cms-form-help" id="cms-form-contact-files-help" data-cms-field="formWords\.contact\.fields\.files\.help"/);
	});

	test('a placeholder and a select’s first line are marked without their value; the controls take no focus or typing', async () => {
		const form = formOf(await render(true));
		const email = /<input id="cms-form-contact-email"[^>]*>/.exec(form)?.[0] ?? '';
		assert.match(email, /readonly/);
		assert.match(email, /tabindex="-1"/);
		assert.match(email, /data-cms-field="formWords\.contact\.fields\.email\.placeholder" data-cms-source="settings"/);
		assert.doesNotMatch(email, /data-cms-kind/);
		const select = /<select id="cms-form-contact-kind"[^>]*>/.exec(form)?.[0] ?? '';
		assert.match(select, /tabindex="-1"/);
		// Form rows Decision 15: the blank first choice is the select's own placeholder word (blank: the form's "Choose…").
		assert.match(select, /data-cms-field="formWords\.contact\.fields\.kind\.placeholder"/);
		assert.match(form, /<textarea id="cms-form-contact-message"[^>]*readonly[^>]*tabindex="-1"/);
	});

	test('it never sends or checks itself: novalidate, no submit button, labels point at no input (Acceptance 21)', async () => {
		const form = formOf(await render(true));
		assert.match(form, /^<form[^>]*novalidate/);
		assert.doesNotMatch(form, /type="submit"/);
		assert.doesNotMatch(form, /<label class="cms-form-label" for=/);
		assert.doesNotMatch(form, /\binert\b/);
	});

	test('the public form is 0.10.0’s: no markers, a submit button, labels for their inputs, no novalidate (Acceptance 18)', async () => {
		const form = formOf(await render(false));
		assert.doesNotMatch(form, /data-cms-|contenteditable|novalidate|readonly|data-thanks|data-failed|data-sending/);
		assert.match(form, /<label class="cms-form-label" for="cms-form-contact-name">\s*Your name\s*<\/label>/);
		assert.match(form, /<span class="cms-form-optional"> \(optional\)<\/span>/);
		assert.match(form, /<button type="submit" class="cms-form-submit">\s*Send\s*<\/button>/);
		assert.match(form, /<option value="">Choose…<\/option>/);
	});

	test('a form the config doesn’t have: the preview’s sentence is data-cms-fixed', async () => {
		const html = await r.component('caracms/components/Form.astro', { form: 'nope', preview: true });
		assert.match(html, /<p class="cms-form-missing" data-cms-fixed>/);
	});
});

describe('words set in Site Settings (Decision 10, Acceptance 17)', () => {
	before(() => setWords({ contact: { fields: { name: { label: 'Name' }, email: { placeholder: 'you@example.com' }, kind: { options: { print: 'Printed things' } } }, submit: 'Send it over', choose: 'Pick one' } }));
	after(() => setWords(undefined));

	test('the page reads them, public and preview', async () => {
		const pub = formOf(await render(false));
		assert.match(pub, /for="cms-form-contact-name">\s*Name\s*<\/label>/);
		assert.match(pub, /placeholder="you@example\.com"/);
		assert.match(pub, /<option value="print">Printed things<\/option>/);
		assert.match(pub, /<option value="">Pick one<\/option>/);
		assert.match(pub, />\s*Send it over\s*<\/button>/);
		const pre = formOf(await render(true));
		assert.match(pre, /data-cms-field="formWords\.contact\.fields\.name\.label"[^>]*>Name<\/span>/);
	});

	test('cms.formWords gives the same words, each with its field (Decision 13)', async () => {
		const words = await read.documentReader(site, read.renderSourceOf(undefined)).formWords('contact', { sentHeading: 'Got it' });
		assert.deepEqual(words.fields.name.label, { value: 'Name', field: 'formWords.contact.fields.name.label' });
		assert.deepEqual(words.submit, { value: 'Send it over', field: 'formWords.contact.submit' });
		assert.equal(words.sent.heading.value, 'Got it');
		assert.equal(await read.documentReader(site, read.renderSourceOf(undefined)).formWords('nope'), null);
	});
});

describe('the form’s states (Decision 14, Acceptance 20)', () => {
	before(() => setWords(undefined));
	after(() => setWords(undefined));

	test('sent with no heading: the form stays, the thanks line in the status line, typed on the page', async () => {
		const form = formOf(await render(true, { block: 1, name: 'sent' }));
		assert.match(form, /<p class="cms-form-status" role="status" aria-live="polite" data-caracms-form-status data-cms-field="formWords\.contact\.sent\.line"[^>]*>Thanks, we&#39;ll be in touch shortly\.<\/p>/);
		assert.match(form, /id="cms-form-contact-name"/);
	});

	test('sent with a heading: the form gives way to the sent panel, both words typed', async () => {
		setWords({ contact: { sent: { heading: 'Thanks, it’s sent', line: 'We answer within two days.' } } });
		const form = formOf(await render(true, { block: 1, name: 'sent' }));
		assert.match(form, /<div class="cms-form-sent" role="status">\s*<p class="cms-form-sent-heading" data-cms-field="formWords\.contact\.sent\.heading"[^>]*>Thanks, it’s sent<\/p>\s*<p class="cms-form-sent-line" data-cms-field="formWords\.contact\.sent\.line"[^>]*>We answer within two days\.<\/p>/);
		assert.doesNotMatch(form, /id="cms-form-contact-name"/);
		// The public form carries the panel hidden, for its script to show after a send.
		const pub = formOf(await render(false));
		assert.match(pub, /<div class="cms-form-sent" role="status" data-caracms-form-sent hidden>\s*<p class="cms-form-sent-heading">Thanks, it’s sent<\/p>/);
	});

	test('error: the couldn’t-send line in the status line', async () => {
		const form = formOf(await render(true, { block: 1, name: 'error' }));
		assert.match(form, /<p class="cms-form-status cms-form-failed"[^>]*data-cms-field="formWords\.contact\.failed"[^>]*>Something went wrong\. Please email us directly\.<\/p>/);
	});

	test('invalid: every required field’s error showing, the optional ones not', async () => {
		const form = formOf(await render(true, { block: 1, name: 'invalid' }));
		assert.match(fieldIn(form, 'name'), /^<div class="cms-form-field cms-form-invalid"/);
		assert.match(fieldIn(form, 'kind'), /^<div class="cms-form-field cms-form-invalid"/);
		assert.match(fieldIn(form, 'phone'), /^<div class="cms-form-field" /);
	});

	test('a public render never draws a state, whatever was asked', async () => {
		const form = formOf(await render(false, { block: 1, name: 'invalid' }));
		assert.doesNotMatch(form, /cms-form-invalid|cms-form-failed/);
	});
});
