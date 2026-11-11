// lobby.js
// Room discovery for online play — still with no backend of our own.
//
// This used to elect one browser as a "lobby coordinator" by claiming a fixed
// PeerJS id, with everyone else connecting to it. That had two fatal flaws in the
// real world: it needed a working peer-to-peer data channel just to SEE the room
// list (the very thing that fails on restrictive networks), and the well-known id
// was global — any stale or zombie tab anywhere could hold it and wedge discovery
// for everybody.
//
// So discovery is now a plain broadcast feed over HTTPS. Every host repeats a
// small "my room is open" beacon on one shared public topic; every browser listens
// to that topic and keeps the rooms it has heard from recently. Nobody is in
// charge, there is nothing to elect, and nothing to wedge: a host that goes away
// simply stops beaconing and ages out of everyone's list.
//
// The room registry is kept as a pure, dependency-free piece so it can be
// unit-tested without a network.

import { RELAY_BASE } from './relay.js';

export const LOBBY_TOPIC = 'guesswho-v1-lobby';

// Room lifecycle as seen in the browser list.
export const ROOM_STATUS = { OPEN: 'open', PLAYING: 'playing', ENDED: 'ended' };

// MESSAGE BUDGET. ntfy.sh allows roughly 60 requests per 5 minutes and 250
// publishes per day PER IP — and two players behind one router share that. A
// 15-second beacon spends 240 publishes an hour, which burns the whole daily
// budget in about an hour of hosting and then silently 429s everything,
// including the join requests that actually matter.
//
// So hosts do not beacon continuously. A room is announced when it opens, when
// its status changes and when it closes, plus a slow keepalive so a long-running
// room doesn't age out. Anyone opening the room list asks once ("who's there?")
// and live hosts answer once — a couple of requests per browse instead of a
// steady drip from every host on the internet.
const KEEPALIVE_MS = 240000;   // 4 min: ~15 publishes/hour for a host, not 240
const STALE_MS = 600000;       // 10 min without a word before a room is dropped
const SWEEP_MS = 30000;        // how often we age the list
const WHO_COOLDOWN_MS = 10000; // a host answers at most one "who's there?" per 10s

/* --------------------------- pure room registry --------------------------- */
// Tracks the set of live rooms keyed by code. Each entry remembers who published
// it and when it was last heard from, so silent rooms can be aged out.
export function createRegistry() {
  const rooms = new Map();   // code -> { code, hostName, status, ownerId, ts }

  return {
    // Add or replace a room. `ownerId` identifies the publisher.
    publish(ownerId, room, ts = 0) {
      if (!room || !room.code) return false;
      rooms.set(room.code, {
        code: String(room.code),
        hostName: String(room.hostName || 'Player'),
        status: room.status || ROOM_STATUS.OPEN,
        ownerId,
        ts,
      });
      return true;
    },
    update(code, status) {
      const r = rooms.get(code);
      if (!r) return false;
      r.status = status;
      return true;
    },
    remove(code) { return rooms.delete(code); },
    // Drop every room a departed owner was hosting; returns how many were removed.
    removeByOwner(ownerId) {
      let n = 0;
      for (const [code, r] of rooms) if (r.ownerId === ownerId) { rooms.delete(code); n++; }
      return n;
    },
    // Drop rooms last heard from before `cutoff`; returns how many were removed.
    expire(cutoff) {
      let n = 0;
      for (const [code, r] of rooms) if (r.ts < cutoff) { rooms.delete(code); n++; }
      return n;
    },
    has(code) { return rooms.has(code); },
    size() { return rooms.size; },
    clear() { rooms.clear(); },
    // Public view (newest first), without the internal bookkeeping.
    list() {
      return [...rooms.values()]
        .sort((a, b) => b.ts - a.ts)
        .map(({ ownerId, ts, ...pub }) => pub);
    },
  };
}

/* ------------------------- pure beacon interpretation --------------------- */
// Apply one decoded feed message to the registry. Returns true if the visible
// list changed. Kept free of I/O so it can be driven directly in tests.
export function applyBeacon(registry, msg, now) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.t === 'who') return false;          // a request, not a room: handled by the feed
  if (msg.t === 'room') {
    if (!msg.code) return false;
    if (msg.status === ROOM_STATUS.ENDED) return registry.remove(msg.code);
    registry.publish(msg.code, {
      code: msg.code, hostName: msg.hostName, status: msg.status,
    }, now);
    return true;
  }
  if (msg.t === 'gone') return registry.remove(msg.code);
  return false;
}

/* ------------------------------- the feed --------------------------------- */
// `fetchImpl` / `EventSourceImpl` / `now` are injectable so this is testable.
export function createLobby({
  base = RELAY_BASE, topic = LOBBY_TOPIC, onRooms, onStatus,
  fetchImpl, EventSourceImpl, now = () => Date.now(),
  staleMs = STALE_MS, sweepMs = SWEEP_MS, keepaliveMs = KEEPALIVE_MS,
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const ES = EventSourceImpl || (typeof EventSource === 'function' ? EventSource : null);

  const registry = createRegistry();
  const seen = new Set();
  let sub = null;
  let sweeper = null, beacon = null;
  let mine = null;            // the room this browser is hosting, if any
  let lastWho = 0;            // when we last answered a "who's there?"
  let started = false, closed = false;

  const emit = () => onRooms && onRooms(registry.list());
  const say = (k) => onStatus && onStatus(k);
  // A background timer must never be the reason a process (or a test run) stays
  // alive; browsers ignore unref, Node honours it.
  const every = (fn, ms) => {
    const t = setInterval(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };

  // One spaced retry at most. Room discovery is a convenience — joining by code
  // always works — so it must never spend the request budget that the join
  // handshake itself needs.
  async function post(body, tries = 0) {
    if (closed || !doFetch) return false;
    try {
      const res = await doFetch(`${base}/${topic}`, { method: 'POST', body });
      if (res && res.status === 429) {
        if (tries < 1) { setTimeout(() => post(body, tries + 1), 4000); return false; }
        say('throttled');
        return false;
      }
      return !!(res && res.ok);
    } catch (_) {
      if (tries < 1) setTimeout(() => post(body, tries + 1), 2000);
      return false;
    }
  }

  const announce = () => { if (mine) post(JSON.stringify({ t: 'room', ...mine })); };

  function take(raw, id, live) {
    if (id) { if (seen.has(id)) return; seen.add(id); }
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    // Someone just opened the room list and is asking who is hosting. Answer once
    // if we are, rate-limited so a busy lobby can't make hosts shout over
    // each other. Only live traffic: a cached "who" from history is long answered.
    if (msg && msg.t === 'who') {
      if (live && mine && now() - lastWho > WHO_COOLDOWN_MS) { lastWho = now(); announce(); }
      return;
    }
    if (applyBeacon(registry, msg, now())) emit();
  }

  // Catch up on rooms announced just before this page opened, so the list is
  // populated at once instead of after the next beacon.
  async function catchUp() {
    if (!doFetch) return;
    try {
      const res = await doFetch(`${base}/${topic}/json?poll=1&since=${Math.round(staleMs / 1000)}s`);
      if (!res || !res.ok) return;
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          // History, not live traffic: never answer a cached "who's there?".
          if (frame && frame.event === 'message' && frame.message) take(frame.message, frame.id, false);
        } catch (_) { /* skip a bad line */ }
      }
      emit();
    } catch (_) { say('error'); }
  }

  function listen() {
    if (!ES) { say('error'); return; }
    try { sub = new ES(`${base}/${topic}/sse`); } catch (_) { say('error'); return; }
    sub.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch (_) { return; }
      if (frame && frame.event === 'message' && frame.message) take(frame.message, frame.id, true);
    };
    sub.onerror = () => { if (!registry.size()) say('error'); };
  }

  // "Who's there?" — hosts answer once, so a page that just opened learns about
  // rooms whose announcement has already scrolled out of the cached history.
  const askWho = () => post(JSON.stringify({ t: 'who' }));

  return {
    start() {
      if (started || closed) return;
      started = true;
      listen();
      catchUp();
      askWho();
      sweeper = every(() => {
        if (registry.expire(now() - staleMs)) emit();
      }, sweepMs);
      // A slow keepalive only: a host that beacons constantly exhausts the
      // service's per-IP budget and takes the join handshake down with it.
      beacon = every(announce, keepaliveMs);
    },

    // Re-read the list on demand (the Refresh button).
    refresh() { catchUp(); askWho(); announce(); },

    // Start advertising the room this browser is hosting.
    publish(room) {
      if (!room || !room.code) return;
      if (mine && mine.code !== room.code) this.unpublish(mine.code);
      mine = { code: room.code, hostName: room.hostName || 'Player', status: room.status || ROOM_STATUS.OPEN };
      // Show it locally straight away — don't wait for our own beacon to come back.
      registry.publish(mine.code, mine, now());
      emit();
      announce();
    },

    setStatus(code, status) {
      if (mine && mine.code === code) { mine.status = status; announce(); }
      if (registry.update(code, status)) emit();
    },

    unpublish(code) {
      post(JSON.stringify({ t: 'gone', code }));
      if (mine && mine.code === code) mine = null;
      if (registry.remove(code)) emit();
    },

    rooms() { return registry.list(); },

    close() {
      // Say goodbye BEFORE shutting down — post() is a no-op once closed, and a
      // missed goodbye leaves a dead room sitting in everyone's list until it
      // ages out.
      if (mine) { post(JSON.stringify({ t: 'gone', code: mine.code })); mine = null; }
      closed = true;
      clearInterval(sweeper); clearInterval(beacon);
      try { sub && sub.close(); } catch (_) {}
      sub = null;
    },
  };
}
