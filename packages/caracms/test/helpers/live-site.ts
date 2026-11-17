/**
 * The demo in live mode for M4's browser tests (Phase 4 → Verify 1–5): a copy under
 * `astro dev` (dev-site.ts) on the in-memory GitHub and the Redis stand-in
 * (`CARACMS_GITHUB=memory`, Decision 2), never a real repo, with short sweep and lock
 * timings (`CARACMS_TIMINGS`). People are signed in with a session cookie made here
 * (`sessionCookieFor`), not through the sign-in pages.
 *
 * The dev server runs in this process, so the test reaches the live runtime itself
 * (`runtime()`: the in-memory backend's `push` and `deployments`), and `resetLive()`
 * forgets the mode, the runtime and the live editor so the next request builds them
 * again from the environment as it is then.
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sessionCookieFor } from '../../src/live/auth/session.ts';
import type { MemoryBackend } from '../../src/live/backend.ts';
import { existingLiveRuntime, resetLiveRuntime, type LiveRuntime } from '../../src/live/runtime.ts';
import { startDevSite, type DevSite } from './dev-site.ts';

export const SECRET = 'a-test-secret-for-the-live-editor-0123456789';
export const AOIFE = 'aoife@example.com';
export const CIARAN = 'ciaran@example.com';

export interface LiveSite {
	site: DevSite;
	/** Put the environment back and stop the server. */
	close(): Promise<void>;
}

/** `edit` changes the copy before the server starts (its config, say), as startDevSite's does. */
export async function startLiveSite(name: string, env: Record<string, string> = {}, options: { edit?: (root: string) => void } = {}): Promise<LiveSite> {
	const all: Record<string, string> = {
		CARACMS_GITHUB: 'memory',
		CARACMS_SECRET: SECRET,
		CARACMS_ALLOW: `${AOIFE},${CIARAN}`,
		...env,
	};
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(all)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	await resetLive();
	const site = await startDevSite(name, options);
	return {
		site,
		async close() {
			await site.close();
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			await resetLive();
		},
	};
}

/** Forget the process's mode, live runtime, live editor and sign-in (the next request reads the environment again). */
export async function resetLive(): Promise<void> {
	const g = globalThis as Record<symbol, unknown>;
	delete g[Symbol.for('caracms.editorMode')];
	delete g[Symbol.for('caracms.liveEditor')];
	// Sign-in reads the whitelist through the runtime it was made with.
	delete g[Symbol.for('caracms.auth')];
	await resetLiveRuntime();
}

/** The live runtime the dev server built, and its in-memory GitHub. */
export async function runtime(): Promise<LiveRuntime & { backend: MemoryBackend }> {
	const rt = existingLiveRuntime();
	if (!rt) throw new Error('no live runtime yet: load /admin first');
	return (await rt) as LiveRuntime & { backend: MemoryBackend };
}

/** A browser context signed in as this person (their own cookie jar, so their own tabs). */
export async function signedIn(browser: Browser, site: DevSite, email: string): Promise<BrowserContext> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await context.addCookies([cookieFor(site, email)]);
	return context;
}

export function cookieFor(site: DevSite, email: string) {
	const pair = sessionCookieFor({ email }, SECRET);
	const eq = pair.indexOf('=');
	return { name: pair.slice(0, eq), value: pair.slice(eq + 1), url: site.origin };
}

export async function openAdmin(context: BrowserContext, site: DevSite, path = '/admin'): Promise<Page> {
	const page = await context.newPage();
	page.on('pageerror', (error) => console.error('[page]', error.message));
	page.on('console', (message) => {
		if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) console.error('[console]', message.text());
	});
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	return page;
}

/** Wait until `check` holds, polling (no fixed sleeps in assertions). */
export async function eventually<T>(check: () => T | Promise<T>, timeout = 15000, what = 'the condition'): Promise<T> {
	const end = Date.now() + timeout;
	let last: unknown;
	while (Date.now() < end) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

export const keepState = (page: Page) => page.getAttribute('[data-keep]', 'data-keep');
