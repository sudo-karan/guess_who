// lobby.js
// Serverless room discovery for online play, built on the SAME PeerJS broker as
// the game — no backend required.
//
// One browser volunteers as the LOBBY COORDINATOR by claiming a fixed, well-known
// peer id (`guesswho-v1-lobby`). Everyone else connects to it to publish the room
// they are hosting and to browse the live list of open rooms. If the coordinator
// leaves, a remaining client re-claims the id and becomes the new coordinator;
// hosts re-publish so the list heals on its own.
//
// The room-registry and the coordinator's message handling are split out as pure,
// dependency-free pieces so they can be unit-tested without a real network.

export const LOBBY_ID = 'guesswho-v1-lobby';   // codes are 4 upper-case chars, so this never clashes

// Room lifecycle as seen in the browser list.
export const ROOM_STATUS = { OPEN: 'open', PLAYING: 'playing', ENDED: 'ended' };

/* --------------------------- pure room registry --------------------------- */
// Tracks the set of live rooms keyed by code. Each entry remembers which peer
// connection owns it so the coordinator can drop a host's rooms when it leaves.
export function createRegistry() {
  const rooms = new Map();   // code -> { code, hostName, status, ownerId, ts }

  return {
    // Add or replace a room. `ownerId` is the publishing connection's peer id.
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
    has(code) { return rooms.has(code); },
    size() { return rooms.size; },
    // Public view (newest first), without the internal ownerId bookkeeping.
    list() {
      return [...rooms.values()]
        .sort((a, b) => b.ts - a.ts)
        .map(({ ownerId, ts, ...pub }) => pub);
    },
  };
}

/* ----------------------- pure coordinator message logic ------------------- */
// Handle one inbound message from a client connection, mutating `registry` and
// `subscribers` and calling `broadcast()` when the room list changes. Kept pure
// of PeerJS so it can be driven by fake connections in tests.
//
//   conn: { peer, send(msg) }   (PeerJS DataConnection shape)
//   msg types (client -> coordinator):
//     { t:'sub' }                       subscribe to the live list
//     { t:'pub', room }                 publish/replace my room
//     { t:'status', code, status }      change my room's status
//     { t:'unpub', code }               remove my room
export function handleCoordinatorMessage(registry, subscribers, conn, msg, broadcast, now = 0) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'sub':
      subscribers.add(conn);
      // Send the current list straight to the new subscriber.
      safeSend(conn, { t: 'rooms', rooms: registry.list() });
      break;
    case 'pub':
      if (registry.publish(conn.peer, msg.room, now)) broadcast();
      break;
    case 'status':
      if (registry.update(msg.code, msg.status)) broadcast();
      break;
    case 'unpub':
      if (registry.remove(msg.code)) broadcast();
      break;
    default:
      break;
  }
}

function safeSend(conn, msg) {
  try { conn && conn.send(msg); } catch (_) { /* connection went away mid-send */ }
}

/* --------------------------- PeerJS lobby client -------------------------- */
// Connects to (or becomes) the coordinator and exposes a tiny API the UI uses:
//   publish(room) / setStatus(code,status) / unpublish(code) / refresh() / close()
// Callbacks: onRooms(rooms[]) whenever the list changes; onStatus(kind) for state.
//
// `makePeer(id?)` is injected so tests can supply a fake; in the browser it
// defaults to PeerJS. A monotonically increasing clock is used only to order the
// list newest-first; it must not use Date.now() so behaviour stays deterministic.
export function createLobby({ makePeer, onRooms = () => {}, onStatus = () => {} } = {}) {
  const mkPeer = makePeer || defaultMakePeer;
  const registry = createRegistry();     // populated only while we are coordinator
  const subscribers = new Set();         // coordinator: client conns wanting the list
  let peer = null;
  let coordConn = null;                  // client: our connection to the coordinator
  let role = null;                       // 'coordinator' | 'client' | null
  let wantList = false;                  // did the UI ask to browse
  let myRoom = null;                     // the room this browser hosts (to re-publish)
  let seq = 0;                           // ordering clock
  let closed = false;
  let retryPending = false;

  const tick = () => ++seq;

  function broadcast() {
    const rooms = registry.list();
    onRooms(rooms);                                  // the coordinator browses too
    const msg = { t: 'rooms', rooms };
    for (const c of subscribers) safeSend(c, msg);
  }

  // ---- coordinator role ----
  function becomeCoordinator() {
    role = 'coordinator';
    onStatus('coordinator');
    peer.on('connection', (c) => {
      c.on('data', (d) => handleCoordinatorMessage(registry, subscribers, c, d, broadcast, tick()));
      c.on('close', () => {
        subscribers.delete(c);
        if (registry.removeByOwner(c.peer)) broadcast();
      });
      c.on('error', () => { subscribers.delete(c); });
    });
    // As coordinator we serve ourselves directly (no self-connection needed).
    if (myRoom) { registry.publish('self', myRoom, tick()); }
    if (wantList || myRoom) broadcast();
  }

  // ---- client role ----
  function wireClientConn(c) {
    coordConn = c;
    c.on('open', () => {
      role = 'client';
      onStatus('client');
      if (wantList) safeSend(c, { t: 'sub' });
      if (myRoom) safeSend(c, { t: 'pub', room: myRoom });
    });
    c.on('data', (d) => { if (d && d.t === 'rooms') onRooms(d.rooms || []); });
    c.on('close', () => { coordConn = null; scheduleReclaim(); });
    c.on('error', () => { /* handled by close / peer error */ });
  }

  function connectAsClient() {
    peer = mkPeer();                          // random id
    peer.on('open', () => {
      if (closed) return;
      wireClientConn(peer.connect(LOBBY_ID, { reliable: true }));
    });
    peer.on('error', (err) => {
      // Coordinator vanished between claim-failure and connect: try to become it.
      if (isUnavailablePeer(err)) scheduleReclaim();
      else onStatus('error');
    });
  }

  // The coordinator left (or was never reachable): after a short randomised
  // backoff, try to claim the id ourselves; if it's taken, connect as a client.
  function scheduleReclaim() {
    if (closed || retryPending) return;
    retryPending = true;
    onStatus('reconnecting');
    // Vary the delay by our seq so simultaneous clients don't all collide.
    const delay = 300 + (seq % 7) * 120;
    setTimeout(() => { retryPending = false; if (!closed) start(); }, delay);
  }

  function start() {
    try { peer && peer.destroy(); } catch (_) {}
    peer = null; coordConn = null; role = null;
    // Try to claim the well-known coordinator id.
    peer = mkPeer(LOBBY_ID);
    peer.on('open', () => { if (!closed) becomeCoordinator(); });
    peer.on('error', (err) => {
      if (isIdTaken(err)) { try { peer.destroy(); } catch (_) {} connectAsClient(); }
      else if (isUnavailablePeer(err)) scheduleReclaim();
      else onStatus('error');
    });
  }

  return {
    start() { closed = false; start(); },
    // Announce (or update) the room this browser is hosting.
    publish(room) {
      myRoom = { code: room.code, hostName: room.hostName, status: room.status || ROOM_STATUS.OPEN };
      if (role === 'coordinator') { registry.publish('self', myRoom, tick()); broadcast(); }
      else if (coordConn) safeSend(coordConn, { t: 'pub', room: myRoom });
    },
    setStatus(code, status) {
      if (myRoom && myRoom.code === code) myRoom.status = status;
      if (role === 'coordinator') { if (registry.update(code, status)) broadcast(); }
      else if (coordConn) safeSend(coordConn, { t: 'status', code, status });
    },
    unpublish(code) {
      if (myRoom && myRoom.code === code) myRoom = null;
      if (role === 'coordinator') { if (registry.remove(code)) broadcast(); }
      else if (coordConn) safeSend(coordConn, { t: 'unpub', code });
    },
    // Ask to browse the live list.
    refresh() {
      wantList = true;
      if (role === 'coordinator') broadcast();
      else if (coordConn) safeSend(coordConn, { t: 'sub' });
    },
    role() { return role; },
    close() {
      closed = true;
      try { peer && peer.destroy(); } catch (_) {}
      peer = null; coordConn = null; role = null; subscribers.clear();
    },
  };
}

/* ------------------------------- peer helpers ----------------------------- */
function defaultMakePeer(id) {
  const P = (typeof window !== 'undefined') && window.Peer;
  if (typeof P !== 'function') throw new Error('PeerJS unavailable');
  return id ? new P(id, { debug: 1 }) : new P({ debug: 1 });
}
function errType(err) { return String((err && (err.type || err.message)) || err || ''); }
function isIdTaken(err) { return errType(err) === 'unavailable-id'; }
function isUnavailablePeer(err) { return errType(err) === 'peer-unavailable'; }
