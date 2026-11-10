// Tests for the HTTPS relay transport — the fallback that carries a game when
// the two browsers can't reach each other directly. Driven by an in-memory fake
// of ntfy.sh (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayChannel, relayTopic } from '../js/relay.js';
import { createFakeNtfy, until, flush } from './fake-ntfy.mjs';

function pair(ntfy) {
  const opts = { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl };
  const host = createRelayChannel(opts);
  const guest = createRelayChannel(opts);
  const st = { hostOpen: false, guestOpen: false, hostData: [], guestData: [], guestErrors: [], joinName: null, ctl: null };
  host.onOpen(() => { st.hostOpen = true; });
  host.onData((m) => st.hostData.push(m));
  guest.onOpen(() => { st.guestOpen = true; });
  guest.onData((m) => st.guestData.push(m));
  guest.onError((e) => st.guestErrors.push(e));
  return { host, guest, st, opts };
}

test('relay: topics separate the two directions', () => {
  assert.equal(relayTopic('ab3u', 'h'), 'guesswho-v1-AB3U-h');
  assert.equal(relayTopic('AB3U', 'g'), 'guesswho-v1-AB3U-g');
});

test('relay: host approves guest -> both open, messages flow both ways', async () => {
  const ntfy = createFakeNtfy();
  const { host, guest, st } = pair(ntfy);
  host.onJoinRequest((name, ctl) => { st.joinName = name; st.ctl = ctl; });

  host.host('AB3U');
  guest.join('AB3U', 'Bo');

  await until(() => st.joinName !== null);
  assert.equal(st.joinName, 'Bo');
  assert.equal(st.hostOpen, false, 'host must not be open before approving');
  assert.equal(st.guestOpen, false);

  st.ctl.accept();
  await until(() => st.hostOpen && st.guestOpen);
  assert.ok(st.hostOpen && st.guestOpen, 'both open after approval');

  host.send({ type: 'roster', roster: [1, 2] });
  guest.send({ type: 'setup', name: 'Bo' });
  await until(() => st.guestData.length && st.hostData.length);
  // Delivered exactly as sent — no routing fields leaking into the protocol.
  assert.deepEqual(st.guestData.at(-1), { type: 'roster', roster: [1, 2] });
  assert.deepEqual(st.hostData.at(-1), { type: 'setup', name: 'Bo' });
  // Handshake frames must never surface as game data.
  assert.ok(!st.guestData.some((m) => m.__t), 'no handshake frames delivered as game data');
  assert.ok(!st.hostData.some((m) => m.__t));

  host.close(); guest.close();
});

test('relay: host declines -> guest is told, and nobody opens', async () => {
  const ntfy = createFakeNtfy();
  const { host, guest, st } = pair(ntfy);
  host.onJoinRequest((name, ctl) => ctl.deny());
  host.host('AB3U');
  guest.join('AB3U', 'Bo');
  await until(() => st.guestErrors.some((e) => e.type === 'denied'));
  assert.ok(st.guestErrors.some((e) => e.type === 'denied'));
  assert.equal(st.hostOpen, false);
  assert.equal(st.guestOpen, false);
  host.close(); guest.close();
});

test('relay: a second guest is told the room is full, and the first is untouched', async () => {
  const ntfy = createFakeNtfy();
  const opts = { fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl };
  const host = createRelayChannel(opts);
  let hostOpen = false;
  host.onOpen(() => { hostOpen = true; });
  host.host('AB3U');                       // no approval handler -> auto-accept

  const g1 = createRelayChannel(opts);
  let g1Open = false; const g1Err = [];
  g1.onOpen(() => { g1Open = true; });
  g1.onError((e) => g1Err.push(e));
  g1.join('AB3U', 'A');
  await until(() => g1Open && hostOpen);
  assert.ok(g1Open, 'first guest gets in');

  const g2 = createRelayChannel(opts);
  let g2Open = false; const g2Err = [];
  g2.onOpen(() => { g2Open = true; });
  g2.onError((e) => g2Err.push(e));
  g2.join('AB3U', 'B');
  await until(() => g2Err.some((e) => e.type === 'full'));
  assert.ok(g2Err.some((e) => e.type === 'full'), 'second guest is told the room is full');
  assert.equal(g2Open, false);
  // The verdict is addressed, so the guest already playing must not see it.
  assert.ok(!g1Err.length, 'the seated guest is unaffected by the newcomer');

  host.close(); g1.close(); g2.close();
});

test('relay: an oversized message is chunked and reassembled intact', async () => {
  const ntfy = createFakeNtfy();
  const { host, guest, st } = pair(ntfy);
  host.host('AB3U');
  guest.join('AB3U', 'Bo');
  await until(() => st.hostOpen && st.guestOpen);

  // The end-of-game full log can be several KB — comfortably over one message.
  const big = { type: 'fulllog', log: Array.from({ length: 400 }, (_, i) => ({ i, text: 'event number ' + i })) };
  host.send(big);
  await until(() => st.guestData.some((m) => m.type === 'fulllog'));
  const got = st.guestData.find((m) => m.type === 'fulllog');
  assert.equal(got.log.length, 400);
  assert.equal(got.log[399].text, 'event number 399');
  host.close(); guest.close();
});

test('relay: a guest whose JOIN is rate-limited is TOLD, not left waiting', async () => {
  // THE reported bug: the guest sat on "Asking the host to let you in…" forever
  // while post() swallowed a 429, so the host was never asked anything.
  const ntfy = createFakeNtfy({ throttleAfter: 0 });     // every publish is 429'd
  const guest = createRelayChannel({ fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl });
  const errs = [];
  guest.onError((e) => errs.push(e));
  guest.join('AB3U', 'Bo');
  await until(() => errs.length > 0, 20000);
  assert.ok(errs.length, 'the player is told something went wrong');
  assert.ok(['ratelimited', 'unsent'].includes(errs[0].type), `got ${errs[0].type}`);
  assert.match(errs[0].message, /rate-limited/i, 'and the message names the real reason');
  assert.ok(guest.diagnostics().timesThrottled > 0, 'and the details panel can show it');
  guest.close();
});

test('relay: a subscription killed by the service is rebuilt, not left deaf', async () => {
  // A browser abandons an EventSource for good when a reconnect is answered with
  // an HTTP error. A host that is silently deaf never sees a join request.
  const ntfy = createFakeNtfy();
  const host = createRelayChannel({ fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl });
  host.onJoinRequest(() => {});
  host.host('AB3U');
  await until(() => /listening/.test(host.diagnostics().listening));

  ntfy.killSubscriptions('guesswho-v1-AB3U-h');
  assert.match(host.diagnostics().listening, /dropped|reconnecting/);
  // It must come back by itself and receive a join request afterwards.
  await until(() => /listening/.test(host.diagnostics().listening), 20000);

  let asked = null;
  host.onJoinRequest((who) => { asked = who; });
  const guest = createRelayChannel({ fetchImpl: ntfy.fetchImpl, EventSourceImpl: ntfy.EventSourceImpl });
  guest.join('AB3U', 'Bo');
  await until(() => asked !== null, 20000);
  assert.equal(asked, 'Bo', 'the rebuilt subscription still hears a join request');
  host.close(); guest.close();
});

test('relay: close stops delivery', async () => {
  const ntfy = createFakeNtfy();
  const { host, guest, st } = pair(ntfy);
  host.host('AB3U');
  guest.join('AB3U', 'Bo');
  await until(() => st.hostOpen && st.guestOpen);
  guest.close();
  const before = st.guestData.length;
  host.send({ type: 'ping' });
  await flush(30);
  assert.equal(st.guestData.length, before, 'a closed channel receives nothing');
  host.close();
});
