// In-memory fake of the ntfy.sh pub/sub surface we use (POST /<topic> to publish,
// GET /<topic>/sse to stream, GET /<topic>/json?poll=1 to catch up), so the relay
// transport and the room feed can be tested without a network.
export const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await flush(5); }
  return pred();
}

export function createFakeNtfy({ base = 'https://ntfy.sh' } = {}) {
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
    const t = topic(name);
    const msg = { id: 'm' + (++idc), time: 0, event: 'message', topic: name, message: String(opts.body) };
    t.msgs.push(msg);
    for (const fn of [...t.subs]) setTimeout(() => fn(msg), 0);
    return { ok: true, status: 200, text: async () => '' };
  };

  class FakeEventSource {
    constructor(url) {
      this.name = nameOf(url);
      this.onmessage = null;
      this.onerror = null;
      this._h = (m) => { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); };
      topic(this.name).subs.add(this._h);
    }
    close() { topic(this.name).subs.delete(this._h); }
  }

  return { fetchImpl, EventSourceImpl: FakeEventSource, topics, postCount: () => posts };
}
