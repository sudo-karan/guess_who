// loganalysis.js
// Pure helpers for the end-game activity log. Kept dependency-light (only the
// trait labels) so they can be unit-tested without a browser.
import { TRAIT_LABELS } from './characters.js';

// Given a set of characters (e.g. the cards someone crossed off in one turn),
// return the traits whose value is identical across ALL of them — the "common
// features" of that batch. Each entry is { trait, label, value, valueLabel }.
// Returns [] for an empty batch. For a single card every trait is trivially
// shared; callers decide how to phrase that.
export function commonTraits(cards) {
  if (!cards || !cards.length) return [];
  const out = [];
  for (const [key, meta] of Object.entries(TRAIT_LABELS)) {
    const first = cards[0][key];
    if (first == null) continue;
    if (cards.every((c) => c[key] === first)) {
      out.push({ trait: key, label: meta.name, value: first, valueLabel: meta.values[first] || String(first) });
    }
  }
  return out;
}

// Human-readable one-liner for a batch's common features, e.g.
// "Glasses = None · Hair colour = Black" or "no shared traits".
export function commonTraitsText(cards) {
  const shared = commonTraits(cards);
  if (!shared.length) return 'no shared traits';
  return shared.map((t) => `${t.label} = ${t.valueLabel}`).join(' · ');
}

// Group a flat, chronological list of log events into per-turn buckets, each
// { turn, events }, ordered by turn then original order. Used to render the
// end-game transcript turn by turn.
export function groupByTurn(events) {
  const order = [];
  const byTurn = new Map();
  for (const ev of events || []) {
    const t = ev.turn == null ? 0 : ev.turn;
    if (!byTurn.has(t)) { byTurn.set(t, []); order.push(t); }
    byTurn.get(t).push(ev);
  }
  return order.sort((a, b) => a - b).map((t) => ({ turn: t, events: byTurn.get(t) }));
}
