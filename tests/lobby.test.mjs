// Unit tests for the serverless lobby: room registry, coordinator message
// handling, and the become-coordinator / join-as-client / re-election flow,
// driven by an in-memory fake PeerJS broker (no real network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistry, handleCoordinatorMessage, createLobby, LOBBY_ID, ROOM_STATUS,
} from '../js/lobby.js';

/* ------------------------------ registry ------------------------------ */
test('registry: publish, list newest-first, update, remove', () => {
  const r = createRegistry();
  r.publish('p1', { code: 'AAAA', hostName: 'Ann' }, 1);
  r.publish('p2', { code: 'BBBB', hostName: 'Bo' }, 2);
  assert.equal(r.size(), 2);
  assert.deepEqual(r.list().map((x) => x.code), ['BBBB', 'AAAA']); // newest (higher ts) first
  assert.equal(r.list()[0].status, ROOM_STATUS.OPEN);
  assert.ok(!('ownerId' in r.list()[0]));                          // internal field hidden

  assert.equal(r.update('AAAA', ROOM_STATUS.PLAYING), true);
  assert.equal(r.list().find((x) => x.code === 'AAAA').status, ROOM_STATUS.PLAYING);
  assert.equal(r.update('ZZZZ', ROOM_STATUS.PLAYING), false);

  assert.equal(r.remove('AAAA'), true);
  assert.equal(r.size(), 1);
});

test('registry: publish replaces same code; removeByOwner drops a hosts rooms', () => {
  const r = createRegistry();
  r.publish('p1', { code: 'AAAA', hostName: 'Ann' }, 1);
  r.publish('p1', { code: 'AAAA', hostName: 'Ann2', status: ROOM_STATUS.PLAYING }, 2); // replace
  assert.equal(r.size(), 1);
  assert.equal(r.list()[0].hostName, 'Ann2');
  assert.equal(r.list()[0].status, ROOM_STATUS.PLAYING);

  r.publish('p2', { code: 'BBBB', hostName: 'Bo' }, 3);
  assert.equal(r.removeByOwner('p1'), 1);   // only Ann's room
  assert.equal(r.size(), 1);
  assert.equal(r.list()[0].code, 'BBBB');
});

test('registry: publish ignores malformed rooms', () => {
  const r = createRegistry();
  assert.equal(r.publish('p1', null), false);
  assert.equal(r.publish('p1', { hostName: 'no code' }), false);
  assert.equal(r.size(), 0);
});

/* ---------------------- coordinator message handling ------------------- */
function fakeConn(peerId) {
  const sent = [];
  return { peer: peerId, send: (m) => sent.push(m), sent };
}

test('coordinator: sub sends current list; pub/status/unpub broadcast', () => {
  const reg = createRegistry();
  const subs = new Set();
  let broadcasts = 0;
  const broadcast = () => { broadcasts++; };

  const sub = fakeConn('c1');
  handleCoordinatorMessage(reg, subs, sub, { t: 'sub' }, broadcast, 1);
  assert.equal(subs.size, 1);
  assert.deepEqual(sub.sent.at(-1), { t: 'rooms', rooms: [] });   // immediate snapshot

  const host = fakeConn('h1');
  handleCoordinatorMessage(reg, subs, host, { t: 'pub', room: { code: 'AAAA', hostName: 'Ann' } }, broadcast, 2);
  assert.equal(reg.size(), 1);
  assert.equal(broadcasts, 1);

  handleCoordinatorMessage(reg, subs, host, { t: 'status', code: 'AAAA', status: ROOM_STATUS.PLAYING }, broadcast, 3);
  assert.equal(reg.list()[0].status, ROOM_STATUS.PLAYING);
  assert.equal(broadcasts, 2);

  handleCoordinatorMessage(reg, subs, host, { t: 'unpub', code: 'AAAA' }, broadcast, 4);
  assert.equal(reg.size(), 0);
  assert.equal(broadcasts, 3);
});

test('coordinator: garbage messages are ignored', () => {
  const reg = createRegistry();
  const subs = new Set();
  let broadcasts = 0;
  handleCoordinatorMessage(reg, subs, fakeConn('c'), null, () => broadcasts++, 1);
  handleCoordinatorMessage(reg, subs, fakeConn('c'), { t: 'nope' }, () => broadcasts++, 1);
  assert.equal(broadcasts, 0);
  assert.equal(reg.size(), 0);
});

/* --------------------------- fake PeerJS broker ------------------------ */
// Minimal async model of the PeerJS signalling + data-channel behaviour:
// claiming an id, id-collision errors, connecting, and message passing.
const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// Poll until `pred()` is truthy (robust to CPU contention / timer stretching).
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await flush(10); }
  return pred();
}

function createFakeBroker() {
  const claimed = new Map();       // id -> peer
  let idc = 0;
  const later = (fn) => setTimeout(fn, 0);

  function makeConn(remoteId) {
    const h = {};
    let closed = false;
    const c = {
      peer: remoteId,
      other: null,
      on(ev, fn) { (h[ev] || (h[ev] = [])).push(fn); return c; },
      emit(ev, a) { (h[ev] || []).forEach((fn) => fn(a)); },
      send(msg) { later(() => c.other && c.other.emit('data', msg)); },
      _shutdown() { if (closed) return; closed = true; c.emit('close'); },
      close() { later(() => { c._shutdown(); c.other && c.other._shutdown(); }); },
    };
    return c;
  }

  function makePeer(id) {
    const h = {};
    let myId = id || ('rand-' + (++idc));
    let destroyed = false;
    const conns = [];                              // every conn this peer owns
    const peer = {
      get id() { return myId; },
      on(ev, fn) { (h[ev] || (h[ev] = [])).push(fn); return peer; },
      emit(ev, a) { (h[ev] || []).forEach((fn) => fn(a)); },
      connect(targetId) {
        const clientConn = makeConn(targetId);
        conns.push(clientConn);
        later(() => {
          const target = claimed.get(targetId);
          if (!target || destroyed) { peer.emit('error', { type: 'peer-unavailable' }); return; }
          const serverConn = makeConn(myId);
          target._track(serverConn);
          clientConn.other = serverConn; serverConn.other = clientConn;
          target.emit('connection', serverConn);
          later(() => { serverConn.emit('open'); clientConn.emit('open'); });
        });
        return clientConn;
      },
      _track(conn) { conns.push(conn); },
      // Real PeerJS closes a peer's connections on destroy; the remote ends fire 'close'.
      destroy() {
        destroyed = true;
        if (claimed.get(myId) === peer) claimed.delete(myId);
        for (const c of conns.splice(0)) later(() => { c._shutdown(); c.other && c.other._shutdown(); });
      },
    };
    later(() => {
      if (destroyed) return;
      if (id && claimed.has(id)) peer.emit('error', { type: 'unavailable-id' });
      else { claimed.set(myId, peer); peer.emit('open', myId); }
    });
    return peer;
  }

  return { makePeer, claimed };
}

/* ------------------------- lobby: coordinator/client ------------------- */
test('lobby: first is coordinator, second joins as client and sees published rooms', async () => {
  const broker = createFakeBroker();
  const roomsA = []; const roomsB = [];
  const statusA = []; const statusB = [];

  const has = (arr, code) => arr.length && arr.at(-1).some((x) => x.code === code);

  const A = createLobby({ makePeer: broker.makePeer, onRooms: (r) => roomsA.push(r), onStatus: (s) => statusA.push(s) });
  A.start();
  await until(() => A.role() === 'coordinator');
  assert.equal(A.role(), 'coordinator');
  assert.ok(statusA.includes('coordinator'));
  assert.equal(broker.claimed.has(LOBBY_ID), true);

  const B = createLobby({ makePeer: broker.makePeer, onRooms: (r) => roomsB.push(r), onStatus: (s) => statusB.push(s) });
  B.start();
  await until(() => B.role() === 'client');
  assert.equal(B.role(), 'client');

  // B browses and publishes a room; both A (coordinator) and B (subscriber) see it.
  B.refresh();
  B.publish({ code: 'WXYZ', hostName: 'Bo' });
  await until(() => has(roomsA, 'WXYZ') && has(roomsB, 'WXYZ'));
  assert.ok(has(roomsA, 'WXYZ'), 'coordinator sees clients room');
  assert.ok(has(roomsB, 'WXYZ'), 'subscriber gets the list');

  // Coordinator publishes its own room; the client subscriber sees it too.
  A.refresh();
  A.publish({ code: 'AAAA', hostName: 'Ann' });
  await until(() => has(roomsB, 'AAAA'));
  assert.ok(has(roomsB, 'AAAA'));

  // Status change propagates.
  B.setStatus('WXYZ', ROOM_STATUS.PLAYING);
  await until(() => roomsB.at(-1).find((x) => x.code === 'WXYZ')?.status === ROOM_STATUS.PLAYING);
  assert.equal(roomsB.at(-1).find((x) => x.code === 'WXYZ').status, ROOM_STATUS.PLAYING);

  // Unpublish removes it.
  B.unpublish('WXYZ');
  await until(() => !has(roomsB, 'WXYZ'));
  assert.ok(!has(roomsB, 'WXYZ'));

  A.close(); B.close();
});

test('lobby: a departed host disappears from the list', async () => {
  const broker = createFakeBroker();
  const roomsA = [];
  const has = (code) => roomsA.length && roomsA.at(-1).some((x) => x.code === code);
  const A = createLobby({ makePeer: broker.makePeer, onRooms: (r) => roomsA.push(r) });
  A.start(); await until(() => A.role() === 'coordinator');
  A.refresh();

  const B = createLobby({ makePeer: broker.makePeer });
  B.start(); await until(() => B.role() === 'client');
  B.publish({ code: 'BBBB', hostName: 'Bo' });
  await until(() => has('BBBB'));
  assert.ok(has('BBBB'));

  B.close();                       // host leaves entirely
  await until(() => !has('BBBB'));
  assert.ok(!has('BBBB'), 'coordinator drops the departed hosts room');
  A.close();
});

test('lobby: client re-elects itself when the coordinator leaves', async () => {
  const broker = createFakeBroker();
  const statusB = [];
  const A = createLobby({ makePeer: broker.makePeer });
  A.start(); await until(() => A.role() === 'coordinator');

  const B = createLobby({ makePeer: broker.makePeer, onStatus: (s) => statusB.push(s) });
  B.start(); await until(() => B.role() === 'client');

  A.close();                       // coordinator disappears; frees the id
  await until(() => statusB.includes('reconnecting'));
  assert.ok(statusB.includes('reconnecting'));
  await until(() => B.role() === 'coordinator');   // waits out the backoff + reclaim
  assert.equal(B.role(), 'coordinator', 'B took over as the new coordinator');
  assert.equal(broker.claimed.has(LOBBY_ID), true);
  B.close();
});
