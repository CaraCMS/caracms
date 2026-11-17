import { defineSite } from 'caracms/config';
import { docsBlocks } from './src/starlight-kit/blocks/index.ts';

/**
 * caracms's config for this site: its collections and blocks. astro.config passes it to the
 * integration. The blocks are the docs kit's (src/starlight-kit/blocks/);
 * the page component draws every page inside Starlight's <StarlightPage>.
 */
export default defineSite({
	services: 'cloud',
	collections: {
		// content/pages/<path>.json is the page at /<path>; content/pages/index.json is Home.
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
	},
	blocks: docsBlocks,
	textStyles: {},
	page: 'src/starlight-kit/DocsPage.astro',
});
