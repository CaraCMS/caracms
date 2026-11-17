// The live session's calls (client/state/live.ts), with a stubbed fetch: a Publish the
// server didn't do is never shown as published (the M4 review round, item 1).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lapsedToast, takenOverToast, type Access } from '../src/editor/client/editor.ts';
import { createLiveSession, POLL_MS } from '../src/editor/client/state/live.ts';
import { ENDPOINTS, TAB_HEADER, type PublishView, type StatusResponse } from '../src/editor/types.ts';

const you = { email: 'aoife@example.com' };
const waitingView: PublishView = { state: 'none', running: false, record: null, assumed: false, canTryAgain: false, hasRedeployer: false };
const status: StatusResponse = {
	mode: 'live',
	you,
	tab: 'tab-aoife-1',
	now: new Date().toISOString(),
	timeZone: 'UTC',
	open: null,
	waiting: [],
	locks: [],
	presence: [],
	githubAccess: null,
	notices: [],
	publish: waitingView,
	brand: { name: 'CaraCMS', accent: '#1f3a2e', accentInk: '#ffffff', accentEdge: '#1f3a2e' },
	pageOrderStamp: '',
};

function session(publishAnswer: () => Response | Promise<Response>) {
	return createLiveSession({
		props: { you, status },
		tab: 'tab-aoife-1',
		openFile: () => null,
		log: () => {},
		fetch: (async (url: string) => {
			if (url === ENDPOINTS.publish) return publishAnswer();
			return new Response(JSON.stringify(status), { status: 200 });
		}) as typeof fetch,
	});
}

describe('Publish from the live session', () => {
	test('a 502 (git.publish threw): not ok, with the server\'s reason, and nothing shown as publishing', async () => {
		const s = session(() => new Response(JSON.stringify({ error: "That didn't work (GitHub said no)." }), { status: 502 }));
		const r = await s.publish();
		assert.deepEqual(r, { ok: false, error: "That didn't work (GitHub said no)." });
		assert.deepEqual(s.state.get().status!.publish, waitingView);
	});

	test('the server out of reach: not ok', async () => {
		const s = session(() => Promise.reject(new TypeError('fetch failed')));
		const r = await s.publish();
		assert.equal(r.ok, false);
	});

	test('a 200: ok, with the answer, and the bar takes its publish state', async () => {
		const publishing: PublishView = { ...waitingView, state: 'publishing' };
		const s = session(() => new Response(JSON.stringify({ result: 'published', publish: publishing }), { status: 200 }));
		const r = await s.publish();
		assert.equal(r.ok, true);
		assert.equal(s.state.get().status!.publish.state, 'publishing');
	});
});

// ── The poll (Decision 13) and the tab header (Decision 4) ──────────────────────

/** A document that is a visibility switch and a source of input events: all `start()` needs. */
function fakeDocument() {
	const listeners = new Set<string>();
	const fns = new Map<string, () => void>();
	const doc = {
		visibilityState: 'visible' as 'visible' | 'hidden',
		addEventListener: (type: string, fn: () => void) => {
			listeners.add(type);
			fns.set(type, fn);
		},
		removeEventListener: (type: string) => {
			listeners.delete(type);
			fns.delete(type);
		},
		fire: (type: string) => fns.get(type)?.(),
		show() {
			doc.visibilityState = 'visible';
			fns.get('visibilitychange')?.();
		},
		hide() {
			doc.visibilityState = 'hidden';
			fns.get('visibilitychange')?.();
		},
		listeners,
	};
	return doc;
}

/** Timers by hand: `fire()` runs the one pending. */
function manualTimers() {
	const pending: { fn: () => void; ms: number; id: number }[] = [];
	let id = 0;
	return {
		pending,
		setTimer: (fn: () => void, ms: number) => {
			const t = { fn, ms, id: ++id };
			pending.push(t);
			return t.id;
		},
		clearTimer: (t: unknown) => {
			const i = pending.findIndex((p) => p.id === t);
			if (i !== -1) pending.splice(i, 1);
		},
		async fire() {
			const t = pending.shift();
			assert.ok(t, 'a timer is pending');
			t.fn();
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
		},
	};
}

describe('the live session\'s poll: every 5 seconds while visible, at once when visible again (Decision 13)', () => {
	function start(answer: () => Response = () => new Response(JSON.stringify(status), { status: 200 })) {
		const doc = fakeDocument();
		const clock = { t: 1_000_000 };
		const timers = manualTimers();
		const calls: { url: string; headers: Record<string, string>; method: string; body?: string }[] = [];
		const open = { file: 'content/pages/index.json' as string | null };
		const previous = (globalThis as { document?: unknown }).document;
		(globalThis as { document?: unknown }).document = doc;
		const s = createLiveSession({
			props: { you, status },
			tab: 'tab-aoife-1',
			openFile: () => open.file,
			now: () => clock.t,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			log: () => {},
			fetch: (async (url: string, init: RequestInit = {}) => {
				calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, method: init.method ?? 'GET', body: init.body as string | undefined });
				return answer();
			}) as typeof fetch,
		});
		const stop = s.start();
		return {
			s,
			doc,
			timers,
			calls,
			open,
			clock,
			stop: () => {
				stop();
				(globalThis as { document?: unknown }).document = previous;
			},
		};
	}
	const polls = <C extends { url: string }>(calls: C[]) => calls.filter((c) => c.url.startsWith(ENDPOINTS.status));

	test('the first poll is at once; then one every 5000 ms; each names the open document and carries the tab', async () => {
		const t = start();
		try {
			await new Promise((r) => setImmediate(r));
			assert.equal(polls(t.calls).length, 1, 'at once');
			assert.equal(POLL_MS, 5000);
			assert.deepEqual(t.timers.pending.map((p) => p.ms), [5000]);
			await t.timers.fire();
			await t.timers.fire();
			assert.equal(polls(t.calls).length, 3);
			for (const c of polls(t.calls)) {
				assert.equal(c.url, `${ENDPOINTS.status}?file=${encodeURIComponent('content/pages/index.json')}&input=0&interval=5000`);
				assert.equal(c.headers[TAB_HEADER], 'tab-aoife-1');
				assert.equal(c.method, 'GET');
			}
			t.open.file = null;
			await t.timers.fire();
			assert.equal(polls(t.calls).at(-1)!.url, `${ENDPOINTS.status}?input=0&interval=5000`, 'no document open: no file named');
		} finally {
			t.stop();
		}
	});

	test('a hidden tab does not poll; when it is visible again it polls at once, and the loop carries on', async () => {
		const t = start();
		try {
			await new Promise((r) => setImmediate(r));
			t.doc.hide();
			await t.timers.fire();
			await t.timers.fire();
			assert.equal(polls(t.calls).length, 1, 'two turns while hidden: nothing sent');
			t.doc.show();
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			assert.equal(polls(t.calls).length, 2, 'back in view: at once, not after the next 5 s');
			assert.equal(t.timers.pending.length, 1, 'one loop, not two');
			await t.timers.fire();
			assert.equal(polls(t.calls).length, 3);
		} finally {
			t.stop();
		}
	});

	test('each poll says how long ago someone used the tab; typing, clicking, scrolling or coming back to it resets that (the lock\'s idle rule)', async () => {
		const t = start();
		const input = () => new URL(polls(t.calls).at(-1)!.url, 'http://x').searchParams.get('input');
		try {
			await new Promise((r) => setImmediate(r));
			t.clock.t += 7 * 60_000;
			await t.timers.fire();
			assert.equal(input(), String(7 * 60_000));
			t.doc.fire('pointerdown'); // a slowed tab (Redis diet Decision 8): polls at once, back to 5 s
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			assert.equal(input(), '0');
			t.clock.t += 2000;
			await t.timers.fire();
			assert.equal(input(), '2000');
			t.clock.t += 60_000;
			t.s.active(); // a preview's keydown, through the driver's onActivity
			await t.timers.fire();
			assert.equal(input(), '0');
			for (const type of ['keydown', 'wheel', 'input']) assert.ok(t.doc.listeners.has(type), type);
			t.doc.hide();
			t.clock.t += 30 * 60_000;
			t.doc.show();
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			assert.equal(input(), '0', 'back in view counts as using it');
		} finally {
			t.stop();
		}
	});

	test('Redis diet Decision 8: idle for 2 minutes, a visible tab polls every 30 s and says so; any input polls at once and it is back to 5 s', async () => {
		const t = start();
		const interval = () => new URL(polls(t.calls).at(-1)!.url, 'http://x').searchParams.get('interval');
		try {
			await new Promise((r) => setImmediate(r));
			assert.equal(interval(), '5000');
			t.clock.t += 2 * 60_000 - 1;
			await t.timers.fire();
			assert.equal(interval(), '5000', 'not idle long enough yet');
			assert.deepEqual(t.timers.pending.map((p) => p.ms), [5000], 'the next poll comes when this one said');
			t.clock.t += 5000;
			await t.timers.fire();
			assert.equal(interval(), '30000');
			assert.deepEqual(t.timers.pending.map((p) => p.ms), [30_000]);
			t.clock.t += 30_000;
			await t.timers.fire();
			assert.equal(interval(), '30000');
			const before = polls(t.calls).length;
			t.doc.fire('keydown');
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			assert.equal(polls(t.calls).length, before + 1, 'a key press polls at once');
			assert.equal(interval(), '5000');
			assert.deepEqual(t.timers.pending.map((p) => p.ms), [5000], 'one loop, at 5 s');
			t.doc.fire('keydown');
			await new Promise((r) => setImmediate(r));
			assert.equal(polls(t.calls).length, before + 1, 'input on a fast tab polls no sooner');
		} finally {
			t.stop();
		}
	});

	test('Redis diet Decision 8: a slow tab whose poll shows another person or another tab holding its document is back to 5 s; presence alone is not', async () => {
		const lock = { file: 'content/pages/index.json', person: { email: 'ciaran@example.com' }, since: new Date().toISOString(), releasing: false, mine: null as 'this-tab' | 'other-tab' | null };
		const answer = { open: null as StatusResponse['open'], presence: [] as StatusResponse['presence'] };
		const t = start(() => new Response(JSON.stringify({ ...status, ...answer }), { status: 200 }));
		const interval = () => new URL(polls(t.calls).at(-1)!.url, 'http://x').searchParams.get('interval');
		try {
			await new Promise((r) => setImmediate(r));
			t.clock.t += 3 * 60_000;
			answer.presence = [{ file: 'content/pages/index.json', people: [lock.person] }];
			await t.timers.fire();
			assert.equal(interval(), '30000');
			assert.deepEqual(t.timers.pending.map((p) => p.ms), [30_000], 'someone else on the page: still slow');
			answer.open = { file: lock.file, state: 'theirs', lock, lastChange: null as unknown as NonNullable<StatusResponse['open']>['lastChange'], deleted: null };
			t.clock.t += 30_000;
			await t.timers.fire();
			assert.equal(interval(), '30000', 'that poll went slow: the lock shows in its answer');
			assert.deepEqual(t.timers.pending.map((p) => p.ms), [5000], 'back to 5 s');
			t.clock.t += 5000;
			await t.timers.fire();
			assert.equal(interval(), '5000');
			answer.open = { ...answer.open, state: 'yours-elsewhere', lock: { ...lock, person: you, mine: 'other-tab' } };
			t.clock.t += 5000;
			await t.timers.fire();
			assert.deepEqual(t.timers.pending.map((p) => p.ms), [5000], 'your own other tab counts too');
			answer.open = { ...answer.open, state: 'yours', lock: { ...lock, person: you, mine: 'this-tab' } };
			t.clock.t += 5000;
			await t.timers.fire();
			assert.deepEqual(t.timers.pending.map((p) => p.ms), [5000], 'that poll promised 5 s');
			t.clock.t += 5000;
			await t.timers.fire();
			assert.equal(interval(), '30000');
			assert.deepEqual(t.timers.pending.map((p) => p.ms), [30_000], 'this tab\'s own lock: slow again');
		} finally {
			t.stop();
		}
	});

	test('Take over posts take-over for the file, with the tab', async () => {
		const t = start(() => new Response(JSON.stringify({ ...status, state: 'yours', lock: { file: 'content/pages/index.json' } }), { status: 200 }));
		try {
			const r = await t.s.takeOver('content/pages/index.json');
			assert.equal(r.ok, true);
			const call = t.calls.find((c) => c.url === ENDPOINTS.lock)!;
			assert.equal(call.method, 'POST');
			assert.equal(call.headers[TAB_HEADER], 'tab-aoife-1');
			assert.deepEqual(JSON.parse(call.body!), { file: 'content/pages/index.json', action: 'take-over' });
		} finally {
			t.stop();
		}
	});

	test('stopping leaves no timer and no listener', async () => {
		const t = start();
		await new Promise((r) => setImmediate(r));
		t.stop();
		assert.equal(t.timers.pending.length, 0);
		assert.equal(t.doc.listeners.size, 0);
	});

	test('the other calls carry the tab too: publish, history, a notice\'s dismiss, Edit here, Try again', async () => {
		const t = start(() => new Response(JSON.stringify({ result: 'published', publish: waitingView, entries: [], timeZone: 'UTC', state: 'yours', lock: {} }), { status: 200 }));
		try {
			await t.s.publish();
			await t.s.history();
			await t.s.dismiss('kept:x');
			await t.s.take('content/pages/index.json');
			await t.s.tryAgain();
			const others = t.calls.filter((c) => !c.url.startsWith(ENDPOINTS.status));
			assert.deepEqual(others.map((c) => c.url), [ENDPOINTS.publish, ENDPOINTS.history, ENDPOINTS.notice, ENDPOINTS.lock, ENDPOINTS.tryAgain]);
			for (const c of others) assert.equal(c.headers[TAB_HEADER], 'tab-aoife-1', c.url);
		} finally {
			t.stop();
		}
	});

	test('the server out of reach keeps the last status and says so; a 401 says signed out, and why; a 200 clears it', async () => {
		let next: () => Response | Promise<Response> = () => new Response(JSON.stringify(status), { status: 200 });
		const t = start(() => next() as Response);
		try {
			await t.s.poll();
			assert.deepEqual([t.s.state.get().reachable, t.s.state.get().signedOut], [true, null]);
			const keep = t.s.state.get().status;
			(next as unknown) = () => {
				throw new TypeError('fetch failed');
			};
			await t.s.poll();
			assert.equal(t.s.state.get().reachable, false);
			assert.equal(t.s.state.get().status, keep, 'last-known data stays');
			next = () => new Response(JSON.stringify({ error: 'x', code: 'signed-out', reason: 'removed', signIn: '/admin/login' }), { status: 401 });
			await t.s.poll();
			assert.equal(t.s.state.get().signedOut?.reason, 'removed');
			assert.equal(t.s.state.get().status, keep);
			next = () => new Response(JSON.stringify({ error: 'x', code: 'signed-out', signIn: '/admin/login' }), { status: 401 });
			await t.s.poll();
			assert.equal(t.s.state.get().signedOut?.reason, 'signed-out', 'any other reason reads as plainly signed out');
			next = () => new Response(JSON.stringify(status), { status: 200 });
			await t.s.poll();
			assert.deepEqual([t.s.state.get().reachable, t.s.state.get().signedOut], [true, null], 'signing in from another tab brings it back');
			next = () => new Response('{}', { status: 503 });
			await t.s.poll();
			assert.equal(t.s.state.get().reachable, false, 'Redis out (503): not an error screen, just unreachable for now');
		} finally {
			t.stop();
		}
	});
});

// ── The lock toasts (Decision 9): someone's done; someone took over ─────────────
describe('the lock toasts', () => {
	const HOME = 'content/pages/index.json';
	const ciaran = { email: 'ciaran@example.com', name: 'Ciarán' };
	const holder = (person: typeof ciaran) => ({ file: HOME, person, since: new Date(0).toISOString(), releasing: false, mine: null });
	const access = (lock: Access['lock'], h: Access['holder'] = null): Access => ({ lock, holder: h, held: null, signedOut: null, readOnly: lock === 'theirs', veil: lock === 'theirs', deleted: null });

	test('yours, then someone else\'s: "Ciarán took over Home"; not for another document, nor for Edit here', () => {
		assert.equal(takenOverToast(access('yours'), access('theirs', holder(ciaran)), HOME, 'Home'), 'Ciarán took over Home.');
		assert.equal(takenOverToast(access('yours'), access('theirs', { ...holder(ciaran), file: 'content/pages/about.json' }), HOME, 'Home'), null);
		assert.equal(takenOverToast(access('yours'), access('yours-elsewhere', holder(ciaran)), HOME, 'Home'), null);
		assert.equal(takenOverToast(access('free'), access('theirs', holder(ciaran)), HOME, 'Home'), null, 'opening a locked document is not a take-over');
	});

	test('someone else\'s, then free: the lapse toast', () => {
		assert.equal(lapsedToast(access('theirs', holder(ciaran)), access('free'), HOME, 'Home'), 'Home is free to edit.');
	});
});
