// Edit in context, Decision 3, live mode: "Default footer" on a slot block writes every other
// default of the slot as a normal save (an autosave of this tab's, waiting for Publish), and is
// refused, naming the holder, while someone else is editing one of them (Acceptance 3). Nothing
// is written on a refusal. (Its locks are let go as Replace…'s are: they drop once the sweep has
// committed the autosaves.)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { text, type SiteConfig } from '../src/config.ts';
import { handleSlotDefault } from '../src/editor/server/create.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { makeCreateSite, type CreateSite } from './helpers/create-site.ts';

const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const ORIGIN = 'http://site.test';
const TAB_A = 'tab-aoife-1';
const TAB_C = 'tab-ciaran-1';

const settings: LiveSettings = { github: { kind: 'memory' }, redisUrl: null, secret: 's'.repeat(32), allow: [], webhookSecret: null, railway: null, backup: null, runningCommit: null, timings: { ...DEFAULT_TIMINGS }, production: false };

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
let s: CreateSite;
before(() => {
	s = makeCreateSite({
		repoPath: 'starter',
		link: false,
		extend: (c: SiteConfig) => ({ ...c, blocks: { ...c.blocks, foot: { component: 'Block.astro', slot: 'footer', fields: { note: text() } } } }),
		files: {
			'content/shared/main.json': json({ title: 'Main', default: true, block: { type: 'foot', note: 'Hi' } }),
			'content/shared/dark.json': json({ title: 'Dark', block: { type: 'foot', note: 'Dark' } }),
		},
	});
});
after(() => s.cleanup());

async function world(): Promise<LiveEditor> {
	const clock = { t: Date.parse('2026-10-30T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	const redis = memoryRedis({ now: () => clock.t });
	backend.seed(await siteFiles(s.site));
	const rt = await createLiveRuntime({ site: s.site, settings, backend, redis, now: () => clock.t, log: () => {}, runningCommit: () => null });
	return createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
}

function request(path: string, tab: string, body: unknown) {
	return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'x-caracms-tab': tab, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function call(res: Promise<Response>) {
	const r = await res;
	return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/** A write from a tab: the document as the store opens it now, changed by `edit`. */
async function type(ed: LiveEditor, person: Person, tab: string, path: string, edit: (d: Record<string, unknown>) => void) {
	const opened = await ed.store.read('shared', path);
	const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
	edit(document);
	return call(ed.write(request('/_caracms/write', tab, { file: opened.entry.file, base: opened.text, document }), person));
}

const makeDefault = (ed: LiveEditor, person: Person, tab: string, path: string) => call(handleSlotDefault(request('/_caracms/slot-default', tab, { path }), ed.store, { person }));

describe('live: a slot block made the default (Decision 3, Acceptance 3)', () => {
	test('the other default loses it, as this tab\'s autosave', async () => {
		const ed = await world();
		const answer = await makeDefault(ed, aoife, TAB_A, 'dark');
		assert.equal(answer.status, 200, JSON.stringify(answer.body));
		assert.deepEqual(answer.body.undefaulted, [{ path: 'main', title: 'Main' }]);
		const main = await ed.store.read('shared', 'main');
		assert.equal((main.document as { default?: boolean }).default, undefined);
		assert.doesNotMatch(main.text, /"default"/);
	});
	test('refused, naming them, while someone else is editing the default; nothing written', async () => {
		const ed = await world();
		assert.equal((await type(ed, ciaran, TAB_C, 'main', (d) => (d.title = 'Main (Ciarán)'))).status, 200);
		const before = (await ed.store.read('shared', 'main')).text;
		const answer = await makeDefault(ed, aoife, TAB_A, 'dark');
		assert.equal(answer.status, 409, JSON.stringify(answer.body));
		assert.equal(answer.body.code, 'locked');
		assert.equal(answer.body.error, "Ciarán is editing Main (Ciarán), so Dark can't be the default yet. Try once they're done.");
		assert.equal((await ed.store.read('shared', 'main')).text, before);
	});
});
