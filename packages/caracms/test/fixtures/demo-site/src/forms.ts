import type { FormConfig } from 'caracms/config';

/**
 * The demo's forms (M6 Decision 4): what a visitor can send the studio. A form's id
 * (the key) is stored on every submission and keys its recipients in Site Settings, so
 * it's never renamed once live. The Form block (src/blocks/form.ts) picks one of them.
 */
export const forms = {
	contact: {
		label: 'Contact',
		email: { subject: 'New contact enquiry' },
		fields: {
			name: { label: 'Your name', autocomplete: 'name' },
			email: { label: 'Email', type: 'email', autocomplete: 'email' },
			phone: { label: 'Phone', type: 'tel', optional: true, autocomplete: 'tel' },
			kind: {
				label: 'What’s it for?',
				type: 'select',
				options: [
					{ value: 'identity', label: 'An identity' },
					{ value: 'website', label: 'A website' },
					{ value: 'print', label: 'Print' },
					{ value: 'other', label: 'Something else' },
				],
			},
			message: { label: 'Tell us about it', type: 'textarea' },
			files: { label: 'Anything to show us?', type: 'files', optional: true, help: 'PDF, JPEG, PNG or Word. Up to 5 files, 25 MB in all.' },
		},
	},
	workshop: {
		label: 'Riso workshop',
		email: { subject: 'Workshop booking' },
		fields: {
			given: { label: 'First name', autocomplete: 'given-name' },
			family: { label: 'Last name', autocomplete: 'family-name' },
			email: { label: 'Email', type: 'email', autocomplete: 'email' },
			date: {
				label: 'Which Saturday?',
				type: 'select',
				options: [
					{ value: '2026-11-08', label: '8 November' },
					{ value: '2026-11-22', label: '22 November' },
					{ value: '2026-12-06', label: '6 December' },
				],
			},
			places: { label: 'Places', type: 'select', options: ['1', '2', '3', '4'].map((n) => ({ value: n, label: n })) },
			notes: { label: 'Anything we should know?', type: 'textarea', optional: true },
		},
	},
} satisfies Record<string, FormConfig>;
