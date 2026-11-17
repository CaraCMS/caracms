/**
 * The editor's mode at run time (M4 Decision 1), and the drafts store it implies.
 *
 * - `editorMode()`: `readMode(process.env, isProductionServer(), bakedAtBuild())`, read once per
 *   process. **A production server is the build**, not `NODE_ENV`: the integration
 *   sets `__CARACMS_PRODUCTION__` (a Vite define) to `command !== 'dev'`, so the
 *   built server is always live mode (or unconfigured), and `astro dev` is local
 *   unless the App or `CARACMS_GITHUB=memory` is set. Phase 3's guard reads the
 *   mode here too, so the two never disagree.
 * - Unconfigured: the missing variables are logged once, on the first read (the
 *   503 itself is ../middleware.ts's).
 * - `editorStore(site)`: local mode's disk store (M3, unchanged), or live mode's
 *   (../../live/drafts-store.ts). `liveEditorOf(site)`: live mode's handlers, or null.
 */
import type { ResolvedSite } from '../../config.ts';
import { liveEditor, type LiveEditor } from '../../live/editor.ts';
import { readMode, unconfiguredMessage, type Baked, type Mode } from '../../live/mode.ts';
import { bakedServices } from '../../live/services.ts';
import { localDraftsStore, type DraftsStore } from './drafts-store.ts';

declare const __CARACMS_PRODUCTION__: boolean | undefined;
declare const __CARACMS_SITE__: string | null | undefined;
declare const __CARACMS_BUILD_COMMIT__: string | null | undefined;

/** True in the built server (`astro build`), false under `astro dev` and in plain Node (tests). */
export function isProductionServer(): boolean {
	return typeof __CARACMS_PRODUCTION__ === 'boolean' ? __CARACMS_PRODUCTION__ : false;
}

/** The site's address, the commit and the config's `services` the build baked in (runs-anywhere Decisions 7 and 9, caracms-cloud M5 Decision 1); empty in plain Node (tests). */
export function bakedAtBuild(): Baked {
	return {
		site: typeof __CARACMS_SITE__ === 'string' ? __CARACMS_SITE__ : null,
		commit: typeof __CARACMS_BUILD_COMMIT__ === 'string' ? __CARACMS_BUILD_COMMIT__ : null,
		services: bakedServices(),
	};
}

const SHARED = Symbol.for('caracms.editorMode');
type Shared = { [SHARED]?: Mode };

/** The mode, read once per process. Sync, no arguments. */
export function editorMode(): Mode {
	const g = globalThis as Shared;
	if (!g[SHARED]) {
		const mode = readMode(process.env, isProductionServer(), bakedAtBuild());
		if (mode.kind === 'unconfigured') console.error(`[caracms] ${unconfiguredMessage(mode)} The public site is served; /admin answers 503.`);
		g[SHARED] = mode;
	}
	return g[SHARED];
}

/** Forget the mode read (tests that change the environment). */
export function resetEditorMode(): void {
	delete (globalThis as Shared)[SHARED];
}

/** Live mode's editor server, or null in local mode. Unconfigured never gets here (the middleware's 503). */
export async function liveEditorOf(site: ResolvedSite): Promise<LiveEditor | null> {
	const mode = editorMode();
	if (mode.kind === 'local') return null;
	if (mode.kind === 'unconfigured') throw new Error(`caracms: ${unconfiguredMessage(mode)}`);
	return liveEditor(site, mode.settings);
}

const local = new WeakMap<object, DraftsStore>();

/** The drafts store for the mode: disk (local) or Redis over the `drafts` copy (live). */
export async function editorStore(site: ResolvedSite): Promise<DraftsStore> {
	const live = await liveEditorOf(site);
	if (live) return live.store;
	let store = local.get(site);
	if (!store) local.set(site, (store = localDraftsStore(site)));
	return store;
}
