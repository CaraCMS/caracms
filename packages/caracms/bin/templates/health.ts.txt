import type { APIRoute } from 'astro';

// Railway's healthcheck: answered by the server, not prerendered.
export const prerender = false;

export const GET: APIRoute = () => new Response('ok');
