// M6 Decision 4 (Acceptance 1–2): the forms config's checks, and the names M6 reserves.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CaracmsConfigError, resolveSite, SETTINGS_KEYS, text, type FormConfig } from '../src/config.ts';
import { formsAcceptFiles, senderName, submissionSnippet } from '../src/forms/rules.ts';
import { config, siteRoot, variant } from './helpers/site.ts';

const contact = (fields: FormConfig['fields']): FormConfig => ({ label: 'Contact', email: { subject: 'New contact enquiry' }, fields });
const ok = {
	name: { label: 'Name', autocomplete: 'name' },
	email: { label: 'Email', type: 'email' },
	message: { label: 'Message', type: 'textarea' },
} as const satisfies FormConfig['fields'];

const refused = (forms: Record<string, FormConfig>, pattern: RegExp) =>
	assert.throws(() => resolveSite(variant({ forms }), siteRoot), (e: Error) => e instanceof CaracmsConfigError && pattern.test(e.message), `expected ${pattern}`);

describe('the forms config (Decision 4)', () => {
	test('a good form resolves: fields in order, each with its type, required unless optional', () => {
		const site = resolveSite(variant({ forms: { contact: contact({ ...ok, phone: { label: 'Phone', type: 'tel', optional: true } }) } }), siteRoot);
		const form = site.forms.contact!;
		assert.deepEqual(form.fields.map((f) => [f.name, f.type, f.optional]), [
			['name', 'text', false],
			['email', 'email', false],
			['message', 'textarea', false],
			['phone', 'tel', true],
		]);
		assert.equal(form.label, 'Contact');
		assert.equal(form.email.subject, 'New contact enquiry');
		assert.deepEqual(JSON.parse(JSON.stringify(site.forms)), site.forms, 'plain JSON, for the virtual module');
		assert.deepEqual(resolveSite(config, siteRoot).forms, {}, 'no forms: {}');
	});

	test('Acceptance 1: no email field', () => refused({ contact: contact({ name: { label: 'Name' } }) }, /form "contact" needs a field named "email"/));
	test('Acceptance 1: an email field that is not type email', () => refused({ contact: contact({ email: { label: 'Email' } }) }, /form "contact", field "email": its type must be 'email'/));
	test('Acceptance 1: two files fields', () =>
		refused({ contact: contact({ ...ok, plans: { label: 'Plans', type: 'files' }, photos: { label: 'Photos', type: 'files' } }) }, /form "contact", field "photos": a form has at most one files field \("plans"/));
	for (const name of ['fax', 'form', 'return', 'cf-turnstile-response']) {
		test(`Acceptance 1: a field named ${name}`, () => refused({ contact: contact({ ...ok, [name]: { label: 'X' } }) }, new RegExp(`form "contact", field "${name}": "${name}" is taken`)));
	}
	test('Acceptance 1: a duplicate field name (two spellings of one name)', () => refused({ contact: contact({ ...ok, Message: { label: 'Again' } }) }, /form "contact", field "Message" is listed twice/));
	test('Acceptance 1: a select without options', () => refused({ contact: contact({ ...ok, topic: { label: 'Topic', type: 'select' } }) }, /form "contact", field "topic": a select needs options/));
	test('Acceptance 1: options on a field that is not a select', () =>
		refused({ contact: contact({ ...ok, topic: { label: 'Topic', options: [{ value: 'a', label: 'A' }] } }) }, /form "contact", field "topic": only a select takes options/));
	test('an unknown type, a bad id, a missing label or subject', () => {
		refused({ contact: contact({ ...ok, when: { label: 'When', type: 'date' as never } }) }, /field "when": type must be one of/);
		refused({ Contact: contact(ok) }, /form "Contact": its id must be lowercase/);
		refused({ contact: { ...contact(ok), label: '' } }, /form "contact" needs a label/);
		refused({ contact: { ...contact(ok), email: { subject: ' ' } } }, /form "contact" needs email.subject/);
	});

	test('G6: placeholder and prefix are trimmed, blank means absent, and carried onto the resolved field', () => {
		const site = resolveSite(
			variant({
				forms: {
					contact: contact({
						name: { label: 'Name', placeholder: '  Your name ', prefix: ' ' },
						email: { label: 'Email', type: 'email', placeholder: 'name@example.com' },
						message: { label: 'Message', type: 'textarea', placeholder: '' },
						price: { label: 'Budget', prefix: ' $ ', placeholder: '5000' },
						phone: { label: 'Phone', type: 'tel', prefix: '+353' },
						topic: { label: 'Topic', type: 'select', options: [{ value: 'a', label: 'A' }], placeholder: '  ' },
					}),
				},
			}),
			siteRoot,
		);
		const by = Object.fromEntries(site.forms.contact!.fields.map((f) => [f.name, f]));
		assert.equal(by.name!.placeholder, 'Your name');
		assert.equal('prefix' in by.name!, false, 'a blank prefix is absent');
		assert.equal(by.email!.placeholder, 'name@example.com');
		assert.equal('placeholder' in by.message!, false, 'an empty placeholder is absent');
		assert.equal(by.price!.prefix, '$');
		assert.equal(by.price!.placeholder, '5000');
		assert.equal(by.phone!.prefix, '+353');
		assert.equal('placeholder' in by.topic!, false, 'a blank placeholder on a select is just absent');
	});
	test('G6: a placeholder on a files field is refused (form rows Decision 15: a select takes one, its blank first choice)', () => {
		const site = resolveSite(variant({ forms: { contact: contact({ ...ok, topic: { label: 'Topic', type: 'select', options: [{ value: 'a', label: 'A' }], placeholder: ' Pick one ' } }) } }), siteRoot);
		assert.equal(site.forms.contact!.fields.find((f) => f.name === 'topic')!.placeholder, 'Pick one');
		refused({ contact: contact({ ...ok, plans: { label: 'Plans', type: 'files', placeholder: 'Drop here' } }) }, /form "contact", field "plans": a files field has no box to type in/);
	});
	test('G6: a prefix on anything but text or tel is refused', () => {
		for (const type of ['email', 'textarea', 'files'] as const) {
			refused({ contact: contact({ ...ok, extra: { label: 'Extra', type, optional: true, prefix: '$' } }) }, new RegExp(`form "contact", field "extra": only a text or tel field takes a prefix \\(this one is ${type}\\)`));
		}
		refused({ contact: contact({ ...ok, topic: { label: 'Topic', type: 'select', options: [{ value: 'a', label: 'A' }], prefix: '$' } }) }, /field "topic": only a text or tel field takes a prefix \(this one is select\)/);
	});
	test('M9: rows on a textarea, a whole number from 1 to 50, carried onto the resolved field', () => {
		refused({ contact: contact({ ...ok, extra: { label: 'Extra', optional: true, rows: 4 } }) }, /form "contact", field "extra": only a textarea takes rows \(this one is text\)/);
		for (const rows of [0, 2.5, 51, '4']) {
			refused({ contact: contact({ ...ok, notes: { label: 'Notes', type: 'textarea', optional: true, rows: rows as never } }) }, /form "contact", field "notes": rows must be a whole number from 1 to 50/);
		}
		const site = resolveSite(variant({ forms: { contact: contact({ ...ok, notes: { label: 'Notes', type: 'textarea', optional: true, rows: 3 } }) } }), siteRoot);
		const by = Object.fromEntries(site.forms.contact!.fields.map((f) => [f.name, f]));
		assert.equal(by.notes!.rows, 3);
		assert.equal('rows' in by.email!, false, 'left out, no rows');
	});
	test('G6: placeholder and prefix must be text', () => {
		refused({ contact: contact({ ...ok, price: { label: 'Price', prefix: 5 as never } }) }, /field "price": prefix must be text/);
		refused({ contact: contact({ ...ok, price: { label: 'Price', placeholder: true as never } }) }, /field "price": placeholder must be text/);
	});

	test('Acceptance 2: "seo" as a collection field, and M6\'s Site Settings keys in settings.fields, are refused', () => {
		const cases = { kind: 'fields', folder: 'content/case-studies', urlBase: '/work', component: 'Block.astro', fields: { seo: text() } } as const;
		assert.throws(() => resolveSite(variant({ collections: { x: cases } }), siteRoot), /"seo" is every page's own search and sharing settings/);
		for (const key of ['seo', 'googleTag', 'formRecipients']) {
			assert.ok((SETTINGS_KEYS as readonly string[]).includes(key));
			assert.throws(() => resolveSite(variant({ settings: { fields: { [key]: text() } } }), siteRoot), new RegExp(`settings: "${key}" is one of Site Settings' own keys`));
		}
	});

	test('a collection called "submissions" is refused (its address is the inbox)', () => {
		assert.throws(() => resolveSite(variant({ collections: { ...config.collections, submissions: { kind: 'sections', folder: 'content/subs', urlBase: '/subs/' } } }), siteRoot), /\/admin\/submissions is the editor's inbox/);
	});
});

describe('what the inbox works out from a form', () => {
	const site = resolveSite(variant({ forms: { contact: contact(ok), quote: contact({ first: { label: 'First', autocomplete: 'given-name' }, last: { label: 'Last', autocomplete: 'family-name' }, email: { label: 'Email', type: 'email' }, plans: { label: 'Plans', type: 'files', optional: true } }) } }), siteRoot);
	test('the sender: a name field, else given and family names, else the address', () => {
		assert.equal(senderName(site.forms.contact!, { name: ' Aoife ', email: 'a@b.test' }), 'Aoife');
		assert.equal(senderName(site.forms.quote!, { first: 'Aoife', last: 'B.', email: 'a@b.test' }), 'Aoife B.');
		assert.equal(senderName(site.forms.contact!, { name: '', email: 'a@b.test' }), 'a@b.test');
		assert.equal(senderName(null, { name: 'X', email: 'a@b.test' }), 'a@b.test', 'a form no longer in the config: the address');
	});
	test('the snippet: the first textarea, on one line', () => {
		assert.equal(submissionSnippet(site.forms.contact!, { message: 'Hello\n\nthere' }), 'Hello there');
		assert.equal(submissionSnippet(site.forms.quote!, { message: 'x' }), '');
	});
	test('formsAcceptFiles: only when some form has a files field', () => {
		assert.equal(formsAcceptFiles({ contact: site.forms.contact! }), false);
		assert.equal(formsAcceptFiles(site.forms), true);
	});
});
