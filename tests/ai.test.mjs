import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../js/engine.js';
import { generateRoster } from '../js/characters.js';
import {
  robotSetup, openCandidates, chooseQuestion, shouldGuess, cardsToCrossOff, pickGuess,
} from '../js/ai.js';

const roster = generateRoster();
const byId = Object.fromEntries(roster.map((c) => [c.id, c]));
const first20 = Array.from({ length: 20 }, (_, i) => i + 1);
// A deterministic RNG so probabilistic paths are reproducible.
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

test('robotSetup: 20 unique cards with a secret among them', () => {
  const { board, secret } = robotSetup(roster, seeded(1));
  assert.equal(board.length, 20);
  assert.equal(new Set(board).size, 20);
  assert.ok(board.includes(secret));
});

test('shouldGuess: always at one candidate; hard is patient', () => {
  assert.equal(shouldGuess(1, 'easy', seeded(1)), true);
  assert.equal(shouldGuess(1, 'hard', seeded(1)), true);
  assert.equal(shouldGuess(2, 'hard', seeded(1)), false);
  assert.equal(shouldGuess(5, 'hard', seeded(1)), false);
});

test('chooseQuestion: hard picks the most even split', () => {
  // Candidates 1..20; craft byId-like traits so one trait splits 10/10.
  const cands = first20;
  const b = {};
  for (const id of cands) b[id] = { hair: id <= 10 ? 'black' : 'blonde', eye: id <= 3 ? 'blue' : 'brown', style: 'short', skin: 'light', glasses: 'none', hat: 'none', beard: 'none', acc: 'none' };
  const q = chooseQuestion(cands, b, 'hard', seeded(1));
  // The 10/10 hair split is optimal (worst-case 10) vs the 3/17 eye split (worst 17).
  assert.equal(q.trait, 'hair');
  assert.equal(q.values.length, 1);
});

test('chooseQuestion: only returns splitting questions (1..n-1 matches)', () => {
  const cands = first20;
  const q = chooseQuestion(cands, byId, 'easy', seeded(7));
  assert.ok(q, 'should find a useful question');
  const m = cands.reduce((k, id) => k + (byId[id][q.trait] === q.values[0] ? 1 : 0), 0);
  assert.ok(m >= 1 && m <= cands.length - 1, `question splits (matched ${m})`);
});

test('cardsToCrossOff: a Yes keeps matches, a No keeps non-matches; the secret is never removed', () => {
  const cands = first20;
  const q = { trait: 'hair', values: [byId[5].hair] };
  const secret = 5;
  const yes = q.values.includes(byId[secret].hair);   // truthful answer for secret 5
  const removed = cardsToCrossOff(cands, q, yes, byId);
  assert.ok(!removed.includes(secret), 'the true secret is never crossed off by an honest answer');
  // Everything removed genuinely contradicts the answer.
  for (const id of removed) assert.notEqual(q.values.includes(byId[id].hair), yes);
});

test('pickGuess: returns a candidate (or null when empty)', () => {
  assert.ok(first20.includes(pickGuess(first20, seeded(3))));
  assert.equal(pickGuess([], seeded(3)), null);
});

// --- full-game simulation: the robot deduces YOUR secret and guesses it ---
function simulate(difficulty, humanSecret, rng) {
  const A = createEngine({ isHost: true, myName: 'You' });      // human
  const B = createEngine({ isHost: false, myName: 'Robot' });   // robot
  A.on('send', (m) => B.handleMessage(m));
  B.on('send', (m) => A.handleMessage(m));
  // Human answers the robot's questions truthfully from its own secret.
  A.on('question', ({ question }) => {
    const yes = question.values.includes(byId[A.state.mySecret][question.trait]);
    A.answerStructured(yes, 'a');
  });
  // Robot processes the human's answer: cross off, then end its turn.
  let pendingQ = null;
  B.on('answer', ({ yes }) => {
    const cands = openCandidates(B.state.deduction, B.state.oppBoard);
    for (const id of cardsToCrossOff(cands, pendingQ, yes, byId)) B.toggleCard(id);
    pendingQ = null;
    B.endTurn();
  });

  A.setupLocal({ board: first20, secret: humanSecret });
  B.setupLocal(robotSetup(roster, rng));   // robot's own board+secret (irrelevant to its deduction)

  let guard = 0;
  while (A.state.phase === 'play' && guard++ < 200) {
    if (A.state.turn === 'me') { A.endTurn(); continue; }        // human does nothing but pass
    const cands = openCandidates(B.state.deduction, B.state.oppBoard);
    if (shouldGuess(cands.length, difficulty, rng) || cands.length === 0) {
      B.beginGuess(); B.makeGuess(pickGuess(cands.length ? cands : B.state.oppBoard, rng));
    } else {
      pendingQ = chooseQuestion(cands, byId, difficulty, rng);
      if (!pendingQ) { B.beginGuess(); B.makeGuess(pickGuess(cands, rng)); }
      else B.askStructured(pendingQ, 'q');   // sync: A answers -> B crosses off + ends turn
    }
  }
  return { over: A.state.phase === 'over', lastGuess: A.state.lastGuess, turns: guard };
}

test('a hard robot always deduces and guesses YOUR secret correctly', () => {
  for (const secret of [1, 5, 11, 17, 20]) {
    const r = simulate('hard', secret, seeded(secret * 13 + 1));
    assert.ok(r.over, 'game ends');
    assert.equal(r.lastGuess.by, 'opp', 'the robot made the final guess');
    assert.equal(r.lastGuess.id, secret, `robot guessed the real secret (${secret})`);
    assert.equal(r.lastGuess.correct, true);
    assert.ok(r.turns < 40, `converges quickly (${r.turns} half-turns)`);
  }
});

test('easy and medium robots always finish a game (no softlock)', () => {
  for (const diff of ['easy', 'medium']) {
    for (let i = 0; i < 6; i++) {
      const r = simulate(diff, (i % 20) + 1, seeded(i * 101 + 5));
      assert.ok(r.over, `${diff} game ${i} ends`);
      assert.ok(first20.includes(r.lastGuess.id), 'guessed a real board card');
    }
  }
});
