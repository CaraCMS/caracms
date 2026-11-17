import { list, select, toggle, type BlockData, type FieldsCollectionConfig } from 'caracms/config';

/**
 * Workshops (form rows and sourced selects; the fixture's copy of the starter's): a pageless list-of-fields collection the
 * Riso workshop form's Bookings rows pick from. Only the ones open for booking are offered; a
 * booking's Session follows the workshop's Sessions (both, when it names none). In a hand order,
 * which is the order the form lists them in.
 */
export const workshops = {
	kind: 'fields',
	folder: 'content/workshops',
	order: 'manual',
	component: 'src/collections/Workshop.astro',
	fields: {
		open: toggle({ label: 'Open for booking', help: 'Off: the booking form stops offering it. Bookings already made still name it.' }),
		sessions: list(select({ options: [{ value: 'morning', label: 'Morning' }, { value: 'afternoon', label: 'Afternoon' }] }), {
			label: 'Sessions',
			itemNoun: 'session',
			help: 'The sessions it runs. None: a booking can pick either.',
		}),
	},
} satisfies FieldsCollectionConfig;

export type WorkshopData = BlockData<typeof workshops.fields>;
