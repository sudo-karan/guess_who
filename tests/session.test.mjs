// Tests for surviving a page reload: the saved-game store, the engine's
// snapshot/restore, and the resume handshake that gets a returning player back
// into the match without the host being asked to approve their own opponent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSession, loadSession, clearSession } from '../js/session.js';
import { createEngine } from '../js/engine.js';
import { createOnlineChannel } from '../js/net.js';
import { createRelayChannel } from '../js/relay.js';
import { createReliableChannel } from '../js/reliable.js';
import { createFakeBroker, until, flush } from './fake-peer.mjs';
import { createFakeNtfy } from './fake-ntfy.mjs';

// sessionStorage does not exist in Node; the store reads it through a guard.
function withStorage(fn) {
  const map = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  try { return fn(map); } finally { delete globalThis.sessionStorage; }
}

const aGame = (over = {}) => ({
  code: 'AB3U', isHost: true, myName: 'Karan', token: 'tok123',
  roster: [{ id: 1 }, { id: 2 }],
  engine: { phase: 'play', turn: 'me', myBoard: [1, 2] },
  ...over,
});

/* ------------------------------ the store ----------------------------- */
test('session: a game in progress round-trips', () => {
  withStorage(() => {
    assert.equal(saveSession(aGame()), true);
    const got = loadSession();
    assert.equal(got.code, 'AB3U');
    assert.equal(got.token, 'tok123');
    assert.equal(got.engine.turn, 'me');
  });
});

test('session: nothing saved means nothing to resume', () => {
  withStorage(() => assert.equal(loadSession(), null));
});

test('session: a finished game is not offered, and is cleared', () => {
  withStorage((map) => {
    saveSession(aGame({ engine: { phase: 'over', winner: 'me' } }));
    assert.equal(loadSession(), null);
    assert.equal(map.size, 0, 'and it does not sit there forever');
  });
});

test('session: a stale game is not offered', () => {
  withStorage(() => {
    saveSession(aGame());
    const later = () => Date.now() + 5 * 60 * 60 * 1000;
    assert.equal(loadSession({ now: later }), null);
  });
});

test('session: junk is ignored rather than thrown', () => {
  withStorage((map) => {
    map.set('gw-session-v1', 'not json at all');
    assert.equal(loadSession(), null);
    map.set('gw-session-v1', JSON.stringify({ code: 'AB3U' }));   // no engine
    assert.equal(loadSession(), null);
  });
});

test('session: clearing works, and storage being unavailable is survivable', () => {
  withStorage(() => { saveSession(aGame()); clearSession(); assert.equal(loadSession(), null); });
  // No sessionStorage at all (private mode, or an old browser).
  assert.equal(saveSession(aGame()), false);
  assert.equal(loadSession(), null);
});

/* --------------------------- engine snapshot -------------------------- */
test('engine: a game in progress survives a snapshot and restore', () => {
  const a = createEngine({ isHost: true, myName: 'Karan' });
  const board = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(a.setupLocal({ board, secret: 7 }).ok, true);
  const snap = a.snapshot();
  assert.equal(snap.mySecret, 7);
  assert.equal(Array.isArray(snap.turnStartOff), true, 'the Set is stored as a list');

  const b = createEngine({ isHost: true, myName: 'Karan' });
  assert.equal(b.restore(snap), true);
  assert.equal(b.state.mySecret, 7);
  assert.deepEqual(b.state.myBoard, a.state.myBoard);
  assert.equal(b.state.phase, a.state.phase);
  assert.ok(b.state.turnStartOff instanceof Set, 'and comes back as a Set');

  assert.equal(b.restore(null), false);
  assert.equal(b.restore({ nonsense: true }), false);
});

test('engine: a hand-over already applied is ignored if it arrives again', () => {
  // A resumed connection re-sends anything it never saw confirmed, so the same
  // endTurn can legitimately turn up twice. Applying it twice would wipe the
  // undo history of the turn the player is part way through.
  const e = createEngine({ isHost: false, myName: 'Bo' });
  e.restore({ ...e.snapshot(), phase: 'play', turn: 'opp', lastOppTurn: -1 });
  e.handleMessage({ type: 'endTurn', open: 19, closed: 1, off: 1, on: 0, ts: 1, turn: 4 });
  assert.equal(e.state.turn, 'me');
  const logLen = e.state.log.length;

  e.handleMessage({ type: 'endTurn', open: 19, closed: 1, off: 1, on: 0, ts: 1, turn: 4 });
  assert.equal(e.state.log.length, logLen, 'the repeat changes nothing');

  e.handleMessage({ type: 'endTurn', open: 18, closed: 2, off: 1, on: 0, ts: 2, turn: 5 });
  assert.ok(e.state.log.length > logLen, 'but a genuinely new hand-over still lands');
});

/* -------------------------- resume handshake -------------------------- */
test('resume: a returning player is let straight back in, over a direct link', async () => {
  const broker = createFakeBroker();
  const host = createOnlineChannel({ makePeer: broker.makePeer });
  let code = null, prompts = 0, hostOpen = false, resumedHost = false;
  host.onJoinRequest((who, ctl) => { prompts++; ctl.accept(); });
  host.onOpen(() => { hostOpen = true; });
  host.onResumed(() => { resumedHost = true; });
  host.host((c) => { code = c; });
  await until(() => code !== null);

  const g1 = createOnlineChannel({ makePeer: broker.makePeer });
  let token = null;
  g1.onToken((t) => { token = t; });
  g1.join(code, 'Bo');
  await until(() => hostOpen && token !== null);
  assert.equal(prompts, 1, 'approved once, as normal');
  assert.ok(token, 'and handed a token to come back with');

  g1.close();                                  // the player refreshes
  await flush(40);

  const g2 = createOnlineChannel({ makePeer: broker.makePeer });
  let resumedGuest = false;
  g2.onResumed(() => { resumedGuest = true; });
  g2.onOpen(() => { assert.fail('a resume must not look like a fresh join'); });
  g2.join(code, 'Bo', token);
  await until(() => resumedGuest && resumedHost, 8000);
  assert.ok(resumedGuest, 'the guest is told it resumed');
  assert.ok(resumedHost, 'and so is the host');
  assert.equal(prompts, 1, 'the host is NOT asked to approve its own opponent again');
  host.close(); g1.close(); g2.close();
});

test('resume: the same works over the relay', async () => {
  const ntfy = createFakeNtfy();
  const opts = { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl, joinRetryMs: 120 };
  const host = createRelayChannel(opts);
  let prompts = 0, hostOpen = false, resumedHost = false;
  host.onJoinRequest((who, ctl) => { prompts++; ctl.accept(); });
  host.onOpen(() => { hostOpen = true; });
  host.onResumed(() => { resumedHost = true; });
  host.host('AB3U');

  const g1 = createRelayChannel(opts);
  let token = null;
  g1.onToken((t) => { token = t; });
  g1.join('AB3U', 'Bo');
  await until(() => hostOpen && token !== null);
  g1.close();

  const g2 = createRelayChannel(opts);
  let resumedGuest = false;
  g2.onResumed(() => { resumedGuest = true; });
  g2.join('AB3U', 'Bo', token);
  await until(() => resumedGuest && resumedHost, 8000);
  assert.ok(resumedGuest && resumedHost);
  assert.equal(prompts, 1);
  host.close(); g1.close(); g2.close();
});

test('resume: a stranger with the wrong token still has to be approved', async () => {
  const broker = createFakeBroker();
  const host = createOnlineChannel({ makePeer: broker.makePeer });
  let code = null, prompts = 0, hostOpen = false;
  host.onJoinRequest((who, ctl) => { prompts++; ctl.accept(); });
  host.onOpen(() => { hostOpen = true; });
  host.host((c) => { code = c; });
  await until(() => code !== null);

  const g1 = createOnlineChannel({ makePeer: broker.makePeer });
  g1.join(code, 'Bo');
  await until(() => hostOpen);
  g1.close();
  await flush(40);

  const intruder = createOnlineChannel({ makePeer: broker.makePeer });
  intruder.join(code, 'Zed', 'a-made-up-token');
  await until(() => prompts === 2, 8000);
  assert.equal(prompts, 2, 'a bad token gets you the normal approval prompt, not a free pass');
  host.close(); g1.close(); intruder.close();
});

test('resume: both sides start counting again, and nothing unconfirmed is dropped', async () => {
  // The side that refreshed lost its sequence numbers. If only it reset, the
  // other side would treat everything it sent as already seen.
  const ends = {};
  const mk = (name, other) => {
    const cbs = {};
    const e = {
      onData(f) { cbs.data = f; }, onOpen(f) { cbs.open = f; }, onError(f) { cbs.error = f; },
      onStatus(f) { cbs.status = f; }, onJoinRequest(f) { cbs.join = f; },
      onHealthy(f) { cbs.healthy = f; }, onResumed(f) { cbs.resumed = f; },
      deliver: (m) => cbs.data && cbs.data(m),
      fireResume: () => cbs.resumed && cbs.resumed(),
      blocked: false,
      send(m) { if (!e.blocked) setTimeout(() => ends[other].deliver(m), 0); },
      host() {}, join() {}, isOpen() { return true; }, close() {},
      diagnostics: () => ({}),
    };
    return e;
  };
  ends.a = mk('a', 'b'); ends.b = mk('b', 'a');
  const A = createReliableChannel(ends.a, { resendMs: 80, ackIdleMs: 40 });
  const B = createReliableChannel(ends.b, { resendMs: 80, ackIdleMs: 40 });
  const got = [];
  B.onData((m) => got.push(m));
  A.onResumed(() => {}); B.onResumed(() => {});

  A.send({ type: 'one' });
  await until(() => got.length === 1);

  ends.a.blocked = true;                 // this one never makes it out
  A.send({ type: 'endTurn', turn: 2 });
  await flush(30);
  assert.equal(got.length, 1, 'it really was lost');

  ends.a.blocked = false;
  ends.b.fireResume();                   // B refreshed and came back
  ends.a.fireResume();
  await until(() => got.some((m) => m.type === 'endTurn'), 4000);
  assert.ok(got.some((m) => m.type === 'endTurn'), 'the unconfirmed hand-over is sent again');
  A.close(); B.close();
});
