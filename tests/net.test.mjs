// Tests for the online channel's join-approval handshake, driven by an
// in-memory fake PeerJS broker (real WebRTC can't run in CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineChannel, createLocalPair, savedTurn, saveTurn, iceConfig } from '../js/net.js';
import { createFakeBroker, until, flush } from './fake-peer.mjs';

// Spin up a host + one guest sharing a broker; returns handles + captured state.
function pair(broker) {
  const host = createOnlineChannel({ makePeer: broker.makePeer });
  const guest = createOnlineChannel({ makePeer: broker.makePeer });
  const st = {
    hostOpen: false, guestOpen: false, hostData: [], guestData: [],
    guestErrors: [], hostErrors: [], joinName: null, ctl: null, code: null,
  };
  host.onOpen(() => { st.hostOpen = true; });
  host.onData((m) => st.hostData.push(m));
  host.onError((e) => st.hostErrors.push(e));
  guest.onOpen(() => { st.guestOpen = true; });
  guest.onData((m) => st.guestData.push(m));
  guest.onError((e) => st.guestErrors.push(e));
  return { host, guest, st };
}

test('online: host approves guest → both open, messages flow both ways', async () => {
  const broker = createFakeBroker();
  const { host, guest, st } = pair(broker);
  host.onJoinRequest((name, ctl) => { st.joinName = name; st.ctl = ctl; });

  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  guest.join(st.code, 'Bo');

  await until(() => st.joinName !== null);
  assert.equal(st.joinName, 'Bo');
  assert.equal(st.hostOpen, false, 'host must NOT be open before it approves');
  assert.equal(st.guestOpen, false, 'guest must NOT be open before approval');

  st.ctl.accept();
  await until(() => st.hostOpen && st.guestOpen);
  assert.ok(st.hostOpen && st.guestOpen, 'both open after approval');

  host.send({ type: 'roster', roster: [1, 2] });
  guest.send({ type: 'setup', name: 'Bo' });
  await until(() => st.guestData.length && st.hostData.length);
  assert.deepEqual(st.guestData.at(-1), { type: 'roster', roster: [1, 2] });
  assert.deepEqual(st.hostData.at(-1), { type: 'setup', name: 'Bo' });
  // The handshake messages must never leak through as game data.
  assert.ok(!st.guestData.some((m) => m.__t), 'no handshake frames delivered as game data');
  assert.ok(!st.hostData.some((m) => m.__t));

  host.close(); guest.close();
});

test('online: host declines → guest gets a "denied" error and nobody opens', async () => {
  const broker = createFakeBroker();
  const { host, guest, st } = pair(broker);
  host.onJoinRequest((name, ctl) => ctl.deny());

  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  guest.join(st.code, 'Bo');

  await until(() => st.guestErrors.some((e) => e.type === 'denied'));
  assert.ok(st.guestErrors.some((e) => e.type === 'denied'));
  assert.equal(st.hostOpen, false);
  assert.equal(st.guestOpen, false);
  host.close(); guest.close();
});

test('online: a second guest to an occupied room is told it is full', async () => {
  const broker = createFakeBroker();
  const host = createOnlineChannel({ makePeer: broker.makePeer });
  // No onJoinRequest wired → host auto-accepts the first guest.
  let code = null, hostOpen = false;
  host.onOpen(() => { hostOpen = true; });
  host.host((c) => { code = c; });
  await until(() => code !== null);

  const g1 = createOnlineChannel({ makePeer: broker.makePeer });
  let g1Open = false; g1.onOpen(() => { g1Open = true; });
  g1.join(code, 'A');
  await until(() => g1Open && hostOpen);
  assert.ok(g1Open, 'first guest gets in');

  const g2 = createOnlineChannel({ makePeer: broker.makePeer });
  const g2Errors = []; let g2Open = false;
  g2.onOpen(() => { g2Open = true; });
  g2.onError((e) => g2Errors.push(e));
  g2.join(code, 'B');
  await until(() => g2Errors.some((e) => e.type === 'full'));
  assert.ok(g2Errors.some((e) => e.type === 'full'), 'second guest is told the room is full');
  assert.equal(g2Open, false);

  host.close(); g1.close(); g2.close();
});

test('online: with no approval handler the host auto-accepts (back-compat)', async () => {
  const broker = createFakeBroker();
  const { host, guest, st } = pair(broker);   // note: no onJoinRequest wired
  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  guest.join(st.code, 'Bo');
  await until(() => st.hostOpen && st.guestOpen);
  assert.ok(st.hostOpen && st.guestOpen);
  host.close(); guest.close();
});

test('online: a disconnect after the match opens surfaces a "closed" error', async () => {
  const broker = createFakeBroker();
  const { host, guest, st } = pair(broker);
  host.onJoinRequest((name, ctl) => ctl.accept());
  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  guest.join(st.code, 'Bo');
  await until(() => st.hostOpen && st.guestOpen);

  host.close();                                   // host drops
  await until(() => st.guestErrors.some((e) => e.type === 'closed'));
  assert.ok(st.guestErrors.some((e) => e.type === 'closed'));
  host.close(); guest.close();
});

test('online: approving a guest that already left does not strand the host', async () => {
  const broker = createFakeBroker();
  const host = createOnlineChannel({ makePeer: broker.makePeer });
  let code = null, hostOpen = false, ctl = null;
  host.onOpen(() => { hostOpen = true; });
  host.onJoinRequest((name, c) => { ctl = c; });   // capture, approve manually
  host.host((c) => { code = c; });
  await until(() => code !== null);

  const g1 = createOnlineChannel({ makePeer: broker.makePeer });
  g1.join(code, 'A');
  await until(() => ctl !== null);
  g1.close();                       // guest leaves before the host answers
  await flush(60);                  // let the close reach the host's pending conn
  const ctl1 = ctl; ctl = null;
  ctl1.accept();                    // host approves the now-dead connection
  await flush(60);
  assert.equal(hostOpen, false, 'host must NOT commit the game to a dead connection');

  // A fresh guest can still be accepted afterwards (room isn't wedged "full").
  const g2 = createOnlineChannel({ makePeer: broker.makePeer });
  let g2Open = false; g2.onOpen(() => { g2Open = true; });
  g2.join(code, 'B');
  await until(() => ctl !== null);
  ctl.accept();
  await until(() => hostOpen && g2Open);
  assert.ok(hostOpen && g2Open, 'a fresh guest can still join after a ghost approval');
  host.close(); g1.close(); g2.close();
});

test('online: a late connect timeout cannot replace "no room with that code"', async () => {
  // The first, specific cause must stick. Before this rule, a definite
  // peer-unavailable was overwritten seconds later by a vague timeout, which is
  // what made a failed join impossible to diagnose from a screenshot.
  const broker = createFakeBroker();
  const errs = [];
  const guest = createOnlineChannel({ makePeer: broker.makePeer, connectMs: 30 });
  guest.onError((e) => errs.push(e));
  guest.join('ZZZZ', 'Bo');                  // nobody is hosting ZZZZ
  await until(() => errs.length > 0);
  assert.equal(errs[0].type, 'nosuchroom', 'the specific cause is reported first');
  await flush(140);                          // well past connectMs
  assert.equal(errs.length, 1, 'the connect timeout must not add a second, vaguer error');
  guest.close();
});

// The real-world failure: the broker answers and the code is accepted, but the
// data channel never opens. PeerJS reports nothing at all in that case.
function blockedPeer() {
  const h = {};
  const p = {
    id: 'blocked',
    on(e, f) { (h[e] || (h[e] = [])).push(f); return p; },
    emit(e, a) { (h[e] || []).forEach((fn) => fn(a)); },
    connect() {
      const ch = {};
      return {
        open: false,                       // never becomes true
        on(e, f) { (ch[e] || (ch[e] = [])).push(f); return this; },
        send() {}, close() {},
      };
    },
    destroy() {},
  };
  setTimeout(() => p.emit('open', 'blocked'), 0);
  return p;
}

test('online: a blocked data channel hands over instead of erroring', async () => {
  // With a fallback transport listening, "this network can't do peer-to-peer"
  // is a handover signal, not a player-facing failure.
  const errs = []; let why = null;
  const guest = createOnlineChannel({ makePeer: blockedPeer, connectMs: 40 });
  guest.onError((e) => errs.push(e));
  guest.onUnreachable((w) => { why = w; });
  guest.join('ABCD', 'Bo');
  await until(() => why !== null);
  assert.ok(why, 'the blocked channel reports itself unreachable');
  assert.deepEqual(errs, [], 'and surfaces no error, because a fallback is listening');
  guest.close();
});

test('online: with no fallback listening, a blocked channel becomes a clear error', async () => {
  const errs = [];
  const guest = createOnlineChannel({ makePeer: blockedPeer, connectMs: 40 });
  guest.onError((e) => errs.push(e));      // note: no onUnreachable wired
  guest.join('ABCD', 'Bo');
  await until(() => errs.length > 0);
  assert.equal(errs[0].type, 'timeout');
  assert.match(errs[0].message, /network/i, 'the message names the real cause');
  guest.close();
});

test('ice: a malformed saved TURN entry is rejected, not handed to the browser', () => {
  // An invalid ICE server makes RTCPeerConnection throw, which would break EVERY
  // connection — hosting included — with no way out but clearing site data.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    for (const junk of ['not json', '{}', '{"urls":""}', '{"urls":123}', '{"urls":["http://nope"]}', '{"urls":[]}']) {
      store.set('gw-turn', junk);
      assert.equal(savedTurn(), null, `rejected: ${junk}`);
      assert.ok(iceConfig().iceServers.every((s) => !/^http/.test([].concat(s.urls)[0])));
    }
    saveTurn({ urls: ' turns:example.com:443?transport=tcp ', username: 'u', credential: 'p' });
    const t = savedTurn();
    assert.equal(t.urls, 'turns:example.com:443?transport=tcp', 'a valid entry survives, trimmed');
    assert.equal(t.username, 'u');
    assert.ok(iceConfig().iceServers.some((s) => s.urls === t.urls), 'and reaches the ICE config');

    saveTurn({ urls: 'turns:example.com:443', username: 7, credential: 'p' });
    assert.equal(savedTurn().username, undefined, 'half-supplied credentials are dropped');
  } finally {
    delete globalThis.localStorage;
  }
});

test('online: losing the matchmaking server mid-game does NOT end the game', async () => {
  // THE reported bug. The data channel is peer-to-peer; the broker only matters
  // for setting up new connections. PeerJS reports a dropped signalling socket as
  // an error on the peer, and treating that as a disconnect told the player whose
  // turn it wasn't — sitting idle, receiving nothing — that their opponent had
  // left, over a connection that was working perfectly.
  const broker = createFakeBroker();
  const { host, guest, st } = pair(broker);
  host.onJoinRequest((name, ctl) => ctl.accept());
  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  guest.join(st.code, 'Bo');
  await until(() => st.hostOpen && st.guestOpen);

  // The guest is idle, waiting on the host's move, when the signalling socket dies.
  for (const type of ['network', 'socket-error', 'socket-closed', 'server-error']) {
    const peer = broker.claimed.get('guesswho-v1-' + st.code);
    assert.ok(peer, 'host peer still registered');
    [...broker.claimed.values()].forEach((p) => p.emit('error', { type }));
    await flush(10);
    assert.deepEqual(st.guestErrors, [], `a "${type}" blip must not be reported as a disconnect`);
    assert.deepEqual(st.hostErrors, [], `nor on the host side ("${type}")`);
  }

  // And the game still works afterwards.
  host.send({ type: 'turn', to: 'guest' });
  await until(() => st.guestData.some((m) => m.type === 'turn'));
  assert.ok(st.guestData.some((m) => m.type === 'turn'), 'moves still get through');
  host.close(); guest.close();
});

test('online: a broker reconnect mid-game does not open a SECOND connection', async () => {
  // reconnect() re-fires 'open'. Dialling again opened a second data connection
  // that the guest then treated as the live one — muting the real channel and
  // making the host reject it as full. Worse than the bug it was added to fix.
  const broker = createFakeBroker();
  const { host, guest, st } = pair(broker);
  host.onJoinRequest((name, ctl) => ctl.accept());
  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  guest.join(st.code, 'Bo');
  await until(() => st.hostOpen && st.guestOpen);

  const before = st.hostData.length;
  // The broker drops and comes back, as it does on any network blip.
  [...broker.claimed.values()].forEach((p) => { p.emit('disconnected'); p.emit('open', p.id); });
  await flush(60);

  assert.deepEqual(st.guestErrors, [], 'no error from a reconnect');
  assert.deepEqual(st.hostErrors, [], 'and the host is not told the room is full');
  // The original channel must still be the live one, in both directions.
  guest.send({ type: 'move', n: 1 });
  host.send({ type: 'move', n: 2 });
  await until(() => st.hostData.length > before && st.guestData.some((m) => m.type === 'move'));
  assert.ok(st.hostData.some((m) => m.type === 'move' && m.n === 1), 'guest -> host still works');
  assert.ok(st.guestData.some((m) => m.type === 'move' && m.n === 2), 'host -> guest still works');
  host.close(); guest.close();
});

test('online: a reconnect reports the transport healthy again', async () => {
  // The player whose turn it is NOT receives nothing for minutes, so recovery has
  // to be reported by the transport; judging them by silence is the original bug.
  const broker = createFakeBroker();
  const { host, guest, st } = pair(broker);
  host.onJoinRequest((name, ctl) => ctl.accept());
  let healthy = 0;
  guest.onHealthy(() => { healthy++; });
  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  guest.join(st.code, 'Bo');
  await until(() => st.hostOpen && st.guestOpen);

  [...broker.claimed.values()].forEach((p) => { p.emit('disconnected'); p.emit('open', p.id); });
  await until(() => healthy > 0);
  assert.ok(healthy > 0, 'recovery is announced without needing any game traffic');
  host.close(); guest.close();
});

test('online: "unavailable-id" mid-game must not destroy the live connection', async () => {
  // After a reconnect the server can still hold our old registration. Destroying
  // the peer over that would close the live data channel with it.
  const broker = createFakeBroker();
  const { host, guest, st } = pair(broker);
  host.onJoinRequest((name, ctl) => ctl.accept());
  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  guest.join(st.code, 'Bo');
  await until(() => st.hostOpen && st.guestOpen);

  [...broker.claimed.values()].forEach((p) => p.emit('error', { type: 'unavailable-id' }));
  await flush(40);
  assert.deepEqual(st.hostErrors, [], 'not reported as a failure');
  host.send({ type: 'still-here' });
  await until(() => st.guestData.some((m) => m.type === 'still-here'));
  assert.ok(st.guestData.some((m) => m.type === 'still-here'), 'the game connection survives');
  host.close(); guest.close();
});

test('online: the same signalling errors ARE fatal before the match opens', async () => {
  // Before anyone is connected, the broker is the only way in — so a dead socket
  // there is a real failure and must still be reported.
  const broker = createFakeBroker();
  const errs = [];
  let code = null;
  const host = createOnlineChannel({ makePeer: broker.makePeer });
  host.onError((e) => errs.push(e));
  host.host((c) => { code = c; });
  await until(() => code !== null);           // room is up, but nobody has joined
  [...broker.claimed.values()].forEach((p) => p.emit('error', { type: 'network' }));
  await until(() => errs.length > 0);
  assert.equal(errs[0].type, 'peer');
  assert.match(errs[0].message, /matchmaking server|connection/i);
  host.close();
});

test('local pair still wires two engines directly', () => {
  const p = createLocalPair();
  const a = [], b = [];
  p.a.onData((m) => a.push(m));
  p.b.onData((m) => b.push(m));
  p.a.send({ x: 1 });   // a -> b
  p.b.send({ y: 2 });   // b -> a
  assert.deepEqual(b, [{ x: 1 }]);
  assert.deepEqual(a, [{ y: 2 }]);
});
