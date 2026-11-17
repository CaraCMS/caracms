/**
 * Site Settings as they apply to the running site (M5a Decision 10): `editors` and
 * `brand` are read from the **committed** copy, never an autosave, so a half-typed
 * value is never site-wide.
 *
 * - Live mode: the `drafts` copy (`git.read`), as M4's whitelist reads `editors`
 *   (live/auth/allow.ts). Site Settings' autosave is swept at once (live/sweep.ts →
 *   `ready`), so a kept change applies on the sweep's next tick.
 * - Local mode: the file on disk, read on every call, so it applies on the next request.
 *
 * The brand: Site Settings' `brand.name` (else "Site") and `brand.accent` (else the
 * editor's neutral accent, `--accent` in tokens.css), and its `brand.logo` and
 * `brand.icon` as signed URLs (M5b Decision 11).
 *
 * One exception, in the browser only (editor restyle, Decision 12, amending Decision 10):
 * an accent preset picked in Site Settings paints that tab's editor at once, before it's
 * kept, since a preset can't be half-typed. Other people and tabs still see it only once
 * it's kept, through this file (the sweep's next tick in live mode, the next load in local).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SITE_SETTINGS_FILE, type Brand, type ResolvedSite } from '../../config.ts';
import { brandFrom } from '../brand.ts';
import { editorMode, liveEditorOf } from './mode.ts';

export { brandFrom, DEFAULT_BRAND_NAME, editorBrand } from '../brand.ts';

/** Site Settings' committed text for the mode: the `drafts` copy (live) or the disk (local); null when there's none. */
export async function committedSettingsText(site: ResolvedSite): Promise<string | null> {
	if (editorMode().kind === 'live') {
		const live = await liveEditorOf(site);
		return live!.runtime.git.read(SITE_SETTINGS_FILE);
	}
	return readFile(join(site.root, SITE_SETTINGS_FILE), 'utf8').catch(() => null);
}

/** The brand as it applies now (Decision 10). */
export async function currentBrand(site: ResolvedSite): Promise<Brand> {
	return brandFrom(await committedSettingsText(site), site);
}
