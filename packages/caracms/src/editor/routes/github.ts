/**
 * POST /_caracms/github: GitHub's push webhook (M4 Decision 14). It only prompts the
 * check that keeps `drafts` up to date with `main` (Decision 8); the logic, and what
 * it refuses, is in ../../live/webhook.ts.
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { liveEditor } from '../../live/editor.ts';
import { handleGithubWebhook } from '../../live/webhook.ts';
import { editorMode } from '../server/mode.ts';

export const prerender = false;

export const ALL: APIRoute = ({ request }) => {
	const mode = editorMode(); // local mode: 404 (no secret)
	if (mode.kind !== 'live') return handleGithubWebhook(request, { secret: null, trigger: async () => {} });
	const { settings } = mode;
	return handleGithubWebhook(request, {
		secret: settings.webhookSecret,
		// The editor, not just the runtime: the merge commits pending autosaves first (the sweep fills that hook).
		trigger: async () => (await liveEditor(site, settings)).runtime.git.check({ force: true }),
	});
};
