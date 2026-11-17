/**
 * A throwaway copy of the pinned demo site (code and content) for the M8 commands, in
 * test/.tmp/ (ignored), with `node_modules/caracms` linked to this package as an
 * installed site has it. `astro` (and its Vite) resolve from this package's own
 * dependencies, as in dev-site.ts. `run` runs `bin/caracms.mjs` in the copy, as
 * `caracms …` would from the site's root, on the Node running the tests.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoContent, demoSite, packageRoot } from './dev-site.ts';

export const bin = fileURLToPath(new URL('../../bin/caracms.mjs', import.meta.url));

export interface CliSite {
	root: string;
	read(file: string): string;
	write(file: string, text: string): void;
	run(...args: string[]): { code: number | null; stdout: string; stderr: string };
	cleanup(): void;
}

export function makeCliSite(name: string): CliSite {
	const tmp = join(packageRoot, 'test/.tmp');
	mkdirSync(tmp, { recursive: true });
	const root = mkdtempSync(join(tmp, `${name}-`));
	for (const part of ['src', 'public', 'schemas', 'caracms.config.ts', 'tsconfig.json']) cpSync(join(demoSite, part), join(root, part), { recursive: true });
	cpSync(demoContent, join(root, 'content'), { recursive: true });
	mkdirSync(join(root, 'node_modules'));
	symlinkSync(packageRoot, join(root, 'node_modules/caracms'));
	writeFileSync(join(root, 'package.json'), '{\n  "name": "cli-site",\n  "private": true,\n  "type": "module"\n}\n');
	return {
		root,
		read: (file) => readFileSync(join(root, file), 'utf8'),
		write: (file, text) => {
			mkdirSync(join(root, file, '..'), { recursive: true });
			writeFileSync(join(root, file), text);
		},
		run: (...args) => {
			const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
			return { code: r.status, stdout: r.stdout, stderr: r.stderr };
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
