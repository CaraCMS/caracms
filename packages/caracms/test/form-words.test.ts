// Review gaps, a form's words, the pure half (src/forms/words.ts and
// word-fields.ts): where a word comes from (Decision 10), the fields that hold them (Decisions 9a and 13),
// and the form the endpoint, the email and the inbox read (Decision 11). The email's line uses Site
// Settings' label (Acceptance 17's unit test); with nothing set, every word is 0.10.0's (Acceptance 18).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkForms, type FormConfig } from '../src/forms/rules.ts';
import { formWithWords, resolveFormWords, storedWordsOf, PACKAGE_WORDS } from '../src/forms/words.ts';
import { formWordFields } from '../src/forms/word-fields.ts';
import { buildNotification } from '../src/forms/email.ts';
import { fieldAtPath } from '../src/fields.ts';

const forms = checkForms(
	{
		contact: {
			label: 'Contact',
			email: { subject: 'New enquiry' },
			fields: {
				name: { label: 'Your name', autocomplete: 'name' },
				email: { label: 'Email', type: 'email', error: 'Check that address.' },
				phone: { label: 'Phone', type: 'tel', optional: true },
				kind: { label: 'What’s it for?', type: 'select', options: [{ value: 'web', label: 'A website' }, { value: '1', label: 'One' }, { value: 'v1.5', label: 'Version 1.5' }] },
				message: { label: 'Message', type: 'textarea' },
			},
		} satisfies FormConfig,
	},
	(m) => {
		throw new Error(m);
	},
);
const contact = forms.contact!;

describe('where a word comes from (Decision 10)', () => {
	test('with nothing set, every word is 0.10.0’s (Acceptance 18)', () => {
		const w = resolveFormWords(contact, storedWordsOf(undefined, 'contact'));
		assert.equal(w.fields.name!.label.value, 'Your name');
		assert.equal(w.fields.name!.placeholder!.value, '');
		assert.equal(w.fields.name!.error.value, 'Please fill this in.');
		assert.equal(w.fields.email!.error.value, 'Check that address.');
		assert.equal(w.fields.phone!.optional!.value, '(optional)');
		assert.equal(w.fields.name!.optional, null);
		// Form rows Decision 15: a select's placeholder is its blank first choice, the form's "Choose…" when nothing sets it.
		assert.deepEqual(w.fields.kind!.placeholder, { value: 'Choose…', field: 'formWords.contact.fields.kind.placeholder' });
		assert.equal(w.submit.value, 'Send');
		assert.equal(w.sending.value, 'Sending…');
		assert.equal(w.sent.heading.value, '');
		assert.equal(w.sent.line.value, PACKAGE_WORDS.thanks);
		assert.equal(w.failed.value, 'Something went wrong. Please email us directly.');
		assert.equal(w.choose.value, 'Choose…');
	});

	test('the code’s words come over the package’s; the config’s own error still wins over the code’s by type', () => {
		const w = resolveFormWords(contact, {}, { submit: 'Send it', thanks: 'Ta.', sentHeading: 'Sent', errors: { email: 'Bad email.', text: 'Fill it.' }, labelPlaceholders: true, optional: '(if you like)' });
		assert.equal(w.submit.value, 'Send it');
		assert.equal(w.sent.line.value, 'Ta.');
		assert.equal(w.sent.heading.value, 'Sent');
		assert.equal(w.fields.email!.error.value, 'Check that address.');
		assert.equal(w.fields.name!.error.value, 'Fill it.');
		assert.equal(w.fields.name!.placeholder!.value, 'Your name');
		assert.equal(w.fields.phone!.optional!.value, '(if you like)');
	});

	test('Site Settings wins over both, and a blank word is unset', () => {
		const stored = storedWordsOf(
			{ contact: { fields: { name: { label: ' Name ', placeholder: '' }, kind: { options: { web: 'Websites', '1': 'Just one' } } }, submit: 'Go', sent: { heading: 'Got it' } } },
			'contact',
		);
		const w = resolveFormWords(contact, stored, { submit: 'Send it', labelPlaceholders: true, sentHeading: 'Sent' });
		assert.equal(w.fields.name!.label.value, 'Name');
		assert.equal(w.fields.name!.placeholder!.value, 'Name', 'labelPlaceholders reads the resolved label');
		assert.equal(w.fields.kind!.options.web!.value, 'Websites');
		assert.equal(w.fields.kind!.options['1']!.value, 'Just one');
		assert.equal(w.submit.value, 'Go');
		assert.equal(w.sent.heading.value, 'Got it');
	});
});

describe('the fields that hold them (Decisions 9a and 13)', () => {
	test('every word names its Site Settings path; an option value with a dot keeps its config label and has none', () => {
		const w = resolveFormWords(contact, {});
		assert.equal(w.fields.name!.label.field, 'formWords.contact.fields.name.label');
		assert.equal(w.fields.kind!.options.web!.field, 'formWords.contact.fields.kind.options.web');
		assert.deepEqual(w.fields.kind!.options['v1.5'], { value: 'Version 1.5', field: null });
		assert.equal(w.sent.heading.field, 'formWords.contact.sent.heading');
		assert.equal(w.choose.field, 'formWords.contact.choose');
	});

	test('the generated group has a text field at every path a word names', () => {
		const group = formWordFields(forms)!;
		const fields = { formWords: group };
		const w = resolveFormWords(contact, {});
		const paths = [w.submit, w.sending, w.sent.heading, w.sent.line, w.failed, w.choose, ...Object.values(w.fields).flatMap((f) => [f.label, f.placeholder, f.help, f.error, f.optional, ...Object.values(f.options)])]
			.filter((x) => x && x.field)
			.map((x) => x!.field!);
		for (const path of paths) {
			const found = fieldAtPath(fields, path);
			assert.ok(found && found.rest.length === 0 && found.field.kind === 'text', path);
		}
		assert.ok(fieldAtPath(fields, 'formWords.contact.fields.kind.placeholder'), 'a select has its blank first choice (form rows Decision 15)');
		assert.equal(fieldAtPath(fields, 'formWords.contact.fields.name.optional'), undefined, 'a required field has no "(optional)"');
		assert.equal(formWordFields({}), null);
	});

	test('a form with no select has no "Choose…" field, and its choose word names none', () => {
		const plain = checkForms({ note: { label: 'Note', email: { subject: 'A note' }, fields: { name: { label: 'Your name' }, email: { label: 'Email', type: 'email' } } } satisfies FormConfig }, (m) => {
			throw new Error(m);
		});
		const w = resolveFormWords(plain.note!, {});
		assert.deepEqual(w.choose, { value: PACKAGE_WORDS.choose, field: null });
		assert.equal(fieldAtPath({ formWords: formWordFields(plain)! }, 'formWords.note.choose'), undefined, 'the generated group has none');
	});
});

describe('the form the endpoint, the email and the inbox read (Decision 11)', () => {
	const stored = storedWordsOf({ contact: { fields: { name: { label: 'Name' }, kind: { options: { web: 'Websites' } } } } }, 'contact');
	const form = formWithWords(contact, stored);

	test('labels and option labels from Site Settings, the rest as configured', () => {
		assert.equal(form.fields[0]!.label, 'Name');
		assert.equal(form.fields[1]!.label, 'Email');
		assert.deepEqual(form.fields[3]!.options!.map((o) => o.label), ['Websites', 'One', 'Version 1.5']);
		assert.deepEqual(formWithWords(contact, {}), contact);
	});

	test('the email’s line uses Site Settings’ label (Acceptance 17)', () => {
		const mail = buildNotification({
			submission: { id: 's1', form: 'contact', fields: { name: 'Aoife', email: 'a@example.com', phone: '', kind: 'web', message: 'Hello' }, files: [], at: '2026-11-01T10:00:00Z' } as never,
			form,
			brandName: 'CaraCMS',
			siteUrl: 'https://example.com',
			timeZone: 'Europe/Dublin',
		});
		assert.match(mail.text, /^Name: Aoife$/m);
		assert.match(mail.text, /^What’s it for\?: Websites$/m);
		assert.doesNotMatch(mail.text, /Your name/);
	});
});
