/**
 * `pnpm --filter caracms-starter restyle-proof` (M7 Decision 9, Contracts → The restyle
 * proof): the starter restyled with a second look, for a person to look at.
 *
 * Copies the starter (its code and its live content) to test/.tmp/restyle-proof, swaps in
 * the second look's files (under test/fixtures/, at the same paths: test/helpers/look.ts),
 * builds the copy, prints `git diff --no-index --stat` between the starter's and the copy's
 * src/ and public/ (it lists only the look's files), and serves the build on
 * http://localhost:4331 until stopped. The starter's own .env is read into the build's
 * environment, as `pnpm build` reads it, so the demo's images show; it's never copied.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swapLook } from '../test/helpers/look.ts';

const PORT = 4331;
const starter = fileURLToPath(new URL('..', import.meta.url));
const copy = join(starter, 'test/.tmp/restyle-proof');

rmSync(copy, { recursive: true, force: true });
mkdirSync(copy, { recursive: true });
for (const part of ['src', 'public', 'content', 'astro.config.mjs', 'caracms.config.ts', 'tsconfig.json', 'package.json']) {
	cpSync(join(starter, part), join(copy, part), { recursive: true });
}
swapLook(copy);

const env = { ...process.env };
if (existsSync(join(starter, '.env'))) process.loadEnvFile(join(starter, '.env'));
Object.assign(env, process.env);

console.log('Building the starter with the second look…');
const build = spawnSync(join(starter, 'node_modules/.bin/astro'), ['build', '--root', copy], { env, stdio: ['ignore', 'ignore', 'inherit'] });
if (build.status !== 0) process.exit(build.status ?? 1);

const rel = relative(starter, copy);
console.log('\nWhat differs from the starter (only the look’s files: src/styles/, src/fonts/, public/favicon.*):\n');
for (const part of ['src', 'public']) {
	spawnSync('git', ['diff', '--no-index', '--stat=120', part, `${rel}/${part}`], { cwd: starter, stdio: 'inherit' });
}

console.log(`\nServing the restyled build on http://localhost:${PORT} (Ctrl-C stops it).`);
const server = spawn(process.execPath, [join(copy, 'dist/server/entry.mjs')], { env: { ...env, HOST: '127.0.0.1', PORT: String(PORT) }, stdio: 'inherit' });
const stop = () => server.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
