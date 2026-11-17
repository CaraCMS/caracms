/**
 * The guard as Astro middleware (M4 Decision 14), registered by the integration with
 * `addMiddleware({ order: 'pre' })` after Phase 2's 503 middleware for an
 * unconfigured server. The check itself is guard.ts.
 *
 * - **Local mode: it does nothing** (M3's behaviour, no sign-in; Decision 1).
 * - **Live mode**: a path outside `/admin` and `/_caracms/` goes straight on, without
 *   even building the runtime, so the public site never waits on GitHub or Redis.
 *   A guarded path that passes records the person (`setPerson`) for the route.
 * - **Unconfigured** never reaches here in a correct setup (Phase 2's middleware
 *   answers first); if it does, a guarded path gets a 503 rather than through. The
 *   public form endpoint's POST is the exception: Phase 2 lets it through, and so does this, since
 *   a site's forms work without the editor (M6 Decision 5; a port found it
 *   answering 503 here until the GitHub App's variables were set). A GET to it is as
 *   unavailable as any other guarded path, as live mode's let-through is POST-only too.
 *
 * - **A start that fails** answers 503 and the next request tries again (runtime.ts). When
 *   CaraCMS Cloud refused the start or couldn't be reached (caracms-cloud M2 Decision 14), the
 *   answer is the cloud's own sentence, as an HTML page with its install link as a link
 *   (JSON under `/_caracms/`, as ../../editor/middleware.ts answers); any other failure keeps
 *   the plain sentence. Neither the log line nor the page carries the site key or a token.
 *
 * The mode is Phase 2's `editorMode()`, so the two agree on live and local.
 */
import type { MiddlewareHandler } from 'astro';
import { site } from 'virtual:caracms/config';
import { editorMode } from '../../editor/server/mode.ts';
import { isCloudRefusal, cloudUnavailable } from '../cloud.ts';
import { setPerson } from '../locals.ts';
import { guard, isFormEndpoint, isGuardedPath } from './guard.ts';
import { authFor } from './index.ts';

const unavailable = (text: string) => new Response(text, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } });

export const onRequest: MiddlewareHandler = async (context, next) => {
	if (!isGuardedPath(context.url.pathname)) return next();
	const mode = editorMode();
	if (mode.kind === 'local') return next();
	if (mode.kind !== 'live') return isFormEndpoint(context.url.pathname) && context.request.method === 'POST' ? next() : unavailable("The editor isn't set up on this server yet.");

	let auth;
	try {
		auth = await authFor(site, mode.settings, context.site);
	} catch (error) {
		if (isCloudRefusal(error)) {
			console.error(`[caracms] sign-in: the live runtime could not start: CaraCMS Cloud (${error.error}): ${error.message}`);
			return cloudUnavailable(error, context.url.pathname.startsWith('/_caracms/'));
		}
		console.error('[caracms] sign-in: the live runtime could not start:', error);
		return unavailable("The editor couldn't start. Try again in a moment.");
	}
	const result = guard(context.request, auth);
	if (result.kind === 'respond') return result.response;
	if (result.kind === 'skip') return next();

	setPerson(context.locals, result.person);
	const response = await next();
	if (!result.setCookie) return response;
	try {
		response.headers.append('Set-Cookie', result.setCookie);
		return response;
	} catch {
		// Immutable headers (a Response.redirect): copy it.
		const copy = new Response(response.body, response);
		copy.headers.append('Set-Cookie', result.setCookie);
		return copy;
	}
};
