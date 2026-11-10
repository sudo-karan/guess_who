// net.js
// Direct peer-to-peer transport for two players using PeerJS (WebRTC data
// channels). PeerJS is loaded globally from a vendored <script> in index.html; we
// degrade gracefully if it is unavailable (the app still offers local pass-and-play).
//
// Flow: the HOST creates a peer named after a short room code. The GUEST enters
// that code (or picks the room from the browser) and opens a data connection.
// Before the match starts the guest sends a JOIN REQUEST and the host approves or
// declines; a second guest to an occupied room is told the room is full.
// Everything after approval is symmetric JSON.
//
// This transport is PRIVATE (end-to-end encrypted, browser to browser) and fast,
// but it only works if the two networks can actually reach each other. When they
// can't, channel.js falls back to the relay in relay.js — so this module's job is
// to find that out QUICKLY and say so, rather than hanging on "Connecting…".

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
export const ID_PREFIX = 'guesswho-v1-';
const TURN_KEY = 'gw-turn';        // optional user-supplied TURN server

export function randomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

export function peerAvailable() {
  return typeof window !== 'undefined' && typeof window.Peer === 'function';
}

/* ------------------------------ ICE config ------------------------------ */
// PeerJS ships its own default RTCConfiguration, but the two TURN relays in it
// (eu-0/us-0.turn.peerjs.com) no longer exist — they have no DNS record at all —
// so out of the box every connection is STUN-only and simply fails on any network
// that needs a relay. Passing `config` REPLACES PeerJS's default, so we spell out
// the full list here: several independent STUN servers for redundancy, plus any
// TURN server the player has supplied themselves.

// A player can paste their own TURN credentials (e.g. a free Metered or Cloudflare
// account) to make the direct connection work on hostile networks. Stored locally;
// never sent anywhere but to their own TURN server.
// Validate the shape before it ever reaches an RTCPeerConnection: a malformed
// entry would make the constructor throw, which would break EVERY connection
// (hosting included) with no way out but clearing site data.
export function savedTurn() {
  try {
    const raw = localStorage.getItem(TURN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    const list = Array.isArray(t && t.urls) ? t.urls : [t && t.urls];
    const urls = list.filter((u) => typeof u === 'string' && /^(turns?|stun):\S+$/.test(u.trim()));
    if (!urls.length) return null;
    const out = { urls: urls.length === 1 ? urls[0].trim() : urls.map((u) => u.trim()) };
    if (typeof t.username === 'string' && typeof t.credential === 'string') {
      out.username = t.username;
      out.credential = t.credential;
    }
    return out;
  } catch (_) { return null; }
}

export function saveTurn(turn) {
  try {
    if (!turn || !turn.urls) localStorage.removeItem(TURN_KEY);
    else localStorage.setItem(TURN_KEY, JSON.stringify(turn));
  } catch (_) { /* private browsing */ }
}

export function iceConfig() {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.nextcloud.com:443' },
  ];
  const turn = savedTurn();
  if (turn) iceServers.push(turn);
  return { iceServers, sdpSemantics: 'unified-plan' };
}

function defaultMakePeer(id) {
  const opts = { debug: 1, config: iceConfig() };
  try {
    return id ? new window.Peer(id, opts) : new window.Peer(opts);
  } catch (_) {
    // Belt and braces: if a custom ICE entry is still somehow unacceptable to
    // this browser, fall back to PeerJS's own defaults rather than failing to
    // create a peer at all.
    const bare = { debug: 1 };
    return id ? new window.Peer(id, bare) : new window.Peer(bare);
  }
}

// Reserved handshake messages travel on the same channel as game messages but
// are namespaced with `__t` so they never collide with engine message `type`s.
const H = { JOIN: 'join', ACCEPT: 'accept', DENY: 'deny', FULL: 'full' };

// PeerJS reports failures as bare internal tokens ("network", "server-error",
// "socket-closed"…). Those must never reach a player as the whole message.
const FRIENDLY = {
  network: 'Lost contact with the matchmaking server. Check your connection and try again.',
  'server-error': 'The matchmaking server had a problem. Try again in a moment.',
  'socket-error': 'Couldn\'t reach the matchmaking server. Check your connection.',
  'socket-closed': 'Connection to the matchmaking server dropped. Try again.',
  'ssl-unavailable': 'Your browser blocked the secure connection needed for online play.',
  'browser-incompatible': 'This browser doesn\'t support online play. Try Chrome, Edge, Firefox or Safari.',
  'invalid-id': 'That room code isn\'t valid.',
  'invalid-key': 'Online play is misconfigured on this build.',
  webrtc: 'Your browser couldn\'t set up the connection.',
};
const friendly = (type) => FRIENDLY[type] || 'Connection problem — please try again.';

const BROKER_MS = 12000;   // no answer from the signalling server -> offline?
const CONNECT_MS = 9000;   // data channel never opened -> this network can't do P2P
const VERDICT_MS = 60000;  // host never answered the join request

// Create an online channel. `makePeer` is injectable for tests; it defaults to
// PeerJS in the browser. Returns an object with lifecycle callbacks.
export function createOnlineChannel({ makePeer, connectMs = CONNECT_MS } = {}) {
  const mkPeer = makePeer || defaultMakePeer;
  let peer = null;
  let conn = null;          // the ACTIVE (accepted) connection
  let opened = false;       // has the match connection been approved + opened
  let done = false;         // a terminal error has already been reported
  let myName = '';
  const cbs = { data: null, open: null, error: null, status: null, joinRequest: null, unreachable: null };
  const cleaners = new Set();   // per-connection timer teardown, run on close()
  // What we know about this attempt, for the "Connection details" readout.
  const diag = { role: null, code: null, peerId: null, broker: 'connecting', ice: null, candidates: [], note: null };

  function status(text) { if (!done) cbs.status && cbs.status(text); }

  // Report a terminal failure exactly once — a late timer must never overwrite an
  // earlier, more accurate message (e.g. "no room with that code" being replaced
  // by a generic timeout fifteen seconds later).
  function fail(type, message) {
    if (done) return;
    done = true;
    cbs.error && cbs.error({ type, message });
  }

  // "This network can't make a direct connection." If someone is listening for
  // that (channel.js, to fail over to the relay) hand it to them instead of
  // surfacing an error to the player.
  function unreachable(why) {
    if (done) return;
    diag.note = why;
    if (cbs.unreachable) { done = true; cbs.unreachable(why); return; }
    fail('timeout', 'Couldn\'t make a direct connection to that room. Your network may be blocking it.');
  }

  const softClose = (c) => { try { c.close(); } catch (_) {} };

  // Watch the underlying RTCPeerConnection so we can tell a blocked network apart
  // from a wrong room code, and show the player what actually happened. PeerJS
  // attaches `peerConnection` to the DataConnection during negotiation, so poll
  // briefly for it rather than assuming it is there already.
  function watchIce(c, tries = 0) {
    const pc = c && c.peerConnection;
    if (!pc) {
      if (tries < 30) setTimeout(() => watchIce(c, tries + 1), 200);
      return;
    }
    const note = () => {
      diag.ice = pc.iceConnectionState;
      if (pc.iceConnectionState === 'failed') unreachable('ICE failed — no usable network path.');
    };
    try {
      pc.addEventListener('iceconnectionstatechange', note);
      pc.addEventListener('icecandidate', (e) => {
        const t = e && e.candidate && e.candidate.type;
        if (t && !diag.candidates.includes(t)) diag.candidates.push(t);
      });
      note();
    } catch (_) { /* older shim */ }
  }

  // HOST side: a guest connected, but the match only starts once the host
  // approves the guest's join request. A second guest to an occupied room is
  // told the room is full.
  function wireHostConn(c) {
    let prompted = false;      // only prompt once per connection (JOIN may repeat)
    let settled = false;       // has this connection been accepted/denied
    watchIce(c);

    function askApproval(name) {
      if (prompted || settled) return;
      prompted = true;
      const accept = () => {
        if (done) return;          // this attempt was already abandoned
        settled = true;
        stop();
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
    // on "Player joining…" forever. If an OPEN connection sits silent, prompt
    // anyway — the guest is waiting for a verdict and will proceed once accepted.
    // A connection that never opened is a different story: that guest cannot hear
    // us and is already failing over to the relay, so prompting for it would raise
    // a ghost request and then a second, real one moments later.
    const fallback = setTimeout(() => {
      if (!prompted && !settled && !opened && c.open === true) {
        status('A player is waiting to join…');
        askApproval('A player');
      }
    }, 6000);

    // PeerJS announces a connection when the OFFER arrives, long before (or
    // without) the data channel opening. If it never opens, this guest cannot
    // hear us and is failing over to the relay — so stop saying "Player joining…"
    // and go back to advertising the room.
    const idle = setTimeout(() => {
      if (!settled && !opened && c.open !== true) {
        status('Room ready — share your code.');
        softClose(c);
      }
    }, connectMs + 3000);
    const stop = () => { clearTimeout(fallback); clearTimeout(idle); };
    cleaners.add(stop);

    c.on('data', (d) => {
      if (d && d.__t === H.JOIN) {
        clearTimeout(idle);
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
      stop();
      if (c === conn && opened) {
        opened = false;
        status('Opponent disconnected.');
        fail('closed', 'Connection closed.');
      }
    });
    c.on('error', (err) => {
      stop();
      if (c === conn) fail('conn', String((err && err.message) || err));
    });
  }

  // GUEST side: once the data channel opens, ask to join and await the verdict.
  function wireGuestConn(c) {
    conn = c;   // tentative — not "opened" until the host accepts
    let pending = [];   // game data that somehow arrives before ACCEPT is processed
    let verdict = false;
    let joinTimer = null, giveUp = null, openTimer = null;
    const stopTimers = () => { clearInterval(joinTimer); clearTimeout(giveUp); clearTimeout(openTimer); };
    cleaners.add(stopTimers);
    const sendJoin = () => { if (c.open !== false) { try { c.send({ __t: H.JOIN, name: myName }); } catch (_) {} } };
    watchIce(c);

    // The data channel never opening is the signature of a network that can't do
    // peer-to-peer at all. Don't sit on "Connecting…" — say so (or hand over to
    // the relay) while the player is still watching.
    openTimer = setTimeout(() => {
      if (!verdict && c.open === false) {
        stopTimers();
        unreachable('The data channel never opened' + (diag.ice ? ` (ICE: ${diag.ice})` : '') + '.');
      }
    }, connectMs);

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
          fail('timeout', 'No response from the host — they may not have answered your request. Try again.');
        }
      }, VERDICT_MS);
    });
    c.on('data', (d) => {
      if (d && d.__t === H.ACCEPT) {
        verdict = true; stopTimers();
        if (done) return;          // a late yes to an attempt we already gave up on
        opened = true; status('Connected!');
        cbs.open && cbs.open();
        // Flush anything (e.g. the roster) that raced ahead of the accept so it is
        // never silently dropped — this is the guest's ONLY setup-entry trigger.
        const q = pending; pending = [];
        for (const m of q) cbs.data && cbs.data(m);
        return;
      }
      if (d && d.__t === H.DENY) { verdict = true; stopTimers(); fail('denied', 'The host declined your request to join.'); return; }
      if (d && d.__t === H.FULL) { verdict = true; stopTimers(); fail('full', 'That room is already full.'); return; }
      if (opened) cbs.data && cbs.data(d);
      else if (d && !d.__t) pending.push(d);   // buffer game data until accepted
    });
    c.on('close', () => {
      stopTimers();
      if (opened) {
        opened = false;
        status('Opponent disconnected.');
        fail('closed', 'Connection closed.');
      } else if (!verdict) {
        fail('closed', 'The room closed before you got in. Ask the host to create a new room.');
      }
    });
    c.on('error', (err) => {
      stopTimers();
      fail('conn', String((err && err.message) || err));
    });
  }

  // PeerJS drops its signalling socket on network blips, laptop sleep and
  // background-tab throttling. Without reconnecting, a host's room silently stops
  // accepting guests while the page still says "Room ready".
  function keepAlive(p) {
    p.on('disconnected', () => {
      if (done) return;
      diag.broker = 'reconnecting';
      status('Reconnecting…');
      try { p.reconnect(); } catch (_) {}
    });
  }

  return {
    onData(fn) { cbs.data = fn; },
    onOpen(fn) { cbs.open = fn; },
    onError(fn) { cbs.error = fn; },
    onStatus(fn) { cbs.status = fn; },
    // Host: called with (guestName, { accept, deny }) when a guest asks to join.
    onJoinRequest(fn) { cbs.joinRequest = fn; },
    // Called instead of onError when this network simply cannot make a direct
    // connection, so a caller can fall back to another transport.
    onUnreachable(fn) { cbs.unreachable = fn; },

    // What happened, in the player's own words — shown behind "Connection details".
    diagnostics() {
      return {
        transport: 'direct (peer-to-peer)',
        role: diag.role, code: diag.code, peerId: diag.peerId,
        broker: diag.broker, ice: diag.ice || 'not started',
        candidates: diag.candidates.length ? diag.candidates.join(', ') : 'none seen',
        turn: savedTurn() ? 'custom TURN configured' : 'no TURN server',
        note: diag.note || '',
      };
    },

    // Host a room. `code` is supplied by the caller so both transports can share
    // one code; omit it for a fresh random one. Calls back once the peer is ready.
    host(code, onCode) {
      if (typeof code === 'function') { onCode = code; code = null; }
      if (!makePeer && !peerAvailable()) { fail('unsupported', 'Online play needs an internet connection.'); return; }
      const room = code || randomCode();
      diag.role = 'host'; diag.code = room;
      status('Creating room…');
      // Hold this attempt's peer in a local, so a late event from a peer we have
      // already discarded can never tear down the one that replaced it.
      const p = mkPeer(ID_PREFIX + room);
      peer = p;
      const brokerTimer = setTimeout(() => {
        if (diag.broker === 'connecting') fail('broker', 'Couldn\'t reach the matchmaking server. Check your connection and try again.');
      }, BROKER_MS);
      cleaners.add(() => clearTimeout(brokerTimer));
      p.on('open', () => {
        clearTimeout(brokerTimer);
        diag.broker = 'connected'; diag.peerId = p.id;
        status('Room ready — share your code.');
        onCode && onCode(room);
      });
      p.on('connection', (c) => { status('Player joining…'); wireHostConn(c); });
      keepAlive(p);
      p.on('error', (err) => {
        const msg = String((err && err.type) || err);
        // The room code is already in use on the shared broker. When the caller
        // chose the code (so another transport is advertising it too) report it
        // and let them pick a new one; otherwise just re-roll here.
        if (msg === 'unavailable-id') {
          clearTimeout(brokerTimer);
          try { p.destroy(); } catch (_) {}
          if (code) { fail('taken', 'That room code is already in use.'); return; }
          if (peer === p) return this.host(null, onCode);
          return;
        }
        if (msg === 'peer-unavailable') return;     // a guest vanished; not fatal to the room
        if (peer !== p) return;                     // a ghost of a discarded attempt
        clearTimeout(brokerTimer);
        fail('peer', friendly(msg));
      });
    },

    // Join a room by code. `name` is sent with the join request.
    join(code, name) {
      if (!makePeer && !peerAvailable()) { fail('unsupported', 'Online play needs an internet connection.'); return; }
      myName = String(name || '').slice(0, 14);
      const clean = String(code || '').trim().toUpperCase();
      if (!clean) { fail('code', 'Enter a room code.'); return; }
      diag.role = 'guest'; diag.code = clean;
      status('Connecting to room…');
      const p = mkPeer();
      peer = p;
      const brokerTimer = setTimeout(() => {
        if (diag.broker === 'connecting') fail('broker', 'Couldn\'t reach the matchmaking server. Check your connection and try again.');
      }, BROKER_MS);
      cleaners.add(() => clearTimeout(brokerTimer));
      p.on('open', () => {
        clearTimeout(brokerTimer);
        diag.broker = 'connected'; diag.peerId = p.id;
        wireGuestConn(p.connect(ID_PREFIX + clean, { reliable: true }));
      });
      keepAlive(p);
      p.on('error', (err) => {
        const t = String((err && err.type) || err);
        if (peer !== p) return;                     // a ghost of a discarded attempt
        clearTimeout(brokerTimer);
        // No such room is a REAL answer — report it straight away so no later
        // timeout can replace it with a vaguer message.
        if (t === 'peer-unavailable') { fail('nosuchroom', 'No room found with that code. Check it and try again.'); return; }
        fail('peer', friendly(t));
      });
    },

    send(msg) {
      if (conn && opened) {
        try { conn.send(msg); } catch (e) { /* ignore transient send errors */ }
      }
    },

    isOpen() { return opened; },

    close() {
      done = true;
      // Stop every timer this attempt armed. They are harmless once `done` is
      // set, but an abandoned attempt should not keep waking up for a minute.
      for (const fn of cleaners) { try { fn(); } catch (_) {} }
      cleaners.clear();
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
