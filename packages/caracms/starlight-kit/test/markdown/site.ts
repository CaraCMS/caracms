// Test helper: the site's resolved config, and a ReadEntry built from stored page JSON.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSite } from 'caracms/config';
import { parseDocument, type ReadEntry } from 'caracms/document';
import config from '../../caracms.config.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const site = resolveSite(config, ROOT);

/** A stored page as `read.document` would give it (values parsed). */
export function entryOf(raw: { title: string; seo?: { description?: string }; blocks: unknown[] }, path = 'x'): ReadEntry {
	const document = parseDocument(raw, site);
	return { collection: 'pages', path, url: `/${path}`, title: document.title, document, data: {} };
}

/** A page's blocks as the schema parses them, for comparing two pages' content. */
export const parsedBlocks = (blocks: unknown[]) => parseDocument({ title: 't', blocks }, site).blocks.map((b) => ({ type: b.type, data: b.data }));
