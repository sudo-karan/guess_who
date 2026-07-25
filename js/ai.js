// ai.js
// A small deduction AI so you can play Guess Who solo against the computer.
// The robot deduces over YOUR board: it asks a trait question, crosses off the
// cards your (honest) answer rules out, and guesses once it's confident. All the
// decision logic here is pure + dependency-light so it can be unit-tested; the
// timing/animation and engine wiring live in app.js.
import { TRAIT_LABELS } from './characters.js';

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const matches = (char, q) => !!char && q.values.includes(char[q.trait]);

// The robot picks its own 20-card board + a secret (this is what YOU deduce over).
export function robotSetup(roster, rng = Math.random) {
  const ids = shuffle(roster.map((c) => c.id), rng);
  const board = ids.slice(0, 20);
  return { board, secret: pick(board, rng) };
}

// Ids still standing on the robot's deduction board (its guesses about YOUR secret).
export function openCandidates(deduction, oppBoard) {
  return (oppBoard || []).filter((id) => deduction[id] !== false);
}

// Every single-value question that would actually SPLIT the current candidates
// (matches between 1 and n-1 of them), with its match count.
function usefulQuestions(candidates, byId) {
  const n = candidates.length;
  const out = [];
  for (const [trait, meta] of Object.entries(TRAIT_LABELS)) {
    for (const value of Object.keys(meta.values)) {
      const m = candidates.reduce((k, id) => k + (byId[id] && byId[id][trait] === value ? 1 : 0), 0);
      if (m >= 1 && m <= n - 1) out.push({ trait, value, matchCount: m });
    }
  }
  return out;
}

// Choose the next question for the given difficulty. Returns {trait, values:[value]}
// or null when no question can split the field (time to guess).
export function chooseQuestion(candidates, byId, difficulty = 'medium', rng = Math.random) {
  const qs = usefulQuestions(candidates, byId);
  if (!qs.length) return null;
  const n = candidates.length;
  const toQ = (q) => ({ trait: q.trait, values: [q.value] });
  const worst = (q) => Math.max(q.matchCount, n - q.matchCount);   // worst-case remaining

  if (difficulty === 'easy') return toQ(pick(qs, rng));            // any useful question
  if (difficulty === 'hard') return toQ(qs.reduce((a, b) => (worst(b) < worst(a) ? b : a)));
  // medium: a reasonably even split (30–70%), else fall back to any useful one.
  const mid = qs.filter((q) => q.matchCount >= n * 0.3 && q.matchCount <= n * 0.7);
  return toQ(pick(mid.length ? mid : qs, rng));
}

// Should the robot guess now instead of asking? Harder = more patient (and so
// almost never guesses wrong); easier = impatient and risky.
export function shouldGuess(candidateCount, difficulty = 'medium', rng = Math.random) {
  if (candidateCount <= 1) return true;
  if (difficulty === 'easy' && candidateCount <= 3) return rng() < 0.35;
  if (difficulty === 'medium' && candidateCount === 2) return rng() < 0.4;
  return false;
}

// Which open candidates a yes/no answer to `question` rules out (to cross off).
export function cardsToCrossOff(candidates, question, answerYes, byId) {
  return candidates.filter((id) => matches(byId[id], question) !== answerYes);
}

// Pick a card to guess — the lone survivor if there is one, else a random candidate.
export function pickGuess(candidates, rng = Math.random) {
  if (!candidates || !candidates.length) return null;
  return pick(candidates, rng);
}
