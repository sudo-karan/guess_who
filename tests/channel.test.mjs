// Tests for the composite online channel: a direct peer-to-peer connection when
// the networks allow one, and an automatic fallback to the HTTPS relay when they
// don't. This is the behaviour that decides whether two real players can get into
// a room at all, so it is tested on both paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameChannel } from '../js/channel.js';
import { createFakeBroker, until, flush } from './fake-peer.mjs';
import { createFakeNtfy } from './fake-ntfy.mjs';

// A direct transport that behaves exactly as a blocked network does: the signalling
// works, nothing else ever happens, and it reports itself unreachable.
function deadDirect({ errorType } = {}) {
  const cbs = {};
  return {
    onData(f) { cbs.data = f; }, onOpen(f) { cbs.open = f; }, onError(f) { cbs.error = f; },
    onStatus(f) { cbs.status = f; }, onJoinRequest(f) { cbs.join = f; }, onUnreachable(f) { cbs.unreach = f; },
    diagnostics: () => ({ transport: 'direct (peer-to-peer)', ice: 'failed' }),
    host(code, onCode) { setTimeout(() => onCode && onCode(code), 0); },
    join() {
      setTimeout(() => {
        if (errorType) cbs.error && cbs.error({ type: errorType, message: 'nope' });
        else cbs.unreach && cbs.unreach('data channel never opened');
      }, 0);
    },
    send() {}, isOpen() { return false; }, close() {},
  };
}

function harness(opts) {
  const st = { code: null, hostOpen: false, guestOpen: false, hostData: [], guestData: [], errors: [], joinName: null, ctl: null };
  const host = createGameChannel(opts);
  const guest = createGameChannel(opts);
  host.onOpen(() => { st.hostOpen = true; });
  host.onData((m) => st.hostData.push(m));
  host.onError((e) => st.errors.push(e));
  host.onJoinRequest((who, ctl) => { st.joinName = who; st.ctl = ctl; });
  guest.onOpen(() => { st.guestOpen = true; });
  guest.onData((m) => st.guestData.push(m));
  guest.onError((e) => st.errors.push(e));
  return { host, guest, st };
}

test('channel: when the network allows it, the game runs over the direct connection', async () => {
  const broker = createFakeBroker();
  const ntfy = createFakeNtfy();
  const opts = {
    makePeer: broker.makePeer,
    relayOpts: { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl },
  };
  const { host, guest, st } = harness(opts);

  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  assert.match(st.code, /^[A-Z0-9]{4}$/, 'a room code is issued');

  guest.join(st.code, 'Bo');
  await until(() => st.joinName !== null);
  assert.equal(st.joinName, 'Bo');
  st.ctl.accept();

  await until(() => st.hostOpen && st.guestOpen);
  assert.equal(host.mode(), 'direct', 'direct wins when it works');
  assert.equal(guest.mode(), 'direct');

  host.send({ type: 'roster', roster: [1, 2] });
  guest.send({ type: 'setup', name: 'Bo' });
  await until(() => st.guestData.length && st.hostData.length);
  assert.deepEqual(st.guestData.at(-1), { type: 'roster', roster: [1, 2] });
  assert.deepEqual(st.hostData.at(-1), { type: 'setup', name: 'Bo' });

  host.close(); guest.close();
});

test('channel: a guest whose network blocks peer-to-peer still gets into the room', async () => {
  // This is the reported failure: signalling succeeds, the data channel never
  // opens, and the player is stranded. The relay must pick the game up.
  const broker = createFakeBroker();
  const ntfy = createFakeNtfy();
  const relayOpts = { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl };
  const st = { code: null, hostOpen: false, guestOpen: false, hostData: [], guestData: [], joinName: null, ctl: null, errors: [] };

  const host = createGameChannel({ makePeer: broker.makePeer, relayOpts });
  host.onOpen(() => { st.hostOpen = true; });
  host.onData((m) => st.hostData.push(m));
  host.onJoinRequest((who, ctl) => { st.joinName = who; st.ctl = ctl; });
  host.onError((e) => st.errors.push(e));

  const guest = createGameChannel({ relayOpts, makeDirect: () => deadDirect() });
  guest.onOpen(() => { st.guestOpen = true; });
  guest.onData((m) => st.guestData.push(m));
  guest.onError((e) => st.errors.push(e));

  host.host((c) => { st.code = c; });
  await until(() => st.code !== null);
  guest.join(st.code, 'Bo');

  await until(() => st.joinName !== null);
  assert.equal(st.joinName, 'Bo', 'the join request reaches the host over the relay');
  st.ctl.accept();

  await until(() => st.hostOpen && st.guestOpen);
  assert.ok(st.hostOpen && st.guestOpen, 'the match opens despite the blocked direct path');
  assert.equal(guest.mode(), 'relay');
  assert.equal(host.mode(), 'relay', 'the host follows the transport the guest arrived on');
  assert.deepEqual(st.errors, [], 'the player is never shown an error');

  host.send({ type: 'roster', roster: [7, 8] });
  guest.send({ type: 'setup', name: 'Bo' });
  await until(() => st.guestData.length && st.hostData.length);
  assert.deepEqual(st.guestData.at(-1), { type: 'roster', roster: [7, 8] });
  assert.deepEqual(st.hostData.at(-1), { type: 'setup', name: 'Bo' });

  host.close(); guest.close();
});

test('channel: "no such room" on the broker still tries the relay before giving up', async () => {
  // A host whose broker registration failed is reachable ONLY over the relay;
  // reporting peer-unavailable straight away would strand both players.
  const ntfy = createFakeNtfy();
  const relayOpts = { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl };
  const st = { hostOpen: false, guestOpen: false, errors: [], ctl: null };

  const host = createGameChannel({ relayOpts, makeDirect: () => deadDirect({ errorType: 'broker' }) });
  host.onOpen(() => { st.hostOpen = true; });
  host.onJoinRequest((who, ctl) => { st.ctl = ctl; });
  host.onError((e) => st.errors.push(e));
  let code = null;
  host.host((c) => { code = c; });
  await until(() => code !== null);

  const guest = createGameChannel({ relayOpts, makeDirect: () => deadDirect({ errorType: 'nosuchroom' }) });
  guest.onOpen(() => { st.guestOpen = true; });
  guest.onError((e) => st.errors.push(e));
  guest.join(code, 'Bo');

  await until(() => st.ctl !== null);
  st.ctl.accept();
  await until(() => st.hostOpen && st.guestOpen);
  assert.ok(st.hostOpen && st.guestOpen, 'a relay-only room is still joinable');
  assert.deepEqual(st.errors, []);
  host.close(); guest.close();
});

test('channel: the host advertises ONE code on both transports', async () => {
  const broker = createFakeBroker();
  const ntfy = createFakeNtfy();
  const relayOpts = { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl };
  let code = null;
  const host = createGameChannel({ makePeer: broker.makePeer, relayOpts });
  host.host((c) => { code = c; });
  await until(() => code !== null);
  await flush(20);
  // The direct transport claimed the peer id, and the relay is listening on the
  // matching topic — so a guest reaching either one finds the same room.
  assert.ok(broker.claimed.has('guesswho-v1-' + code), 'direct peer id claimed for the code');
  assert.ok(ntfy.topics.has('guesswho-v1-' + code + '-h'), 'relay listening on the same code');
  host.close();
});

test('channel: a blocked guest with no relay available gets a clear error, not a hang', async () => {
  const st = { errors: [] };
  const guest = createGameChannel({ makeDirect: () => deadDirect() });
  guest.onError((e) => st.errors.push(e));
  guest.join('AB3U', 'Bo');
  await until(() => st.errors.length > 0);
  assert.equal(st.errors[0].type, 'timeout');
  assert.match(st.errors[0].message, /network/i);
  guest.close();
});
