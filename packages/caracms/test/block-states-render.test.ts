// Review gaps, block states on the server (Decisions 6–8, Contracts →
// Preview, Acceptance 12 and 15), on the package's fixture (helpers/site-render.ts), through Astro's
// container. A pinned copy's Form block says which state it was given (`data-test-state`), so this
// checks the context, not a form's markup (site-form-render covers that):
// - `cms.state` is the asked-for key on the asked-for block only, in a preview;
// - an unknown block index or key, a public render and a preview that asked for none all give null;
// - `states` is checked by resolveSite.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pinnedSite, root, startRenderer, type Renderer } from './helpers/site-render.ts';

const copy = pinnedSite('block-states');
const component = join(copy.root, 'src/blocks/Form.astro');
writeFileSync(component, readFileSync(component, 'utf8').replace('<Block cms={cms} class="band bg-light form-block">', '<Block cms={cms} class="band bg-light form-block" data-test-state={String(cms.state)}>'));
const heroComponent = join(copy.root, 'src/blocks/Hero.astro');
writeFileSync(heroComponent, readFileSync(heroComponent, 'utf8').replace(/<Block cms=\{cms\}/, '<Block cms={cms} data-test-hero-state={String(cms.state)}'));

let r: Renderer;
let site: any;
let parseAnyDocument: (raw: unknown, site: unknown, collection: unknown) => any;
before(async () => {
	r = await startRenderer(copy.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseAnyDocument } = await r.load('caracms/document'));
});
after(async () => {
	await r?.close();
	copy.close();
});

const contact = () => parseAnyDocument(JSON.parse(readFileSync(join(copy.root, 'content/pages/contact.json'), 'utf8')), site, site.collections.pages);
/** Contact as RenderDocument draws it, with the render state the preview route would set (read.ts → setRenderState). */
async function render(preview: boolean, state: { block: number; name: string } | null) {
	const { setRenderState } = await r.load(join(root, 'src/read.ts'));
	const locals: Record<string, unknown> = {};
	if (state) setRenderState(locals, state);
	return r.page('caracms/components/RenderDocument.astro', { document: contact(), collection: 'pages', preview, previewPath: 'contact' }, 'http://localhost/contact', locals);
}
const formState = (html: string) => /data-test-state="([^"]*)"/.exec(html)?.[1];
const heroState = (html: string) => /data-test-hero-state="([^"]*)"/.exec(html)?.[1];

describe('cms.state (Decision 8)', () => {
	test('the fixture Form block declares its states', () => {
		assert.deepEqual(site.blocks.form.states, { sent: 'Sent', error: 'Couldn’t send', invalid: 'Invalid' });
	});

	test('in a preview, the asked-for block gets the key; the others get null', async () => {
		const html = await render(true, { block: 1, name: 'sent' });
		assert.equal(formState(html), 'sent');
		assert.equal(heroState(html), 'null');
	});

	test('an unknown key, another block’s index, or a block without states: null', async () => {
		assert.equal(formState(await render(true, { block: 1, name: 'shouting' })), 'null');
		assert.equal(formState(await render(true, { block: 0, name: 'sent' })), 'null');
		assert.equal(heroState(await render(true, { block: 0, name: 'sent' })), 'null');
	});

	test('a preview that asked for none, and a public render even with a state set: null (Acceptance 15)', async () => {
		assert.equal(formState(await render(true, null)), 'null');
		assert.equal(formState(await render(false, { block: 1, name: 'sent' })), 'null');
		assert.equal(formState(await render(false, null)), 'null');
	});
});

describe('states in the config (Decision 6)', () => {
	test('resolveSite checks the keys and labels', async () => {
		const { resolveSite } = await r.load('caracms/config');
		const config = (states: unknown) => ({
			collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/' } },
			blocks: { form: { component: 'src/blocks/Form.astro', fields: {}, states } },
			page: 'src/components/Page.astro',
		});
		assert.deepEqual(resolveSite(config({ sent: ' Sent ' }), copy.root).blocks.form.states, { sent: 'Sent' });
		assert.equal(resolveSite(config({}), copy.root).blocks.form.states, undefined);
		assert.throws(() => resolveSite(config(['sent']), copy.root), /block "form": states must be an object/);
		assert.throws(() => resolveSite(config({ 'sent ok': 'Sent' }), copy.root), /block "form": state "sent ok": a state's key starts with a letter/);
		assert.throws(() => resolveSite(config({ sent: '' }), copy.root), /block "form": state "sent" needs a label/);
	});
});
