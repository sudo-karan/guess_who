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

// Net card batches per turn per actor. Replays each actor's card events in order
// and reports, for each turn, only the cards whose state NET-changed that turn:
// on->off goes in `off`, off->on goes in `on`. A card crossed off then brought
// back within the same turn (net zero) is NOT listed — matching the engine's
// per-turn count (which diffs against the turn-start state). Returns
// { [turn]: { [by]: { off:[ids], on:[ids] } } }.
export function netBatchesByTurnActor(cardEvents) {
  const result = {};
  const actors = [...new Set((cardEvents || []).map((e) => e.by))];
  for (const by of actors) {
    const byTurn = new Map();
    for (const e of (cardEvents || []).filter((e2) => e2.by === by)) {
      if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
      byTurn.get(e.turn).push(e);
    }
    const st = new Map();                       // cardId -> isOff (persists across turns)
    for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
      const evs = byTurn.get(turn).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const start = new Map();                  // touched card -> its state at turn start
      for (const e of evs) if (!start.has(e.cardId)) start.set(e.cardId, st.get(e.cardId) || false);
      for (const e of evs) st.set(e.cardId, e.action === 'off');
      const off = [], on = [];
      for (const [cardId, wasOff] of start) {
        const nowOff = st.get(cardId) || false;
        if (!wasOff && nowOff) off.push(cardId);
        else if (wasOff && !nowOff) on.push(cardId);
      }
      if (off.length || on.length) (result[turn] = result[turn] || {})[by] = { off, on };
    }
  }
  return result;
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
