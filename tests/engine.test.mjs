// Engine tests — run with:  node --test
// Cross-wires two engines (host + guest) exactly like the real transport and
// walks full games to verify setup, turns, disable/guess rules, and win logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../js/engine.js';

// Wire two engines together so each one's outbound messages reach the other.
function pair() {
  const A = createEngine({ isHost: true, myName: 'A' });
  const B = createEngine({ isHost: false, myName: 'B' });
  A.on('send', (m) => B.handleMessage(m));
  B.on('send', (m) => A.handleMessage(m));
  return { A, B };
}

const first20 = Array.from({ length: 20 }, (_, i) => i + 1); // ids 1..20

function setupBoth(A, B, aSecret = 3, bSecret = 7) {
  A.setupLocal({ board: first20, secret: aSecret });
  B.setupLocal({ board: first20, secret: bSecret });
}

test('setup rejects wrong board size', () => {
  const { A } = pair();
  const res = A.setupLocal({ board: [1, 2, 3], secret: 1 });
  assert.equal(res.ok, false);
});

test('setup rejects secret not on board', () => {
  const { A } = pair();
  const res = A.setupLocal({ board: first20, secret: 99 });
  assert.equal(res.ok, false);
});

test('setup rejects duplicate cards', () => {
  const { A } = pair();
  const dup = [...first20.slice(0, 19), 1];
  const res = A.setupLocal({ board: dup, secret: 1 });
  assert.equal(res.ok, false);
});

test('both setups begin play with host first', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  assert.equal(A.state.phase, 'play');
  assert.equal(B.state.phase, 'play');
  assert.equal(A.state.turn, 'me');   // host goes first
  assert.equal(B.state.turn, 'opp');
  assert.equal(A.state.oppName, 'B');
  assert.equal(B.state.oppName, 'A');
});

test('cannot act out of turn', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  assert.equal(B.beginDisable(), false);   // not B's turn
  assert.equal(B.beginGuess(), false);
  assert.equal(B.endTurn(), false);
});

test('disable mode blocks guessing, and vice versa', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  assert.equal(A.beginDisable(), true);
  assert.equal(A.state.turnMode, 'disable');
  assert.equal(A.beginGuess(), false);     // locked out
  // toggling a card crosses it out
  assert.equal(A.toggleCard(5), true);
  assert.equal(A.state.deduction[5], false);
});

test('guess mode blocks disabling', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  assert.equal(A.beginGuess(), true);
  assert.equal(A.state.turnMode, 'guess');
  assert.equal(A.toggleCard(5), false);
  assert.equal(A.beginDisable(), false);
});

test('ending a turn reports counts and passes play', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  A.beginDisable();
  A.toggleCard(5); A.toggleCard(6); A.toggleCard(7);
  A.endTurn();
  assert.equal(A.state.turn, 'opp');
  assert.equal(B.state.turn, 'me');
  // B now sees A's progress: 17 open, 3 closed.
  assert.equal(B.state.oppOpen, 17);
  assert.equal(B.state.oppClosed, 3);
  assert.equal(B.state.turnNumber >= 1, true);
});

test('correct guess wins for guesser, reveals secrets', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);              // B's secret is 7
  A.beginGuess();
  assert.equal(A.makeGuess(7), true);
  assert.equal(A.state.phase, 'over');
  assert.equal(B.state.phase, 'over');
  assert.equal(A.state.winner, 'me');
  assert.equal(B.state.winner, 'opp');
  // secrets revealed both ways
  assert.equal(A.state.oppSecret, 7);
  assert.equal(B.state.oppSecret, 3);
});

test('wrong guess loses for guesser', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);
  A.beginGuess();
  A.makeGuess(9);                    // wrong (B's secret is 7)
  assert.equal(A.state.winner, 'opp');
  assert.equal(B.state.winner, 'me');
});

test('cannot guess a card outside the opponent board', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  A.beginGuess();
  assert.equal(A.makeGuess(25), false);  // 25 is not on B's board (1..20)
  assert.equal(A.state.phase, 'play');
});

test('rematch resets both engines to setup', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);
  A.beginGuess(); A.makeGuess(7);
  A.requestRematch();
  assert.equal(A.state.phase, 'setup');
  assert.equal(B.state.phase, 'setup');
  assert.equal(A.state.winner, null);
  assert.equal(A.state.oppSecret, null);
});

test('a full multi-turn game plays through', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);
  // A disables some, ends turn
  A.beginDisable(); A.toggleCard(1); A.toggleCard(2); A.endTurn();
  // B disables some, ends turn
  B.beginDisable(); B.toggleCard(10); B.endTurn();
  assert.equal(A.state.turn, 'me');
  assert.equal(A.state.oppOpen, 19); // B crossed out 1
  // A guesses correctly
  A.beginGuess(); A.makeGuess(7);
  assert.equal(A.state.winner, 'me');
});
