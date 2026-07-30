// net.js
// Online transport for two players using PeerJS (WebRTC data channels).
// PeerJS is loaded globally from a vendored <script> in index.html; we degrade
// gracefully if it is unavailable (the app still offers local pass-and-play).
//
// Flow: the HOST creates a peer and shows a short room code. The GUEST enters
// that code (or picks the room from the lobby) and opens a data connection.
// Before the match starts the guest sends a JOIN REQUEST and the host approves
// or declines; a second guest to an occupied room is told the room is full.
// Everything after approval is symmetric JSON.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
export const ID_PREFIX = 'guesswho-v1-';

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

function defaultMakePeer(id) {
  return id ? new window.Peer(id, { debug: 1 }) : new window.Peer({ debug: 1 });
}

// Reserved handshake messages travel on the same channel as game messages but
// are namespaced with `__t` so they never collide with engine message `type`s.
const H = { JOIN: 'join', ACCEPT: 'accept', DENY: 'deny', FULL: 'full' };

// Create an online channel. `makePeer` is injectable for tests; it defaults to
// PeerJS in the browser. Returns an object with lifecycle callbacks.
export function createOnlineChannel({ makePeer } = {}) {
  const mkPeer = makePeer || defaultMakePeer;
  let peer = null;
  let conn = null;          // the ACTIVE (accepted) connection
  let opened = false;       // has the match connection been approved + opened
  let myName = '';
  const cbs = { data: null, open: null, error: null, status: null, joinRequest: null };

  function status(text) { cbs.status && cbs.status(text); }
  function unsupported() {
    cbs.error && cbs.error({ type: 'unsupported', message: 'Online play needs an internet connection.' });
  }
  const softClose = (c) => { try { c.close(); } catch (_) {} };

  // HOST side: a guest connected, but the match only starts once the host
  // approves the guest's join request. A second guest to an occupied room is
  // told the room is full.
  function wireHostConn(c) {
    let prompted = false;      // only prompt once per connection (JOIN may repeat)
    let settled = false;       // has this connection been accepted/denied

    function askApproval(name) {
      if (prompted || settled) return;
      prompted = true;
      const accept = () => {
        settled = true;
        if (opened) { if (c !== conn) { try { c.send({ __t: H.FULL }); } catch (_) {} softClose(c); } return; }
        // The guest may have left while the host deliberated — don't commit the
        // game to a dead connection (which would strand the host in setup and make
        // every future guest hit "room full").
        if (c.open === false) { status('The player left before you answered.'); return; }
        conn = c; opened = true;
        try { c.send({ __t: H.ACCEPT }); } catch (_) {}
        status('Connected!');
        cbs.open && cbs.open();
      };
      const deny = () => { settled = true; try { c.send({ __t: H.DENY }); } catch (_) {} softClose(c); };
      if (cbs.joinRequest) cbs.joinRequest(name, { accept, deny });
      else accept();          // no approval handler wired -> accept (back-compat)
    }

    // A guest whose JOIN frame never arrives would otherwise leave the host stuck
    // on "Player joining…" forever. If a connection sits silent, prompt anyway —
    // the guest is waiting for a verdict and will proceed once accepted.
    const fallback = setTimeout(() => {
      if (!prompted && !settled && !opened && c.open !== false) {
        status('A player is waiting to join…');
        askApproval('A player');
      }
    }, 6000);

    c.on('data', (d) => {
      if (d && d.__t === H.JOIN) {
        clearTimeout(fallback);
        // Already in a game: reject a DIFFERENT second guest as full, but ignore a
        // duplicate join on the already-accepted connection (never kill the live game).
        if (opened) { if (c !== conn) { try { c.send({ __t: H.FULL }); } catch (_) {} softClose(c); } return; }
        askApproval(String(d.name || 'A player').slice(0, 14));
        return;
      }
      if (c === conn && opened) cbs.data && cbs.data(d);   // game data only from the accepted guest
    });
    c.on('close', () => {
      clearTimeout(fallback);
      if (c === conn && opened) {
        opened = false;
        status('Opponent disconnected.');
        cbs.error && cbs.error({ type: 'closed', message: 'Connection closed.' });
      }
    });
    c.on('error', (err) => {
      clearTimeout(fallback);
      if (c === conn) cbs.error && cbs.error({ type: 'conn', message: String((err && err.message) || err) });
    });
  }

  // GUEST side: once the data channel opens, ask to join and await the verdict.
  function wireGuestConn(c) {
    conn = c;   // tentative — not "opened" until the host accepts
    let pending = [];   // game data that somehow arrives before ACCEPT is processed
    let verdict = false;
    let joinTimer = null, giveUp = null, openTimer = null;
    const stopTimers = () => { clearInterval(joinTimer); clearTimeout(giveUp); clearTimeout(openTimer); };
    const sendJoin = () => { try { c.send({ __t: H.JOIN, name: myName }); } catch (_) {} };

    // If the data channel never opens, say so rather than hanging on "Connecting…".
    openTimer = setTimeout(() => {
      if (!verdict && c.open === false) {
        cbs.error && cbs.error({ type: 'timeout', message: 'Couldn\'t connect to that room. Check the code, or ask the host to create a new room.' });
      }
    }, 15000);

    c.on('open', () => {
      clearTimeout(openTimer);
      status('Asking the host to let you in…');
      sendJoin();
      // Re-send periodically: a dropped JOIN frame is the classic cause of a host
      // sitting on "Player joining…" while the guest waits forever. Duplicates are
      // ignored host-side.
      joinTimer = setInterval(() => { if (!verdict) sendJoin(); else clearInterval(joinTimer); }, 3000);
      giveUp = setTimeout(() => {
        if (!verdict) {
          stopTimers();
          cbs.error && cbs.error({ type: 'timeout', message: 'No response from the host — they may not have answered your request. Try again.' });
        }
      }, 60000);
    });
    c.on('data', (d) => {
      if (d && d.__t === H.ACCEPT) {
        verdict = true; stopTimers();
        opened = true; status('Connected!');
        cbs.open && cbs.open();
        // Flush anything (e.g. the roster) that raced ahead of the accept so it is
        // never silently dropped — this is the guest's ONLY setup-entry trigger.
        const q = pending; pending = [];
        for (const m of q) cbs.data && cbs.data(m);
        return;
      }
      if (d && d.__t === H.DENY) { verdict = true; stopTimers(); cbs.error && cbs.error({ type: 'denied', message: 'The host declined your request to join.' }); return; }
      if (d && d.__t === H.FULL) { verdict = true; stopTimers(); cbs.error && cbs.error({ type: 'full', message: 'That room is already full.' }); return; }
      if (opened) cbs.data && cbs.data(d);
      else if (d && !d.__t) pending.push(d);   // buffer game data until accepted
    });
    c.on('close', () => {
      stopTimers();
      if (opened) {
        opened = false;
        status('Opponent disconnected.');
        cbs.error && cbs.error({ type: 'closed', message: 'Connection closed.' });
      } else if (!verdict) {
        cbs.error && cbs.error({ type: 'closed', message: 'The room closed before you got in. Ask the host to create a new room.' });
      }
    });
    c.on('error', (err) => {
      stopTimers();
      cbs.error && cbs.error({ type: 'conn', message: String((err && err.message) || err) });
    });
  }

  return {
    onData(fn) { cbs.data = fn; },
    onOpen(fn) { cbs.open = fn; },
    onError(fn) { cbs.error = fn; },
    onStatus(fn) { cbs.status = fn; },
    // Host: called with (guestName, { accept, deny }) when a guest asks to join.
    onJoinRequest(fn) { cbs.joinRequest = fn; },

    // Host a room. Calls back with the room code once the peer is ready.
    host(onCode) {
      if (!makePeer && !peerAvailable()) { unsupported(); return; }
      const code = randomCode();
      status('Creating room…');
      peer = mkPeer(ID_PREFIX + code);
      peer.on('open', () => { status('Room ready — share your code.'); onCode && onCode(code); });
      peer.on('connection', (c) => { status('Player joining…'); wireHostConn(c); });
      peer.on('error', (err) => {
        const msg = String((err && err.type) || err);
        // If the id is taken, retry once with a fresh code.
        if (msg === 'unavailable-id') { try { peer.destroy(); } catch (_) {} return this.host(onCode); }
        cbs.error && cbs.error({ type: 'peer', message: msg });
      });
    },

    // Join a room by code. `name` is sent with the join request.
    join(code, name) {
      if (!makePeer && !peerAvailable()) { unsupported(); return; }
      myName = String(name || '').slice(0, 14);
      const clean = String(code || '').trim().toUpperCase();
      if (!clean) { cbs.error && cbs.error({ type: 'code', message: 'Enter a room code.' }); return; }
      status('Connecting to room…');
      peer = mkPeer();
      peer.on('open', () => { wireGuestConn(peer.connect(ID_PREFIX + clean, { reliable: true })); });
      peer.on('error', (err) => {
        const t = String((err && err.type) || err);
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
