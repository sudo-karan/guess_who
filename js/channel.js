// channel.js
// The online channel the app actually uses: a direct peer-to-peer connection when
// the two networks allow one, and an automatic fallback to the HTTPS relay when
// they don't.
//
// Why: a direct WebRTC data channel is private and fast, but it needs a network
// path between the two browsers. Plenty of ordinary networks — Wi-Fi with client
// isolation, mobile data behind carrier-grade NAT, anything that blocks UDP —
// have no such path, and the usual cure (a TURN relay) is not available to a
// static site for free any more. Rather than tell the player "couldn't connect",
// we try direct first and quietly switch to the relay when it doesn't come up.
//
//   HOST  listens on BOTH transports at once under one room code, and drops the
//         loser as soon as a guest arrives on either.
//   GUEST tries direct for a few seconds, then abandons it and asks over the
//         relay. Only ever one outstanding join request, so the host is never
//         prompted twice for the same person.
//
// Presents exactly the interface createOnlineChannel() does, so app.js is
// transport-agnostic.

import { createOnlineChannel, randomCode, peerAvailable } from './net.js';
import { createRelayChannel, relayAvailable } from './relay.js';

const HOST_RETRIES = 3;       // room-code collisions on the shared broker

export function createGameChannel({ makePeer, relayOpts, makeDirect, makeRelay } = {}) {
  const mkDirect = makeDirect || (() => createOnlineChannel({ makePeer }));
  const mkRelay = makeRelay || (() => createRelayChannel(relayOpts || {}));
  // An injected relay factory (tests) counts as available even where the browser
  // globals it would otherwise need are absent.
  const canRelay = () => !!makeRelay || !!relayOpts || relayAvailable();
  const canDirect = () => !!makeDirect || !!makePeer || peerAvailable();

  let direct = null, relay = null;
  let active = null;          // the transport that won
  let directDead = false;     // the broker failed; only the relay can carry this room
  let opened = false;
  let done = false;           // terminal error already reported
  let mode = 'direct';        // 'direct' | 'relay'
  const cbs = { data: null, open: null, error: null, status: null, joinRequest: null, healthy: null };

  const status = (t) => { if (!done) cbs.status && cbs.status(t); };

  // Recoverable trouble must NOT latch the channel shut. It used to: the first
  // error of any kind set `done`, so after one harmless blip a genuine departure
  // was never reported at all and the player sat in a game nobody was in.
  const RECOVERABLE = ['peer', 'broker', 'relay', 'ratelimited', 'conn', 'timeout', 'unsent'];
  let lastSoft = '';
  const fail = (type, message) => {
    if (done) return;
    if (RECOVERABLE.includes(type)) {
      if (lastSoft === type) return;            // don't repeat the same complaint
      lastSoft = type;
      cbs.error && cbs.error({ type, message });
      return;
    }
    done = true;
    cbs.error && cbs.error({ type, message });
  };
  const recovered = () => { lastSoft = ''; cbs.healthy && cbs.healthy(); };

  const shut = (c) => { if (c) { try { c.close(); } catch (_) {} } };

  // Point one transport's callbacks at ours. `claim` makes this transport the
  // active one and drops the other — which is why it must happen ONLY when this
  // transport has actually opened (see onOpen below), never merely because the
  // host clicked Approve. An accept can decline to commit (the guest's direct
  // connection died while the host deliberated), and claiming first would have
  // already torn down the transport the guest is really on, leaving the host
  // listening on nothing with no error shown.
  function wire(ch, label, claim) {
    if (ch.onHealthy) ch.onHealthy(() => { if (!active || active === ch) recovered(); });
    ch.onData((m) => { if (active === ch) cbs.data && cbs.data(m); });
    ch.onStatus((t) => { if (!active || active === ch) status(label ? `${label} ${t}` : t); });
    ch.onJoinRequest((who, ctl) => {
      if (opened && active !== ch) { ctl.deny(); return; }   // already playing elsewhere
      const accept = () => {
        // Re-checked here as well as on arrival: approvals are serialised through
        // one modal queue, so this can be answered long after the room filled up
        // on the other transport.
        if (opened && active !== ch) { ctl.deny(); return; }
        ctl.accept();
        // Both transports call back into onOpen synchronously from a successful
        // accept. If nothing opened, the accept quietly committed nothing — say
        // so rather than leaving the host staring at an unchanged screen.
        if (!opened) status('That player had already left. The room is still open.');
      };
      if (cbs.joinRequest) cbs.joinRequest(who, { accept, deny: () => ctl.deny() });
      else accept();
    });
    ch.onOpen(() => {
      if (opened && active !== ch) { shut(ch); return; }
      claim();
      opened = true;
      cbs.open && cbs.open();
    });
  }

  /* -------------------------------- host -------------------------------- */

  function startHost(onCode, attempt) {
    const code = randomCode();
    direct = mkDirect();
    let settled = false;

    const claimDirect = () => { active = direct; mode = 'direct'; shut(relay); relay = null; };
    wire(direct, '', claimDirect);
    direct.onError((e) => {
      // A code collision on the shared broker: roll a new one so BOTH transports
      // keep advertising the same room code.
      if (e.type === 'taken' && !settled && attempt < HOST_RETRIES) {
        shut(direct); direct = null;
        startHost(onCode, attempt + 1);
        return;
      }
      if (active === direct || opened) { fail(e.type, e.message); return; }
      // The broker is unreachable but the relay can still carry the whole game.
      directDead = true;
      if (!settled) { settled = true; openRelayHost(code, onCode); }
    });

    direct.host(code, (finalCode) => {
      if (settled) return;
      settled = true;
      openRelayHost(finalCode, onCode);
    });
  }

  function openRelayHost(code, onCode) {
    if (canRelay()) {
      relay = mkRelay();
      wire(relay, 'Relay:', () => { active = relay; mode = 'relay'; shut(direct); direct = null; });
      // Without this the host's relay failures went nowhere at all: a throttled or
      // dead relay subscription left the room silently deaf to join requests while
      // it carried on advertising itself as open.
      relay.onError((e) => {
        if (opened && active === relay) { fail(e.type, e.message); return; }  // a live game died
        if (opened) return;                        // playing over direct; relay is moot
        if (!directDead) {                         // the direct route may still work
          status('Relay unavailable, but a direct connection can still get through.');
          return;
        }
        fail(e.type, e.message);                   // nothing left to listen on
      });
      relay.host(code);
    }
    onCode && onCode(code);
  }

  /* -------------------------------- join -------------------------------- */

  function startJoin(code, name) {
    direct = mkDirect();
    let switched = false;

    const toRelay = (why) => {
      if (switched || opened || done) return;
      switched = true;
      shut(direct); direct = null;
      if (!canRelay()) {
        fail('timeout', 'Couldn\'t connect to that room. Your network may be blocking it.');
        return;
      }
      mode = 'relay';
      status('Direct connection blocked, connecting through the relay…');
      relay = mkRelay();
      wire(relay, '', () => { active = relay; });
      relay.onError((e) => {
        if (e.type === 'timeout') { fail('timeout', 'No room found with that code, or the host has left. Check the code and try again.'); return; }
        fail(e.type, e.message);
      });
      relay.join(code, name);
    };

    wire(direct, '', () => { active = direct; });
    // A network that can't do peer-to-peer, or a host that only ever came up on
    // the relay (its broker registration failed) — both mean: try the relay.
    direct.onUnreachable(toRelay);
    direct.onError((e) => {
      if (e.type === 'nosuchroom' || e.type === 'broker' || e.type === 'peer') { toRelay(e.message); return; }
      fail(e.type, e.message);
    });
    direct.join(code, name);
  }

  /* --------------------------------- api -------------------------------- */

  return {
    onData(fn) { cbs.data = fn; },
    onOpen(fn) { cbs.open = fn; },
    onError(fn) { cbs.error = fn; },
    onStatus(fn) { cbs.status = fn; },
    onJoinRequest(fn) { cbs.joinRequest = fn; },
    // Called when reported trouble has cleared and the transport is working again.
    onHealthy(fn) { cbs.healthy = fn; },

    host(onCode) {
      if (!canDirect() && !canRelay()) {
        fail('unsupported', 'Online play needs an internet connection.');
        return;
      }
      startHost(onCode, 0);
    },

    join(code, name) {
      const clean = String(code || '').trim().toUpperCase();
      if (!clean) { fail('code', 'Enter a room code.'); return; }
      if (!canDirect() && !canRelay()) {
        fail('unsupported', 'Online play needs an internet connection.');
        return;
      }
      startJoin(clean, name);
    },

    send(msg) { if (active) active.send(msg); },
    isOpen() { return opened; },
    mode() { return mode; },

    // Merged connection details for the "Connection details" readout. Both halves
    // matter: the direct half explains why peer-to-peer failed, the relay half
    // explains whether the fallback is actually carrying anything.
    diagnostics() {
      const d = (direct && direct.diagnostics && direct.diagnostics()) || {};
      const r = (relay && relay.diagnostics && relay.diagnostics()) || {};
      return {
        transport: mode === 'relay' ? 'relay (over HTTPS)' : (d.transport || 'direct (peer-to-peer)'),
        ...d,
        ...r,
        listeningOn: [direct ? 'direct' : null, relay ? 'relay' : null].filter(Boolean).join(' + ') || 'nothing',
      };
    },

    close() {
      done = true; opened = false;
      shut(direct); shut(relay);
      direct = relay = active = null;
    },
  };
}
