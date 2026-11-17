import { date, list, lockup, media, reference, richText, select, text, toggle, type BlockData, type FieldsCollectionConfig } from 'caracms/config';

/** The demo's sectors (a case study's `sector`, and the case-study list's cards). */
export const SECTORS = [
	{ value: 'food', label: 'Food and drink' },
	{ value: 'culture', label: 'Culture' },
	{ value: 'retail', label: 'Retail' },
	{ value: 'health', label: 'Health' },
	{ value: 'travel', label: 'Travel' },
	{ value: 'craft', label: 'Craft' },
] as const;

/**
 * Case studies (M5a Decision 17): a list-of-fields collection at /work/<slug>, one
 * of each new field kind. The Work page holds it (`"holds": "case-studies"` in its file,
 * collections under pages), so its documents follow that page's address. Its component renders a document's body in the page frame.
 */
export const caseStudies = {
	label: 'Case studies',
	kind: 'fields',
	folder: 'content/case-studies',
	heldBy: 'pages',
	component: 'src/collections/CaseStudy.astro',
	fields: {
		heading: lockup({ style: 'display', label: 'Heading' }),
		client: text({ label: 'Client' }),
		sector: select({ label: 'Sector', options: SECTORS }),
		featured: toggle({ label: 'Featured' }),
		launched: date({ label: 'Launched' }),
		summary: text({ multiline: true, label: 'Summary' }),
		// M5b Decision 10: across the top of the page at 16:9, and on the cards that link here at 3:2.
		cover: media({ only: 'image', label: 'Cover image' }),
		body: richText({ label: 'Story', headings: ['h2'] }),
		credits: list({ role: text({ label: 'Role' }), name: text({ label: 'Name' }) }, { label: 'Credits' }),
		related: list(reference({ to: 'case-studies', label: 'Case study' }), { label: 'Related work' }),
	},
	// The editor's table of case studies (at the collection's level): after the title.
	columns: ['client', 'sector', 'launched', 'featured'],
	// Review gaps (Decision 5a): a hand order, dragged in the editor's list; the Work page shows them in it.
	order: 'manual',
} satisfies FieldsCollectionConfig;

export type CaseStudyData = BlockData<typeof caseStudies.fields>;

/** A sector's label. */
export const sectorLabel = (value: string) => SECTORS.find((s) => s.value === value)?.label ?? '';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** `2024-05-02` → "2 May 2024" (a day, no zone: M5a Decision 2). */
export const formatDay = (iso: string | null) => {
	if (!iso) return '';
	const [y, m, d] = iso.split('-').map(Number);
	return `${d} ${MONTHS[m! - 1]} ${y}`;
};
