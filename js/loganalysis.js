// loganalysis.js
// Pure helpers for the end-game activity log. Kept dependency-light (only the
// trait labels) so they can be unit-tested without a browser.
import { TRAIT_LABELS } from './characters.js';

// Given a set of characters (e.g. the cards someone crossed off in one turn),
// return their "common features". Two kinds are detected:
//   • kind:'is'  — every card shares the SAME value (e.g. all have Glasses: None).
//   • kind:'not' — every card LACKS exactly one value that exists in the board's
//                  value-space for that trait (e.g. none have Brown eyes, though
//                  their eye colours otherwise differ). This is how a deduction
//                  like "cross off everyone WITHOUT brown eyes" reads.
// `boardValues` maps a trait -> the set/array of values present on the board the
// batch was drawn from (the value-space the deduction distinguishes within); it
// enables the 'not' kind. Omit it for positive-only detection.
// Each entry is { trait, label, kind, value, valueLabel }. [] for an empty batch.
export function commonTraits(cards, boardValues) {
  if (!cards || !cards.length) return [];
  const out = [];
  for (const [key, meta] of Object.entries(TRAIT_LABELS)) {
    const present = new Set();
    let ok = true;
    for (const c of cards) { const v = c[key]; if (v == null) { ok = false; break; } present.add(v); }
    if (!ok || present.size === 0) continue;

    if (present.size === 1) {
      const v = [...present][0];
      out.push({ trait: key, label: meta.name, kind: 'is', value: v, valueLabel: meta.values[v] || String(v) });
      continue;
    }
    // Shared absence: the batch spans all-but-one of the board's values for this
    // trait, i.e. there is exactly one board value none of them have.
    const ref = boardValues && boardValues[key];
    if (ref) {
      const absent = [...ref].filter((v) => !present.has(v));
      if (absent.length === 1) {
        const v = absent[0];
        out.push({ trait: key, label: meta.name, kind: 'not', value: v, valueLabel: meta.values[v] || String(v) });
      }
    }
  }
  return out;
}

// Human-readable one-liner, e.g. "Glasses: None · Eye colour: not Brown", or
// "no shared traits".
export function commonTraitsText(cards, boardValues) {
  const shared = commonTraits(cards, boardValues);
  if (!shared.length) return 'no shared traits';
  return shared.map((t) => (t.kind === 'not' ? `${t.label}: not ${t.valueLabel}` : `${t.label}: ${t.valueLabel}`)).join(' · ');
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
