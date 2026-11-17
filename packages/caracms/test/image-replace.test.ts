// Replace… on an image: every use of the old key, in every document the store lists, takes
// the new key and the new image's size; each keeps its alt text, decorative flag and other
// members, and its focal point unless resetFocal. On the memory bucket (`CARACMS_MEDIA=memory`).
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { defineSite, link, list, media, resolveSite, text, type SiteConfig } from '../src/config.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { handleMedia, type MediaContext } from '../src/editor/server/media/handler.ts';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { parseReplaceBody, reimageText } from '../src/editor/server/replace.ts';

const OLD = 'uploads/aaaaaaaaaaaa/headshot.jpg';
const NEW = 'uploads/bbbbbbbbbbbb/headshot-v2.jpg';
const OTHER = 'uploads/cccccccccccc/harbour.jpg';
const RATE = 'uploads/3f9c2a71b0e4/rate-card.pdf';

const root = mkdtempSync(join(tmpdir(), 'caracms-image-replace-'));
after(() => rmSync(root, { recursive: true, force: true }));

const files: Record<string, unknown> = {
	'content/pages/index.json': {
		title: 'Home',
		cover: { key: OLD, alt: 'Aoife at the harbour', focal: [0.4, 0.3], w: 4000, h: 2667 },
		blocks: [
			{ type: 'hero', image: { key: OLD, alt: 'Aoife', w: 4000, h: 2667 } },
			{ type: 'gallery', images: [{ key: OTHER, alt: 'The harbour', w: 10, h: 10 }, { key: OLD, alt: '', decorative: true, focal: [0.5, 0.5], w: 4000, h: 2667 }] },
			{ type: 'gone-block', photo: { key: OLD, alt: 'kept in an unknown block', extra: 'mine' } },
			{ shared: 'team' },
		],
	},
	'content/pages/about.json': { title: 'About', blocks: [{ type: 'hero', image: { key: OTHER, alt: 'Not this one', w: 10, h: 10 } }] },
	'content/shared/team.json': { title: 'Team', block: { type: 'hero', image: { key: OLD, alt: 'Aoife, founder' } } },
	'content/site-settings.json': { title: 'Site Settings', brand: { name: 'CaraCMS', accent: '#225544', logo: { key: OLD, w: 4000, h: 2667 } }, note: OLD, redirects: [] },
};
for (const [file, value] of Object.entries(files)) {
	mkdirSync(join(root, file, '..'), { recursive: true });
	writeFileSync(join(root, file), JSON.stringify(value, null, 2) + '\n');
}
writeFileSync(join(root, 'Block.astro'), '---\n---\n');

const config = defineSite({
	repoPath: 'starter',
	collections: {
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true, fields: { cover: media({ only: 'image' }), brochure: link() } },
	},
	blocks: {
		hero: { label: 'Hero', component: 'Block.astro', fields: { image: media() } },
		gallery: { label: 'Gallery', component: 'Block.astro', fields: { images: list(media({ only: 'image' })) } },
	},
	settings: { fields: { note: text() } },
	page: 'Block.astro',
	textStyles: {},
} as SiteConfig);
const site = resolveSite(config, root);

const ORIGIN = 'http://site.test';
const MEMORY = { CARACMS_MEDIA: 'memory' };
const mem = memoryMedia();
beforeEach(() => mem.reset());

const copy = () => {
	const dir = mkdtempSync(join(tmpdir(), 'caracms-image-replace-'));
	cpSync(root, dir, { recursive: true });
	const copied = resolveSite(config, dir);
	return { dir, ctx: { site: copied, store: localDraftsStore(copied), mode: 'local', person: null, env: MEMORY, production: false, log: () => {} } as MediaContext };
};
const replace = async (body: unknown, ctx: MediaContext) => {
	const res = await handleMedia(
		new Request(`${ORIGIN}/_caracms/media/replace`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-caracms-tab': 'tab-aoife-0001' }, body: JSON.stringify(body) }),
		ctx,
	);
	return { status: res.status, body: (await res.json()) as { relinked?: { collection: string; path: string; links: number }[]; error?: string; code?: string } };
};

describe('reimageText', () => {
	const home = () => readFileSync(join(root, 'content/pages/index.json'), 'utf8');
	test('every value with the old key takes the new key and size; alt, decorative, focal and unknown members kept, on one line', () => {
		const out = reimageText(home(), { from: OLD, to: NEW, size: { w: 1200, h: 1600 } });
		assert.equal(out.links, 4);
		const doc = JSON.parse(out.text);
		assert.deepEqual(doc.cover, { key: NEW, alt: 'Aoife at the harbour', focal: [0.4, 0.3], w: 1200, h: 1600 });
		assert.deepEqual(doc.blocks[0].image, { key: NEW, alt: 'Aoife', w: 1200, h: 1600 });
		assert.deepEqual(doc.blocks[1].images[0], { key: OTHER, alt: 'The harbour', w: 10, h: 10 }, 'another image is left');
		assert.deepEqual(doc.blocks[1].images[1], { key: NEW, alt: '', decorative: true, focal: [0.5, 0.5], w: 1200, h: 1600 });
		assert.deepEqual(doc.blocks[2].photo, { key: NEW, alt: 'kept in an unknown block', extra: 'mine', w: 1200, h: 1600 }, 'a size it had none of is added after the rest');
		assert.match(out.text, new RegExp(`"cover": \\{ "key": "${NEW}", "alt": "Aoife at the harbour", "focal": \\[0\\.4, 0\\.3\\], "w": 1200, "h": 1600 \\}`));
		assert.equal(out.text.replace(/\{ "key"[^\n]*\}/g, '').includes('headshot.jpg'), false);
	});

	test('resetFocal drops each focal point; an unknown size drops w and h; no use leaves the text as it was', () => {
		const doc = JSON.parse(reimageText(home(), { from: OLD, to: NEW, resetFocal: true, size: { w: null, h: null } }).text);
		assert.deepEqual(doc.cover, { key: NEW, alt: 'Aoife at the harbour' });
		assert.deepEqual(doc.blocks[1].images[1], { key: NEW, alt: '', decorative: true });
		const about = readFileSync(join(root, 'content/pages/about.json'), 'utf8');
		assert.deepEqual(reimageText(about, { from: OLD, to: NEW }), { text: about, links: 0 });
	});
});

describe('parseReplaceBody for images', () => {
	test('an image takes an image, resetFocal only for images; the same key is refused', () => {
		assert.deepEqual(parseReplaceBody({ from: OLD, to: NEW, resetFocal: true }), { from: OLD, to: NEW, resetFocal: true });
		assert.deepEqual(parseReplaceBody({ from: OLD, to: NEW, resetFocal: false }), { from: OLD, to: NEW });
		assert.throws(() => parseReplaceBody({ from: OLD, to: RATE }), /an image is replaced by an image/);
		assert.throws(() => parseReplaceBody({ from: RATE, to: OLD }), /"to" must be a file's key/);
		assert.throws(() => parseReplaceBody({ from: RATE, to: 'uploads/3f9c2a71b0e5/b.pdf', resetFocal: true }), /a file has no focal point/);
		assert.throws(() => parseReplaceBody({ from: OLD, to: OLD }), /same image/);
		assert.throws(() => parseReplaceBody({ from: OLD, to: NEW, size: { w: 1, h: 1 } }), /unexpected keys/, 'the size is the route’s, never the editor’s');
	});
});

describe('Replace… on an image in local mode', () => {
	test('every document that uses it changes, Site Settings’ logo and a shared block included; the size comes from the bucket; plain text is left', async () => {
		const c = copy();
		try {
			mem.bucket.seed(OLD, { w: 4000, h: 2667 });
			mem.bucket.seed(NEW, { w: 1200, h: 1600 });
			const r = await replace({ from: OLD, to: NEW }, c.ctx);
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(r.body.relinked!.map((u) => `${u.collection}/${u.path} ×${u.links}`).sort(), ['pages/index ×4', 'settings/site-settings ×1', 'shared/team ×1']);
			const read = (file: string) => JSON.parse(readFileSync(join(c.dir, file), 'utf8'));
			assert.deepEqual(read('content/shared/team.json').block.image, { key: NEW, alt: 'Aoife, founder', w: 1200, h: 1600 });
			assert.deepEqual(read('content/site-settings.json').brand.logo, { key: NEW, w: 1200, h: 1600 }, 'the logo gets no alt');
			assert.equal(read('content/site-settings.json').note, OLD, 'a plain-text mention is left');
			assert.equal(read('content/pages/index.json').cover.focal[0], 0.4, 'focal points kept by default');
			assert.equal(mem.bucket.objects.has(OLD), true, 'the old picture stays in the bucket');
		} finally {
			rmSync(c.dir, { recursive: true, force: true });
		}
	});

	test('a new image not in the bucket, or a file for an image, is refused and nothing changes', async () => {
		const c = copy();
		try {
			const before = readFileSync(join(c.dir, 'content/pages/index.json'), 'utf8');
			const gone = await replace({ from: OLD, to: NEW }, c.ctx);
			assert.equal(gone.status, 404);
			assert.match(gone.body.error!, /The new image isn't in the library/);
			mem.bucket.seed(RATE, {});
			assert.equal((await replace({ from: OLD, to: RATE }, c.ctx)).status, 400);
			assert.equal(readFileSync(join(c.dir, 'content/pages/index.json'), 'utf8'), before);
		} finally {
			rmSync(c.dir, { recursive: true, force: true });
		}
	});
});

describe('Replace… on an image in live mode', async () => {
	const { MemoryBackend } = await import('../src/live/backend.ts');
	const { createLiveEditor } = await import('../src/live/editor.ts');
	const { Tracker } = await import('../src/live/github.ts');
	const { memoryRedis } = await import('../src/live/redis.ts');
	const { createLiveRuntime, siteFiles } = await import('../src/live/runtime.ts');
	const { DEFAULT_TIMINGS } = await import('../src/live/timings.ts');
	const aoife = { email: 'aoife@example.com', name: 'Aoife' };
	const ciaran = { email: 'ciaran@example.com', name: 'Ciarán' };
	const live = { github: { kind: 'memory' as const }, redisUrl: null, secret: 's'.repeat(32), allow: [], webhookSecret: null, railway: null, backup: null, runningCommit: null, timings: { ...DEFAULT_TIMINGS }, production: false };
	async function world() {
		const clock = { t: Date.parse('2026-11-02T10:00:00Z') };
		const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
		backend.seed(await siteFiles(site));
		const rt = await createLiveRuntime({ site, settings: live, backend, redis: memoryRedis({ now: () => clock.t }), now: () => clock.t, log: () => {}, runningCommit: () => null });
		return createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	}
	const ctxOf = (ed: Awaited<ReturnType<typeof world>>): MediaContext => ({ site, store: ed.store, mode: 'live', person: aoife, env: MEMORY, production: false, log: () => {} });

	test('the rewritten documents are waiting autosaves, focal points reset when asked', async () => {
		const ed = await world();
		mem.bucket.seed(OLD, {});
		mem.bucket.seed(NEW, { w: 1200, h: 1600 });
		const r = await replace({ from: OLD, to: NEW, resetFocal: true }, ctxOf(ed));
		assert.equal(r.status, 200, JSON.stringify(r.body));
		const home = JSON.parse((await ed.store.read('pages', 'index')).text);
		assert.deepEqual(home.cover, { key: NEW, alt: 'Aoife at the harbour', w: 1200, h: 1600 });
		for (const file of ['content/pages/index.json', 'content/shared/team.json', 'content/site-settings.json']) assert.ok(await ed.autosaves.get(file), file);
		assert.equal(await ed.autosaves.get('content/pages/about.json'), null, 'About uses another picture');
	});

	test('someone else editing a document that uses it refuses the whole Replace, naming them', async () => {
		const ed = await world();
		mem.bucket.seed(NEW, { w: 1200, h: 1600 });
		const homeBefore = (await ed.store.read('pages', 'index')).text;
		const opened = await ed.store.read('shared', 'team');
		const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
		document.title = 'The team';
		const w = await ed.write(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-caracms-tab': 'tab-ciaran-0001' }, body: JSON.stringify({ file: opened.entry.file, base: opened.text, document }) }), ciaran);
		assert.equal(w.status, 200);
		const refused = await replace({ from: OLD, to: NEW }, ctxOf(ed));
		assert.equal(refused.status, 409);
		assert.match(refused.body.error!, /^Ciarán is editing The team, which uses this image/);
		assert.equal((await ed.store.read('pages', 'index')).text, homeBefore);
	});
});
