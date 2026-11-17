// The parts of `npm create caracms` that don't touch the terminal or the disk: reading the flags,
// working out the package manager, and the list of commands a set of answers turns into.
import { parseArgs } from 'node:util';

export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'];
/** Where the site runs. `init` still calls the second one self-hosted; here it's Standalone. */
export const MODES = ['cloud', 'standalone'];
/** Deploy targets `caracms init` can write files for, plus `none` (init prints the variables any host needs). */
export const DEPLOYS = ['railway', 'none'];

export const HELP = `create-caracms: a new Astro site with caracms on it.

  npm create caracms [folder] [-- flags]

It makes a blank Astro site (the minimal template), installs caracms, runs
\`caracms init\` and leaves two commits. Anything not given as a flag is asked,
in a terminal. Outside one, the folder and --cloud or --standalone are needed.

  --cloud                 The site runs on CaraCMS Cloud.
  --standalone            The site brings its own GitHub access, buckets and imgproxy.
  --deploy <target>       railway (default) or none.
  --tailwind              Add Tailwind (default).
  --no-tailwind           Don't.
  --pm <name>             pnpm, npm, yarn or bun. Default: the one this was run with.
  --dry-run               Print the commands and run nothing.
  --help                  This.

For a site that already exists, use \`npx caracms init\` in it.
`;

/** The package manager a `create` command was run with, from npm_config_user_agent ("pnpm/10.1.0 npm/? node/…"). */
export function detectPm(userAgent) {
	const name = (userAgent ?? '').split(' ')[0].split('/')[0];
	return PACKAGE_MANAGERS.includes(name) ? name : 'npm';
}

/**
 * The flags, as answers. A value is undefined when its flag wasn't given, so the prompts know what's left to ask.
 * @returns {{ help: boolean, dryRun: boolean, dir?: string, mode?: string, deploy?: string, tailwind?: boolean, pm?: string, problems: string[] }}
 */
export function parse(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				help: { type: 'boolean', short: 'h' },
				cloud: { type: 'boolean' },
				standalone: { type: 'boolean' },
				'self-hosted': { type: 'boolean' },
				deploy: { type: 'string' },
				tailwind: { type: 'boolean' },
				'no-tailwind': { type: 'boolean' },
				pm: { type: 'string' },
				'dry-run': { type: 'boolean' },
			},
		});
	} catch (error) {
		return { help: false, dryRun: false, problems: [error.message] };
	}
	const { values: v, positionals } = parsed;
	const problems = [];
	const standalone = v.standalone || v['self-hosted'];
	if (v.cloud && standalone) problems.push('--cloud and --standalone are one or the other.');
	if (v.tailwind && v['no-tailwind']) problems.push('--tailwind and --no-tailwind are one or the other.');
	if (v.deploy !== undefined && !DEPLOYS.includes(v.deploy)) problems.push(`--deploy is ${DEPLOYS.join(' or ')}, not "${v.deploy}".`);
	if (v.pm !== undefined && !PACKAGE_MANAGERS.includes(v.pm)) problems.push(`--pm is ${PACKAGE_MANAGERS.join(', ')}, not "${v.pm}".`);
	if (positionals.length > 1) problems.push(`One folder, not ${positionals.length}: ${positionals.join(', ')}.`);
	return {
		help: Boolean(v.help),
		dryRun: Boolean(v['dry-run']),
		dir: positionals[0],
		mode: v.cloud ? 'cloud' : standalone ? 'standalone' : undefined,
		deploy: v.deploy,
		tailwind: v.tailwind ? true : v['no-tailwind'] ? false : undefined,
		pm: v.pm,
		problems,
	};
}

/** What's wrong with a folder name, or undefined. The folder is made beside where the command runs. */
export function dirProblem(dir) {
	if (!dir || !dir.trim()) return 'The site needs a folder name.';
	if (/[\\/]/.test(dir) || dir === '.' || dir === '..') return 'A folder name, not a path: the site is made in a new folder here.';
	if (/\s/.test(dir)) return 'No spaces in the folder name.';
	return undefined;
}

const RUNNERS = {
	// [the command that runs a package without installing it, the command that runs an installed package's bin]
	pnpm: { dlx: ['pnpm', 'dlx'], exec: ['pnpm', 'exec'], add: ['pnpm', 'add'], exact: '--save-exact' },
	npm: { dlx: ['npx', '--yes'], exec: ['npx'], add: ['npm', 'install'], exact: '--save-exact' },
	yarn: { dlx: ['yarn', 'dlx'], exec: ['yarn'], add: ['yarn', 'add'], exact: '--exact' },
	bun: { dlx: ['bunx'], exec: ['bunx'], add: ['bun', 'add'], exact: '--exact' },
};

/**
 * The commands, in order, that make the site. `cwd` is 'here' (where the command was run) or 'site' (the new folder).
 * A site pins caracms to an exact version, so `add` saves it exact.
 * @param {{ dir: string, mode: string, deploy: string, tailwind: boolean, pm: string }} answers
 * @returns {{ title: string, cwd: 'here' | 'site', cmd?: string, args?: string[], finish?: true }[]}
 */
export function steps({ dir, mode, deploy, tailwind, pm }) {
	const r = RUNNERS[pm];
	const step = (title, cwd, [cmd, ...args]) => ({ title, cwd, cmd, args });
	const git = (title, ...args) => step(title, 'site', ['git', ...args]);
	return [
		// --no-ai: caracms init writes the site's CLAUDE.md block and skills. --no-git and --no-install: both are done below.
		step('A blank Astro site', 'here', [...r.dlx, 'create-astro@latest', dir, '--template', 'minimal', '--no-install', '--no-git', '--no-ai', '--yes', '--skip-houston']),
		// Not a bare install: create-astro's template is bumped on GitHub before the release reaches npm, so for a while it
		// asks for an astro that isn't published yet (7.4.9 on 2026-11-10). Adding astro@latest installs what is.
		step('Its packages', 'site', [...r.add, 'astro@latest']),
		...(tailwind ? [step('Tailwind', 'site', [...r.exec, 'astro', 'add', 'tailwind', '--yes'])] : []),
		step('caracms', 'site', [...r.add, r.exact, 'caracms']),
		git('A git repository', 'init', '--quiet'),
		git('', 'add', '--all'),
		git('The first commit', 'commit', '--quiet', '--message', `A blank Astro site${tailwind ? ' with Tailwind' : ''}, and caracms installed`),
		step('caracms init', 'site', [...r.exec, 'caracms', 'init', '--write', mode === 'cloud' ? '--cloud' : '--self-hosted', ...(deploy === 'railway' ? ['--railway'] : [])]),
		// Not a command: index.js writes the Home page and, with Tailwind, wires its stylesheet in (finish, below).
		{ title: 'A Home page', cwd: 'site', finish: true },
		step('What init asked for', 'site', [pm, 'install']),
		git('', 'add', '--all'),
		git('The second commit', 'commit', '--quiet', '--message', 'caracms init, and a Home page'),
	];
}

/** The command a person types to run a script, for the closing lines. */
export const runScript = (pm, script) => (pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`);

/**
 * Home as a caracms page (content/pages/index.json), laid out the way the editor saves: two-space JSON and a trailing
 * newline. It replaces Astro's own src/pages/index.astro, so "/" is editable from the first run.
 */
export const homePage = () =>
	`${JSON.stringify({ $schema: '../../schemas/pages.schema.json', title: 'Home', blocks: [{ type: 'text', text: 'This is the Home page. Change it in the editor at /admin.' }] }, null, 2)}\n`;

/**
 * init's page component with Tailwind's stylesheet imported (`astro add tailwind` writes src/styles/global.css and leaves
 * importing it to the site). Null when the component isn't shaped as expected, so nothing is guessed at.
 */
export function withStyles(pageText) {
	const anchor = "import Blocks from 'caracms/components/Blocks.astro';";
	if (!pageText.includes(anchor) || pageText.includes('styles/global.css')) return null;
	return pageText.replace(anchor, `import '../../styles/global.css';\n${anchor}`);
}
