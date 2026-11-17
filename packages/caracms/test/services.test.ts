// caracms-cloud M5, the readers' half (Decisions 1–4; Acceptance 1–6): the config's
// `services` decides the mode, the other mode's variables are ignored with one warning
// each per process, and never read.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { cloudSettingsForBuild, resetCloudSettingsRetry } from '../src/cloud-middleware.ts';
import { onRequest as editorGate } from '../src/editor/middleware.ts';
import { resetEditorMode } from '../src/editor/server/mode.ts';
import { CaracmsConfigError, resolveSite } from '../src/config.ts';
import { sendEmail } from '../src/email.ts';
import { readImagesConfig, readMuxConfig } from '../src/editor/server/media/config.ts';
import { readSubmissionsConfig } from '../src/forms/store.ts';
import { heldCloudSettings, loadCloudSettings, resetCloudSettings } from '../src/live/cloud.ts';
import { CLOUD_AND_MEDIA_PROBLEM, CLOUD_REPO_PROBLEM, cloudForms, readMode } from '../src/live/mode.ts';
import { CLOUD_KEY_MISSING_PROBLEM, ignoredMessage, ignoredVariables, REPLACED_VARIABLES, resetIgnoredWarnings, servicesEnv } from '../src/live/services.ts';
import { cloudMedia, readMediaConfig } from '../src/media.ts';
import { siteRoot, variant } from './helpers/site.ts';

const KEY = `cck_${'a'.repeat(43)}`;
const CLOUD = 'https://cloud.test';
const PAIR = { key: '11'.repeat(32), salt: '22'.repeat(32) };

/** Every variable the cloud replaces, set and valid-looking. */
const OWN: Record<string, string> = {
	S3_ENDPOINT: 'https://t3.storageapi.dev',
	S3_REGION: 'own-region',
	S3_BUCKET: 'own-media',
	S3_ACCESS_KEY_ID: 'own-id',
	S3_SECRET_ACCESS_KEY: 'own-secret',
	IMGPROXY_KEY: 'aa'.repeat(32),
	IMGPROXY_SALT: 'bb'.repeat(32),
	CARACMS_MEDIA_URL: 'https://img.own.test',
	MUX_TOKEN_ID: 'mux-id',
	MUX_TOKEN_SECRET: 'mux-secret',
	SUBMISSIONS_S3_BUCKET: 'own-submissions',
	SUBMISSIONS_S3_ACCESS_KEY_ID: 'sub-id',
	SUBMISSIONS_S3_SECRET_ACCESS_KEY: 'sub-secret',
	RESEND_API_KEY: 're_own',
	FORMS_FROM: 'Site <forms@own.test>',
	CARACMS_GITHUB_TOKEN: 'github_pat_own',
	GITHUB_APP_ID: '123',
	GITHUB_APP_PRIVATE_KEY: 'pem',
	GITHUB_REPO: 'own/site',
};
const SERVER = { CARACMS_SECRET: 's'.repeat(32), REDIS_URL: 'redis://localhost:6379', SITE_URL: 'https://example.com' };
const BOTH = { ...OWN, ...SERVER, CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: CLOUD };

/** A stubbed GET /v1/settings, recording every URL fetched. */
function cloudFetch(seen: string[]): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		seen.push(url);
		return Response.json({ site: { name: 'CaraCMS' }, github: { repo: 'example-org/site' }, folder: 'sites/site-a/', media: { bucket: 'caracms-media', imageHost: 'img.caracms.cloud' }, imgproxy: PAIR });
	}) as typeof fetch;
}

const quiet = () => {};

beforeEach(() => {
	resetIgnoredWarnings();
	resetCloudSettings();
	resetCloudSettingsRetry();
});

describe('the config field (Decision 1)', () => {
	test("'cloud', 'self-hosted' or unset; anything else is the config's error", () => {
		assert.equal(resolveSite(variant({ services: 'cloud' }), siteRoot).services, 'cloud');
		assert.equal(resolveSite(variant({ services: 'self-hosted' }), siteRoot).services, 'self-hosted');
		assert.equal(resolveSite(variant({}), siteRoot).services, null);
		assert.throws(() => resolveSite(variant({ services: 'hosted' as never }), siteRoot), (e: Error) => e instanceof CaracmsConfigError && /services must be 'cloud'/.test(e.message));
	});
});

describe('servicesEnv: the other mode is ignored, named once per process (Decision 2)', () => {
	test('cloud: every replaced variable is removed and named once, by group', () => {
		const lines: string[] = [];
		const env = servicesEnv(BOTH, 'cloud', (l) => lines.push(l));
		for (const name of Object.keys(OWN)) assert.equal(env[name], undefined, name);
		assert.equal(env.CARACMS_CLOUD_KEY, KEY);
		assert.equal(env.GITHUB_WEBHOOK_SECRET, undefined);
		assert.equal(lines.length, 4);
		assert.match(lines[0]!, /^\[caracms\] S3_ENDPOINT, .* and CARACMS_MEDIA_URL are set, but this site runs on CaraCMS Cloud \(caracms\.config\.ts\): they're ignored\./);
		for (const name of Object.keys(OWN)) assert.equal(lines.join('\n').split(name).length - 1 >= 1, true, name);
		// Once per process: a second read names nothing.
		servicesEnv(BOTH, 'cloud', (l) => lines.push(l));
		assert.equal(lines.length, 4);
	});

	test("one variable reads as the spec's sentence", () => {
		assert.equal(
			ignoredMessage(['S3_BUCKET'], 'cloud', 'media'),
			"S3_BUCKET is set, but this site runs on CaraCMS Cloud (caracms.config.ts): it's ignored. Remove it once the old bucket and imgproxy are retired.",
		);
	});

	test('self-hosted: only the key is removed and named', () => {
		const lines: string[] = [];
		const env = servicesEnv(BOTH, 'self-hosted', (l) => lines.push(l));
		assert.equal(env.CARACMS_CLOUD_KEY, undefined);
		assert.equal(env.S3_BUCKET, 'own-media');
		assert.deepEqual(lines, [`[caracms] ${ignoredMessage(['CARACMS_CLOUD_KEY'], 'self-hosted')}`]);
		assert.match(lines[0]!, /CARACMS_CLOUD_KEY is set, but this site is self-hosted \(caracms\.config\.ts\): it's ignored/);
	});

	test('unset: the environment as it is, nothing named', () => {
		const lines: string[] = [];
		assert.equal(servicesEnv(BOTH, null, (l) => lines.push(l)), BOTH);
		assert.deepEqual(lines, []);
		assert.deepEqual(ignoredVariables(BOTH, null), []);
	});

	test('ignoredVariables lists the replaced ones in the Contracts order', () => {
		assert.deepEqual(ignoredVariables(BOTH, 'cloud'), Object.values(REPLACED_VARIABLES).flat());
		assert.deepEqual(ignoredVariables({ S3_BUCKET: 'x', RESEND_API_KEY: 'y' }, 'cloud'), ['S3_BUCKET', 'RESEND_API_KEY']);
	});
});

describe("check 1: 'cloud' with the key and every replaced variable", () => {
	test('readMode is the cloud, with no "not both" refusal', () => {
		resetIgnoredWarnings();
		const m = readMode(BOTH, true, { site: 'https://example.com', services: 'cloud' });
		assert.equal(m.kind, 'live');
		if (m.kind === 'live') assert.deepEqual(m.settings.github, { kind: 'cloud', key: KEY, url: CLOUD });
	});

	test('the media, video and forms readers are all the cloud', async () => {
		await loadCloudSettings({ key: KEY, url: CLOUD, fetch: cloudFetch([]) });
		const mediaConfig = readMediaConfig(BOTH, true, 'cloud');
		assert.equal(mediaConfig.kind, 'ready');
		if (mediaConfig.kind === 'ready') assert.equal(mediaConfig.settings.origin, 'https://img.caracms.cloud');
		assert.equal(readImagesConfig(BOTH, true, 'cloud').kind, 'cloud');
		assert.equal(readMuxConfig(BOTH, true, 'cloud').kind, 'cloud');
		assert.equal(readSubmissionsConfig('/site', BOTH, true, 'cloud').kind, 'cloud');
		assert.deepEqual(cloudForms(BOTH, 'cloud'), { connection: { key: KEY, url: CLOUD }, problems: [] });
	});

	test('the build fetches the settings and names every leftover once', async () => {
		const lines: string[] = [];
		const warn = console.warn;
		console.warn = (line: string) => lines.push(line);
		const seen: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = cloudFetch(seen);
		try {
			await cloudSettingsForBuild(BOTH, 'cloud');
			// The prerendered pages' reads in the same process name nothing again.
			readMediaConfig(BOTH, true, 'cloud');
			readMode(BOTH, true, { site: 'https://example.com', services: 'cloud' });
		} finally {
			console.warn = warn;
			globalThis.fetch = realFetch;
		}
		assert.equal(seen.length, 1);
		assert.equal(lines.length, 4);
		const all = lines.join('\n');
		for (const name of Object.keys(OWN)) assert.equal(all.match(new RegExp(`\\b${name}\\b`, 'g'))?.length, 1, name);
		assert.ok(lines.every((l) => /ignored/.test(l)));
	});
});

describe("check 2: 'self-hosted' with the key", () => {
	test('every reader is self-hosted; the cloud is never fetched', async () => {
		const lines: string[] = [];
		const warn = console.warn;
		console.warn = (line: string) => lines.push(line);
		const seen: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = cloudFetch(seen);
		try {
			const m = readMode({ ...BOTH, CARACMS_GITHUB_TOKEN: '', GITHUB_APP_ID: '' }, true, { site: 'https://example.com', services: 'self-hosted' });
			// The App's id is gone here, so the token is the credential.
			const withToken = readMode({ ...BOTH, GITHUB_APP_ID: '' }, true, { site: 'https://example.com', services: 'self-hosted' });
			assert.equal(m.kind, 'unconfigured');
			assert.equal(withToken.kind, 'live');
			if (withToken.kind === 'live') assert.deepEqual(withToken.settings.github, { kind: 'token', token: 'github_pat_own', owner: 'own', repo: 'site' });
			const media = readMediaConfig(BOTH, true, 'self-hosted');
			assert.equal(media.kind, 'ready');
			if (media.kind === 'ready') assert.equal(media.settings.origin, 'https://img.own.test');
			assert.equal(readImagesConfig(BOTH, true, 'self-hosted').kind, 's3');
			assert.equal(readMuxConfig(BOTH, true, 'self-hosted').kind, 'mux');
			assert.equal(readSubmissionsConfig('/site', BOTH, true, 'self-hosted').kind, 'bucket');
			assert.equal(cloudForms(BOTH, 'self-hosted'), null);
			assert.equal(cloudMedia(BOTH, 'self-hosted'), null);
			await cloudSettingsForBuild(BOTH, 'self-hosted');
		} finally {
			console.warn = warn;
			globalThis.fetch = realFetch;
		}
		assert.deepEqual(seen, []);
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /CARACMS_CLOUD_KEY is set, but this site is self-hosted/);
	});
});

describe('check 3: no field behaves as before', () => {
	test('the key with S3_BUCKET or GITHUB_REPO is refused with the old sentences; the key alone is cloud; neither is self-hosted', () => {
		const lines: string[] = [];
		const warn = console.warn;
		console.warn = (line: string) => lines.push(line);
		try {
			const refused = readMode({ ...SERVER, CARACMS_CLOUD_KEY: KEY, S3_BUCKET: 'b', GITHUB_REPO: 'own/site' }, true, { site: 'https://example.com' });
			assert.equal(refused.kind, 'unconfigured');
			if (refused.kind === 'unconfigured') {
				assert.ok(refused.problems.includes(CLOUD_REPO_PROBLEM));
				assert.ok(refused.problems.includes(CLOUD_AND_MEDIA_PROBLEM(['S3_BUCKET'])));
			}
			const alone = readMode({ ...SERVER, CARACMS_CLOUD_KEY: KEY }, true, { site: 'https://example.com' });
			assert.equal(alone.kind === 'live' && alone.settings.github.kind, 'cloud');
			const own = readMode({ ...SERVER, CARACMS_GITHUB_TOKEN: 'github_pat_x', GITHUB_REPO: 'own/site' }, true, { site: 'https://example.com' });
			assert.equal(own.kind === 'live' && own.settings.github.kind, 'token');
			assert.equal(readMediaConfig({ CARACMS_CLOUD_KEY: KEY, S3_BUCKET: 'b' }, true, null).kind, 'unset');
		} finally {
			console.warn = warn;
		}
		assert.deepEqual(lines, []);
	});
});

describe("check 4: 'cloud' without the key (Decision 4)", () => {
	const noKey = { ...OWN, ...SERVER };

	test('the build fails with the sentence, even with every self-hosted variable set', async () => {
		await assert.rejects(cloudSettingsForBuild(noKey, 'cloud'), { message: `caracms: ${CLOUD_KEY_MISSING_PROBLEM}` });
	});

	test("a production server's mode is unconfigured with the sentence (/admin's 503); no fallback", () => {
		const m = readMode(noKey, true, { site: 'https://example.com', services: 'cloud' });
		assert.equal(m.kind, 'unconfigured');
		if (m.kind === 'unconfigured') {
			assert.deepEqual(m.problems, [CLOUD_KEY_MISSING_PROBLEM]);
			assert.deepEqual(m.missing, []);
		}
		assert.deepEqual(readMediaConfig(noKey, true, 'cloud'), { kind: 'unset', missing: [], problems: [CLOUD_KEY_MISSING_PROBLEM] });
		assert.equal(readImagesConfig(noKey, true, 'cloud').kind, 'unset');
		assert.equal(readMuxConfig(noKey, true, 'cloud').kind, 'unset');
		const forms = readSubmissionsConfig('/site', noKey, true, 'cloud');
		assert.equal(forms.kind === 'unset' && forms.message, CLOUD_KEY_MISSING_PROBLEM);
	});

	test('astro dev with the same config is local mode, and keeps the folder for submissions', () => {
		assert.deepEqual(readMode(noKey, false, { services: 'cloud' }), { kind: 'local' });
		assert.equal(readSubmissionsConfig('/site', noKey, false, 'cloud').kind, 'folder');
	});

	test('the tests\' in-memory backends still win in dev', () => {
		const m = readMode({ ...noKey, CARACMS_GITHUB: 'memory' }, false, { services: 'cloud' });
		assert.equal(m.kind === 'live' && m.settings.github.kind, 'memory');
		assert.equal(readImagesConfig({ ...noKey, CARACMS_MEDIA: 'memory' }, false, 'cloud').kind, 'memory');
	});
});

describe('check 5: the ignored variables are never read', () => {
	test("on 'cloud', no reader's answer carries any replaced variable's value", async () => {
		await loadCloudSettings({ key: KEY, url: CLOUD, fetch: cloudFetch([]) });
		const answers = JSON.stringify([
			readMode(BOTH, true, { site: 'https://example.com', services: 'cloud' }),
			readMediaConfig(BOTH, true, 'cloud'),
			readImagesConfig(BOTH, true, 'cloud'),
			readMuxConfig(BOTH, true, 'cloud'),
			readSubmissionsConfig('/site', BOTH, true, 'cloud'),
			cloudForms(BOTH, 'cloud'),
			cloudMedia(BOTH, 'cloud'),
		]);
		for (const [name, value] of Object.entries(OWN)) assert.ok(!answers.includes(value), name);
	});

	test("an upload goes to the cloud, never S3_BUCKET's bucket; an image URL is never signed with IMGPROXY_KEY", async () => {
		await loadCloudSettings({ key: KEY, url: CLOUD, fetch: cloudFetch([]) });
		const images = readImagesConfig(BOTH, true, 'cloud');
		assert.equal(images.kind, 'cloud');
		if (images.kind !== 'cloud') return;
		assert.equal(images.signing.bucket, 'caracms-media');
		assert.equal(images.signing.key, PAIR.key);
		assert.notEqual(images.signing.key, OWN.IMGPROXY_KEY);
		assert.equal(heldCloudSettings({ key: KEY, url: CLOUD })?.kind, 'ready');
	});

	test('sendEmail never calls Resend on a cloud site (its key is ignored)', async () => {
		// The build bakes `services`; plain Node has none, so this checks the reader through servicesEnv directly.
		const env = servicesEnv({ RESEND_API_KEY: 're_own', FORMS_FROM: 'a@b.c' }, 'cloud', quiet);
		let called = false;
		const result = await sendEmail({ to: ['x@y.z'], subject: 's', text: 't' }, { env, fetch: (async () => ((called = true), new Response('{}'))) as typeof fetch });
		assert.equal(result.status, 'skipped');
		assert.equal(called, false);
	});
});

describe('check 1, the running server: the first mode read names each leftover once', () => {
	test('a fresh process names every group once at its first read, and nothing at the next', () => {
		const lines: string[] = [];
		const warn = console.warn;
		console.warn = (line: string) => lines.push(line);
		try {
			readMode(BOTH, true, { site: 'https://example.com', services: 'cloud' });
			const first = lines.length;
			readMode(BOTH, true, { site: 'https://example.com', services: 'cloud' });
			assert.equal(lines.length, first, 'the second read names nothing');
		} finally {
			console.warn = warn;
		}
		assert.equal(lines.length, 4, lines.join('\n'));
		for (const name of Object.keys(OWN)) assert.equal(lines.join('\n').match(new RegExp(`\\b${name}\\b`, 'g'))?.length, 1, name);
		assert.ok(lines.every((l) => /ignored/.test(l)));
	});
});

describe("check 4, the running server: /admin answers 503 with the sentence; the public site is served", () => {
	const saved = { env: { ...process.env }, production: (globalThis as Record<string, unknown>).__CARACMS_PRODUCTION__, services: (globalThis as Record<string, unknown>).__CARACMS_SERVICES__ };
	const g = globalThis as Record<string, unknown>;
	const restore = () => {
		for (const name of Object.keys(process.env)) if (!(name in saved.env)) delete process.env[name];
		Object.assign(process.env, saved.env);
		if (saved.production === undefined) delete g.__CARACMS_PRODUCTION__;
		else g.__CARACMS_PRODUCTION__ = saved.production;
		if (saved.services === undefined) delete g.__CARACMS_SERVICES__;
		else g.__CARACMS_SERVICES__ = saved.services;
		resetEditorMode();
	};
	const asked = async (path: string, method = 'GET') => {
		let passed = false;
		const res = await editorGate({ url: new URL(`https://example.com${path}`), request: new Request(`https://example.com${path}`, { method }) } as never, (async () => ((passed = true), new Response('page'))) as never);
		return { passed, res: res as Response };
	};

	test("with every self-hosted variable set and no key: /admin and /_caracms/ answer 503 with Decision 4's sentence, '/' is served", async () => {
		try {
			for (const name of Object.keys(process.env)) if (/^(GITHUB_|CARACMS_|S3_|IMGPROXY_|MUX_|SUBMISSIONS_|RESEND_|FORMS_)/.test(name)) delete process.env[name];
			Object.assign(process.env, OWN, SERVER);
			g.__CARACMS_PRODUCTION__ = true;
			g.__CARACMS_SERVICES__ = 'cloud';
			resetEditorMode();
			const error = console.error;
			const logged: string[] = [];
			console.error = (line: string) => logged.push(line);
			try {
				const admin = await asked('/admin');
				assert.equal(admin.passed, false);
				assert.equal(admin.res.status, 503);
				assert.ok((await admin.res.text()).includes(CLOUD_KEY_MISSING_PROBLEM));
				const api = await asked('/_caracms/save', 'POST');
				assert.equal(api.res.status, 503);
				assert.equal(((await api.res.json()) as { error: string }).error, CLOUD_KEY_MISSING_PROBLEM);
				const home = await asked('/');
				assert.equal(home.passed, true);
				assert.equal(home.res.status, 200);
			} finally {
				console.error = error;
			}
			assert.ok(logged.some((l) => l.includes(CLOUD_KEY_MISSING_PROBLEM)), 'the server logs it');
		} finally {
			restore();
		}
	});
});
