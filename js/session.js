// session.js
// Remembers an online game across a page reload.
//
// Everything the game knows lives in memory, so refreshing the tab used to end
// the match: your board, your secret, your deductions and the log all went, and
// closing the page dropped the connection, which showed your opponent that you
// had left. People refresh by accident, phones reload tabs on their own, and a
// dropped match is a bad way to find that out.
//
// What goes in here is only ever your OWN side of the game. Your secret is yours
// already, so storing it tells you nothing you did not know, and the opponent's
// secret is not in the state until the game reveals it anyway.
//
// sessionStorage rather than localStorage on purpose: it is per tab and goes
// when the tab does, so a finished game cannot come back to haunt a later one,
// and two tabs can hold two different games.

const KEY = 'gw-session-v1';
const MAX_AGE_MS = 3 * 60 * 60 * 1000;   // an abandoned game stops offering to resume

function store() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch (_) {
    return null;    // private browsing can throw on access alone
  }
}

export function saveSession(data) {
  const s = store();
  if (!s || !data || !data.code) return false;
  try {
    s.setItem(KEY, JSON.stringify({ ...data, savedAt: Date.now() }));
    return true;
  } catch (_) {
    return false;   // quota, or storage disabled; the game just will not resume
  }
}

// Returns the saved game, or null if there isn't one worth offering. `now` is
// injectable so the staleness rule can be tested without waiting hours.
export function loadSession({ now = () => Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const s = store();
  if (!s) return null;
  let raw;
  try { raw = s.getItem(KEY); } catch (_) { return null; }
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch (_) { clearSession(); return null; }
  if (!data || typeof data !== 'object') { clearSession(); return null; }
  if (!data.code || !data.engine || !data.engine.phase) { clearSession(); return null; }
  // A game that already ended has nothing to go back to.
  if (data.engine.phase === 'over') { clearSession(); return null; }
  if (!Number.isFinite(data.savedAt) || now() - data.savedAt > maxAgeMs) { clearSession(); return null; }
  return data;
}

export function clearSession() {
  const s = store();
  if (!s) return;
  try { s.removeItem(KEY); } catch (_) { /* nothing we can do */ }
}
