// reliable.js
// Makes sure a move that was sent actually arrives.
//
// Both transports are fire-and-forget. WebRTC data channels are ordered and
// reliable while they are up, but nothing survives the moment one is torn down
// and rebuilt, and the HTTPS relay has no delivery guarantee at all: a publish
// that gets rate-limited, or a subscription that is down for a second, simply
// loses the message.
//
// For most of the game that is survivable. Losing a chat line or a question is
// annoying and no worse. But six of the engine's messages hand control from one
// player to the other (setup, begin, endTurn, guess, guessResult, rematch, plus
// the app's roster), and losing one of those deadlocks the match: each player
// sits waiting for the other, forever, with no error anywhere because as far as
// both transports are concerned nothing went wrong.
//
// So every message carries a sequence number, the receiver tells the sender what
// it has, and the sender keeps anything unconfirmed and sends it again.
//
// Kept cheap on purpose, because on the relay every frame is spent against a
// shared per-IP rate limit:
//   - confirmations ride along on whatever the receiver sends next, which in a
//     turn-based game is usually the reply, so they normally cost nothing;
//   - a bare confirmation goes out only if the receiver has stayed quiet;
//   - a gap is reported once, naming the first message missing, rather than
//     re-sending everything;
//   - nothing is sent at all while the line is behaving.

const SEQ = '__n';      // sequence number of this message
const ACK = '__a';      // piggybacked: highest run of messages I have received
const BARE = '__ack';   // a confirmation on its own, when there was nothing to carry it
const NEED = '__need';  // I am missing this one, please send it again

export function createReliableChannel(inner, {
  resendMs = 6000,       // how long to wait for confirmation before trying again
  maxResends = 6,        // ~36s of trying before we admit something is wrong
  ackIdleMs = 8000,      // how long a receiver may stay quiet before confirming
  now = () => Date.now(),
} = {}) {
  let outSeq = 0;        // last sequence number we used
  let want = 1;          // next sequence number we expect from them
  let confirmed = 0;     // highest sequence number they have confirmed
  let acked = 0;         // highest we have confirmed to them
  const outbox = new Map();   // seq -> { frame, sentAt, tries }
  const early = new Map();    // seq -> frame, arrived before its turn
  let ackTimer = null, resendTimer = null;
  let troubled = false;
  const cbs = { data: null, open: null, error: null, status: null, joinRequest: null, healthy: null };

  const timer = (fn, ms) => {
    const t = setInterval(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };

  /* ------------------------------ sending ------------------------------ */

  // Anything we send carries our latest confirmation, so in the normal case the
  // receiver never has to spend a frame on one.
  function put(frame) {
    acked = want - 1;
    clearTimeout(ackTimer); ackTimer = null;
    frame[ACK] = acked;
    inner.send(frame);
  }

  function sendApp(msg) {
    const frame = { ...msg, [SEQ]: ++outSeq };
    outbox.set(outSeq, { frame, sentAt: now(), tries: 0 });
    put(frame);
    startResending();
  }

  function startResending() {
    if (resendTimer) return;
    resendTimer = timer(sweep, Math.max(500, Math.floor(resendMs / 3)));
  }

  function sweep() {
    if (!outbox.size) {
      clearInterval(resendTimer); resendTimer = null;
      if (troubled) { troubled = false; cbs.healthy && cbs.healthy(); }
      return;
    }
    const t = now();
    for (const [seq, item] of [...outbox].sort((a, b) => a[0] - b[0])) {
      if (t - item.sentAt < resendMs) continue;
      if (item.tries >= maxResends) {
        if (!troubled) {
          troubled = true;
          cbs.error && cbs.error({
            type: 'unsent',
            message: 'A move isn\'t getting through to your opponent. Still trying.',
          });
        }
        continue;
      }
      item.tries++;
      item.sentAt = t;
      put(item.frame);
    }
  }

  function resendFrom(seq) {
    for (const [n, item] of [...outbox].sort((a, b) => a[0] - b[0])) {
      if (n < seq) continue;
      item.sentAt = now();
      put(item.frame);
    }
  }

  function confirm(upTo) {
    if (typeof upTo !== 'number' || upTo <= confirmed) return;
    confirmed = upTo;
    for (const n of [...outbox.keys()]) if (n <= upTo) outbox.delete(n);
    if (!outbox.size && troubled) { troubled = false; cbs.healthy && cbs.healthy(); }
  }

  /* ----------------------------- receiving ----------------------------- */

  function strip(frame) {
    const clean = { ...frame };
    delete clean[SEQ]; delete clean[ACK]; delete clean[BARE]; delete clean[NEED];
    return clean;
  }

  function handle(frame) {
    if (!frame || typeof frame !== 'object') return;
    // Hearing anything at all proves they are still there, which matters most to
    // the player whose turn it isn't and who has no traffic of their own.
    cbs.healthy && cbs.healthy();

    confirm(frame[ACK]);
    if (frame[BARE] !== undefined) { confirm(frame[BARE]); return; }
    if (frame[NEED] !== undefined) { resendFrom(frame[NEED]); return; }

    const seq = frame[SEQ];
    if (typeof seq !== 'number') { cbs.data && cbs.data(strip(frame)); return; }
    if (seq < want) return;                       // already had it
    if (seq > want) {                             // something is missing
      early.set(seq, frame);
      put({ [NEED]: want });
      return;
    }

    cbs.data && cbs.data(strip(frame));
    want++;
    while (early.has(want)) {                     // the gap closed
      const held = early.get(want); early.delete(want);
      cbs.data && cbs.data(strip(held));
      want++;
    }
    scheduleAck();
  }

  // Only if we have nothing of our own to say for a while.
  function scheduleAck() {
    if (want - 1 <= acked || ackTimer) return;
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (want - 1 <= acked) return;
      acked = want - 1;
      inner.send({ [BARE]: acked, [ACK]: acked });
    }, ackIdleMs);
    if (ackTimer && typeof ackTimer.unref === 'function') ackTimer.unref();
  }

  /* -------------------------------- api -------------------------------- */

  inner.onData(handle);

  return {
    onData(fn) { cbs.data = fn; },
    onOpen(fn) { cbs.open = fn; inner.onOpen(fn); },
    onError(fn) { cbs.error = fn; inner.onError(fn); },
    onStatus(fn) { cbs.status = fn; inner.onStatus(fn); },
    onJoinRequest(fn) { cbs.joinRequest = fn; inner.onJoinRequest(fn); },
    onHealthy(fn) {
      cbs.healthy = fn;
      if (inner.onHealthy) inner.onHealthy(fn);
    },

    host(onCode) { inner.host(onCode); },
    join(code, name) { inner.join(code, name); },
    send(msg) { sendApp(msg); },
    isOpen() { return inner.isOpen(); },
    mode() { return inner.mode ? inner.mode() : 'direct'; },

    diagnostics() {
      const d = (inner.diagnostics && inner.diagnostics()) || {};
      return {
        ...d,
        awaitingConfirmation: outbox.size,
        messagesSentInOrder: outSeq,
        messagesReceivedInOrder: want - 1,
        waitingOnAGap: early.size ? `yes, missing #${want}` : 'no',
      };
    },

    close() {
      clearInterval(resendTimer); resendTimer = null;
      clearTimeout(ackTimer); ackTimer = null;
      outbox.clear(); early.clear();
      inner.close();
    },
  };
}
