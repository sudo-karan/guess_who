// Tests for the faults an adversarial review of the refresh-and-resume work
// turned up after it shipped. Each one fails against the code as it was.
//
// The theme running through most of them: the host never kept the token it
// issued. It handed one to the guest and forgot it, so a host that refreshed
// could not recognise its own opponent coming back and treated them as a
// stranger, dealing a brand-new cast over a game in progress. Everything that
// depends on a host knowing its own room was broken by that one missing line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineChannel } from '../js/net.js';
import { createRelayChannel } from '../js/relay.js';
import { createGameChannel } from '../js/channel.js';
import { createReliableChannel } from '../js/reliable.js';
import { createEngine } from '../js/engine.js';
import { createFakeBroker, until, flush } from './fake-peer.mjs';
import { createFakeNtfy } from './fake-ntfy.mjs';

// A transport with the same surface as net.js / relay.js, so channel.js can be
// driven directly. `fire` exposes the callbacks it was given.
function fakeTransport({ taken = false } = {}) {
  const fire = {};
  const t = {
    hosted: [], tokens: [], joined: [], closed: false, live: false,
    onData(f) { fire.data = f; }, onOpen(f) { fire.open = f; },
    onError(f) { fire.error = f; }, onStatus(f) { fire.status = f; },
    onJoinRequest(f) { fire.joinRequest = f; }, onHealthy(f) { fire.healthy = f; },
    onResumed(f) { fire.resumed = f; }, onToken(f) { fire.token = f; },
    onUnreachable(f) { fire.unreachable = f; },
    useSessionToken(v) { t.tokens.push(v); },
    host(code, onCode) {
      t.hosted.push(code);
      if (taken) setTimeout(() => fire.error && fire.error({ type: 'taken', message: 'taken' }), 0);
      else if (onCode) onCode(code);
    },
    join(code, name, resume, epoch) { t.joined.push({ code, name, resume, epoch }); },
    send() {}, isOpen() { return t.live; }, close() { t.closed = true; },
    diagnostics() { return {}; },
    fire,
  };
  return t;
}

/* ------------------------- the host's own token ------------------------ */

test('token: the host remembers the token it issues, not just the guest', async () => {
  const broker = createFakeBroker();
  const host = createOnlineChannel({ makePeer: broker.makePeer });
  let code = null, hostToken = null, guestToken = null;
  host.onJoinRequest((who, ctl) => ctl.accept());
  host.onToken((t) => { hostToken = t; });
  host.host((c) => { code = c; });
  await until(() => code !== null);

  const g = createOnlineChannel({ makePeer: broker.makePeer });
  g.onToken((t) => { guestToken = t; });
  g.join(code, 'Bo');
  await until(() => guestToken !== null);

  assert.ok(hostToken, 'the host is told the token it minted');
  assert.equal(hostToken, guestToken, 'and it is the same one the guest holds');
  host.close(); g.close();
});

test('token: the same holds over the relay', async () => {
  const ntfy = createFakeNtfy();
  const opts = { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl, joinRetryMs: 120 };
  const host = createRelayChannel(opts);
  let hostToken = null, guestToken = null;
  host.onJoinRequest((who, ctl) => ctl.accept());
  host.onToken((t) => { hostToken = t; });
  host.host('AB3U');

  const g = createRelayChannel(opts);
  g.onToken((t) => { guestToken = t; });
  g.join('AB3U', 'Bo');
  await until(() => guestToken !== null);

  assert.ok(hostToken);
  assert.equal(hostToken, guestToken);
  host.close(); g.close();
});

test('resume: a host that refreshes gets its opponent back, not a join request', async () => {
  const broker = createFakeBroker();
  const h1 = createOnlineChannel({ makePeer: broker.makePeer });
  let code = null, token = null, firstPrompts = 0;
  h1.onJoinRequest((who, ctl) => { firstPrompts++; ctl.accept(); });
  h1.onToken((t) => { token = t; });
  h1.host((c) => { code = c; });
  await until(() => code !== null);

  const g1 = createOnlineChannel({ makePeer: broker.makePeer });
  g1.join(code, 'Bo');
  await until(() => token !== null);
  assert.equal(firstPrompts, 1);

  h1.close(); g1.close();            // the HOST's tab reloads
  await flush(40);

  // What the saved game hands the new page: the same code and the same token.
  const h2 = createOnlineChannel({ makePeer: broker.makePeer });
  let prompts = 0, resumedHost = false, openedHost = false, code2 = null;
  h2.onJoinRequest((who, ctl) => { prompts++; ctl.accept(); });
  h2.onResumed(() => { resumedHost = true; });
  h2.onOpen(() => { openedHost = true; });
  h2.useSessionToken(token);
  h2.host(code, (c) => { code2 = c; });
  await until(() => code2 !== null);
  assert.equal(code2, code, 'the room keeps the code the opponent already has');

  const g2 = createOnlineChannel({ makePeer: broker.makePeer });
  let resumedGuest = false;
  g2.onResumed(() => { resumedGuest = true; });
  g2.join(code, 'Bo', token, 1);
  await until(() => resumedHost && resumedGuest, 8000);

  assert.ok(resumedHost, 'the host knows this is the opponent it was already playing');
  assert.ok(resumedGuest);
  assert.equal(prompts, 0, 'and is never asked to approve them');
  assert.equal(openedHost, false, 'nor told this is a fresh game, which would deal a new cast');
  h2.close(); g2.close();
});

test('token: both transports are told it, since either may carry the return', async () => {
  const direct = fakeTransport();
  const relay = fakeTransport();
  const ch = createGameChannel({ makeDirect: () => direct, makeRelay: () => relay });
  let announced = null;
  ch.host((c) => { announced = c; }, 'AB3U');
  await until(() => announced !== null);

  direct.fire.token('tok-xyz');        // the direct transport minted it
  assert.ok(relay.tokens.includes('tok-xyz'), 'the relay is given it as well');
  assert.equal(ch.sessionToken(), 'tok-xyz');
  ch.close();
});

/* --------------------- a channel that tells the truth ------------------ */

test('channel: isOpen() reports the transport, not a flag that never clears', async () => {
  const direct = fakeTransport();
  const ch = createGameChannel({ makeDirect: () => direct });
  let announced = null;
  ch.host((c) => { announced = c; }, 'AB3U');
  await until(() => announced !== null);

  direct.live = true;
  direct.fire.open();
  assert.equal(ch.isOpen(), true);

  direct.live = false;                 // the connection drops
  assert.equal(ch.isOpen(), false, 'which is what the rejoin loop has to see to retry at all');
  ch.close();
});

test('host: re-opening a room whose code is held gets the room onto the relay anyway', async () => {
  const relay = fakeTransport();
  const ch = createGameChannel({
    makeDirect: () => fakeTransport({ taken: true }),
    makeRelay: () => relay,
  });
  let announced = null;
  ch.host((c) => { announced = c; }, 'AB3U');
  await until(() => announced !== null, 3000);

  assert.equal(announced, 'AB3U', 'the code the opponent already has is still announced');
  assert.deepEqual(relay.hosted, ['AB3U'], 'and the relay is listening on it');
  ch.close();
});

test('resume: a returning player is let back in when the host has not noticed the old link died', async () => {
  // A tab that goes away does not always close its data channel. A phone that
  // backgrounds or reloads one often sends no close at all, so the host's flag
  // for that connection stays true for as long as the host's own page lives.
  // Refusing a token-bearing return on the strength of that flag refused the
  // real player every time, silently, until the game gave up and told them the
  // connection was lost. The test deliberately never closes the first guest.
  const broker = createFakeBroker();
  const host = createOnlineChannel({ makePeer: broker.makePeer, peerQuietMs: 150 });
  let code = null, token = null, prompts = 0, resumedHost = false;
  host.onJoinRequest((who, ctl) => { prompts++; ctl.accept(); });
  host.onResumed(() => { resumedHost = true; });
  host.host((c) => { code = c; });
  await until(() => code !== null);

  const g1 = createOnlineChannel({ makePeer: broker.makePeer });
  g1.onToken((t) => { token = t; });
  g1.join(code, 'Bo');
  await until(() => token !== null);
  assert.equal(prompts, 1);

  const g2 = createOnlineChannel({ makePeer: broker.makePeer });
  let resumedGuest = false;
  const errs = [];
  g2.onResumed(() => { resumedGuest = true; });
  g2.onError((e) => errs.push(e.type));
  g2.join(code, 'Bo', token, 1);

  await until(() => resumedGuest && resumedHost, 10000);
  assert.ok(resumedGuest, 'the returning player gets back in');
  assert.ok(resumedHost, 'and the host knows who they are');
  assert.equal(prompts, 1, 'without being asked to approve them again');
  assert.deepEqual(errs, [], 'and without an error on the way');
  host.close(); g1.close(); g2.close();
});

test('resume: a token cannot barge into a conversation in progress', async () => {
  // The other half of the same rule: while the accepted player is actually
  // sending moves, a second holder of the token is refused. Silently, because
  // answering would kill the retries a real return depends on.
  const broker = createFakeBroker();
  const host = createOnlineChannel({ makePeer: broker.makePeer, peerQuietMs: 3000 });
  let code = null, token = null, prompts = 0, resumedHost = false;
  const got = [];
  host.onJoinRequest((who, ctl) => { prompts++; ctl.accept(); });
  host.onResumed(() => { resumedHost = true; });
  host.onData((m) => got.push(m));
  host.host((c) => { code = c; });
  await until(() => code !== null);

  const g1 = createOnlineChannel({ makePeer: broker.makePeer });
  g1.onToken((t) => { token = t; });
  g1.join(code, 'Bo');
  await until(() => token !== null);

  g1.send({ type: 'chat', text: 'still here' });
  await until(() => got.length === 1);

  const thief = createOnlineChannel({ makePeer: broker.makePeer });
  let thiefResumed = false, thiefOpened = false;
  thief.onResumed(() => { thiefResumed = true; });
  thief.onOpen(() => { thiefOpened = true; });
  thief.join(code, 'Zed', token, 9);

  // Keep the real player talking, which is what holds the door shut.
  for (let i = 0; i < 5; i++) {
    await flush(300);
    g1.send({ type: 'chat', text: 'turn ' + i });
  }
  await until(() => got.length >= 6, 3000);
  assert.equal(resumedHost, false, 'the host does not hand the game over');
  assert.equal(thiefResumed, false);
  assert.equal(thiefOpened, false);
  assert.equal(prompts, 1, 'and is not prompted either, which would be as bad');
  assert.ok(got.length >= 6, 'the real player is still being heard');
  host.close(); g1.close(); thief.close();
});

test('resume: when the direct link dies the host listens on the relay for the return', async () => {
  const direct = fakeTransport();
  const relays = [];
  const ch = createGameChannel({
    makeDirect: () => direct,
    makeRelay: () => { const r = fakeTransport(); relays.push(r); return r; },
  });
  let announced = null, resumed = false;
  ch.onResumed(() => { resumed = true; });
  ch.host((c) => { announced = c; }, 'AB3U');
  await until(() => announced !== null);
  assert.equal(relays.length, 1, 'both transports listen while the room is waiting');

  direct.live = true;
  direct.fire.open();                  // the game starts on the direct link
  assert.equal(relays[0].closed, true, 'and the relay is dropped once direct wins');
  direct.fire.token('tok-1');

  // The opponent's phone reloads on a network with no peer-to-peer path, so the
  // relay is the only way they can reach us.
  direct.live = false;
  direct.fire.error({ type: 'closed', message: 'Connection closed.' });
  await until(() => relays.length === 2, 3000);
  assert.equal(relays[1].hosted[0], 'AB3U', 'the relay comes back on the same code');
  assert.ok(relays[1].tokens.includes('tok-1'), 'holding the token, so the return is recognised');

  relays[1].live = true;
  relays[1].fire.resumed();
  assert.ok(resumed, 'and they are let straight back in');
  assert.equal(ch.isOpen(), true, 'on the transport they actually came back on');
  assert.equal(ch.mode(), 'relay');
  ch.close();
});

test('join: the return attempt number is passed down to the transport', async () => {
  const direct = fakeTransport();
  const ch = createGameChannel({ makeDirect: () => direct });
  ch.join('ab3u', 'Bo', 'tok', 3);
  assert.deepEqual(direct.joined, [{ code: 'AB3U', name: 'Bo', resume: 'tok', epoch: 3 }]);
  ch.close();
});

/* ------------------- a token is not proof of identity ------------------ */

test('relay: a leaked token cannot push aside an opponent who is still playing', async () => {
  const ntfy = createFakeNtfy();
  const opts = { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl, joinRetryMs: 1000 };
  const host = createRelayChannel(opts);
  let resumed = 0, token = null, open = false;
  const got = [];
  host.onJoinRequest((who, ctl) => ctl.accept());
  host.onResumed(() => { resumed++; });
  host.onData((m) => got.push(m));
  host.host('AB3U');

  const g = createRelayChannel(opts);
  g.onOpen(() => { open = true; });
  // Read the token the way an onlooker would: off the ACCEPT frame the host has
  // to publish to the room's public topic.
  g.onToken((t) => { token = t; });
  g.join('AB3U', 'Bo');
  await until(() => open && token !== null);

  g.send({ type: 'chat', text: 'still here' });
  await until(() => got.length === 1);

  // Anyone subscribed to the room's public topic can read the token out of the
  // ACCEPT frame. Holding it must not be enough to take the game over.
  const thief = createRelayChannel(opts);
  let thiefResumed = false, thiefOpen = false;
  thief.onResumed(() => { thiefResumed = true; });
  thief.onOpen(() => { thiefOpen = true; });
  thief.join('AB3U', 'Zed', token, 9);
  await flush(500);

  assert.equal(resumed, 0, 'the host does not hand the game over');
  assert.equal(thiefResumed, false);
  assert.equal(thiefOpen, false);
  g.send({ type: 'chat', text: 'and still here' });
  await until(() => got.length === 2);
  assert.equal(got.length, 2, 'and the real player is still being heard');
  host.close(); g.close(); thief.close();
});

test('resume: the same return asked for twice only restarts the stream once', async () => {
  const ntfy = createFakeNtfy();
  const opts = { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl, joinRetryMs: 120 };
  const host = createRelayChannel(opts);
  let resumed = 0, token = null, open = false;
  host.onJoinRequest((who, ctl) => ctl.accept());
  host.onResumed(() => { resumed++; });
  host.onToken((t) => { token = t; });
  host.host('AB3U');

  const g = createRelayChannel(opts);
  g.onOpen(() => { open = true; });
  g.join('AB3U', 'Bo');
  await until(() => open && token !== null);
  g.close();

  const r1 = createRelayChannel(opts);
  let back = false;
  r1.onResumed(() => { back = true; });
  r1.join('AB3U', 'Bo', token, 1);
  await until(() => back && resumed === 1);

  // The same attempt asking again, because it never saw the answer. A relay
  // round-trip routinely outlasts the retry interval, so this is the norm.
  await flush(400);
  const r2 = createRelayChannel(opts);
  let acceptedAgain = false;
  r2.onResumed(() => { acceptedAgain = true; });
  r2.join('AB3U', 'Bo', token, 1);
  await flush(400);
  assert.equal(resumed, 1, 'the host answers again but does not act on it twice');
  assert.ok(acceptedAgain, 'and the asker is still told it is back in');

  // A genuinely later attempt does count.
  const r3 = createRelayChannel(opts);
  r3.join('AB3U', 'Bo', token, 2);
  await until(() => resumed === 2, 3000);
  assert.equal(resumed, 2);
  host.close(); r1.close(); r2.close(); r3.close();
});

/* ------------- what a reloading tab had in flight, resent -------------- */

function wiredPair() {
  const ends = {};
  const mk = (me, other) => {
    const cbs = {};
    const e = {
      onData(f) { cbs.data = f; }, onOpen(f) { cbs.open = f; }, onError(f) { cbs.error = f; },
      onStatus(f) { cbs.status = f; }, onJoinRequest(f) { cbs.join = f; },
      onHealthy(f) { cbs.healthy = f; }, onResumed(f) { cbs.resumed = f; },
      deliver: (m) => cbs.data && cbs.data(m),
      fireResume: () => cbs.resumed && cbs.resumed(),
      blocked: false,
      send(m) { if (!e.blocked) setTimeout(() => ends[other] && ends[other].deliver(m), 0); },
      host() {}, join() {}, isOpen() { return true; }, close() {},
      diagnostics: () => ({}),
    };
    return e;
  };
  ends.a = mk('a', 'b'); ends.b = mk('b', 'a');
  return ends;
}

test('delivery: a move in flight when the page reloads is sent again from the saved game', async () => {
  const ends = wiredPair();
  const A = createReliableChannel(ends.a, { resendMs: 80, ackIdleMs: 40 });
  const B = createReliableChannel(ends.b, { resendMs: 80, ackIdleMs: 40 });
  const got = [];
  B.onData((m) => got.push(m));
  A.onResumed(() => {}); B.onResumed(() => {});

  A.send({ type: 'one' });
  await until(() => got.length === 1);
  await until(() => A.pending().length === 0, 2000);
  assert.deepEqual(A.pending(), [], 'nothing outstanding while the line is working');

  ends.a.blocked = true;                       // this one never leaves
  A.send({ type: 'endTurn', turn: 2 });
  await flush(40);
  assert.equal(got.length, 1, 'it really was lost');

  // This is what the saved game stores, and the only copy there is: the outbox
  // holding it is about to go with the page.
  const saved = A.pending();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, 'endTurn');
  assert.equal(saved[0].__n, undefined, 'stored as the app sent it, without our bookkeeping');
  A.close();

  // The tab comes back: a brand-new channel, whose outbox is empty. The resume
  // handshake restarts the numbering on both sides, which is the only reason a
  // re-sent message is not mistaken for one already seen.
  ends.a.blocked = false;
  const A2 = createReliableChannel(ends.a, { resendMs: 80, ackIdleMs: 40 });
  A2.onResumed(() => {});
  ends.b.fireResume(); ends.a.fireResume();
  await flush(20);
  A2.requeue(saved);
  await until(() => got.some((m) => m.type === 'endTurn'), 4000);
  assert.ok(got.some((m) => m.type === 'endTurn'), 'the hand-over nobody else could resend gets through');
  A2.close(); B.close();
});

test('delivery: the saved copy is kept in step as messages are confirmed', async () => {
  const ends = wiredPair();
  let notified = 0;
  const A = createReliableChannel(ends.a, { resendMs: 80, ackIdleMs: 20 });
  const B = createReliableChannel(ends.b, { resendMs: 80, ackIdleMs: 20 });
  A.onPending(() => { notified++; });
  B.onData(() => {});

  A.send({ type: 'chat', text: 'hi' });
  assert.ok(notified >= 1, 'told when something is outstanding');
  const atSend = notified;
  // A bare acknowledgement empties the outbox without any game message moving,
  // so nothing else would have prompted a re-save. Replaying a stale copy after
  // that would duplicate a chat line or re-open the answer box.
  await until(() => A.pending().length === 0, 3000);
  assert.ok(notified > atSend, 'and told again once it is confirmed');
  A.close(); B.close();
});

test('delivery: a gap that can never be filled is reported, not asked for forever', async () => {
  const ends = wiredPair();
  const asks = [];
  const errors = [];
  // Watch what goes back out while messages arrive out of order.
  const realSend = ends.a.send;
  ends.a.send = (m) => { if (m && m.__need !== undefined) asks.push(m.__need); realSend(m); };
  const A = createReliableChannel(ends.a, { resendMs: 60, maxResends: 2, ackIdleMs: 500 });
  A.onError((e) => errors.push(e.type));
  A.onData(() => {});

  for (let seq = 2; seq <= 8; seq++) ends.a.deliver({ type: 'x', __n: seq });
  assert.equal(asks.length, 1, 'seven out-of-order arrivals do not mean seven requests');

  await until(() => errors.includes('unsent'), 3000);
  assert.ok(errors.includes('unsent'), 'a gap that never closes is surfaced to the player');
  const settled = asks.length;
  await flush(600);
  assert.ok(asks.length - settled <= 12, 'and it is asked for on a clock, not in a storm');
  A.close();
});

test('resume: a second drop is still reported after the first one was recovered', async () => {
  // net.js latches its error reporting so a late timer cannot overwrite a more
  // accurate terminal message. A resume revives the transport, so it has to
  // lift that latch too: without it the SECOND drop said nothing at all, and
  // nothing put the relay back up for an opponent who needed it to get home.
  const broker = createFakeBroker();
  const host = createOnlineChannel({ makePeer: broker.makePeer, peerQuietMs: 50 });
  let code = null, token = null, resumed = false;
  const errs = [];
  host.onJoinRequest((who, ctl) => ctl.accept());
  host.onToken((t) => { token = t; });
  host.onResumed(() => { resumed = true; });
  host.onError((e) => errs.push(e.type));
  host.host((c) => { code = c; });
  await until(() => code !== null);

  const g1 = createOnlineChannel({ makePeer: broker.makePeer });
  g1.join(code, 'Bo');
  await until(() => token !== null);
  g1.close();
  await until(() => errs.length >= 1, 4000);
  assert.deepEqual(errs, ['closed'], 'the first drop is reported');

  const g2 = createOnlineChannel({ makePeer: broker.makePeer });
  g2.join(code, 'Bo', token, 1);
  await until(() => resumed, 8000);
  assert.ok(resumed);

  g2.close();
  await until(() => errs.length >= 2, 4000);
  assert.deepEqual(errs, ['closed', 'closed'], 'and so is the second');
  host.close(); g1.close(); g2.close();
});

test('delivery: a request for a missing message is answered even after our resends gave up', async () => {
  // An explicit request is newer and better information than our own clock: it
  // proves the peer is listening and says exactly what it wants. Refusing it
  // once our budget had run out left a perfectly recoverable gap open for good.
  const ends = wiredPair();
  const A = createReliableChannel(ends.a, { resendMs: 40, maxResends: 2, ackIdleMs: 500 });
  A.onError(() => {});
  const sent = [];
  const realSend = ends.a.send;
  ends.a.send = (m) => { sent.push(m); realSend(m); };
  const handovers = () => sent.filter((m) => m && m.type === 'endTurn').length;

  A.send({ type: 'endTurn', turn: 2 });
  await until(() => handovers() >= 3, 4000);     // the first send plus two resends
  await flush(900);
  const plateau = handovers();
  await flush(700);
  assert.equal(handovers(), plateau, 'our own clock has given up, as it should');

  ends.a.deliver({ __need: 1 });                 // the peer says what it is missing
  await until(() => handovers() > plateau, 3000);
  assert.ok(handovers() > plateau, 'and asking for it gets it');
  A.close();
});

/* -------------------- an engine that ignores a repeat ------------------ */

function guestInPlay() {
  const e = createEngine({ isHost: false, myName: 'Bo' });
  const board = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(e.setupLocal({ board, secret: 7 }).ok, true);
  e.handleMessage({ type: 'setup', name: 'Ann', board });
  e.handleMessage({ type: 'begin', first: false });     // guest to move
  assert.equal(e.state.phase, 'play');
  assert.equal(e.state.turn, 'me');
  return e;
}

const crossedOff = (e) => Object.values(e.state.deduction).filter((v) => v === false).length;

test('engine: a repeated setup does not wipe the cards you have crossed off', () => {
  const e = guestInPlay();
  const board = e.state.oppBoard.slice();
  e.toggleCard(board[0]); e.toggleCard(board[1]); e.toggleCard(board[2]);
  assert.equal(crossedOff(e), 3);

  // The opponent's setup was never confirmed, so a resumed connection re-sends
  // it. Applying it again stood all twenty cards back up mid-game.
  e.handleMessage({ type: 'setup', name: 'Ann', board });
  assert.equal(crossedOff(e), 3, 'the deductions survive');
  assert.equal(e.state.phase, 'play');
});

test('engine: a guess only decides a game that is actually being played', () => {
  // A rematch moves the phase off 'over' while the end-of-game messages may
  // still be unconfirmed, so a resume just after clicking Rematch replayed the
  // previous game's guess and dropped the receiver onto a result for a round
  // nobody had played.
  const idle = createEngine({ isHost: false, myName: 'Bo' });
  idle.handleMessage({ type: 'guess', id: 3, ts: 1, turn: 1 });
  assert.equal(idle.state.phase, 'setup', 'a guess before a game starts decides nothing');
  assert.equal(idle.state.winner, null);

  const playing = guestInPlay();
  const wrong = playing.state.oppBoard.find((id) => id !== playing.state.mySecret);
  playing.handleMessage({ type: 'guess', id: wrong, ts: 2, turn: 1 });
  assert.equal(playing.state.phase, 'over', 'but one during play still does');
});

test('engine: a result for a guess I never made is ignored', () => {
  const e = guestInPlay();
  assert.equal(e.state.pendingGuess, false);
  e.handleMessage({ type: 'guessResult', id: 5, correct: true, ts: 1 });
  assert.equal(e.state.phase, 'play', 'it does not win a round I did not guess in');
  assert.equal(e.state.winner, null);
});

test('engine: a repeated begin does not hand the turn back mid-game', () => {
  const e = guestInPlay();
  assert.equal(e.state.turn, 'me');
  assert.equal(e.endTurn(), true);
  assert.equal(e.state.turn, 'opp', 'it is the opponent\'s turn now');
  const turnNo = e.state.turnNumber;

  // The host's `begin` was never confirmed, so a resumed connection sends it
  // again. Starting play over takes the turn back and leaves both sides waiting.
  e.handleMessage({ type: 'begin', first: false });
  assert.equal(e.state.turn, 'opp', 'play is not restarted');
  assert.equal(e.state.turnNumber, turnNo, 'nor the turn counter reset');
  assert.equal(e.state.phase, 'play');
});
