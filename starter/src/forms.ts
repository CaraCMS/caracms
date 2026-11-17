import type { FormConfig } from 'caracms/config';

/**
 * The starter's forms (M6 Decision 4): what a visitor can send the site. A form's id
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
					{ value: 'identity', label: 'Setting up a site' },
					{ value: 'website', label: 'Editing a site' },
					{ value: 'print', label: 'Hosting' },
					{ value: 'other', label: 'Something else' },
				],
			},
			message: { label: 'Tell us about it', type: 'textarea' },
			files: { label: 'Anything to show us?', type: 'files', optional: true, help: 'PDF, JPEG, PNG or Word. Up to 5 files, 25 MB in all.' },
		},
	},
	workshop: {
		label: 'Workshop booking',
		email: { subject: 'Workshop booking' },
		fields: {
			given: { label: 'First name', autocomplete: 'given-name' },
			family: { label: 'Last name', autocomplete: 'family-name' },
			email: { label: 'Email', type: 'email', autocomplete: 'email' },
			// Form rows and sourced selects (the Exit): a booking's rows, each a workshop open for booking (from the
			// workshops collection), how many places, and a session the workshop runs (either, when it names none).
			bookings: {
				label: 'Bookings',
				type: 'rows',
				rowLabel: 'Booking',
				max: 4,
				columns: {
					workshop: { label: 'Workshop', type: 'select', source: { collection: 'workshops', where: 'open' } },
					places: { label: 'Places', type: 'number', placeholder: 'e.g. 2' },
					session: {
						label: 'Session',
						type: 'select',
						options: [
							{ value: 'morning', label: 'Morning' },
							{ value: 'afternoon', label: 'Afternoon' },
						],
						from: { column: 'workshop', field: 'sessions' },
					},
				},
			},
			notes: { label: 'Anything we should know?', type: 'textarea', optional: true },
		},
	},
} satisfies Record<string, FormConfig>;
