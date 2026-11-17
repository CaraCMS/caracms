/**
 * The M4 states for the visual pass's check (M4 Phase 5 → Verify 1), run by
 * mockup-diff.ts beside M3's: every M4 state of the mockup's switcher against /admin
 * in live mode, plus the states M4 adds (Decision 19), each against its nearest
 * mockup state. Their accepted differences, each with its reason, are `ALLOW_M4`.
 *
 * /admin runs in live mode on the in-memory GitHub and the Redis stand-in
 * (helpers/live-site.ts; Decision 2), with short sweep times. Before each state the
 * live runtime is forgotten, so every state starts from the demo's content with
 * nothing waiting, nobody editing and nothing published. The mockup's people are
 * Niamh (you), Aoife and Ciarán; here they're the demo's addresses, each in their own
 * browser context. The mockup's sample: Niamh changed Home, Aoife has About open
 * (locked) and changed a case study, which here is a Journal post.
 */
import type { Page } from 'playwright-core';
import { AOIFE, cookieFor, eventually, keepState, openAdmin, runtime } from './helpers/live-site.ts';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { demoContent } from './helpers/dev-site.ts';
import type { Allow, Ctx, State } from './mockup-diff.ts';
import { mediaOffline, seedLibrary, STATES_M5B } from './mockup-diff-m5b.ts';

export const NIAMH = 'niamh@example.com';
export const NOT_A_COMMIT = '0'.repeat(40);
export const BACKUP = { user: 'studio', password: 'a-backup-password-for-the-mockup-diff' };

/** The live site's environment for the whole run (each state may change some, then they're put back). */
export const LIVE_ENV: Record<string, string> = {
	CARACMS_TIMINGS: JSON.stringify({ sweepIdleMs: 1000, sweepTickMs: 400, sweepCapMs: 10_000, lockLapseMs: 15_000, mainCheckMs: 800, historyMs: 300, deploymentReadMs: 300, pollMs: 1000 }),
	// Niamh is let in by the demo's Site Settings (the client half), so removing her there signs her out.
	CARACMS_ALLOW: `${AOIFE},ciaran@example.com`,
	CARACMS_RUNNING_COMMIT: NOT_A_COMMIT,
	CARACMS_RAILWAY_TOKEN: 'a-test-project-token',
	RAILWAY_SERVICE_ID: 'service-1',
	RAILWAY_ENVIRONMENT_ID: 'environment-1',
	CARACMS_BACKUP_USER: BACKUP.user,
	CARACMS_BACKUP_PASSWORD: BACKUP.password,
};

const SHOWN = '.side-level:not([hidden])';
const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const INTRO = `${BLOCK} [data-ff="intro"] textarea`;
const desktop = (page: Page) => page.frameLocator('#stage .frame[data-w="desktop"] iframe');

async function open(page: Page, origin: string, path = '/admin') {
	await page.goto(origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	await page.evaluate(() => document.fonts.ready);
}

/** Another person, in their own browser context (closed when the state ends). */
async function as(ctx: Ctx, email: string, path = '/admin'): Promise<Page> {
	const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
	ctx.extra.push(context);
	await context.addCookies([cookieFor(ctx.site, email)]);
	return openAdmin(context, ctx.site, path);
}

/** Another tab of the person on screen. */
async function tab(ctx: Ctx, path: string): Promise<Page> {
	const page = await ctx.page.context().newPage();
	await open(page, ctx.site.origin, path);
	return page;
}

/** Type into the open document's hero intro and wait until it's kept. */
async function editIntro(page: Page, text: string) {
	if (!(await page.$(INTRO))) await page.click(`${DOC} .brow-main >> nth=0`);
	await page.waitForSelector(INTRO);
	await page.fill(INTRO, text);
	await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');
}

/** The hero picked from the page, then its intro (the mockup's field: 'intro', picked: false). */
async function introPicked(page: Page) {
	await desktop(page).locator('[data-cms-block="0"] [data-cms-field="heading"]').first().click();
	await page.waitForSelector(`${BLOCK} .field-frame.is-picked`);
	await page.click(INTRO);
}

async function waiting(page: Page, n: number) {
	let seen = '';
	await eventually(
		async () => {
			seen = `${await page.getAttribute('.bar [data-slot="publish"]', 'data-pub')}: ${await page.textContent('.bar [data-slot="publish"]')}`;
			return seen === `waiting: ${n} waiting Publish ${n}` || (seen.startsWith('waiting') && seen.includes(`${n} waiting`));
		},
		15_000,
		`"${n} waiting"`,
	).catch((error) => {
		throw new Error(`${error.message} (the bar says ${seen})`);
	});
}
const pubState = (page: Page, state: string) => eventually(async () => (await page.getAttribute('.bar [data-slot="publish"]', 'data-pub')) === state, 15_000, `Publish: ${state}`);

/**
 * The mockup's sample: Aoife changed a Journal post (the mockup's case study) and has
 * About open with a change (so it's locked); Niamh, on screen, opens Home.
 */
async function others(ctx: Ctx, options: { about?: boolean } = {}) {
	const post = await as(ctx, AOIFE, '/admin/journal/notes-from-the-ridge');
	await editIntroOrBody(post, 'Notes, edited by Aoife.');
	await post.close({ runBeforeUnload: true });
	if (options.about === false) return null;
	const about = await as(ctx, AOIFE, '/admin/pages/about');
	await editIntro(about, 'Four people and a long table, edited by Aoife.');
	return about;
}

/** The mockup's three changes, Niamh's to Home made in another tab of hers (closed after), for states that open another document. */
async function threeWaiting(ctx: Ctx, options: { about?: boolean } = {}) {
	const about = await others(ctx, options);
	const home = await tab(ctx, '/admin');
	await editIntro(home, 'Home, edited by Niamh.');
	await home.close({ runBeforeUnload: true });
	return about;
}

/** A Journal post's first text field (posts are section builders too; the first block may not have an intro). */
async function editIntroOrBody(page: Page, text: string) {
	await page.click(`${DOC} .brow-main >> nth=0`);
	const field = page.locator(`${BLOCK} textarea, ${BLOCK} input.input`).first();
	await field.fill(text);
	await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');
}

/** Niamh on Home's hero intro, her own change kept, with the mockup's three changes waiting. */
async function sample(ctx: Ctx) {
	await others(ctx);
	await open(ctx.page, ctx.site.origin);
	await introPicked(ctx.page);
	await ctx.page.keyboard.type(' x');
	await eventually(async () => (await keepState(ctx.page)) === 'kept', 10_000, 'Kept');
	await waiting(ctx.page, 3);
}

/** Niamh publishes Home (her own change) and the bar goes to `state`. */
async function publishHome(ctx: Ctx, state: 'publishing' | 'live' | 'failed') {
	await open(ctx.page, ctx.site.origin);
	await introPicked(ctx.page);
	await ctx.page.keyboard.type(' x');
	await eventually(async () => (await keepState(ctx.page)) === 'kept', 10_000, 'Kept');
	await waiting(ctx.page, 1);
	await ctx.page.click('.bar [data-slot="publish"]');
	await ctx.page.locator('[data-pop="waiting"] [data-act="publish"]').click();
	await pubState(ctx.page, state === 'live' ? 'live' : 'publishing');
	if (state === 'failed') {
		const rt = await runtime();
		const record = (await rt.git.lastPublish())!;
		const at = new Date().toISOString();
		rt.backend.deployments.push({ id: rt.backend.deployments.length + 1, sha: record.commit, environment: 'caracms-demo / production', createdAt: at, statuses: [{ state: 'failure', createdAt: at }] });
		await pubState(ctx.page, 'failed');
	}
	await ctx.page.waitForSelector('[data-pop="waiting"]');
}

/** Up from a field to the document level (Esc blurs the field, Esc again goes up). */
async function upToDoc(page: Page) {
	for (let i = 0; i < 3 && !(await page.isVisible(DOC)); i++) await page.keyboard.press('Escape');
	await page.waitForSelector(DOC, { state: 'visible' });
}

/** A sign-in link for this address, taken from the server log as a developer would (Decision 14: printed outside production). */
async function linkFor(ctx: Ctx, email: string): Promise<string> {
	const logged: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		logged.push(args.map(String).join(' '));
		original(...args);
	};
	try {
		const body = new URLSearchParams({ email, next: '/admin' });
		await fetch(`${ctx.site.origin}/admin/login`, { method: 'POST', body, headers: { origin: ctx.site.origin }, redirect: 'manual' });
		return await eventually<string | null>(() => {
			const line = logged.find((l) => l.includes(`sign-in link for ${email} `));
			return line ? /(https?:\/\/\S+\/admin\/login\/confirm\?token=[A-Za-z0-9_-]{43})/.exec(line)![1]! : null;
		}, 5000, `the sign-in link for ${email}`) as string;
	} finally {
		console.log = original;
	}
}

async function signIn(ctx: Ctx, path: string) {
	await ctx.page.goto(ctx.site.origin + path);
	await ctx.page.waitForSelector('.si-card, .nw');
	await ctx.page.evaluate(() => document.fonts.ready);
}

const EDITOR = ['side', 'bar'] as const;
const WITH_POPS = ['side', 'bar', 'pops'] as const;

export const STATES_M4: State[] = [
	// ── Keeping ──
	{ id: 'live-kept', mock: 'kept', live: true, roots: [...EDITOR], ours: sample },
	{
		id: 'live-keeping',
		mock: 'keeping',
		live: true,
		roots: [...EDITOR],
		ours: async (ctx) => {
			await sample(ctx);
			await ctx.page.route('**/_caracms/write', async (route) => {
				await new Promise((r) => setTimeout(r, 8000));
				await route.continue().catch(() => {});
			});
			await ctx.page.keyboard.type('y');
			await ctx.page.waitForSelector('#bar [data-keep="keeping"]');
		},
	},
	{
		id: 'live-offline',
		mock: 'offline',
		live: true,
		roots: [...EDITOR],
		ours: async (ctx) => {
			await sample(ctx);
			await ctx.page.route('**/_caracms/write', (route) => route.abort());
			await ctx.page.keyboard.type('yz');
			await ctx.page.waitForSelector('#bar [data-keep="offline"]', { timeout: 10000 });
			await ctx.page.waitForSelector(`${SHOWN} [data-act="try-now"]`);
		},
	},
	// ── Waiting changes and Publish ──
	{
		id: 'waiting',
		live: true,
		roots: [...WITH_POPS],
		ours: async (ctx) => {
			await sample(ctx);
			await ctx.page.click('.bar [data-slot="publish"]');
			await ctx.page.waitForSelector('[data-pop="waiting"] .wlist');
		},
	},
	{
		// The editor restyle adds it (Decision 9): Discard changes…, the lose-work dialog, framed in danger (on Aoife's About; the mockup's is her High-street coffee roaster).
		id: 'discard',
		live: true,
		roots: ['side', 'bar', 'modal'],
		ours: async (ctx) => {
			await sample(ctx);
			await ctx.page.click('.bar [data-slot="publish"]');
			await ctx.page.click('[data-pop="waiting"] [data-act="discard"][aria-label$=" About"]');
			await ctx.page.waitForSelector('.dialog[data-dialog="discard"]');
		},
	},
	{
		id: 'nothing',
		live: true,
		roots: [...WITH_POPS],
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await introPicked(ctx.page);
			await ctx.page.click('.bar [data-slot="publish"]');
			await ctx.page.waitForSelector('[data-pop="waiting"]');
		},
	},
	{ id: 'publishing', live: true, roots: [...WITH_POPS], ours: (ctx) => publishHome(ctx, 'publishing') },
	{ id: 'live', live: true, roots: [...WITH_POPS], env: { CARACMS_RUNNING_COMMIT: undefined }, ours: (ctx) => publishHome(ctx, 'live') },
	{
		id: 'failed',
		live: true,
		roots: [...WITH_POPS],
		ours: async (ctx) => {
			await publishHome(ctx, 'failed');
			await ctx.page.waitForSelector('[data-pop="waiting"] [data-act="try-again"]');
		},
	},
	{
		// M4 adds it (Decision 12): failed with no token, against the mockup's failed.
		id: 'failed-no-token',
		mock: 'failed',
		live: true,
		roots: [...WITH_POPS],
		env: { CARACMS_RAILWAY_TOKEN: undefined },
		ours: async (ctx) => {
			await publishHome(ctx, 'failed');
			await ctx.page.waitForSelector('[data-pop="waiting"] [data-note="no-token"]');
		},
	},
	// The mockup's `blocked` is M5b's `publish-alt` now (nothing blocks Publish: M5b Decision 9; `#blocked` opens it),
	// so it's compared in M5b's group (mockup-diff-m5b.ts), with images that have no alt text waiting.
	{
		id: 'history',
		live: true,
		roots: [...WITH_POPS],
		env: { CARACMS_RUNNING_COMMIT: undefined },
		ours: async (ctx) => {
			// One publish that went live, then the mockup's three changes waiting.
			await publishHome(ctx, 'live');
			await ctx.page.keyboard.press('Escape');
			await others(ctx);
			await introPicked(ctx.page);
			await ctx.page.keyboard.type(' y');
			await eventually(async () => (await keepState(ctx.page)) === 'kept', 10_000, 'Kept');
			await waiting(ctx.page, 3);
			await ctx.page.click('.bar [data-slot="publish"]');
			await ctx.page.click('[data-pop="waiting"] [data-act="history"]');
			await ctx.page.waitForSelector('[data-pop="history"] [data-history]');
		},
	},
	{
		id: 'account',
		live: true,
		roots: [...WITH_POPS],
		ours: async (ctx) => {
			await sample(ctx);
			// The mockup's default: the hero's Heading picked from the page.
			await desktop(ctx.page).locator('[data-cms-block="0"] [data-cms-field="heading"]').first().click();
			await ctx.page.waitForSelector(`${BLOCK} .field-frame.is-picked .lk-field`);
			await ctx.page.click('.bar .me');
			await ctx.page.waitForSelector('[data-pop="account"]');
		},
	},
	// ── Locks ──
	{
		id: 'locked',
		live: true,
		roots: ['side', 'bar', 'overlays'],
		ours: async (ctx) => {
			await threeWaiting(ctx);
			await open(ctx.page, ctx.site.origin, '/admin/pages/about');
			await ctx.page.waitForSelector(`${SHOWN} [data-note="locked"]`);
			await desktop(ctx.page).locator('#cms-overlays .cms-veil').waitFor();
		},
	},
	{
		id: 'locked-block',
		live: true,
		roots: ['side', 'bar', 'overlays'],
		ours: async (ctx) => {
			await threeWaiting(ctx);
			await open(ctx.page, ctx.site.origin, '/admin/pages/about');
			await ctx.page.waitForSelector(`${SHOWN} [data-note="locked"]`);
			await ctx.page.click(`${DOC} .brow-main >> nth=0`);
			await ctx.page.waitForSelector(`${BLOCK} fieldset.ro-fields`);
			await desktop(ctx.page).locator('#cms-overlays .cms-veil').waitFor();
		},
	},
	{
		// The mockup replays the lapse: About opens up 1.2 s in, so it's caught after.
		id: 'lapsed',
		live: true,
		roots: ['side', 'bar', 'toast', 'overlays'],
		mockWait: 2400,
		ours: async (ctx) => {
			const about = (await threeWaiting(ctx))!;
			await open(ctx.page, ctx.site.origin, '/admin/pages/about');
			await ctx.page.waitForSelector(`${SHOWN} [data-note="locked"]`);
			await about.close({ runBeforeUnload: true });
			await eventually(async () => (await ctx.page.locator(`${SHOWN} [data-note="locked"]`).count()) === 0, 45_000, 'About editable again');
			await eventually(async () => (await desktop(ctx.page).locator('#cms-overlays .cms-veil').count()) === 0, 5000, 'the veil lifted');
		},
	},
	{
		// M4 adds it (Decision 9): your own lock in another tab, against the mockup's lock.
		id: 'elsewhere',
		mock: 'locked',
		live: true,
		roots: ['side', 'bar', 'overlays'],
		ours: async (ctx) => {
			await threeWaiting(ctx, { about: false });
			const one = await tab(ctx, '/admin/pages/about');
			await editIntro(one, 'About, edited in another tab.');
			await open(ctx.page, ctx.site.origin, '/admin/pages/about');
			await ctx.page.waitForSelector(`${SHOWN} [data-note="elsewhere"]`, { timeout: 15000 });
			await desktop(ctx.page).locator('#cms-overlays .cms-veil').waitFor();
		},
	},
	// ── Notices ──
	{
		id: 'merge',
		live: true,
		roots: ['side', 'bar', 'pops'],
		ours: async (ctx) => {
			await others(ctx);
			const edit = await tab(ctx, '/admin');
			await editIntro(edit, 'A draft change to Home.');
			await edit.close({ runBeforeUnload: true });
			const rt = await runtime();
			await eventually(() => /A draft change to Home/.test(rt.git.read('content/pages/index.json') ?? ''), 15_000, 'the sweep committed Home');
			const home = rt.backend.file('main', 'starter/content/pages/index.json')!;
			rt.backend.push('main', { 'starter/content/pages/index.json': home.replace(/"intro": "[^"]*"/, '"intro": "Changed on main."') });
			await open(ctx.page, ctx.site.origin);
			await eventually(async () => (await ctx.page.locator(`${SHOWN} [data-note="draft-kept"]`).count()) === 1, 15_000, 'the merge notice');
			await eventually(async () => (await ctx.page.locator(`${SHOWN} [data-note="elsewhere"]`).count()) === 0, 30_000, 'the closed tab\'s lock gone');
			await waiting(ctx.page, 3);
			await ctx.page.click('.bar [data-slot="publish"]');
			await ctx.page.waitForSelector('[data-pop="waiting"] [data-note="draft-kept"]');
		},
	},
	{
		id: 'published-over',
		live: true,
		roots: ['side', 'bar'],
		// Aoife's publish went live (the mockup's history says so): no deploy pipeline, so live once the refs move.
		env: { CARACMS_RUNNING_COMMIT: undefined },
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await editIntro(ctx.page, 'Niamh, before the publish.');
			await upToDoc(ctx.page);
			// Aoife publishes while Niamh has Home open.
			const aoife = await as(ctx, AOIFE, '/admin/pages/contact');
			await waiting(aoife, 1);
			await aoife.click('.bar [data-slot="publish"]');
			await aoife.locator('[data-pop="waiting"] [data-act="publish"]').click();
			await pubState(aoife, 'live');
			await eventually(async () => (await ctx.page.locator(`${SHOWN} [data-note="published-over"]`).count()) === 1, 15_000, '"published Home as it stood"');
			// Then Niamh's next change waits for the next Publish; she's back at Home's document level, no block open.
			await editIntro(ctx.page, 'Niamh, after the publish.');
			await waiting(ctx.page, 1);
			await open(ctx.page, ctx.site.origin);
			await ctx.page.waitForSelector(`${SHOWN} [data-note="published-over"]`);
		},
	},
	{
		id: 'signed-out-edit',
		live: true,
		roots: ['side', 'bar', 'modal'],
		keepFocus: true,
		ours: async (ctx) => {
			await sample(ctx);
			await ctx.page.context().clearCookies();
			await ctx.page.keyboard.type(' y');
			await eventually(async () => (await ctx.page.locator('[data-modal="signed-out"]').count()) === 1, 15_000, '"You\'ve been signed out"');
		},
	},
	{
		// M4 adds it (Decision 11): a person removed from the whitelist, against signed out while editing.
		id: 'signed-out-removed',
		mock: 'signed-out-edit',
		live: true,
		roots: ['side', 'bar', 'modal'],
		keepFocus: true,
		ours: async (ctx) => {
			await sample(ctx);
			const rt = await runtime();
			const settings = rt.git.read('content/site-settings.json')!;
			rt.backend.push('main', { 'starter/content/site-settings.json': settings.replace(NIAMH, 'someone-else@example.com') });
			await ctx.page.keyboard.type(' y');
			await eventually(async () => (await ctx.page.locator('[data-modal="removed"]').count()) === 1, 20_000, '"You can\'t sign in … any more"').catch(async (e) => {
				const c = cookieFor(ctx.site, NIAMH);
				const r = await fetch(`${ctx.site.origin}/_caracms/status`, { headers: { cookie: `${c.name}=${c.value}` } });
				throw new Error(`${e.message}; modal ${await ctx.page.getAttribute('[data-modal]', 'data-modal').catch(() => 'none')}; status ${r.status} ${(await r.text()).slice(0, 200)}; settings ${rt.git.read('content/site-settings.json')}`);
			});
		},
	},
	{
		// M4 adds it (Decision 11): edits that weren't kept, with Use mine and Discard mine, against the merge notice on Home.
		id: 'not-kept',
		mock: 'merge',
		live: true,
		roots: ['side', 'bar'],
		ours: async (ctx) => {
			// Niamh's change can't reach the server, and stays in her browser.
			const away = await tab(ctx, '/admin');
			await editIntro(away, 'Niamh, kept.');
			await away.route('**/_caracms/write', (route) => route.abort());
			await away.fill(INTRO, 'Niamh, never sent.');
			await away.waitForSelector('#bar [data-keep="offline"]', { timeout: 10000 });
			await away.close();
			// Aoife edits Home meanwhile, and is done with it.
			const aoife = await as(ctx, AOIFE, '/admin');
			await eventually(async () => (await aoife.locator(`${SHOWN} [data-note="locked"], ${SHOWN} [data-note="elsewhere"]`).count()) === 0, 60_000, 'Home free for Aoife');
			await editIntro(aoife, 'Aoife, meanwhile.');
			await aoife.close({ runBeforeUnload: true });
			const rt = await runtime();
			await eventually(() => /Aoife, meanwhile/.test(rt.git.read('content/pages/index.json') ?? ''), 15_000, 'the sweep committed Aoife\'s change');
			await open(ctx.page, ctx.site.origin);
			await eventually(async () => (await ctx.page.locator(`${SHOWN} [data-note="not-kept"]`).count()) === 1, 20_000, '"You had changes here that weren\'t kept"');
			await eventually(async () => (await ctx.page.locator(`${SHOWN} [data-note="locked"]`).count()) === 0, 30_000, 'Aoife\'s lock gone');
		},
	},
	// ── Sign-in ──
	{ id: 'si-email', live: true, as: null, page: 'signin', keepFocus: true, roots: ['signin'], ours: (ctx) => signIn(ctx, '/admin/login') },
	{ id: 'si-signedout', live: true, as: null, page: 'signin', roots: ['signin'], ours: (ctx) => signIn(ctx, '/admin/login?signedout=1') },
	{
		id: 'si-invalid',
		live: true,
		keepFocus: true,
		as: null,
		page: 'signin',
		roots: ['signin'],
		ours: async (ctx) => {
			await signIn(ctx, '/admin/login');
			await ctx.page.fill('#si-email', 'niamh@example');
			await Promise.all([ctx.page.waitForNavigation(), ctx.page.click('.si-card button[type="submit"]')]);
			await ctx.page.waitForSelector('#si-err');
		},
	},
	{
		id: 'si-sent',
		live: true,
		as: null,
		page: 'signin',
		roots: ['signin'],
		ours: async (ctx) => {
			await signIn(ctx, '/admin/login');
			await ctx.page.fill('#si-email', NIAMH);
			await Promise.all([ctx.page.waitForNavigation(), ctx.page.click('.si-card button[type="submit"]')]);
			await ctx.page.waitForSelector('.si-card .row-acts');
		},
	},
	{
		id: 'si-confirm',
		live: true,
		as: null,
		page: 'signin',
		roots: ['signin'],
		ours: async (ctx) => {
			const link = new URL(await linkFor(ctx, NIAMH));
			await signIn(ctx, link.pathname + link.search);
		},
	},
	{
		id: 'si-switch',
		live: true,
		page: 'signin',
		roots: ['signin'],
		ours: async (ctx) => {
			const link = new URL(await linkFor(ctx, AOIFE));
			await signIn(ctx, link.pathname + link.search);
			await ctx.page.waitForSelector('.si-card .who');
		},
	},
	{ id: 'si-dead', live: true, as: null, page: 'signin', roots: ['signin'], ours: (ctx) => signIn(ctx, `/admin/login/confirm?token=${'x'.repeat(43)}`) },
	{ id: 'si-backup', live: true, as: null, page: 'signin', roots: ['signin'], ours: (ctx) => signIn(ctx, '/admin/login?backup=1') },
	{
		id: 'narrow-signed',
		live: true,
		page: 'signin',
		roots: ['nwpage'],
		viewport: { width: 375, height: 812 },
		ours: (ctx) => signIn(ctx, '/admin/login/signed-in?next=/admin'),
	},
	// Sign-in at 320, 375 and 1280 (the mockup's window sizes for review).
	{ id: 'si-email-320', mock: 'si-email', mockFrame: '320', live: true, as: null, page: 'signin', roots: ['signin'], viewport: { width: 320, height: 640 }, ours: (ctx) => signIn(ctx, '/admin/login') },
	{ id: 'si-email-375', mock: 'si-email', mockFrame: 'phone', live: true, as: null, page: 'signin', roots: ['signin'], viewport: { width: 375, height: 812 }, ours: (ctx) => signIn(ctx, '/admin/login') },
	{ id: 'si-email-1280', mock: 'si-email', mockFrame: '1280', live: true, as: null, page: 'signin', roots: ['signin'], viewport: { width: 1280, height: 800 }, ours: (ctx) => signIn(ctx, '/admin/login') },
	{
		id: 'si-sent-320',
		mock: 'si-sent',
		mockFrame: '320',
		live: true,
		as: null,
		page: 'signin',
		roots: ['signin'],
		viewport: { width: 320, height: 640 },
		ours: async (ctx) => {
			await signIn(ctx, '/admin/login');
			await ctx.page.fill('#si-email', NIAMH);
			await Promise.all([ctx.page.waitForNavigation(), ctx.page.click('.si-card button[type="submit"]')]);
			await ctx.page.waitForSelector('.si-card .row-acts');
		},
	},
];

/** Accepted differences in the M4 states, each with its reason. */
const M5 = 'an M5 slot (the page menu, the media, link and button fields, groups), left empty';
const SAMPLE = "the mockup's sample content, not a difference in the design";
/** The mockup's sample accent (navy #1f2f57) and the demo's own (the brand slot's colour, M2 Decision 5). */
const NAVY = /rgb\(31, 47, 87\)/;
export const ALLOW_M4: Allow[] = [
	// As in M3's states (mockup-diff.ts → ALLOW), for the same reasons.
	{ key: /(logo-slot|si-logo) > (svg|img)$/, reason: "the site's logo is a file its config names, drawn as an <img> (the mockup inlines its sample SVG)" },
	{ root: 'overlays', prop: /^font-family$/, key: /./, reason: 'the layer loads the editor\'s Instrument Sans under its own name ("caracms UI")' },
	{ key: /rchip/, reason: 'Recent is per browser (M3 Decision 20): a fresh browser lists only what it opened; the mockup\'s strip is a sample' },
	{ key: /cur-row > div$/, kind: 'missing', reason: `${M5}: the page's "…" menu` },
	{ key: /media|with-pre|\.two\b|fgroup|\.prose|\.lrows|\.switch\b/, reason: M5 },
	{ key: /field-head > span\.field-meta$/, kind: 'missing', reason: "a field with a maximum shows a count; the demo's fields set none" },
	{ key: /note[.\w-]*\.warn[.\w-]* > svg\.i$|wmark > svg/, kind: 'style', prop: /color$/, reason: "contrast (M3 Phase 5, icons 3:1): the warning mark and a warning note's icon take the strong warning amber" },
	// M5a: the hero's Buttons field (Decision 17), as in M3's states.
	{ key: /field-frame > div\.field > div\.(btnf|list-empty)$/, reason: `${SAMPLE}: the mockup's hero has a filled button; the demo's hero has an empty Buttons field ("No buttons."), and gets no button (it would collide with the live demo's drafts)` },
	{ key: /field-head > span\.field-label$/, kind: 'extra', reason: "a field that's a group of inputs (Buttons, a list) is named by a span, not a <label> with nothing to point at (the mockup's buttons field has a <label for> whose input doesn't exist)" },
	// The brand and the people.
	{ kind: 'style', key: /./, mock: NAVY, ours: /rgb\(31, 58, 46\)/, reason: "the demo's own brand accent (its green) where the mockup has its sample navy: the accent's slots" },
	{ state: /^not-kept$/, key: /div\.side-body > div\.note\.warn$/, kind: 'style', prop: /^(border-(top|right|bottom|left)-color|box-shadow)$/, reason: "the editor restyle (Decision 6): edits that weren't kept are a failure, so their .note.warn is framed; the mockup state it's compared with is the merge notice (data-note=\"draft-kept\"), which is calm on purpose" },
	// Pinned to the focused rule's values, so a lost frame or halo still fails.
	{ state: /^si-invalid$/, key: /section\.si-card > div\.field > input\.input$/, kind: 'style', prop: /^border-(top|right|bottom|left)-color$/, ours: /^rgb\(180, 35, 24\)$/, reason: "focus: after the refused submit the address field keeps focus here (the mockup's doesn't), so its border is the focused invalid field's --status-danger (both pages have the rule)" },
	{ state: /^si-invalid$/, key: /section\.si-card > div\.field > input\.input$/, kind: 'style', prop: /^box-shadow$/, ours: /^rgba\(180, 35, 24, 0\.14\) 0px 0px 0px 3px, rgb\(220, 154, 140\) \d+px \d+px 0px 0px$/, reason: "focus: after the refused submit the address field keeps focus here (the mockup's doesn't), and since the restyle a focused invalid field shows the danger halo over its hard frame shadow (both pages have the rule)" },
	{ kind: 'style', key: /./, prop: /^box-shadow$/, mock: /oklab\(/, ours: /oklab\(/, reason: "the editor restyle (Decision 9 (b)): an accent button's pressed edge is --edge-accent, a color-mix of the accent, which computes as oklab(…) from the mockup's navy and the demo's own green, out of the catch-all accent rule's reach" },
	{ kind: 'style', key: /\.av\b[^>]*$/, prop: /^background-color$/, reason: `${SAMPLE}: a person's colour is picked from their address (format.ts → colourOf, one of the mockup's three), and the demo's Niamh and Aoife happen to get the same one` },
	// Sign-in: its own pages.
	{ root: 'signin', key: /^\(root\)$/, reason: "the sign-in page's body is the page; the mockup draws it in a positioned #signin over its editor" },
	{ root: 'nwpage', key: /^\(root\)$/, reason: "the signed-in note's body is the page; the mockup draws it in a positioned #narrow over its editor" },
	{ root: 'signin', key: /(p\.si-alt|div\.row-acts) > (a|button)\.linkbtn$/, reason: 'a link, not a button: the sign-in pages work without script (Decision 14), so switching form is a plain navigation' },
	{ state: /^si-dead$/, key: /section\.si-card > (a|button)\.accent\.block\.btn(\.dead-act)?$/, reason: '"Send a new link" is a link to the email form (no script needed); its margin is the class `dead-act` instead of an inline style, under the CSP' },
	{ state: /^narrow-signed$/, key: /nw-in > (p|form)\.fine$/, reason: 'Sign out is a form POST (Phase 3: `POST /admin/login/signout`), so its paragraph is the form' },
	{ state: /^narrow-signed$/, key: /addr > button\.btn\.sm > span$/, kind: 'extra', reason: 'the Copy label is its own span, so the script can say "Copied" without touching the icon' },
	{ state: /^si-(email|sent)-\d+$/, key: /main\.si-main$/, prop: /^padding-top$/, reason: "the top padding is clamp(28px, 9vh, 96px): the mockup's window sizes scale a fixed box inside a 1440 × 900 window, so its vh is the window's, not the box's" },
	// Publish (Decisions 12 and 18).
	{ state: /^live$/, root: 'pops', key: /pop-f > (a|button)\.btn$/, reason: '"View the live site" is a link to the site (it opens in a new tab), not a button' },
	{ state: /^failed-no-token$/, key: /(pub > span\.(off\.)?pb|pop-f > button\.btn\.ink\.lg)$/, reason: "Decision 12: with no Railway token there's no Try again; the failed state says a developer can redeploy from Railway" },
	{ state: /^history$/, key: /td\.docs > small$/, kind: 'missing', reason: 'the history entry has no "failed first, live after Try again" note: the contract (HistoryEntryView) carries no record of a Try again' },
	{ state: /^history$/, key: /table\.hist > tbody > tr > td\.\w+$/, prop: /^border-top-(width|style)$/, reason: `${SAMPLE}: the rule is between rows, and the demo's history has one publish` },
	// Locks and notices.
	{ key: /span\.nm > span\.chip\.(shared|phone)$|field-head > span\.chip\.phone$|lk-field > div\.lk-phone-sum$/, reason: `${SAMPLE}: the mockup's About has a shared block; the demo's About hero has phone lines` },
	{ key: /span\.nm > span\.chip\.warn$|span\.meta > span\.wmark$/, kind: 'extra', reason: "the \"too long for mobile\" marks are the mockup's own (browHTML, metaFor), but its sidebar isn't redrawn after it measures the phone frame (as in M3's states)" },
	{ state: /^signed-out-(edit|removed)$/, root: 'side', key: /side-body( > div\.field-frame(\.is-picked)? > div\.field(\.lk-field)?( > (p\.field-help|textarea\.input))?)?$/, reason: "the held change is typed into the hero's intro, so the intro is the picked field; the mockup's default has the Heading picked" },
	{ state: /^signed-out-removed$/, root: 'modal', key: /dialog > (div\.acts|p\.field-help|p)$/, reason: "Decision 11 (a state M4 adds): a removed person has no way back, so there's no Sign in again, and the body is one paragraph" },
	{ state: /^not-kept$/, key: /blist > li\.brow(\.is-disabled)?$|side-body > button\.add-row$|bar-e > span\.keep(\.loud)?$/, reason: "Decision 11 (a state M4 adds): with edits held, the document is read-only until Use mine or Discard mine (rows off, Add block off), and the bar says Not kept" },
	{ state: /^locked(-block)?$/, key: /lock\.note > div > div\.acts$/, kind: 'extra', reason: "Take over (M4 Decision 9, added during a walk on 2026-10-15, after the mockup): someone else's lock note offers Take over, in the lock note's language" },
	{ state: /^elsewhere$/, key: /lock\.note > div > div\.acts$/, kind: 'extra', reason: 'Decision 9 (a state M4 adds): your own lock in another tab offers Edit here, in the lock note\'s language' },
];



/**
 * One live state on its own (M4's, or M5b's live ones), for the chrome's checks
 * (chrome-live*.visual.test.ts): a fresh runtime, the state's environment, a page signed
 * in as the state says, driven into the state. A state with sample content of its own
 * (`setup`, M5b's) gets the pinned content with it, and the content is put back after;
 * an M5b state also gets the in-memory library (mockup-diff-m5b.ts). `close` puts the
 * environment back and closes everything it opened.
 */
export async function openLiveState(
	state: State,
	options: { browser: import('playwright-core').Browser; site: import('./helpers/dev-site.ts').DevSite; reducedMotion?: 'reduce' | 'no-preference' },
): Promise<{ page: Page; ctx: Ctx; close: () => Promise<void> }> {
	const { browser, site } = options;
	const pinned = () => {
		rmSync(join(site.root, 'content'), { recursive: true, force: true });
		cpSync(demoContent, join(site.root, 'content'), { recursive: true });
	};
	if (state.setup) {
		pinned();
		state.setup(site);
	}
	if (state.m5b) seedLibrary();
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(state.env ?? {})) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	const { resetLive } = await import('./helpers/live-site.ts');
	await resetLive();
	const context = await browser.newContext({ viewport: state.viewport ?? { width: 1440, height: 900 }, reducedMotion: options.reducedMotion ?? 'reduce' });
	await mediaOffline(context);
	const who = state.as === undefined ? NIAMH : state.as;
	if (who) await context.addCookies([cookieFor(site, who)]);
	const page = await context.newPage();
	page.on('pageerror', (e) => console.error(`[${state.id}] page error:`, e.message));
	const ctx: Ctx = { page, site, browser, extra: [] };
	const close = async () => {
		for (const c of ctx.extra) await c.close().catch(() => {});
		await context.close();
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		if (state.setup) pinned();
	};
	try {
		await state.ours(ctx);
	} catch (error) {
		await close();
		throw error;
	}
	return { page, ctx, close };
}

export const liveState = (id: string): State => {
	const s = STATES_M4.find((x) => x.id === id) ?? STATES_M5B.find((x) => x.id === id && x.live);
	if (!s) throw new Error(`no live state ${id}`);
	return s;
};
