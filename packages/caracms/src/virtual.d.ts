// Types for the integration's virtual modules (see index.ts). A site gets these
// through `.astro/types.d.ts` (the integration's injectTypes).

declare module 'virtual:caracms/config' {
	export const site: import('./config.ts').ResolvedSite;
}

declare module 'virtual:caracms/public' {
	/** M6: the site's address, Turnstile's site key and the build's kind, as the integration read them at build. */
	export const build: import('./index.ts').PublicBuild;
}

declare module 'virtual:caracms/blocks' {
	/** Block type → its Astro component. */
	export const blocks: Record<string, (props: import('./document.ts').BlockProps<any>) => any>;
}

declare module 'virtual:caracms/page' {
	/** The site's page component. */
	export const Page: (props: import('./document.ts').PageProps) => any;
}

declare module 'virtual:caracms/collections' {
	/** A list-of-fields collection's name → its Astro component (M5a Decision 7). */
	export const components: Record<string, (props: import('./document.ts').FieldsDocumentProps<any>) => any>;
}

declare module 'virtual:caracms/lockup.css' {}

/** Astro's own: the scripts framework integrations inject before an island hydrates (routes/admin.astro loads it first). */
declare module 'astro:scripts/before-hydration.js' {}
