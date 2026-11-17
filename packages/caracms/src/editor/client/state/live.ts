/**
 * Live mode's connection to the server (M4 Decisions 9, 11 and 13): the status poll
 * and the calls the bar and the pane make (Publish, Try again, history, a notice's
 * Dismiss, Edit here, Sign out). Local mode never makes one (M3's editor).
 *
 * - **The poll**: `GET /_caracms/status?file=<the open document>` every `POLL_MS`
 *   while the tab is visible, and at once when it becomes visible again. It carries
 *   the tab's id, so it's also the lock's heartbeat and the tab's presence.
 * - **Idle tabs slow down** (Redis diet Decision 8): a visible tab with no input for
 *   `idleSlowAfterMs` polls every `slowPollMs`; any input, becoming visible, or a poll
 *   answer showing someone else's lock on the open document (another person or another
 *   tab) brings it back to `pollMs` at once. Each poll says how long until the next
 *   (`interval`), so the server holds the tab's presence that long (Decision 9); the
 *   next poll never comes later than the interval it sent.
 * - **Last-known data**: a poll that can't reach the server (a deploy replacing it,
 *   which Publish causes) keeps the last status and says `reachable: false`. Nothing
 *   is lost and nothing shows as an error; the next answer brings it back.
 * - **Signed out**: any 401 (`SignedOutError`) sets `signedOut`; the next poll that
 *   answers 200 clears it (signing in from another tab brings the session back).
 */
import { ENDPOINTS, TAB_HEADER, type DiscardRefusal, type DiscardResponse, type HistoryResponse, type LiveProps, type LockRefusal, type LockResponse, type PublishResponse, type SignedOutError, type StatusResponse, type TryAgainResponse } from '../../types.ts';
import { createStore, type Store } from './store.ts';

/**
 * Decision 13: every 5 s while the tab is visible. (The spec's Open questions may
 * shorten it to 3 s while someone else is on the same document; not done for
 * now.)
 */
export const POLL_MS = 5000;

/** Redis diet Decision 8's defaults, for a page whose props don't carry the live timings. */
export const IDLE_SLOW_AFTER_MS = 2 * 60_000;
export const SLOW_POLL_MS = 30_000;

/** Where sign out goes (Phase 3's route): `{ ok, location }` to a JSON request. */
export const SIGN_OUT = '/admin/login/signout';

export interface LiveState {
	/** The last status the server gave (the page's own, from the server, until the first poll). */
	status: StatusResponse | null;
	/** The last poll got an answer. False while the server can't be reached (a deploy, say). */
	reachable: boolean;
	/** The session ended (a 401), until a poll answers 200 again. */
	signedOut: SignedOutError | null;
	/** This tab's own poll has answered: the page's first status had no tab, so its locks of yours can't say which tab. */
	polled: boolean;
	/** Which poll this answer came from (they're numbered as they start). */
	seq: number;
}

export interface LiveSession {
	readonly tab: string;
	readonly state: Store<LiveState>;
	/** How many polls have started: a lock answer newer than this outranks the poll in flight. */
	started(): number;
	poll(): Promise<void>;
	/** Browser only: the poll loop and the visibility listener. Returns a stop. */
	start(): () => void;
	/** The server's answer, or why it didn't publish (a non-200, or the server out of reach): a failure is never shown as published. */
	publish(): Promise<{ ok: true; body: PublishResponse } | { ok: false; error: string }>;
	tryAgain(): Promise<TryAgainResponse>;
	history(): Promise<HistoryResponse | null>;
	dismiss(id: string): Promise<void>;
	/** Edit here: take the open document's lock (moves your own at once). */
	take(file: string): Promise<{ ok: true; lock: LockResponse } | { ok: false; refusal: LockRefusal | null }>;
	/** Take over: move anyone's lock on the document to this tab (their autosave is committed first). */
	takeOver(file: string): Promise<{ ok: true; lock: LockResponse } | { ok: false }>;
	/** Discard changes: put one waiting document back to what's live. A refusal carries the server's sentence. */
	discard(file: string): Promise<{ ok: true; body: DiscardResponse } | { ok: false; error: string; code: DiscardRefusal['code'] | null }>;
	/** This tab has let go of its copy of a document someone discarded (`open.discarded`). */
	discardSeen(file: string): Promise<void>;
	/** Someone typed, clicked or scrolled in this tab: each poll says how long ago (the lock's idle rule). */
	active(): void;
	signOut(): Promise<string>;
}

export interface LiveOptions {
	fetch: typeof fetch;
	props: LiveProps;
	tab: string;
	/** The open document's file, named by every poll. */
	openFile: () => string | null;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	log?: (message: string) => void;
}

/** The tab's id: kept for the tab's life in sessionStorage, so a reload is the same tab (its lock stays its own). */
export function tabId(): string {
	const make = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
	try {
		const s = window.sessionStorage;
		let id = s.getItem('caracms:tab');
		if (!id) s.setItem('caracms:tab', (id = make()));
		return id;
	} catch {
		return make();
	}
}

/** What counts as someone using the tab, in the editor and in the previews (the lock's idle rule). */
export const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'wheel', 'input'] as const;

export function createLiveSession(options: LiveOptions): LiveSession {
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
	const log = options.log ?? ((message) => console.warn(`[caracms] ${message}`));
	const state = createStore<LiveState>({ status: options.props.status, reachable: true, signedOut: null, polled: false, seq: 0 });
	let seq = 0;
	const now = options.now ?? (() => Date.now());
	let lastInput = now();
	let inFlight: Promise<void> | null = null;
	let again = false;
	const pollMs = options.props.pollMs ?? POLL_MS;
	const slowPollMs = options.props.slowPollMs ?? SLOW_POLL_MS;
	const idleSlowAfterMs = options.props.idleSlowAfterMs ?? IDLE_SLOW_AFTER_MS;
	/** The interval the last poll sent: the next one comes no later (the server holds presence from it). */
	let sentInterval = pollMs;
	/** Set by start(): input while the loop runs slow brings it back to `pollMs` at once. */
	let onInput: (() => void) | null = null;
	const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
	/** Decision 8: the open document's lock is someone else's (another person, or another tab). */
	const othersLock = () => {
		const lock = state.get().status?.open?.lock;
		return !!lock && lock.mine !== 'this-tab';
	};
	/** How long until the next poll, as things stand. */
	const interval = () => (visible() && now() - lastInput >= idleSlowAfterMs && !othersLock() ? slowPollMs : pollMs);
	const used = () => {
		lastInput = now();
		onInput?.();
	};

	const headers = (json: boolean): Record<string, string> => ({ Accept: 'application/json', [TAB_HEADER]: options.tab, ...(json ? { 'Content-Type': 'application/json' } : {}) });

	/** A call to an editor route: the answer's body, or null when the server couldn't be reached. A 401 marks the session ended. */
	async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T } | null> {
		try {
			const response = await options.fetch(path, {
				method: init.method ?? 'GET',
				headers: headers(init.body !== undefined),
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			});
			const body = (await response.json().catch(() => ({}))) as T;
			if (response.status === 401) {
				const b = body as unknown as Partial<SignedOutError>;
				state.update({ signedOut: { error: b.error ?? 'signed-out', code: 'signed-out', reason: b.reason === 'removed' ? 'removed' : 'signed-out', signIn: b.signIn ?? '/admin/login' }, reachable: true });
			}
			return { status: response.status, body };
		} catch (error) {
			log(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	async function pollOnce(): Promise<void> {
		const mine = ++seq;
		const file = options.openFile();
		// `input`: ms since someone used this tab. The server stops renewing an idle tab's lock.
		// `interval`: ms until this tab's next poll (Redis diet Contracts): the server holds its presence from it.
		sentInterval = interval();
		const query = new URLSearchParams({ ...(file ? { file } : {}), input: String(Math.max(0, Math.round(now() - lastInput))), interval: String(sentInterval) });
		const answer = await call<StatusResponse>(`${ENDPOINTS.status}?${query}`);
		if (!answer) {
			state.update({ reachable: false });
			return;
		}
		if (answer.status === 200 && answer.body && (answer.body as StatusResponse).mode === 'live') {
			state.set((s) => ({ ...s, status: answer.body, reachable: true, signedOut: null, polled: true, seq: mine }));
		} else if (answer.status === 401) {
			// call() marked it.
		} else if (answer.status >= 500 || answer.status === 404) {
			// 503 unavailable (Redis), a deploy's gap, or the route not there yet: the server isn't answering for now.
			state.update({ reachable: false });
		}
	}

	async function poll(): Promise<void> {
		if (inFlight) {
			again = true;
			return inFlight;
		}
		inFlight = (async () => {
			try {
				do {
					again = false;
					await pollOnce();
				} while (again);
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	}

	const session: LiveSession = {
		tab: options.tab,
		state,
		started: () => seq,
		poll,
		start() {
			let timer: unknown = null;
			let stopped = false;
			/** One loop at a time: a restart starts a new generation, and the old one stops at its next turn. */
			let generation = 0;
			/** Whether the timer now running is a slow one (input then restarts at once). */
			let slow = false;
			const loop = (g: number) => {
				if (stopped || g !== generation) return;
				// Never later than the last poll said; sooner when the answer showed someone else's lock.
				const ms = Math.min(sentInterval, interval());
				slow = ms > pollMs;
				timer = setTimer(async () => {
					timer = null;
					if (g !== generation) return;
					if (visible()) await poll();
					loop(g);
				}, ms);
			};
			const restart = () => {
				slow = false;
				const g = ++generation;
				if (timer !== null) clearTimer(timer);
				timer = null;
				void poll().finally(() => loop(g));
			};
			// Visible again: at once (Decision 13). The lock is re-taken by that poll if nobody else has it (Decision 9).
			const onVisible = () => {
				if (!visible()) return;
				lastInput = now(); // coming back to the tab counts as using it
				restart();
			};
			const onActivity = () => used();
			// Decision 8: input on a slowed tab polls now, and the loop is back to `pollMs`.
			onInput = () => {
				if (slow && !stopped) restart();
			};
			document.addEventListener('visibilitychange', onVisible);
			for (const type of ACTIVITY_EVENTS) document.addEventListener(type, onActivity, { capture: true, passive: true });
			restart();
			return () => {
				stopped = true;
				onInput = null;
				if (timer !== null) clearTimer(timer);
				document.removeEventListener('visibilitychange', onVisible);
				for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, onActivity, { capture: true });
			};
		},
		async publish() {
			const answer = await call<PublishResponse>(ENDPOINTS.publish, { method: 'POST', body: {} });
			void poll();
			if (!answer) return { ok: false, error: "The server couldn't be reached." };
			if (answer.status !== 200 || !answer.body?.publish) {
				const said = (answer.body as unknown as { error?: unknown } | null)?.error;
				return { ok: false, error: typeof said === 'string' && said ? said : `The server answered ${answer.status}.` };
			}
			state.set((s) => (s.status ? { ...s, status: { ...s.status, publish: answer.body.publish } } : s));
			return { ok: true, body: answer.body };
		},
		async tryAgain() {
			const answer = await call<TryAgainResponse>(ENDPOINTS.tryAgain, { method: 'POST', body: {} });
			void poll();
			if (!answer) return { ok: false, error: "Couldn't reach the server." };
			return answer.body;
		},
		async history() {
			const answer = await call<HistoryResponse>(ENDPOINTS.history);
			return answer && answer.status === 200 ? answer.body : null;
		},
		async dismiss(id) {
			// Gone at once; the server agrees on the next poll.
			state.set((s) => (s.status ? { ...s, status: { ...s.status, notices: s.status.notices.filter((n) => n.id !== id) } } : s));
			await call(ENDPOINTS.notice, { method: 'POST', body: { id } });
		},
		async discard(file) {
			const answer = await call<DiscardResponse | DiscardRefusal>(ENDPOINTS.discard, { method: 'POST', body: { file } });
			void poll();
			if (!answer) return { ok: false, error: "The server can't be reached. Nothing was discarded; try again in a moment.", code: null };
			if (answer.status !== 200) {
				const said = answer.body as DiscardRefusal;
				return { ok: false, error: typeof said?.error === 'string' && said.error ? said.error : `The server said no (${answer.status}).`, code: said?.code ?? null };
			}
			return { ok: true, body: answer.body as DiscardResponse };
		},
		async discardSeen(file) {
			await call(ENDPOINTS.discard, { method: 'POST', body: { file, seen: true } });
		},
		active() {
			used();
		},
		async takeOver(file) {
			const answer = await call<LockResponse>(ENDPOINTS.lock, { method: 'POST', body: { file, action: 'take-over' } });
			void poll();
			return answer?.status === 200 ? { ok: true, lock: answer.body } : { ok: false };
		},
		async take(file) {
			const answer = await call<LockResponse | LockRefusal>(ENDPOINTS.lock, { method: 'POST', body: { file, action: 'take' } });
			if (answer?.status === 200) return { ok: true, lock: answer.body as LockResponse };
			return { ok: false, refusal: answer?.status === 409 ? (answer.body as LockRefusal) : null };
		},
		async signOut() {
			try {
				const response = await options.fetch(SIGN_OUT, { method: 'POST', headers: { Accept: 'application/json' } });
				const body = (await response.json().catch(() => ({}))) as { location?: string };
				return body.location ?? '/admin/login';
			} catch {
				return '/admin/login';
			}
		},
	};
	return session;
}
