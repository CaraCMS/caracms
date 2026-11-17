/**
 * Form rows and sourced selects: the rows config's content, kept apart from `demo-content` (whose
 * base config would read a `workshops` folder as stray files). A copy run on
 * `caracms.rows.config.ts` gets the three workshops and their hand order.
 */
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rowsContent = fileURLToPath(new URL('../fixtures/rows-content', import.meta.url));

/** Add the workshops (Riso basics: open, mornings; Two-colour posters: open, no sessions; Zine binding: closed) to a copy's `content/`. */
export function addRowsContent(root: string): void {
	cpSync(join(rowsContent, 'workshops'), join(root, 'content/workshops'), { recursive: true });
	const file = join(root, 'content/site-settings.json');
	const settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	settings.collectionOrder = { ...((settings.collectionOrder as object | undefined) ?? {}), workshops: ['riso-basics', 'two-colour-posters', 'zine-binding'] };
	writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}
