/**
 * `POST /_caracms/form` (M6 Decision 5): the public forms' endpoint, on demand. Public in
 * every mode: the guard lets it through and the unconfigured 503 exempts it. The rules
 * are endpoint.ts's.
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { handleForm } from './endpoint.ts';

export const prerender = false;

export const ALL: APIRoute = (context) =>
	handleForm(context.request, {
		site,
		astroSite: context.site,
		// Astro's getter throws where the adapter gives no address (tests' containers).
		clientAddress: () => {
			try {
				return context.clientAddress;
			} catch {
				return undefined;
			}
		},
	});
