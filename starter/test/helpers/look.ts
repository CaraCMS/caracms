/**
 * The look's files (M7 Decision 6) and the restyle proof's swap (Decision 9, Contracts →
 * The restyle proof): `src/styles/`, `src/fonts/` and `public/favicon.*` are the look,
 * and nothing else. The second look's are in test/fixtures/second-look/, at the same paths.
 * Shared by the look test and `pnpm restyle-proof` (scripts/restyle-proof.ts).
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const starter = fileURLToPath(new URL('../..', import.meta.url));

export const secondLook = join(starter, 'test/fixtures/second-look');

/** A path (relative, `/`-separated) that belongs to the look. */
export const isLookFile = (path: string) => path.startsWith('src/styles/') || path.startsWith('src/fonts/') || /^public\/favicon\.[^/]+$/.test(path);

/** Replace the look in a copy of the starter with `look`'s files: the two folders whole, and the tab icons. */
export function swapLook(root: string, look = secondLook): void {
	for (const folder of ['src/styles', 'src/fonts']) rmSync(join(root, folder), { recursive: true, force: true });
	for (const name of readdirSync(join(root, 'public'))) if (isLookFile(`public/${name}`)) rmSync(join(root, 'public', name));
	cpSync(join(look, 'src'), join(root, 'src'), { recursive: true });
	cpSync(join(look, 'public'), join(root, 'public'), { recursive: true });
}

function files(dir: string, prefix: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		const rel = `${prefix}/${name}`;
		return statSync(path).isDirectory() ? files(path, rel) : [rel];
	});
}

/** The files under `src/` and `public/` that differ between two copies: added, removed or changed. */
export function changedFiles(a: string, b: string): string[] {
	const all = new Set(['src', 'public'].flatMap((part) => [...files(join(a, part), part), ...files(join(b, part), part)]));
	return [...all]
		.filter((rel) => {
			const [x, y] = [join(a, rel), join(b, rel)];
			return !existsSync(x) || !existsSync(y) || !readFileSync(x).equals(readFileSync(y));
		})
		.sort();
}
