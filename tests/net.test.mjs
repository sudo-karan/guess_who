// Tests for the online channel's join-approval handshake, driven by an
// in-memory fake PeerJS broker (real WebRTC can't run in CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineChannel, createLocalPair } from '../js/net.js';
import { createFakeBroker, until } from './fake-peer.mjs';

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
