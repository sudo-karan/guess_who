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
// BUDGET. ntfy.sh rate-limits per IP: ~60 requests per 5 minutes and 250 publishes
// per day, and two players behind one router SHARE that budget. Every request here
// is therefore spent deliberately: retries are few and spaced, and a throttled
// request is reported to the player rather than swallowed — being silently
// rate-limited is indistinguishable from the app being broken.
//
// PRIVACY: a relayed game's messages (display names, chat, moves) pass through a
// public service and are readable by anyone who knows the room topic. Direct
// WebRTC is always tried first and is end-to-end encrypted; this is the fallback.
// A per-session token keeps a stray or stale publisher from corrupting a game.
//
// The interface is deliberately identical to createOnlineChannel() in net.js, so
// the two are interchangeable and can be composed (see channel.js).

const DEFAULT_BASE = 'https://ntfy.sh';
const TOPIC_PREFIX = 'guesswho-v1-';
const MAX_BODY = 3000;          // ntfy's per-message body limit is 4 KiB; stay clear
const JOIN_RETRY_MS = 5000;     // spaced out: each retry costs a request from the quota
const JOIN_MAX_TRIES = 4;       // ...so cap them rather than hammering for a minute
const RESUB_MS = 4000;          // backoff before rebuilding a dead subscription
const RESUB_MAX = 4;

// Anyone self-hosting the game can point it at their own ntfy instance (which has
// no shared rate limit) by setting window.__GW_RELAY_BASE before the app loads.
export function relayBase() {
  if (typeof window !== 'undefined' && typeof window.__GW_RELAY_BASE === 'string' && window.__GW_RELAY_BASE) {
    return window.__GW_RELAY_BASE.replace(/\/+$/, '');
  }
  return DEFAULT_BASE;
}

// Kept as a named export for callers that only need the default.
export const RELAY_BASE = DEFAULT_BASE;

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
export function createRelayChannel({ base, fetchImpl, EventSourceImpl } = {}) {
  const url = (base || relayBase()).replace(/\/+$/, '');
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const ES = EventSourceImpl || (typeof EventSource === 'function' ? EventSource : null);

  let sub = null;             // our EventSource subscription
  let inTopic = null;         // the topic we listen on
  let outTopic = null;        // the topic we publish to
  let opened = false;         // has the match been approved and started
  let closed = false;
  let amHost = false;
  let myName = '';
  let sid = null;             // our session token (host mints it, guest echoes it)
  let peerSid = null;         // the token we accept messages from
  let verdict = false;        // guest: has the host answered
  let prompted = false;       // host: have we already raised this join request
  let promptedSid = null;     // ...and whose it was
  let lastJoinAt = 0;         // when that requester was last heard from
  let joinTimer = null, joinTries = 0;
  let resubs = 0;
  const seen = new Set();     // ntfy message ids already handled (SSE may re-deliver)
  const chunks = new Map();   // reassembly buffers for oversized messages
  const cbs = { data: null, open: null, error: null, status: null, joinRequest: null };
  // Everything the "Connection details" readout needs to explain a stuck room.
  const diag = { sent: 0, failed: 0, throttled: 0, lastStatus: null, sub: 'not started' };

  const status = (t) => { if (!closed) cbs.status && cbs.status(t); };
  const fail = (type, message) => { if (!closed) cbs.error && cbs.error({ type, message }); };
  const stopTimers = () => { clearInterval(joinTimer); joinTimer = null; };

  /* ---------------------------- publishing ---------------------------- */

  // One attempt plus at most one spaced retry. Retrying harder makes throttling
  // worse, since every attempt spends from the same per-IP budget.
  async function post(body, tries = 0) {
    if (closed || !doFetch || !outTopic) return false;
    try {
      const res = await doFetch(`${url}/${outTopic}`, { method: 'POST', body });
      diag.lastStatus = (res && res.status) || 0;
      if (res && res.status === 429) {
        diag.throttled++;
        if (tries < 1) { await sleep(3000); return post(body, tries + 1); }
        diag.failed++;
        throttled();
        return false;
      }
      if (res && !res.ok) {
        if (tries < 1) { await sleep(1500); return post(body, tries + 1); }
        diag.failed++;
        return false;
      }
      diag.sent++;
      return true;
    } catch (_) {
      diag.lastStatus = 'network error';
      if (tries < 1) { await sleep(1500); return post(body, tries + 1); }
      diag.failed++;
      return false;
    }
  }

  // Being rate-limited must never look like "nothing is happening".
  function throttled() {
    if (opened) { status('The relay is busy — messages may be delayed.'); return; }
    fail('ratelimited', 'The relay is rate-limited right now (too many requests from your network). Wait a minute and try again, or get on the same Wi-Fi so a direct connection can be used.');
  }

  // Publish one app/handshake message, splitting anything over the service's size
  // limit into numbered parts (the end-of-game full log can be several KB).
  function publish(msg) {
    const body = JSON.stringify({ ...msg, __s: sid });
    if (body.length <= MAX_BODY) return post(body);
    const id = token(8);
    const n = Math.ceil(body.length / MAX_BODY);
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push(post(JSON.stringify({ __p: id, i, n, s: body.slice(i * MAX_BODY, (i + 1) * MAX_BODY), __s: sid })));
    }
    return Promise.all(parts).then((r) => r.every(Boolean));
  }

  /* --------------------------- subscribing ---------------------------- */

  function subscribe(topic) {
    inTopic = topic;
    if (!ES) { fail('unsupported', 'Online play needs an internet connection.'); return; }
    try {
      sub = new ES(`${url}/${topic}/sse`);
    } catch (_) {
      diag.sub = 'could not start';
      fail('relay', 'Could not reach the relay service.');
      return;
    }
    diag.sub = 'connecting';
    if ('onopen' in sub) sub.onopen = () => { diag.sub = 'listening'; resubs = 0; };
    sub.onmessage = (ev) => {
      diag.sub = 'listening';
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
    // A browser gives up on an EventSource for good when the server answers with
    // an HTTP error (a 429 from the shared rate limit, say) — readyState goes to
    // CLOSED and it never retries. Silently deaf is the worst possible state for
    // a host waiting on a join request, so rebuild it ourselves.
    sub.onerror = () => {
      const dead = sub && sub.readyState === 2;
      diag.sub = dead ? 'dropped' : 'reconnecting';
      if (!dead || closed) return;
      if (resubs >= RESUB_MAX) {
        diag.sub = 'gave up';
        fail('relay', 'Lost the relay connection and could not get it back. Your network may be rate-limited — wait a minute and try again.');
        return;
      }
      resubs++;
      const delay = RESUB_MS * resubs;
      status('Reconnecting to the relay…');
      setTimeout(() => {
        if (closed) return;
        try { sub && sub.close(); } catch (_) {}
        subscribe(inTopic);
      }, delay);
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
        // A guest that is still waiting re-publishes its JOIN every few seconds,
        // so silence means it has gone. Without that liveness rule the "already
        // prompted" latch was permanent: once the host had been asked once and
        // had not answered, no later request — not even the same player
        // reloading, who arrives with a fresh session id — was ever raised
        // again, and the host simply never saw another popup.
        const at = Date.now();
        if (prompted) {
          if (from === promptedSid) { lastJoinAt = at; return; }   // same guest, still waiting
          if (at - lastJoinAt < JOIN_RETRY_MS * 2) return;         // the pending one is alive: wait
          // Otherwise the pending requester has gone quiet — let this one take over.
          // Deliberately no DENY/FULL to the newcomer: both are terminal and would
          // tell them the host refused when the host never saw them.
        }
        prompted = true;
        promptedSid = from;
        lastJoinAt = at;
        peerSid = from;
        const who = String(msg.name || 'A player').slice(0, 14);
        const free = () => { prompted = false; promptedSid = null; peerSid = null; };
        const accept = () => {
          if (opened || closed) { free(); return; }   // committed nothing: don't wedge the room
          opened = true;
          publish({ __t: H.ACCEPT, to: from });
          status('Connected!');
          cbs.open && cbs.open();
        };
        const deny = () => {
          publish({ __t: H.DENY, to: from });
          free();                                      // the room is free again
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

    diagnostics() {
      return {
        relay: url,
        listening: inTopic ? `${inTopic} (${diag.sub})` : 'not listening',
        publishing: outTopic || 'nowhere',
        messagesSent: diag.sent,
        sendsFailed: diag.failed,
        timesThrottled: diag.throttled,
        lastSendStatus: diag.lastStatus === null ? 'nothing sent yet' : String(diag.lastStatus),
      };
    },

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
      const ask = async () => {
        joinTries++;
        const ok = await publish({ __t: H.JOIN, name: myName });
        // A JOIN that never left the building is the one failure the player must
        // not be left guessing about: the host simply never heard them.
        if (!ok && joinTries >= JOIN_MAX_TRIES && !verdict) {
          stopTimers();
          fail('unsent', 'Couldn\'t reach the relay to ask the host to let you in. Your network may be rate-limited — wait a minute and try again.');
          return;
        }
        if (joinTries >= JOIN_MAX_TRIES && !verdict) {
          stopTimers();
          fail('timeout', 'No answer from that room. Check the code, or ask the host to create a new one.');
        }
      };
      ask();
      // The host may not be subscribed at the instant we ask, and a relayed message
      // is fire-and-forget — so ask again a few times, spaced out to stay inside
      // the service's request budget.
      joinTimer = setInterval(() => { if (verdict) stopTimers(); else ask(); }, JOIN_RETRY_MS);
    },

    send(msg) { if (opened) publish(msg); },

    isOpen() { return opened; },

    close() {
      closed = true; opened = false;
      stopTimers();
      try { sub && sub.close(); } catch (_) {}
      sub = null;
      diag.sub = 'closed';
    },
  };
}
