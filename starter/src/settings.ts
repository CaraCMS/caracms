import { group, link, list, select, text } from 'caracms/config';

/**
 * The starter's own Site Settings fields (M7 Decision 16): the details more than one piece
 * shows, the contact details and social links, which the footer draws
 * (src/components/SiteFooter.astro) and marks as Site Settings' (edit in context, Decision 4).
 * They're the site's, not the package's (Spec → The package/site boundary), so
 * caracms.config.ts passes them as `settings: { fields }`, and the editor shows them under
 * "The site". The menu and the footer's link columns moved to the header's and the footer's
 * shared blocks (edit in context, Decision 16: src/blocks/site-header.ts, site-footer.ts).
 *
 * Like the rest of the page shell, a change shows on the public site once it's published
 * (Spec → Settings that act on the running site); the preview shows the draft.
 */

/** The social networks the footer knows, as stored (the value) and as shown (the label). */
export const NETWORKS = [
	{ value: 'instagram', label: 'Instagram' },
	{ value: 'facebook', label: 'Facebook' },
	{ value: 'linkedin', label: 'LinkedIn' },
	{ value: 'x', label: 'X' },
	{ value: 'youtube', label: 'YouTube' },
	{ value: 'tiktok', label: 'TikTok' },
] as const;

export const siteSettings = {
	contact: group(
		{
			email: text({ label: 'Email' }),
			phone: text({ label: 'Phone' }),
			address: text({ label: 'Postal address', multiline: true }),
		},
		{ label: 'Contact details', help: 'In the footer. Blank ones are left out.' },
	),
	socials: list(
		{
			network: select({ label: 'Network', options: NETWORKS }),
			href: link({ label: 'Address', addressOnly: true }),
		},
		{ label: 'Social links', itemLabel: 'network', help: 'In the footer.' },
	),
};
