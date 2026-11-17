import { media, text } from 'caracms/config';

/**
 * The journal's page fields (edit in context, Decision 10a): a post's kicker, photo and photo
 * credit, which the page component (src/components/Page.astro) draws above its blocks and marks
 * with the page's own context (Acceptance 18a, 18b).
 */
export const journalFields = {
	kicker: text({ label: 'Kicker' }),
	photo: media({ only: 'image', label: 'Photo' }),
	credit: text({ label: 'Photo credit' }),
};
