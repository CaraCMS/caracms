// Starlight's `docs` collection, empty: every page is a CaraCMS page. Starlight needs it defined to start.
// `.mjs`, not `.ts`: the package's type check takes in test/**/*.ts, where `astro:content` has no types.
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
