// Lifted with the sequencer from M1's spike (M3 Decision 13).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSequencer } from '../src/editor/client/preview/render-sequencer.ts';

test('a change is sent at once when nothing is in flight (no debounce)', () => {
	const seq = createSequencer();
	assert.deepEqual(seq.change('render'), { version: 1, send: 1 });
	assert.equal(seq.state.inFlight, 1);
});

test('at most one render in flight: changes meanwhile wait, and only the latest is sent', () => {
	const seq = createSequencer();
	assert.equal(seq.change('render').send, 1);
	assert.equal(seq.change('render').send, null);
	assert.equal(seq.change('render').send, null);
	assert.equal(seq.change('render').send, null);
	assert.equal(seq.state.inFlight, 1);

	// v1 returns: it's applied, and v4 (the latest), not v2 or v3, goes out.
	const back = seq.response(1, 1);
	assert.equal(back.apply, true);
	assert.equal(back.send, 4);
	assert.equal(seq.state.inFlight, 4);

	// v4 returns: applied, current, nothing more to send.
	assert.deepEqual(seq.response(4, 4), { apply: true, reapplyLocal: false, send: null });
	assert.equal(seq.state.inFlight, null);
	assert.equal(seq.state.applied, 4);
});

test('a response older than one already morphed in is dropped', () => {
	const seq = createSequencer();
	seq.change('render'); // v1 in flight
	seq.change('render'); // v2 waits
	assert.equal(seq.response(1, 1).send, 2);
	assert.equal(seq.response(2, 2).apply, true);
	// A late duplicate of v1 (e.g. a retried request) arrives after v2 was morphed.
	const late = seq.response(1, 1);
	assert.equal(late.apply, false);
	assert.equal(late.reapplyLocal, false);
	assert.equal(late.send, null);
	assert.equal(seq.state.applied, 2);
	// The same version twice is dropped too.
	assert.equal(seq.response(2, 2).apply, false);
});

test('a response older than the current version is morphed, then the on-page text is re-applied', () => {
	const seq = createSequencer();
	assert.equal(seq.change('render').send, 1); // lockup edit, v1 in flight
	// The intro is typed while v1 is in flight: versions bump, no render is asked for.
	assert.deepEqual(seq.change('local'), { version: 2, send: null });
	assert.deepEqual(seq.change('local'), { version: 3, send: null });

	// v1 comes back: it predates the intro typing, so re-apply it after the morph.
	// Nothing needing a render is waiting, so nothing is sent.
	assert.deepEqual(seq.response(1, 1), { apply: true, reapplyLocal: true, send: null });
	assert.equal(seq.state.inFlight, null);
});

test('intro edits alone never send; the next render carries their version', () => {
	const seq = createSequencer();
	assert.equal(seq.change('local').send, null);
	assert.equal(seq.change('local').send, null);
	assert.equal(seq.state.inFlight, null);
	// A lockup edit goes out at the latest version, which includes the intro.
	assert.deepEqual(seq.change('render'), { version: 3, send: 3 });
	assert.deepEqual(seq.response(3, 3), { apply: true, reapplyLocal: false, send: null });
});

test('lockup, then intro, then lockup while in flight: the latest goes out, the stale one re-applies', () => {
	const seq = createSequencer();
	seq.change('render'); // v1 in flight
	seq.change('local'); // v2 intro
	seq.change('render'); // v3 lockup waits
	seq.change('local'); // v4 intro
	const back = seq.response(1, 1);
	assert.deepEqual(back, { apply: true, reapplyLocal: true, send: 4 });
	assert.deepEqual(seq.response(4, 4), { apply: true, reapplyLocal: false, send: null });
});

test('a failed render waits for the next change, which sends the latest', () => {
	const seq = createSequencer();
	seq.change('render'); // v1
	seq.failure(1);
	assert.equal(seq.state.inFlight, null);
	assert.equal(seq.state.pending, true);
	// An intro edit is enough to flush the waiting render, at the latest version.
	assert.equal(seq.change('local').send, 2);
});

test('a response with no echoed version is a failure: the slot is freed and the next change sends', () => {
	const seq = createSequencer();
	assert.equal(seq.change('render').send, 1);
	// 200 without X-Preview-Version
	assert.deepEqual(seq.response(1, null), { apply: false, reapplyLocal: false, send: null });
	assert.equal(seq.state.inFlight, null);
	assert.equal(seq.state.applied, 0);
	assert.equal(seq.state.pending, true);
	// Not wedged: the next change goes out, at the latest version.
	assert.deepEqual(seq.change('render'), { version: 2, send: 2 });
	assert.deepEqual(seq.response(2, 2), { apply: true, reapplyLocal: false, send: null });
});

test('a response echoing a different version is a failure: not applied, slot freed, change kept pending', () => {
	const seq = createSequencer();
	seq.change('render'); // v1 in flight
	seq.change('render'); // v2 waits
	// The server echoes 7 for the request that carried v1.
	assert.deepEqual(seq.response(1, 7), { apply: false, reapplyLocal: false, send: null });
	assert.equal(seq.state.inFlight, null);
	assert.equal(seq.state.applied, 0);
	assert.equal(seq.state.pending, true);
	// No automatic retry; the next change flushes the latest version.
	assert.equal(seq.change('local').send, 3);
});
