// Tests for the delivery layer. Both transports can drop a message without
// anyone noticing, and six of the engine's messages hand control from one player
// to the other, so losing one of those used to freeze the match for both people
// with no error anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReliableChannel } from '../js/reliable.js';

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await flush(5); }
  return pred();
}

// A pair of fake transports wired to each other, where you can decide which
// frames go missing. `drop` is called with the frame and returns true to lose it.
function lossyPair() {
  const ends = {};
  const mk = (name, other) => {
    const cbs = {};
    const e = {
      name,
      sent: [],
      drop: () => false,
      onData(f) { cbs.data = f; },
      onOpen(f) { cbs.open = f; }, onError(f) { cbs.error = f; },
      onStatus(f) { cbs.status = f; }, onJoinRequest(f) { cbs.join = f; },
      onHealthy(f) { cbs.healthy = f; },
      host() {}, join() {},
      send(frame) {
        e.sent.push(frame);
        if (e.drop(frame)) return;                       // lost in transit
        setTimeout(() => ends[other].deliver(frame), 0);
      },
      deliver(frame) { cbs.data && cbs.data(frame); },
      isOpen() { return true; },
      diagnostics: () => ({ transport: 'fake' }),
      close() {},
    };
    return e;
  };
  ends.a = mk('a', 'b');
  ends.b = mk('b', 'a');
  return ends;
}

function wrap(end, opts) {
  const ch = createReliableChannel(end, { resendMs: 120, ackIdleMs: 60, ...opts });
  const got = [], errs = [];
  ch.onData((m) => got.push(m));
  ch.onError((e) => errs.push(e));
  return { ch, got, errs };
}

test('reliable: ordinary messages arrive once, with no routing fields leaking', async () => {
  const p = lossyPair();
  const A = wrap(p.a), B = wrap(p.b);
  A.ch.send({ type: 'roster', roster: [1, 2, 3] });
  B.ch.send({ type: 'setup', name: 'Bo' });
  await until(() => A.got.length && B.got.length);
  assert.deepEqual(B.got, [{ type: 'roster', roster: [1, 2, 3] }]);
  assert.deepEqual(A.got, [{ type: 'setup', name: 'Bo' }]);
  A.ch.close(); B.ch.close();
});

test('reliable: a lost turn handover is resent instead of freezing the game', async () => {
  // THE bug. endTurn hands control over. Lose it and each player waits for the
  // other with nothing to tell either of them that anything went wrong.
  const p = lossyPair();
  const A = wrap(p.a), B = wrap(p.b);
  let dropped = 0;
  p.a.drop = (f) => {                                  // lose it exactly once
    if (f.type === 'endTurn' && dropped === 0) { dropped++; return true; }
    return false;
  };

  A.ch.send({ type: 'endTurn', turn: 3 });
  assert.equal(B.got.length, 0, 'it really was lost');
  await until(() => B.got.some((m) => m.type === 'endTurn'), 4000);
  assert.deepEqual(B.got, [{ type: 'endTurn', turn: 3 }], 'delivered once, after a resend');
  assert.equal(dropped, 1, 'and it was genuinely dropped the first time');
  A.ch.close(); B.ch.close();
});

test('reliable: a gap is filled and messages are delivered in order', async () => {
  const p = lossyPair();
  const A = wrap(p.a), B = wrap(p.b);
  p.a.drop = (f) => f.type === 'two';           // the middle one goes missing

  A.ch.send({ type: 'one' });
  A.ch.send({ type: 'two' });
  await flush(20);
  p.a.drop = () => false;                        // line recovers
  A.ch.send({ type: 'three' });

  await until(() => B.got.length === 3, 4000);
  assert.deepEqual(B.got.map((m) => m.type), ['one', 'two', 'three'],
    'the later message waits for the missing one rather than overtaking it');
  A.ch.close(); B.ch.close();
});

test('reliable: a duplicate is delivered only once', async () => {
  const p = lossyPair();
  const A = wrap(p.a), B = wrap(p.b);
  A.ch.send({ type: 'guess', id: 7 });
  await until(() => B.got.length === 1);
  p.b.deliver(p.a.sent[0]);                      // the same frame arrives again
  await flush(40);
  assert.equal(B.got.length, 1, 'the replay is ignored');
  A.ch.close(); B.ch.close();
});

test('reliable: confirmations ride along on the reply and cost nothing extra', async () => {
  const p = lossyPair();
  const A = wrap(p.a, { ackIdleMs: 5000 }), B = wrap(p.b, { ackIdleMs: 5000 });
  A.ch.send({ type: 'ask' });
  await until(() => B.got.length === 1);
  B.ch.send({ type: 'answer' });                 // the reply carries the confirmation
  await until(() => A.got.length === 1);
  await flush(80);
  assert.equal(p.b.sent.length, 1, 'B sent one frame in total, the reply itself');
  assert.equal(A.ch.diagnostics().awaitingConfirmation, 0, 'and A knows its message landed');
  A.ch.close(); B.ch.close();
});

test('reliable: a quiet receiver confirms on its own so the sender can stop', async () => {
  const p = lossyPair();
  const A = wrap(p.a), B = wrap(p.b);            // ackIdleMs 60ms, B says nothing
  A.ch.send({ type: 'endTurn' });
  await until(() => A.ch.diagnostics().awaitingConfirmation === 0, 4000);
  assert.equal(A.ch.diagnostics().awaitingConfirmation, 0);
  A.ch.close(); B.ch.close();
});

test('reliable: a line that never recovers is reported, not left silent', async () => {
  const p = lossyPair();
  const A = wrap(p.a, { resendMs: 40, maxResends: 2 }), B = wrap(p.b);
  p.a.drop = () => true;                         // nothing gets through at all
  A.ch.send({ type: 'endTurn' });
  await until(() => A.errs.length > 0, 4000);
  assert.equal(A.errs[0].type, 'unsent');
  assert.match(A.errs[0].message, /opponent/i);
  assert.ok(A.ch.diagnostics().awaitingConfirmation > 0, 'the details panel shows it is stuck');
  A.ch.close(); B.ch.close();
});

test('reliable: hearing anything from the peer counts as proof they are there', async () => {
  const p = lossyPair();
  const A = wrap(p.a), B = wrap(p.b);
  let alive = 0;
  A.ch.onHealthy(() => { alive++; });
  B.ch.send({ type: 'chat', text: 'hi' });
  await until(() => alive > 0);
  assert.ok(alive > 0, 'which is what clears the reconnecting banner');
  A.ch.close(); B.ch.close();
});

test('reliable: the wrapper passes the rest of the channel through untouched', () => {
  const p = lossyPair();
  const ch = createReliableChannel(p.a);
  assert.equal(ch.isOpen(), true);
  assert.equal(ch.diagnostics().transport, 'fake');
  assert.equal(typeof ch.host, 'function');
  assert.equal(typeof ch.join, 'function');
  ch.close();
});
