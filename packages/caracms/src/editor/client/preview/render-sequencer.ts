/**
 * Lifted as is from M1's spike (with its tests;
 * M3 Decision 13). "Intro" below means any plain text typed on the page.
 *
 * M1 Decision 9, "the latest edit wins", as a small pure state machine (no DOM, no
 * fetch) so it can be unit-tested. The editor (/admin) does the I/O and asks this
 * what to do.
 *
 * - The document carries a version; every change bumps it, on-page intro edits
 *   included.
 * - At most one render is in flight, with no debounce: a change that needs a
 *   render is sent at once if nothing is in flight; otherwise, when the current
 *   request returns, the latest version is sent.
 * - A response carries the version it rendered. A response older than one already
 *   morphed in is dropped. The request finishing, not the echoed version, frees the
 *   in-flight slot; a response whose echoed version is missing or isn't the version
 *   sent is a failure, so a bad response can't wedge the editor.
 * - When a response older than the current version is morphed in, the editor
 *   re-applies the current on-page text afterwards, so an intro typed meanwhile
 *   never flashes back.
 *
 * Intro edits (`'local'`) bump the version but don't ask for a render: plain text
 * skips the round trip (Spec → Visual editing). The next render that does go out
 * carries the latest version, intro included. Version 0 is the file, as the
 * iframes' first GET rendered it.
 */

export type ChangeKind = 'render' | 'local';

export interface ResponseAction {
	/** Morph this response in. False: it's older than one already morphed, drop it. */
	apply: boolean;
	/** After the morph, put the current on-page text back (the response predates it). */
	reapplyLocal: boolean;
	/** Send a render of this version now (a change waited while this one was in flight). */
	send: number | null;
}

export interface SequencerState {
	/** The document's current version. */
	version: number;
	/** The version in flight, or null. */
	inFlight: number | null;
	/** The newest version morphed in. */
	applied: number;
	/** A change that needs a render has happened since the last send. */
	pending: boolean;
}

export function createSequencer(initialVersion = 0) {
	const state: SequencerState = {
		version: initialVersion,
		inFlight: null,
		applied: initialVersion,
		pending: false,
	};

	/** Send the latest version if one is waiting and nothing is in flight. */
	function maybeSend(): number | null {
		if (state.inFlight !== null || !state.pending) return null;
		state.pending = false;
		state.inFlight = state.version;
		return state.version;
	}

	/** The request finished without a usable render; keep the change waiting. */
	function failure(sent: number): void {
		if (state.inFlight === sent) state.inFlight = null;
		if (sent > state.applied) state.pending = true;
	}

	return {
		state: state as Readonly<SequencerState>,

		/** A change to the document. Returns the version to send now, or null. */
		change(kind: ChangeKind): { version: number; send: number | null } {
			state.version += 1;
			if (kind === 'render') state.pending = true;
			return { version: state.version, send: maybeSend() };
		},

		/**
		 * A render request finished. `sent` is the version the request carried: it frees
		 * the in-flight slot, whatever the response said. `echoed` is the version the
		 * server says it rendered (`X-Preview-Version`), or null if the header was
		 * missing; it only decides apply or drop. An echo that is missing or isn't the
		 * version sent is a failure: nothing is applied, the slot is freed, and the
		 * change stays pending exactly as `failure()` leaves it (nothing is sent now).
		 */
		response(sent: number, echoed: number | null): ResponseAction {
			if (echoed === null || echoed !== sent) {
				failure(sent);
				return { apply: false, reapplyLocal: false, send: null };
			}
			if (state.inFlight === sent) state.inFlight = null;
			const apply = echoed > state.applied;
			if (apply) state.applied = echoed;
			return {
				apply,
				reapplyLocal: apply && echoed < state.version,
				send: maybeSend(),
			};
		},

		/**
		 * A render failed. The change stays waiting and goes out with the next change
		 * (no automatic retry, so a dead server can't loop).
		 */
		failure,
	};
}

export type Sequencer = ReturnType<typeof createSequencer>;
