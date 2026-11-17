// Review gaps, the starter's part, on the pinned content:
// - Acceptance 20: the Form block has the states Sent, Couldn't send and Invalid, each drawing its
//   words, typed on the page (rendered through the container, as the preview route renders);
// - Acceptance 27: the starter is quiet under `caracms audit` (a copy of it, with the pinned content).
// The package's own tests cover the mechanics (block-states-render, form-words-render, audit).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { FAKE_MEDIA_ENV } from './helpers/dist.ts';
import { count, pinnedSite, root, startRenderer, type Renderer } from './helpers/render.ts';

describe('the Form block’s states (Decision 14, Acceptance 20)', () => {
	const demo = pinnedSite('review-gaps-states');
	let r: Renderer;
	let site: any;
	let parseAnyDocument: (raw: unknown, site: unknown, collection: unknown) => any;
	before(async () => {
		r = await startRenderer(demo.root);
		({ site } = await r.load('virtual:caracms/config'));
		({ parseAnyDocument } = await r.load('caracms/document'));
	});
	after(async () => {
		await r?.close();
		demo.close();
	});

	/** Contact (a Hero, then the Form block at index 1) in a preview, with the state the preview route would set. */
	async function contact(state: string | null) {
		const { setRenderState } = await r.load(join(root, '../packages/caracms/src/read.ts'));
		const locals: Record<string, unknown> = {};
		if (state) setRenderState(locals, { block: 1, name: state });
		const document = parseAnyDocument(JSON.parse(readFileSync(join(demo.root, 'content/pages/contact.json'), 'utf8')), site, site.collections.pages);
		assert.equal(document.blocks[1].type, 'form', 'the pinned Contact page has its Form block second');
		const html = await r.page('caracms/components/RenderDocument.astro', { document, collection: 'pages', preview: true, previewPath: 'contact' }, 'http://localhost/contact', locals);
		return /<form[\s\S]*?<\/form>|<div class="cms-form-sent"[\s\S]*?<\/div>/.exec(html)?.[0] ?? html;
	}

	test('the block declares Sent, Couldn’t send and Invalid', () => {
		assert.deepEqual(site.blocks.form.states, { sent: 'Sent', error: 'Couldn’t send', invalid: 'Invalid' });
	});

	test('its first look has none of them', async () => {
		const form = await contact(null);
		assert.match(form, /id="cms-form-contact-name"/);
		assert.doesNotMatch(form, /cms-form-invalid|cms-form-failed|cms-form-sent/);
	});

	test('Sent: the sent heading, typed on the page, in place of the fields', async () => {
		const form = await contact('sent');
		assert.match(form, /<p class="cms-form-sent-heading" data-cms-field="formWords\.contact\.sent\.heading"[^>]*>Thanks, it’s sent<\/p>/);
		assert.doesNotMatch(form, /id="cms-form-contact-name"/);
	});

	test('Couldn’t send: the failed line, typed on the page', async () => {
		const form = await contact('error');
		assert.match(form, /cms-form-failed"[^>]*data-cms-field="formWords\.contact\.failed"[^>]*>Something went wrong\. Please email us directly\./);
	});

	test('Invalid: every required field shows its error, the optional ones don’t', async () => {
		const form = await contact('invalid');
		// Contact's required fields: name, email, kind, message; optional: phone, files.
		assert.equal(count(form, /cms-form-field cms-form-invalid/g), 4);
	});
});

describe('the starter under caracms audit (Acceptance 27)', () => {
	test('quiet: its words are all marked or fixed', () => {
		const demo = pinnedSite('review-gaps-audit');
		try {
			const out = execFileSync(join(root, 'node_modules/.bin/caracms'), ['audit', '--json'], { cwd: demo.root, env: { ...process.env, ...FAKE_MEDIA_ENV }, encoding: 'utf8', timeout: 120_000 });
			const { findings } = JSON.parse(out) as { findings: { kind: string; message: string }[] };
			assert.deepEqual(findings.map((f) => `${f.kind}: ${f.message}`), []);
		} finally {
			demo.close();
		}
	});
});
