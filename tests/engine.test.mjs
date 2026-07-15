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

test('cannot ask/guess/end out of turn, but may take private notes', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  assert.equal(B.askQuestion(), false);   // not B's turn
  assert.equal(B.beginGuess(), false);
  assert.equal(B.endTurn(), false);
  // ...but crossing cards off my own board is always allowed
  assert.equal(B.toggleCard(5), true);
  assert.equal(B.state.deduction[5], false);
});

test('disabling is free and never blocks guessing', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  assert.equal(A.toggleCard(5), true);     // no mode needed
  assert.equal(A.state.deduction[5], false);
  assert.equal(A.beginGuess(), true);      // still allowed after disabling
  assert.equal(A.toggleCard(6), true);     // and disabling still works mid-guess
});

test('asking a question blocks guessing this turn', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  assert.equal(A.askQuestion(), true);
  assert.equal(A.state.asked, true);
  assert.equal(A.beginGuess(), false);     // locked out after asking
  assert.equal(A.makeGuess(7), false);
});

test('asking a question notifies the opponent', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  let notified = null;
  B.on('ask', (name) => { notified = name; });
  A.askQuestion();
  assert.equal(notified, 'A');
});

test('the ask-lock clears on your next turn', () => {
  const { A, B } = pair();
  setupBoth(A, B);
  A.askQuestion(); A.endTurn();   // A asked, then ended the turn
  B.endTurn();                     // back to A
  assert.equal(A.state.asked, false);
  assert.equal(A.beginGuess(), true);
});

test('a structured question (single trait, OR values) locks guessing and reaches the opponent', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);
  let asked = null;
  B.on('question', (q) => { asked = q; });
  const ok = A.askStructured({ trait: 'glasses', values: ['none', 'sun'] }, 'Glasses: None or Sunglasses');
  assert.equal(ok, true);
  assert.equal(A.state.asked, true);
  assert.equal(A.beginGuess(), false);            // locked out after asking
  assert.equal(asked.question.trait, 'glasses');  // opponent received the question
  assert.deepEqual(asked.question.values, ['none', 'sun']);
  assert.equal(A.state.chat.at(-1).text.includes('Sunglasses'), true);
});

test('answering a structured question flows back as a single yes/no', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);
  let received = null;
  A.on('answer', (a) => { received = a; });
  A.askStructured({ trait: 'hair', values: ['blonde'] }, 'Hair colour: Blonde');
  B.answerStructured(false, 'Hair colour: Blonde -> No');
  assert.equal(received.yes, false);
  assert.equal(A.state.chat.at(-1).text.includes('No'), true);
});

test('structured ask is refused with no values, out of turn, or after asking', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);
  assert.equal(A.askStructured({ trait: 'hair', values: [] }, 'x'), false);            // no values
  assert.equal(B.askStructured({ trait: 'hair', values: ['blonde'] }, 'x'), false);    // not B's turn
  A.askQuestion();
  assert.equal(A.askStructured({ trait: 'hair', values: ['blonde'] }, 'x'), false);    // already asked
});

test('ending a turn reports counts and passes play', () => {
  const { A, B } = pair();
  setupBoth(A, B);
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

test('second player to set up moves to waiting, not stuck on setup', () => {
  const { A, B } = pair();
  A.setupLocal({ board: first20, secret: 3 });
  assert.equal(A.state.phase, 'waiting');   // host waits for guest
  B.setupLocal({ board: first20, secret: 7 });
  // both boards in -> host began -> both playing
  assert.equal(A.state.phase, 'play');
  assert.equal(B.state.phase, 'play');
});

test('a player cannot submit their board twice', () => {
  const { A, B } = pair();
  A.setupLocal({ board: first20, secret: 3 });
  const again = A.setupLocal({ board: first20, secret: 5 });
  assert.equal(again.ok, false);            // already committed
  assert.equal(A.state.mySecret, 3);        // unchanged
});

test('rematch is ignored unless the receiver is on the game-over screen', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);
  // Mid-game, a stray rematch from B must not reset A.
  B.requestRematch();
  assert.equal(A.state.phase, 'play');
  assert.equal(A.state.mySecret, 3);
});

test('rematch clears chat history', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);
  A.sendChat('do they wear glasses?');
  assert.equal(A.state.chat.length, 1);
  assert.equal(B.state.chat.length, 1);
  A.beginGuess(); A.makeGuess(7);           // end the game
  A.requestRematch();
  assert.equal(A.state.chat.length, 0);
  assert.equal(B.state.chat.length, 0);
});

test('a full multi-turn game plays through', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);
  // A crosses some off, ends turn
  A.toggleCard(1); A.toggleCard(2); A.endTurn();
  // B crosses some off, ends turn
  B.toggleCard(10); B.endTurn();
  assert.equal(A.state.turn, 'me');
  assert.equal(A.state.oppOpen, 19); // B crossed out 1
  // A guesses correctly
  A.beginGuess(); A.makeGuess(7);
  assert.equal(A.state.winner, 'me');
});

test('a card can be crossed off during the opponents turn', () => {
  const { A, B } = pair();
  setupBoth(A, B, 3, 7);          // A's turn first
  assert.equal(B.state.turn, 'opp');
  assert.equal(B.toggleCard(4), true);       // B takes notes off-turn
  assert.equal(B.state.deduction[4], false);
  assert.equal(A.state.oppOpen, 19);          // A sees B's live progress
});
