#!/usr/bin/env node
// The `caracms` command (M8 → Contracts): `init`, `schemas`, `validate`, `media import`, `media push`
// and `start`, each run from the site's root. Exit codes: 0 fine, 1 problems found or
// refused, 2 bad usage.
//
// Plain JavaScript importing only Node built-ins, so it runs on Node 22.12 with no flags.
// `schemas` and `validate` need the site's caracms.config.ts, which is TypeScript: they
// load the package's src/cli/*.ts through the site's own Vite (site-runner.mjs).
//
// `caracms start`: the site's production server (M6 Decision 2).
//
// The Node adapter's standalone server sends prerendered pages and static files
// before Astro's middleware runs, so a password or a `noindex` header can't be added
// there. This serves the adapter's own handler (static files, then Astro) behind the
// gate (gate.mjs): robots.txt, the pre-launch password, `X-Robots-Tag`, a page beside a
// folder of the same name, then Site Settings' redirects.
//
// It runs from the site's root (the directory with `dist/` and `content/`) and reads,
// once at start:
//   PORT (default 8080), HOST (default 0.0.0.0), the site's address (Astro's `site` from
//   dist/server/caracms-build.json, else SITE_URL, else RAILWAY_PUBLIC_DOMAIN),
//   CARACMS_PRELAUNCH (`user:password`), CARACMS_CLIENT_IP_HEADER (else the detected
//   host's default; with neither, it exits with the fix), and content/site-settings.json →
//   brand.name and redirects.

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGate, describeClientIpSource, markProcessGated, parsePrelaunch, parseSiteUrl, publicAddress, readBuildInfo, readClientIpSource, readRedirects } from './gate.mjs';

const USAGE = `Usage: caracms <command>, from the site's root

  init [--write] [--railway] [--cloud | --self-hosted]
                              Add caracms to an existing Astro site, and say where it runs (CaraCMS
                              Cloud or self-hosted). Shows the change; --write applies it.
  schemas                     Write schemas/ from caracms.config.ts, and add $schema to content files.
  validate [--fix] [--json]   Check content against caracms.config.ts. --fix runs \`schemas\` first,
                              then lays content files out as the editor saves them;
                              --json prints { errors, warnings }.
  audit [--json]              Render every page in the site's Vite and say what can't be edited from
                              the page. Warnings only (exit 0); --json prints { findings }.
  media import <files…>       Put local images into the site's media bucket (or its CaraCMS Cloud
                              folder, with CARACMS_CLOUD_KEY); prints JSON.
  media push                  Copy the site's own bucket's uploads/ into its CaraCMS Cloud folder,
                              keeping every key (S3_* and CARACMS_CLOUD_KEY); keys not of the
                              upload shape are left, not failed; prints JSON.
  start                       Serve the built site (dist/server/entry.mjs).
`;

/** The command running, for `fatal`'s sentence: set by `main`. */
let running = '';

const fatal = (message) => {
	console.error(`caracms${running ? ` ${running}` : ''}: ${message}`);
	process.exit(1);
};

function readBrandName(root) {
	try {
		const settings = JSON.parse(readFileSync(join(root, 'content/site-settings.json'), 'utf8'));
		const name = settings?.brand?.name;
		return typeof name === 'string' ? name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The adapter's static files folder, as it finds it (@astrojs/node → resolveClientDir):
 * the built server-to-client path from its options, applied to `dist/server` here.
 * `dist/client` when the options don't say.
 */
function clientDirOf(options, root) {
	const serverDir = join(root, 'dist/server');
	try {
		return resolve(serverDir, relative(fileURLToPath(new URL(options.server)), fileURLToPath(new URL(options.client))));
	} catch {
		return join(root, 'dist/client');
	}
}

async function start() {
	const root = process.cwd();
	const entry = join(root, 'dist/server/entry.mjs');
	if (!existsSync(entry)) fatal(`there's no ${entry}. Run \`astro build\` in the site's root first.`);

	const portText = process.env.PORT ?? '';
	const port = portText === '' ? 8080 : Number(portText);
	if (!Number.isInteger(port) || port < 0 || port > 65535) fatal(`PORT must be a port number, not "${portText}".`);
	const host = process.env.HOST || '0.0.0.0';

	// Decision 8: the one setting that stops the public site, on purpose. Read before the site loads.
	const ipSource = readClientIpSource(process.env);
	if (ipSource.problem) fatal(ipSource.problem);

	// A built site is a production server: the submissions store and the email sender read NODE_ENV (M6 Decision 7),
	// and this command is the one thing that starts the built site. An explicit NODE_ENV is left as it is.
	process.env.NODE_ENV ??= 'production';
	// The adapter starts its own server on import unless told not to.
	process.env.ASTRO_NODE_AUTOSTART = 'disabled';
	// Decision 8: the built site runs in this process (the import below), and the only
	// server it gets is `createServer(gate)`, so every request it sees has had
	// x-caracms-client-ip replaced by the gate. The mark tells `clientIp()` so; a server
	// started any other way lacks it and answers 503, a forged header or not.
	markProcessGated();
	const built = await import(pathToFileURL(entry).href);
	if (typeof built.handler !== 'function') fatal(`${entry} exports no handler. Is the site built with @astrojs/node?`);
	if (built.options && built.options.mode !== 'standalone') fatal(`the site's Node adapter must be in standalone mode, not "${built.options.mode}".`);

	const publicSite = publicAddress(process.env, readBuildInfo(root));
	const siteUrl = publicSite?.value;
	const prelaunch = process.env.CARACMS_PRELAUNCH;
	const gate = createGate({
		handler: built.handler,
		clientIpSource: ipSource.source,
		siteUrl,
		prelaunch,
		brandName: readBrandName(root),
		clientDir: clientDirOf(built.options, root),
		redirects: readRedirects(root),
	});

	const server = createServer(gate);
	server.on('error', (err) => fatal(err.message));
	server.listen(port, host, () => {
		const address = server.address();
		const shown = typeof address === 'object' && address ? `${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}` : `${host}:${port}`;
		const site = parseSiteUrl(siteUrl);
		const indexing = site?.indexable
			? `indexable on ${site.host} only (${publicSite.from})`
			: `never indexable (${!publicSite ? 'no address: SITE_URL is unset' : !site ? `${publicSite.from} isn't an http(s) address` : `the address, from ${publicSite.from}, is localhost, a host's own address or a bare IP`})`;
		const password = parsePrelaunch(prelaunch) ? 'on (CARACMS_PRELAUNCH)' : 'off';
		console.log(
			`caracms start: listening on http://${shown}\n  client IP: ${describeClientIpSource(ipSource)}\n  indexing: ${indexing}\n  pre-launch password: ${password}`,
		);
	});

	const stop = () => {
		server.close(() => process.exit(0));
		server.closeIdleConnections?.();
		setTimeout(() => process.exit(0), 10_000).unref();
	};
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
}

/** Bad usage: the sentence and the usage, exit 2. */
function usage(message) {
	process.stderr.write(`caracms: ${message}\n\n${USAGE}`);
	process.exitCode = 2;
}

/** Load the package's src/cli/<name>.ts through the site's Vite and run its `command`. */
async function viaSite(name, ...args) {
	const { withPackageModule } = await import('./site-runner.mjs');
	const root = process.cwd();
	try {
		const { code, out, err } = await withPackageModule(root, name, (m) => m.command(root, ...args));
		// What went wrong first, the report and its summary line last (audit's failed renders above its count).
		if (err) process.stderr.write(err);
		if (out) process.stdout.write(out);
		process.exitCode = code;
	} catch (error) {
		// A CommandError (src/cli/site.ts) or the runner's own: one sentence, no stack.
		process.stderr.write(`caracms ${name}: ${error?.message ?? String(error)}\n`);
		process.exitCode = 1;
	}
}

/** Flags out of `args`: every one must be in `allowed`; no other arguments. */
function flags(command, args, allowed) {
	const set = new Set();
	for (const a of args) {
		if (!allowed.includes(a)) return { error: `"${a}" isn't an option of ${command}.` };
		set.add(a);
	}
	return { set };
}

async function main(argv) {
	const [command, ...rest] = argv;
	running = command === 'media' && rest[0] && !rest[0].startsWith('-') ? `media ${rest[0]}` : (command ?? '');
	switch (command) {
		case 'start':
			if (rest.length) return usage(`start takes no arguments.`);
			return start();
		case 'init': {
			const f = flags('init', rest, ['--write', '--railway', '--cloud', '--self-hosted']);
			if (f.error) return usage(f.error);
			const { run } = await import('./init.mjs');
			process.exitCode = await run({
				root: process.cwd(),
				write: f.set.has('--write'),
				railway: f.set.has('--railway'),
				cloud: f.set.has('--cloud'),
				selfHosted: f.set.has('--self-hosted'),
			});
			return;
		}
		case 'schemas':
			if (rest.length) return usage('schemas takes no arguments.');
			return viaSite('schemas');
		case 'validate': {
			const f = flags('validate', rest, ['--fix', '--json']);
			if (f.error) return usage(f.error);
			return viaSite('validate', { fix: f.set.has('--fix'), json: f.set.has('--json') });
		}
		case 'audit': {
			const f = flags('audit', rest, ['--json']);
			if (f.error) return usage(f.error);
			return viaSite('audit', { json: f.set.has('--json') });
		}
		case 'media': {
			// The media commands are their own module (bin/media.mjs): it takes the arguments after `media`.
			const { run } = await import('./media.mjs');
			process.exitCode = await run(rest);
			return;
		}
		case undefined:
			process.stdout.write(USAGE);
			process.exitCode = 2;
			return;
		case '--help':
		case '-h':
		case 'help':
			process.stdout.write(USAGE);
			return;
		default:
			return usage(`unknown command "${argv.join(' ')}".`);
	}
}

main(process.argv.slice(2)).catch((err) => fatal(err?.stack ?? String(err)));
