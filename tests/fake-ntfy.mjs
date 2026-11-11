// In-memory fake of the ntfy.sh pub/sub surface we use (POST /<topic> to publish,
// GET /<topic>/sse to stream, GET /<topic>/json?poll=1 to catch up), so the relay
// transport and the room feed can be tested without a network.
export const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await flush(5); }
  return pred();
}

// `throttleAfter`: start answering publishes with 429 once this many have been
// made, mirroring ntfy.sh's per-IP rate limit.
export function createFakeNtfy({ base = 'https://ntfy.sh', throttleAfter = Infinity } = {}) {
  const topics = new Map();      // name -> { msgs: [], subs: Set<fn> }
  let idc = 0;
  let posts = 0;
  const topic = (name) => {
    if (!topics.has(name)) topics.set(name, { msgs: [], subs: new Set() });
    return topics.get(name);
  };
  const nameOf = (url) => String(url).slice(base.length + 1).split('?')[0].replace(/\/(sse|json)$/, '');

  const fetchImpl = async (url, opts = {}) => {
    const name = nameOf(url);
    if (String(url).includes('/json')) {
      const body = topic(name).msgs.map((m) => JSON.stringify(m)).join('\n');
      return { ok: true, status: 200, text: async () => body };
    }
    posts++;
    if (posts > throttleAfter) {
      return { ok: false, status: 429, text: async () => 'rate limited' };
    }
    const t = topic(name);
    const msg = { id: 'm' + (++idc), time: 0, event: 'message', topic: name, message: String(opts.body) };
    t.msgs.push(msg);
    for (const fn of [...t.subs]) setTimeout(() => fn(msg), 0);
    return { ok: true, status: 200, text: async () => '' };
  };

  const live = new Set();
  class FakeEventSource {
    constructor(url) {
      this.name = nameOf(url);
      this.readyState = 1;                   // OPEN
      this.onmessage = null;
      this.onerror = null;
      this.onopen = null;
      this._h = (m) => { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); };
      topic(this.name).subs.add(this._h);
      live.add(this);
      setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
    }
    // Mimic a browser giving up for good on an HTTP error: readyState CLOSED and
    // no automatic retry.
    _kill() {
      this.readyState = 2;                   // CLOSED
      topic(this.name).subs.delete(this._h);
      live.delete(this);
      if (this.onerror) this.onerror({});
    }
    close() { this.readyState = 2; topic(this.name).subs.delete(this._h); live.delete(this); }
  }

  return {
    fetchImpl,
    EventSourceImpl: FakeEventSource,
    topics,
    postCount: () => posts,
    // Kill every open subscription on a topic, as a 429'd reconnect would.
    killSubscriptions: (name) => { for (const es of [...live]) if (es.name === name) es._kill(); },
    liveCount: () => live.size,
  };
}
