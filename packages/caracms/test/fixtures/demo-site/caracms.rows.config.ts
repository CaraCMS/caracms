import { defineSite, select, type FormConfig } from 'caracms/config';
import base from './caracms.config.ts';
import { workshops } from './src/collections/workshops.ts';
import { formBlock } from './src/blocks/form.ts';
import { forms } from './src/forms.ts';

/**
 * Form rows and sourced selects: the fixture site with the starter's pageless `workshops`
 * collection and a `booking` form whose Bookings rows pick from it (a sourced select narrowing
 * a Session column), for the package's tests of rows and sourced selects end to end. A copy
 * built by `rowsSite()` (test/helpers/site-render.ts), or a dev site given `useRowsConfig`
 * (test/helpers/dev-site.ts), uses it; the fixture's own config stays as it was (its workshop
 * form's submissions feed the m6 inbox's visual states).
 */
export const booking = {
	label: 'Booking',
	email: { subject: 'New booking' },
	fields: {
		name: { label: 'Your name', autocomplete: 'name' },
		email: { label: 'Email', type: 'email', autocomplete: 'email' },
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
} satisfies FormConfig;

const all = { ...forms, booking };

export default defineSite({
	...base,
	collections: { ...base.collections, workshops },
	// The Form block can pick the booking form too.
	blocks: { ...base.blocks, form: { ...formBlock, fields: { ...formBlock.fields, form: select({ label: 'Form', options: Object.entries(all).map(([value, form]) => ({ value, label: form.label })) }) } } },
	forms: all,
});
