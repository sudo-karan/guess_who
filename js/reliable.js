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
  let gapTimer = null, needTries = 0;   // asking for a message that has not arrived
  const cbs = {
    data: null, open: null, error: null, status: null, joinRequest: null,
    healthy: null, resumed: null, pending: null,
  };

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
    cbs.pending && cbs.pending();
  }

  // What we have sent and not had confirmed, as the app gave it to us. The app
  // stores this with the rest of a saved game: these are the messages that were
  // in flight when the page went, and the outbox they lived in went with it.
  function pendingFrames() {
    return [...outbox].sort((a, b) => a[0] - b[0]).map(([, it]) => {
      const { [SEQ]: _s, [ACK]: _a, ...msg } = it.frame;
      return msg;
    });
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
      if (item.tries >= maxResends) continue;   // counts, so a hopeless gap surfaces
      item.tries++;
      item.sentAt = now();
      put(item.frame);
    }
    startResending();
  }

  // Asking for a message that is missing, on a clock of its own rather than once
  // per out-of-order arrival. Two reasons: a frame lost for good otherwise turned
  // every later arrival into another request, a storm that never ended and spent
  // the relay's shared quota on nothing; and if the other side then went quiet,
  // nothing asked again at all and the player was never told. So: one request per
  // interval while the gap is open, say so once it is clearly not coming, and
  // eventually stop rather than ask forever.
  function openGap() {
    if (gapTimer) return;
    needTries = 0;
    askGap();
    gapTimer = timer(askGap, resendMs);
  }

  function closeGap() {
    clearInterval(gapTimer); gapTimer = null; needTries = 0;
  }

  function askGap() {
    if (!early.size) { closeGap(); return; }
    if (needTries >= maxResends * 4) { clearInterval(gapTimer); gapTimer = null; return; }
    needTries++;
    if (needTries === maxResends + 1 && !troubled) {
      troubled = true;
      cbs.error && cbs.error({
        type: 'unsent',
        message: 'A move from your opponent went missing. Still trying.',
      });
    }
    put({ [NEED]: want });
  }

  function confirm(upTo) {
    if (typeof upTo !== 'number' || upTo <= confirmed) return;
    confirmed = upTo;
    for (const n of [...outbox.keys()]) if (n <= upTo) outbox.delete(n);
    if (!outbox.size && troubled) { troubled = false; cbs.healthy && cbs.healthy(); }
    cbs.pending && cbs.pending();
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
      openGap();
      return;
    }

    cbs.data && cbs.data(strip(frame));
    want++;
    while (early.has(want)) {                     // the gap closed
      const held = early.get(want); early.delete(want);
      cbs.data && cbs.data(strip(held));
      want++;
    }
    closeGap();
    if (!early.size && !outbox.size && troubled) { troubled = false; cbs.healthy && cbs.healthy(); }
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

  // Both sides start counting again, but anything the peer never confirmed is
  // put back on the wire under the new numbering. Those are exactly the messages
  // that may have been in flight when the other side refreshed, and dropping
  // them is how a resumed game would end up out of step. The engine ignores a
  // hand-over it has already applied, so a needless repeat is harmless.
  function reset() {
    clearInterval(resendTimer); resendTimer = null;
    clearTimeout(ackTimer); ackTimer = null;
    const unsent = pendingFrames();
    outSeq = 0; want = 1; confirmed = 0; acked = 0;
    outbox.clear(); early.clear();
    troubled = false;
    closeGap();
    for (const msg of unsent) sendApp(msg);
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

    // A resumed match starts counting again from nothing on BOTH sides, because
    // the side that refreshed lost its counters with the rest of the page. If
    // only one side reset, everything the other sent would look like a message
    // it had already seen and be thrown away.
    onResumed(fn) {
      cbs.resumed = fn;
      if (inner.onResumed) inner.onResumed(() => { reset(); fn && fn(); });
    },
    onToken(fn) { if (inner.onToken) inner.onToken(fn); },

    // Called whenever the set of unconfirmed messages changes, so a saved game
    // can keep an up-to-date copy of it.
    onPending(fn) { cbs.pending = fn; },
    pending() { return pendingFrames(); },

    // Put back what a page that went away had in flight. Resending is normally
    // the sender's job, but a tab that reloads takes its outbox with it, so the
    // one thing the machinery here cannot recover from is its own side vanishing.
    // Those frames have to come back from the saved game instead. Repeats are
    // safe: the engine ignores a hand-over it has already applied.
    requeue(msgs) {
      if (!Array.isArray(msgs)) return;
      for (const m of msgs) if (m && typeof m === 'object') sendApp(m);
    },
    sessionToken() { return inner.sessionToken ? inner.sessionToken() : null; },
    useSessionToken(t) { if (inner.useSessionToken) inner.useSessionToken(t); },

    host(onCode, code) { inner.host(onCode, code); },
    join(code, name, resume, epoch) { inner.join(code, name, resume, epoch); },
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
      closeGap();
      outbox.clear(); early.clear();
      inner.close();
    },
  };
}
