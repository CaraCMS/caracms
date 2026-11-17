// M8 Decision 14, Acceptance 16–17: `caracms schemas` and `astro dev`'s regeneration. The
// schemas accept every file of the pinned demo fixture and catch a wrong field type (ajv,
// its JSON Schema 2020-12 build); a second run changes nothing; a dev server rewrites the
// schema files after a config change and never touches content.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import caracms from '../src/index.ts';
import type { SiteConfig } from '../src/config.ts';
import { jsonFilesUnder } from '../src/cli/site.ts';
import { removeTopLevel } from '../src/serialize.ts';
import { makeCliSite, type CliSite } from './helpers/cli-site.ts';

let s: CliSite;
let first: ReturnType<CliSite['run']>;
let contentBefore: Map<string, string>;

before(() => {
	s = makeCliSite('schemas');
	// The pinned fixture has its keys and its schemas (M8): take them out, so the command's work is what's tested.
	rmSync(join(s.root, 'schemas'), { recursive: true, force: true });
	for (const file of jsonFilesUnder(s.root, join(s.root, 'content'))) s.write(file, removeTopLevel(s.read(file), '$schema'));
	contentBefore = new Map(jsonFilesUnder(s.root, join(s.root, 'content')).map((f) => [f, s.read(f)]));
	first = s.run('schemas');
});
after(() => s.cleanup());

const SCHEMAS = ['case-studies.schema.json', 'journal.schema.json', 'pages.schema.json', 'shared.schema.json', 'site-settings.schema.json'];

describe('caracms schemas', () => {
	test('writes one schema per collection, plus shared blocks and Site Settings', () => {
		assert.equal(first.code, 0, first.stderr);
		assert.deepEqual(readdirSync(join(s.root, 'schemas')).sort(), SCHEMAS);
		for (const name of SCHEMAS) assert.equal(JSON.parse(s.read(`schemas/${name}`)).$schema, 'https://json-schema.org/draft/2020-12/schema');
		assert.match(first.stdout, /wrote schemas\/pages\.schema\.json/);
	});

	test('every content file gets $schema as its first key, the relative path to its schema, and nothing else changes', () => {
		for (const [file, before] of contentBefore) {
			const text = s.read(file);
			const parsed = JSON.parse(text);
			assert.equal(Object.keys(parsed)[0], '$schema', file);
			const { $schema, ...rest } = parsed;
			assert.deepEqual(rest, JSON.parse(before), file);
			assert.ok(existsSync(join(s.root, file, '..', $schema)), `${file}: ${$schema} resolves`);
		}
		assert.equal(JSON.parse(s.read('content/pages/about/team.json')).$schema, '../../../schemas/pages.schema.json');
		assert.equal(JSON.parse(s.read('content/site-settings.json')).$schema, '../schemas/site-settings.schema.json');
		assert.equal(JSON.parse(s.read('content/shared/footer.json')).$schema, '../../schemas/shared.schema.json');
	});

	test('running it again changes nothing', () => {
		const files = new Map([...contentBefore.keys(), ...SCHEMAS.map((n) => `schemas/${n}`)].map((f) => [f, s.read(f)]));
		const again = s.run('schemas');
		assert.equal(again.code, 0, again.stderr);
		assert.match(again.stdout, /up to date/);
		for (const [file, text] of files) assert.equal(s.read(file), text, file);
	});

	test('each schema accepts every file of the fixture, and ajv catches a wrong field type', () => {
		const ajv = new Ajv2020({ allErrors: true, strict: false });
		const validators = new Map(SCHEMAS.map((n) => [n, ajv.compile(JSON.parse(s.read(`schemas/${n}`)))]));
		let checked = 0;
		for (const file of contentBefore.keys()) {
			const doc = JSON.parse(s.read(file));
			const validate = validators.get(doc.$schema.split('/').pop())!;
			assert.ok(validate(doc), `${file}: ${JSON.stringify(validate.errors)}`);
			checked++;
		}
		assert.equal(checked, contentBefore.size);
		const page = JSON.parse(s.read('content/pages/index.json'));
		const hero = page.blocks.findIndex((b: { type?: string }) => b.type === 'hero');
		assert.ok(hero >= 0);
		page.blocks[hero].heading = 42;
		assert.equal(validators.get('pages.schema.json')!(page), false);
		const study = JSON.parse(s.read('content/case-studies/high-street-coffee.json'));
		study.unknownField = 'x';
		assert.equal(validators.get('case-studies.schema.json')!(study), false);
	});

	test('outside a site: one sentence, exit 1', () => {
		const empty = makeCliSite('schemas-empty');
		try {
			empty.write('caracms.config.ts', '');
			const r = empty.run('schemas');
			assert.equal(r.code, 1);
			assert.match(r.stderr, /^caracms schemas: caracms\.config\.ts has no default export/);
		} finally {
			empty.cleanup();
		}
	});
});

describe('astro dev regenerates the schema files only', () => {
	test('a config change rewrites schemas/ at the dev server\'s (re)start; content files are untouched', async () => {
		const config = (await import(pathToFileURL(join(s.root, 'caracms.config.ts')).href)).default as SiteConfig;
		const changed: SiteConfig = {
			...config,
			blocks: { ...config.blocks, text: { ...config.blocks.text!, fields: { ...config.blocks.text!.fields, kicker: { kind: 'text', multiline: false, heading: false } } } },
		};
		// A content file without $schema stays without it.
		s.write('content/pages/plain.json', '{\n  "title": "Plain",\n  "blocks": []\n}\n');
		const content = new Map(jsonFilesUnder(s.root, join(s.root, 'content')).map((f) => [f, s.read(f)]));
		const integration = caracms(changed);
		const logs: string[] = [];
		const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
		await integration.hooks['astro:config:setup']!({
			command: 'dev',
			config: { root: pathToFileURL(`${s.root}/`) },
			logger,
			addWatchFile: () => {},
			updateConfig: () => {},
			injectRoute: () => {},
			addMiddleware: () => {},
		} as any);
		// The server's content watch (watchContent) stops when its server closes.
		let close: (() => void) | undefined;
		const server = { environments: {}, httpServer: { once: (_event: string, stop: () => void) => (close = stop) } };
		await integration.hooks['astro:server:setup']!({ logger, server } as any);
		close?.();
		assert.ok(close, 'the content watch stops with the server');
		assert.ok(JSON.stringify(JSON.parse(s.read('schemas/pages.schema.json')).$defs['block:text']).includes('"kicker"'));
		assert.match(logs.join('\n'), /updated schemas\/pages\.schema\.json/);
		for (const [file, text] of content) assert.equal(s.read(file), text, file);
	});
});
