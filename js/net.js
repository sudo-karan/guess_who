// net.js
// Online transport for two players using PeerJS (WebRTC data channels).
// PeerJS is loaded globally from a CDN <script> in index.html; we degrade
// gracefully if it is unavailable (the app still offers local pass-and-play).
//
// Flow: the HOST creates a peer and shows a short room code. The GUEST enters
// that code and opens a data connection. Everything after is symmetric JSON.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const ID_PREFIX = 'guesswho-v1-';

function randomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

export function peerAvailable() {
  return typeof window !== 'undefined' && typeof window.Peer === 'function';
}

// Create an online channel. Returns an object with lifecycle callbacks.
export function createOnlineChannel() {
  let peer = null;
  let conn = null;
  let opened = false;
  const cbs = { data: null, open: null, error: null, status: null };

  function status(text) { cbs.status && cbs.status(text); }

  function wireConn(c) {
    conn = c;
    c.on('open', () => {
      opened = true;
      status('Connected!');
      cbs.open && cbs.open();
    });
    c.on('data', (d) => { cbs.data && cbs.data(d); });
    c.on('close', () => {
      opened = false;
      status('Opponent disconnected.');
      cbs.error && cbs.error({ type: 'closed', message: 'Connection closed.' });
    });
    c.on('error', (err) => {
      cbs.error && cbs.error({ type: 'conn', message: String(err && err.message || err) });
    });
  }

  return {
    onData(fn) { cbs.data = fn; },
    onOpen(fn) { cbs.open = fn; },
    onError(fn) { cbs.error = fn; },
    onStatus(fn) { cbs.status = fn; },

    // Host a room. Calls back with the room code once the peer is ready.
    host(onCode) {
      if (!peerAvailable()) {
        cbs.error && cbs.error({ type: 'unsupported', message: 'Online play needs an internet connection.' });
        return;
      }
      const code = randomCode();
      status('Creating room…');
      peer = new window.Peer(ID_PREFIX + code, { debug: 1 });
      peer.on('open', () => {
        status('Room ready — share your code.');
        onCode && onCode(code);
      });
      peer.on('connection', (c) => {
        status('Player joining…');
        wireConn(c);
      });
      peer.on('error', (err) => {
        const msg = String(err && err.type || err);
        // If the id is taken, retry once with a fresh code.
        if (msg === 'unavailable-id') {
          try { peer.destroy(); } catch (_) {}
          return this.host(onCode);
        }
        cbs.error && cbs.error({ type: 'peer', message: msg });
      });
    },

    // Join a room by code.
    join(code) {
      if (!peerAvailable()) {
        cbs.error && cbs.error({ type: 'unsupported', message: 'Online play needs an internet connection.' });
        return;
      }
      const clean = String(code || '').trim().toUpperCase();
      if (!clean) { cbs.error && cbs.error({ type: 'code', message: 'Enter a room code.' }); return; }
      status('Connecting to room…');
      peer = new window.Peer({ debug: 1 });
      peer.on('open', () => {
        const c = peer.connect(ID_PREFIX + clean, { reliable: true });
        wireConn(c);
      });
      peer.on('error', (err) => {
        const t = String(err && err.type || err);
        const message = t === 'peer-unavailable'
          ? 'No room found with that code. Check it and try again.'
          : t;
        cbs.error && cbs.error({ type: 'peer', message });
      });
    },

    send(msg) {
      if (conn && opened) {
        try { conn.send(msg); } catch (e) { /* ignore transient send errors */ }
      }
    },

    isOpen() { return opened; },

    close() {
      try { conn && conn.close(); } catch (_) {}
      try { peer && peer.destroy(); } catch (_) {}
      conn = null; peer = null; opened = false;
    },
  };
}

// A local (same-device) channel pair. Wires two engines directly so pass-and-play
// reuses the exact same engine + protocol as online play.
export function createLocalPair() {
  const chA = { onData: null, send: (m) => chB.onData && chB.onData(m) };
  const chB = { onData: null, send: (m) => chA.onData && chA.onData(m) };
  return {
    a: { onData(fn) { chA.onData = fn; }, send: (m) => chA.send(m) },
    b: { onData(fn) { chB.onData = fn; }, send: (m) => chB.send(m) },
  };
}
