/**
 * Sign-in's routes and middleware, for the integration (src/index.ts), which injects
 * them beside the editor's. One route serves every `/admin/login…` page (login.ts);
 * Astro ranks it above `/admin/[...path]`.
 */
export const LOGIN_ROUTES = [{ pattern: '/admin/login/[...path]', entrypoint: 'editor/routes/login/login.ts' }] as const;

/** The guard, relative to src/ (index.ts resolves it against its own URL). */
export const GUARD_MIDDLEWARE = 'live/auth/middleware.ts';
