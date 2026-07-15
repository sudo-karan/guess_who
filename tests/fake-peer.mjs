// In-memory fake of the PeerJS signalling + data-channel behaviour, for testing
// online code paths (which can't reach a real WebRTC broker in CI). Models: id
// claiming, id-collision + peer-unavailable errors, connecting, ordered message
// passing, and connection close propagation (including on peer.destroy()).
export const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Poll until pred() is truthy — robust to CPU contention stretching timers.
export async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await flush(10); }
  return pred();
}

export function createFakeBroker() {
  const claimed = new Map();       // id -> peer
  let idc = 0;
  const later = (fn) => setTimeout(fn, 0);

  function makeConn(remoteId) {
    const h = {};
    let closed = false;
    const c = {
      peer: remoteId,
      other: null,
      on(ev, fn) { (h[ev] || (h[ev] = [])).push(fn); return c; },
      emit(ev, a) { (h[ev] || []).forEach((fn) => fn(a)); },
      send(msg) { later(() => c.other && c.other.emit('data', msg)); },
      _shutdown() { if (closed) return; closed = true; c.emit('close'); },
      close() { later(() => { c._shutdown(); c.other && c.other._shutdown(); }); },
    };
    return c;
  }

  function makePeer(id) {
    const h = {};
    const myId = id || ('rand-' + (++idc));
    let destroyed = false;
    const conns = [];
    const peer = {
      get id() { return myId; },
      on(ev, fn) { (h[ev] || (h[ev] = [])).push(fn); return peer; },
      emit(ev, a) { (h[ev] || []).forEach((fn) => fn(a)); },
      connect(targetId) {
        const clientConn = makeConn(targetId);
        conns.push(clientConn);
        later(() => {
          const target = claimed.get(targetId);
          if (!target || destroyed) { peer.emit('error', { type: 'peer-unavailable' }); return; }
          const serverConn = makeConn(myId);
          target._track(serverConn);
          clientConn.other = serverConn; serverConn.other = clientConn;
          target.emit('connection', serverConn);
          later(() => { serverConn.emit('open'); clientConn.emit('open'); });
        });
        return clientConn;
      },
      _track(conn) { conns.push(conn); },
      destroy() {
        destroyed = true;
        if (claimed.get(myId) === peer) claimed.delete(myId);
        for (const c of conns.splice(0)) later(() => { c._shutdown(); c.other && c.other._shutdown(); });
      },
    };
    later(() => {
      if (destroyed) return;
      if (id && claimed.has(id)) peer.emit('error', { type: 'unavailable-id' });
      else { claimed.set(myId, peer); peer.emit('open', myId); }
    });
    return peer;
  }

  return { makePeer, claimed };
}
