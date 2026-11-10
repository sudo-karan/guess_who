// Unit tests for room discovery: the pure registry, pure beacon interpretation,
// and the broadcast feed, driven by an in-memory fake of ntfy.sh (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, applyBeacon, createLobby, ROOM_STATUS, LOBBY_TOPIC } from '../js/lobby.js';
import { createFakeNtfy, until, flush } from './fake-ntfy.mjs';

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

test('registry: expire drops only rooms last heard from before the cutoff', () => {
  const r = createRegistry();
  r.publish('p1', { code: 'OLD1' }, 1000);
  r.publish('p2', { code: 'NEW1' }, 9000);
  assert.equal(r.expire(5000), 1);
  assert.deepEqual(r.list().map((x) => x.code), ['NEW1']);
});

/* --------------------------- beacon semantics -------------------------- */
test('beacons: a room announcement adds it, "gone" and "ended" remove it', () => {
  const r = createRegistry();
  assert.equal(applyBeacon(r, { t: 'room', code: 'AAAA', hostName: 'Ann' }, 100), true);
  assert.equal(r.list()[0].hostName, 'Ann');

  applyBeacon(r, { t: 'room', code: 'AAAA', hostName: 'Ann', status: ROOM_STATUS.PLAYING }, 200);
  assert.equal(r.list()[0].status, ROOM_STATUS.PLAYING);

  assert.equal(applyBeacon(r, { t: 'gone', code: 'AAAA' }, 300), true);
  assert.equal(r.size(), 0);

  applyBeacon(r, { t: 'room', code: 'BBBB' }, 400);
  applyBeacon(r, { t: 'room', code: 'BBBB', status: ROOM_STATUS.ENDED }, 500);
  assert.equal(r.size(), 0, 'an ended room leaves the list');
});

test('beacons: garbage is ignored', () => {
  const r = createRegistry();
  assert.equal(applyBeacon(r, null, 1), false);
  assert.equal(applyBeacon(r, { t: 'room' }, 1), false);      // no code
  assert.equal(applyBeacon(r, { t: 'nope', code: 'AAAA' }, 1), false);
  assert.equal(r.size(), 0);
});

/* ------------------------------ live feed ------------------------------ */
function feed(ntfy, extra = {}) {
  return createLobby({
    fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl, ...extra,
  });
}

test('feed: a hosted room reaches another browsers list, and leaving removes it', async () => {
  const ntfy = createFakeNtfy();
  const seenB = [];
  const has = (code) => seenB.length && seenB.at(-1).some((x) => x.code === code);

  const B = feed(ntfy, { onRooms: (r) => seenB.push(r) });
  B.start();

  const A = feed(ntfy);
  A.start();
  A.publish({ code: 'WXYZ', hostName: 'Ann' });

  await until(() => has('WXYZ'));
  assert.ok(has('WXYZ'), 'the other browser sees the room');
  assert.equal(seenB.at(-1).find((x) => x.code === 'WXYZ').hostName, 'Ann');

  A.setStatus('WXYZ', ROOM_STATUS.PLAYING);
  await until(() => seenB.at(-1).find((x) => x.code === 'WXYZ')?.status === ROOM_STATUS.PLAYING);
  assert.equal(seenB.at(-1).find((x) => x.code === 'WXYZ').status, ROOM_STATUS.PLAYING);

  A.close();                       // host leaves -> says goodbye
  await until(() => !has('WXYZ'));
  assert.ok(!has('WXYZ'), 'the departed hosts room disappears');
  B.close();
});

test('feed: your own room shows in your own list immediately', async () => {
  const ntfy = createFakeNtfy();
  const seen = [];
  const A = feed(ntfy, { onRooms: (r) => seen.push(r) });
  A.start();
  A.publish({ code: 'AAAA', hostName: 'Ann' });
  // No round trip required: the host must be able to confirm it is advertised.
  assert.ok(seen.at(-1).some((x) => x.code === 'AAAA'), 'listed without waiting for the feed');
  A.close();
});

test('feed: a page opened later catches up on rooms announced before it', async () => {
  const ntfy = createFakeNtfy();
  const A = feed(ntfy);
  A.start();
  A.publish({ code: 'EARL', hostName: 'Ann' });
  await flush(10);

  const seenB = [];
  const B = feed(ntfy, { onRooms: (r) => seenB.push(r) });
  B.start();                       // joins the feed only now
  await until(() => seenB.length && seenB.at(-1).some((x) => x.code === 'EARL'));
  assert.ok(seenB.at(-1).some((x) => x.code === 'EARL'), 'history fills the list at once');
  A.close(); B.close();
});

test('feed: a host that goes silent ages out of the list', async () => {
  const ntfy = createFakeNtfy();
  const seen = [];
  let clock = 1000;
  const B = feed(ntfy, { onRooms: (r) => seen.push(r), now: () => clock });
  B.start();

  const A = feed(ntfy);
  A.start();
  A.publish({ code: 'GHST', hostName: 'Ann' });
  await until(() => seen.length && seen.at(-1).some((x) => x.code === 'GHST'));

  clock += 60000;                  // a minute of silence (no beacons)
  await until(() => !seen.at(-1).some((x) => x.code === 'GHST'), 12000);
  assert.ok(!seen.at(-1).some((x) => x.code === 'GHST'), 'stale rooms are swept');
  A.close(); B.close();
});

test('feed: publishing a new room retires the previous one (one room per host)', async () => {
  const ntfy = createFakeNtfy();
  const seen = [];
  const A = feed(ntfy, { onRooms: (r) => seen.push(r) });
  A.start();
  A.publish({ code: 'ONE1', hostName: 'Ann' });
  A.publish({ code: 'TWO2', hostName: 'Ann' });
  await flush(20);
  const codes = seen.at(-1).map((x) => x.code);
  assert.deepEqual(codes, ['TWO2'], 'only the current room is advertised');
  assert.equal(LOBBY_TOPIC, 'guesswho-v1-lobby');
  A.close();
});
