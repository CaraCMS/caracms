#!/usr/bin/env node
// `npm create caracms`: a blank Astro site with caracms on it. It asks what the flags didn't say, then runs
// create-astro, installs caracms and runs `caracms init`, so a new site gets exactly what an existing one does.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as p from '@clack/prompts';
import { HELP, detectPm, dirProblem, homePage, parse, runScript, steps, withStyles } from './lib.js';

const ASTRO_CONFIGS = ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js', 'astro.config.cjs', 'astro.config.cts'];

const flags = parse(process.argv.slice(2));
if (flags.help) {
	console.log(HELP);
	process.exit(0);
}
const stop = (lines) => {
	console.error(`create-caracms: ${lines.join('\n')}`);
	process.exit(1);
};
if (flags.problems.length) stop([...flags.problems, 'See --help.']);

const here = process.cwd();
if (ASTRO_CONFIGS.some((f) => existsSync(join(here, f)))) stop(['this is already an Astro site. To add caracms to it, run `npx caracms init` here.']);

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const folderProblem = (dir) => dirProblem(dir) ?? (existsSync(join(here, dir)) && readdirSync(join(here, dir)).length ? `${dir} is already here and isn't empty.` : undefined);

if (!interactive) {
	const missing = [];
	if (!flags.dir) missing.push('the folder name');
	if (!flags.mode) missing.push('--cloud or --standalone');
	if (missing.length) stop([`this isn't a terminal, so nothing can be asked. Still needed: ${missing.join(', and ')}.`, 'See --help.']);
}
if (flags.dir && folderProblem(flags.dir)) stop([folderProblem(flags.dir)]);

if (interactive) p.intro('create-caracms');
/** One prompt's answer, or out: Ctrl-C at any prompt leaves nothing behind, since nothing has run yet. */
const asked = async (prompt) => {
	const answer = await prompt;
	if (p.isCancel(answer)) {
		p.cancel('Nothing was made.');
		process.exit(1);
	}
	return answer;
};

const answers = {
	dir: flags.dir ?? (await asked(p.text({ message: "The site's folder", placeholder: 'my-site', validate: folderProblem }))),
	tailwind: flags.tailwind ?? (interactive ? await asked(p.confirm({ message: 'Add Tailwind?', initialValue: true })) : true),
	mode:
		flags.mode ??
		(await asked(
			p.select({
				message: 'Where does it run?',
				options: [
					{ value: 'cloud', label: 'CaraCMS Cloud', hint: 'sign-in, media, email and forms come from the cloud' },
					{ value: 'standalone', label: 'Standalone', hint: 'its own GitHub access, buckets and imgproxy' },
				],
			}),
		)),
	deploy:
		flags.deploy ??
		(interactive
			? await asked(
					p.select({
						message: 'Where is it deployed?',
						options: [
							{ value: 'railway', label: 'Railway', hint: 'writes .railway/railway.ts' },
							{ value: 'none', label: 'Decide later', hint: 'init lists the variables any host needs' },
						],
					}),
				)
			: 'railway'),
	pm: flags.pm ?? detectPm(process.env.npm_config_user_agent),
};

const site = resolve(here, answers.dir);
const plan = steps(answers);

if (flags.dryRun) {
	for (const s of plan.filter((s) => s.cmd)) console.log(`${s.cwd === 'site' ? `(in ${answers.dir}) ` : ''}${[s.cmd, ...s.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
	process.exit(0);
}

/** Runs one command quietly, keeping what it printed for the report (init's) or for the failure. */
const run = (s) =>
	new Promise((done) => {
		// No stdin, so nothing below can stop to ask a question. Not CI=1: that makes pnpm install with a frozen lockfile,
		// which fails after init adds packages.
		const child = spawn(s.cmd, s.args, { cwd: s.cwd === 'site' ? site : here, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let all = '';
		child.stdout.on('data', (d) => ((out += d), (all += d)));
		child.stderr.on('data', (d) => (all += d));
		child.on('error', (error) => done({ ok: false, out, all: `${all}${error.message}\n` }));
		child.on('close', (code) => done({ ok: code === 0, out, all }));
	});

/** After init: Home becomes a caracms page, and Tailwind's stylesheet goes into init's page component. */
const notes = [];
function finish() {
	try {
		mkdirSync(join(site, 'content/pages'), { recursive: true });
		writeFileSync(join(site, 'content/pages/index.json'), homePage());
		rmSync(join(site, 'src/pages/index.astro'), { force: true });
		if (answers.tailwind) {
			const page = join(site, 'src/components/caracms/Page.astro');
			const styled = existsSync(page) ? withStyles(readFileSync(page, 'utf8')) : null;
			if (styled) writeFileSync(page, styled);
			else notes.push("Tailwind's stylesheet (src/styles/global.css) isn't imported anywhere yet: import it in src/components/caracms/Page.astro.");
		}
		return { ok: true, out: '', all: '' };
	} catch (error) {
		return { ok: false, out: '', all: `${error.message}\n` };
	}
}

const spinner = interactive ? p.spinner() : null;
let initReport = '';
for (const s of plan) {
	if (s.title) spinner ? spinner.start(s.title) : console.log(`${s.title}…`);
	const result = s.finish ? finish() : await run(s);
	if (!result.ok) {
		const failed = `${s.title || 'A step'} didn't work${s.cmd ? `: ${[s.cmd, ...s.args].join(' ')}` : ''}`;
		spinner ? spinner.error(failed) : console.error(failed);
		// The cause is at the top; a package manager can follow it with hundreds of lines (every dist-tag of astro).
		const lines = result.all.trimEnd().split('\n');
		console.error(lines.slice(0, 30).join('\n') + (lines.length > 30 ? `\n… and ${lines.length - 30} more lines` : ''));
		console.error(`\nWhat was made so far is in ${answers.dir}. Fix the cause and run that command there, or delete the folder and start again.`);
		process.exit(1);
	}
	// init's closing "Next:" paragraph (install, commit, adopt the pages) is what the steps after it do, so it's left out.
	if (s.title === 'caracms init') initReport = result.out.replace(/\n+Next: [\s\S]*$/, '').trim();
	if (s.title && spinner) spinner.stop(s.title);
}

const next = [
	`cd ${answers.dir}`,
	runScript(answers.pm, 'dev'),
	'',
	'The editor is at /admin, with a Home page and one Text block to start from.',
	'The caracms-blocks skill builds the rest, and caracms-hosting puts it live.',
	...(answers.mode === 'cloud' ? ['', "It won't build until it has a CaraCMS Cloud key: make one in app.caracms.com", 'and put it in .env as CARACMS_CLOUD_KEY.'] : []),
	...notes.flatMap((n) => ['', n]),
];
if (interactive) {
	if (initReport) p.note(initReport, 'caracms init');
	p.note(next.join('\n'), 'Next');
	p.outro(`${answers.dir} is ready.`);
} else {
	if (initReport) console.log(`\n${initReport}`);
	console.log(`\n${answers.dir} is ready.\n\n${next.map((l) => (l ? `  ${l}` : '')).join('\n')}`);
}
