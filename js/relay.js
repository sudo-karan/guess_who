// relay.js
// A fallback transport for online play that works where WebRTC cannot.
//
// Why this exists: PeerJS data channels need a direct peer-to-peer path. On a
// friendly network STUN is enough, but on Wi-Fi with client isolation, on mobile
// data behind carrier-grade NAT, or anywhere UDP is blocked, the two browsers can
// never see each other. A TURN relay would fix that — but the TURN servers baked
// into PeerJS (eu-0/us-0.turn.peerjs.com) no longer resolve, and there is no free
// credential-less TURN service left to point at from a static site.
//
// So instead of relaying at the network layer we relay at the message layer, over
// ordinary HTTPS on port 443 — which every network allows. Each room gets two
// public pub/sub topics on ntfy.sh (a free, account-less notification service):
// one carrying messages TO the host, one carrying messages TO the guest. Each side
// subscribes to its own topic over Server-Sent Events and POSTs to the other's.
//
// PRIVACY: a relayed game's messages (display names, chat, moves) pass through a
// public service and are readable by anyone who knows the room topic. Direct
// WebRTC is always tried first and is end-to-end encrypted; this is the fallback.
// A per-session token keeps a stray or stale publisher from corrupting a game.
//
// The interface is deliberately identical to createOnlineChannel() in net.js, so
// the two are interchangeable and can be composed (see channel.js).

export const RELAY_BASE = 'https://ntfy.sh';
const TOPIC_PREFIX = 'guesswho-v1-';
const MAX_BODY = 3000;          // ntfy's per-message body limit is 4 KiB; stay clear
const JOIN_RETRY_MS = 3000;
const JOIN_GIVEUP_MS = 25000;

// Reserved handshake messages, namespaced with `__t` exactly as in net.js so the
// host/guest approval protocol is shared between both transports.
const H = { JOIN: 'join', ACCEPT: 'accept', DENY: 'deny', FULL: 'full' };

export function relayTopic(code, side) {
  return `${TOPIC_PREFIX}${String(code || '').trim().toUpperCase()}-${side}`;
}

function token(n = 12) {
  let s = '';
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function relayAvailable() {
  return typeof fetch === 'function' && typeof EventSource === 'function';
}

// `fetchImpl` / `EventSourceImpl` are injectable so this is testable without a network.
export function createRelayChannel({ base = RELAY_BASE, fetchImpl, EventSourceImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const ES = EventSourceImpl || (typeof EventSource === 'function' ? EventSource : null);

  let sub = null;             // our EventSource subscription
  let outTopic = null;        // the topic we publish to
  let opened = false;         // has the match been approved and started
  let closed = false;
  let amHost = false;
  let myName = '';
  let sid = null;             // our session token (host mints it, guest echoes it)
  let peerSid = null;         // the token we accept messages from
  let verdict = false;        // guest: has the host answered
  let prompted = false;       // host: have we already raised this join request
  let joinTimer = null, giveUp = null;
  const seen = new Set();     // ntfy message ids already handled (SSE may re-deliver)
  const chunks = new Map();   // reassembly buffers for oversized messages
  const cbs = { data: null, open: null, error: null, status: null, joinRequest: null };

  const status = (t) => { if (!closed) cbs.status && cbs.status(t); };
  const fail = (type, message) => { if (!closed) cbs.error && cbs.error({ type, message }); };
  const stopTimers = () => { clearInterval(joinTimer); clearTimeout(giveUp); joinTimer = giveUp = null; };

  /* ---------------------------- publishing ---------------------------- */

  async function post(body, tries = 0) {
    if (closed || !doFetch || !outTopic) return false;
    try {
      const res = await doFetch(`${base}/${outTopic}`, { method: 'POST', body });
      if (res && res.status === 429 && tries < 4) {       // rate limited — back off
        await sleep(1500 * (tries + 1));
        return post(body, tries + 1);
      }
      if (res && !res.ok && tries < 2) { await sleep(600); return post(body, tries + 1); }
      return !!(res && res.ok);
    } catch (_) {
      if (tries < 3) { await sleep(800 * (tries + 1)); return post(body, tries + 1); }
      return false;
    }
  }

  // Publish one app/handshake message, splitting anything over the service's size
  // limit into numbered parts (the end-of-game full log can be several KB).
  function publish(msg) {
    const body = JSON.stringify({ ...msg, __s: sid });
    if (body.length <= MAX_BODY) { post(body); return; }
    const id = token(8);
    const n = Math.ceil(body.length / MAX_BODY);
    for (let i = 0; i < n; i++) {
      post(JSON.stringify({ __p: id, i, n, s: body.slice(i * MAX_BODY, (i + 1) * MAX_BODY), __s: sid }));
    }
  }

  /* --------------------------- subscribing ---------------------------- */

  function subscribe(topic) {
    if (!ES) { fail('unsupported', 'Online play needs an internet connection.'); return; }
    try {
      sub = new ES(`${base}/${topic}/sse`);
    } catch (_) {
      fail('relay', 'Could not reach the relay service.');
      return;
    }
    sub.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch (_) { return; }
      if (!frame || frame.event !== 'message' || !frame.message) return;
      if (frame.id) { if (seen.has(frame.id)) return; seen.add(frame.id); }
      let msg;
      try { msg = JSON.parse(frame.message); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.__p) { reassemble(msg); return; }
      route(msg);
    };
    // EventSource reconnects on its own; only report a hard failure before we are
    // connected, so a transient blip mid-game doesn't end the match.
    sub.onerror = () => {
      if (!opened && !verdict) status('Trouble reaching the relay — still trying…');
    };
  }

  function reassemble(part) {
    const buf = chunks.get(part.__p) || { n: part.n, got: 0, parts: [] };
    if (buf.parts[part.i] === undefined) { buf.parts[part.i] = part.s; buf.got++; }
    chunks.set(part.__p, buf);
    if (buf.got !== buf.n) return;
    chunks.delete(part.__p);
    try { route(JSON.parse(buf.parts.join(''))); } catch (_) { /* dropped part */ }
  }

  /* ---------------------------- delivery ------------------------------ */

  function route(msg) {
    const t = msg.__t;
    // Both guests of a busy room share one topic, so a verdict is addressed to the
    // session it answers; ignore anyone else's.
    if (msg.to && msg.to !== sid) return;
    // Otherwise only listen to the peer we're in a session with — except for a
    // JOIN, which is how a NEW peer introduces itself.
    if (peerSid && msg.__s && msg.__s !== peerSid && t !== H.JOIN) return;

    if (amHost) {
      if (t === H.JOIN) {
        const from = msg.__s || null;
        if (opened) {                                  // room busy: tell the newcomer
          if (from !== peerSid) publish({ __t: H.FULL, to: from });
          return;
        }
        if (prompted) return;                          // JOIN repeats until answered
        prompted = true;
        peerSid = from;
        const who = String(msg.name || 'A player').slice(0, 14);
        const accept = () => {
          if (opened || closed) return;
          opened = true;
          publish({ __t: H.ACCEPT, to: from });
          status('Connected!');
          cbs.open && cbs.open();
        };
        const deny = () => {
          publish({ __t: H.DENY, to: from });
          prompted = false; peerSid = null;            // the room is free again
        };
        if (cbs.joinRequest) cbs.joinRequest(who, { accept, deny });
        else accept();
        return;
      }
      if (opened && !t) cbs.data && cbs.data(payload(msg));
      return;
    }

    // Guest side.
    if (t === H.ACCEPT) {
      if (verdict) return;
      verdict = true; stopTimers();
      peerSid = msg.__s || null;
      opened = true; status('Connected!');
      cbs.open && cbs.open();
      return;
    }
    if (t === H.DENY) {
      if (verdict) return;
      verdict = true; stopTimers();
      fail('denied', 'The host declined your request to join.');
      return;
    }
    if (t === H.FULL) {
      if (verdict) return;
      verdict = true; stopTimers();
      fail('full', 'That room is already full.');
      return;
    }
    if (opened && !t) cbs.data && cbs.data(payload(msg));
  }

  // Deliver game messages exactly as the engine sent them — the routing fields
  // are ours and must not leak into the protocol.
  function payload(msg) {
    const { __s, to, ...clean } = msg;
    return clean;
  }

  /* ------------------------------ api --------------------------------- */

  return {
    onData(fn) { cbs.data = fn; },
    onOpen(fn) { cbs.open = fn; },
    onError(fn) { cbs.error = fn; },
    onStatus(fn) { cbs.status = fn; },
    onJoinRequest(fn) { cbs.joinRequest = fn; },

    // Listen for a guest on `code`. Unlike the WebRTC host there is nothing to
    // negotiate, so the room is live as soon as we are subscribed.
    host(code, onReady) {
      amHost = true;
      sid = token();
      outTopic = relayTopic(code, 'g');     // host publishes to the guest's topic
      subscribe(relayTopic(code, 'h'));
      onReady && onReady(code);
    },

    join(code, name) {
      amHost = false;
      sid = token();
      myName = String(name || '').slice(0, 14);
      outTopic = relayTopic(code, 'h');     // guest publishes to the host's topic
      subscribe(relayTopic(code, 'g'));
      status('Asking the host to let you in…');
      const ask = () => publish({ __t: H.JOIN, name: myName });
      ask();
      // The host may not be subscribed at the instant we ask, and a relayed message
      // is fire-and-forget — so keep asking until we get an answer.
      joinTimer = setInterval(() => { if (verdict) stopTimers(); else ask(); }, JOIN_RETRY_MS);
      giveUp = setTimeout(() => {
        if (verdict) return;
        stopTimers();
        fail('timeout', 'No answer from that room. Check the code, or ask the host to create a new one.');
      }, JOIN_GIVEUP_MS);
    },

    send(msg) { if (opened) publish(msg); },

    isOpen() { return opened; },

    close() {
      closed = true; opened = false;
      stopTimers();
      try { sub && sub.close(); } catch (_) {}
      sub = null;
    },
  };
}
