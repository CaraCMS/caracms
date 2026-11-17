// Collections under pages, open question 1: how long a holder move with 300 held documents
// takes in live mode on the in-memory GitHub and Redis, and its Publish. Not part of a suite:
//   node --experimental-strip-types test/holder-move-300.timing.ts [count] [plain]
// `plain`: the posts don't link to each other (only the holder's address and theirs change).
import { performance } from 'node:perf_hooks';
import { handleMove } from '../src/editor/server/move.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { makeHolderSite } from './helpers/move-site.ts';

const N = Number(process.argv[2] ?? 300);
const plain = process.argv[3] === 'plain';
const files: Record<string, string> = {};
// Each post links to the one before it, and Home links to the first ten, as a blog's would.
for (let i = 0; i < N; i++) files[`content/case-studies/post-${i}.json`] = `${JSON.stringify({ title: `Post ${i}`, client: 'x', body: i && !plain ? [{ p: `After [the last](/work/post-${i - 1}).` }] : [] }, null, 2)}\n`;
const s = makeHolderSite({ repoPath: 'starter', files });
const settings: LiveSettings = { github: { kind: 'memory' }, redisUrl: null, secret: 's'.repeat(32), allow: [], webhookSecret: null, railway: null, backup: null, runningCommit: null, timings: { ...DEFAULT_TIMINGS }, production: false };
const tracker = new Tracker();
const backend = new MemoryBackend(tracker);
backend.seed([...(await siteFiles(s.site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
const redis = memoryRedis();
const rt = await createLiveRuntime({ site: s.site, settings, backend, redis, now: Date.now, log: () => {}, runningCommit: () => null });
const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
const person = { email: 'aoife@example.com', name: 'Aoife' };
const req = (path: string, body: unknown) => new Request(`http://site.test${path}`, { method: 'POST', headers: { origin: 'http://site.test', 'content-type': 'application/json', 'x-caracms-tab': 'tab-aoife-1' }, body: JSON.stringify(body) });

let calls = redis.calls;
let t = performance.now();
const moved = await handleMove(req('/_caracms/move', { collection: 'pages', path: 'work', to: 'studio' }), ed.store, { person });
const body = (await moved.json()) as { moved: unknown[]; redirects: unknown[]; relinked: unknown[]; error?: string };
if (body.error) throw new Error(`move refused: ${moved.status} ${body.error}`);
console.log(`move: ${moved.status} ${body.error ?? ''} ${(performance.now() - t).toFixed(0)} ms, ${body.moved.length} addresses, ${body.relinked.length} files relinked, ${body.redirects.length} redirects, ${redis.calls - calls} Redis commands`);
calls = redis.calls;
const requests = tracker.records.length;
t = performance.now();
const published = await ed.publish(req('/_caracms/publish', {}), person);
console.log(`publish: ${published.status} ${JSON.stringify(await published.json()).slice(0, 80)} ${(performance.now() - t).toFixed(0)} ms, ${tracker.records.length - requests} GitHub requests, ${redis.calls - calls} Redis commands`);
s.cleanup();
