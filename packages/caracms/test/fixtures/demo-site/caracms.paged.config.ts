import { date, defineSite } from 'caracms/config';
import base from './caracms.config.ts';
import { listing } from './src/blocks/listing.ts';

/**
 * Posts and tags (Decisions 12, 14–16): the fixture site with a paged list block and a `date`
 * page field on the journal, for the package's tests of a page number reaching blocks, routes
 * reading documents with their fields, and the " — page N" title. A copy built by
 * `pagedSite()` (test/helpers/site-render.ts) uses it; the fixture's own config stays as it was.
 */
export default defineSite({
	...base,
	collections: { ...base.collections, journal: { ...base.collections.journal, fields: { ...base.collections.journal.fields, date: date() } } },
	blocks: { ...base.blocks, listing },
});
