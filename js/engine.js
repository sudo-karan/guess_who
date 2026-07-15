// engine.js
// Pure, framework-free game engine for a single client's view of a match.
// It holds this client's state, processes local actions + remote messages,
// and emits `change` (new state) and `send` (outbound message) events.
//
// The two clients are symmetric: each only ever knows its OWN secret. A guess
// is validated by the *owner's* client, which replies with the result, so no
// client can read the opponent's secret from the game state.
//
// Activity log: every action (chat, question, answer, card cross-off, guess) is
// recorded in `state.log` with a timestamp, the turn it happened on, and who did
// it. During play you see your OWN card actions in detail but only a per-turn
// COUNT of the opponent's; the full card detail is exchanged only once the game
// ends (see the `fulllog` message), so both players then see an identical, com-
// plete transcript.

const BOARD_SIZE = 20;
const ROSTER_SIZE = 30;

// A tiny event emitter (no dependencies, works in browser + Node tests).
function emitter() {
  const map = new Map();
  return {
    on(name, fn) { (map.get(name) || map.set(name, []).get(name)).push(fn); },
    emit(name, payload) { (map.get(name) || []).forEach((fn) => fn(payload)); },
  };
}

export function createEngine({ isHost, myName, now }) {
  const ev = emitter();
  // Injectable clock (defaults to wall-clock). Tests pass a deterministic counter.
  const clock = typeof now === 'function' ? now : () => Date.now();

  const state = {
    phase: 'setup',        // 'setup' | 'waiting' | 'play' | 'over'
    isHost,
    myName: myName || (isHost ? 'Player 1' : 'Player 2'),
    oppName: null,

    // My board (the 20 characters the opponent will deduce over) + my secret.
    myBoard: [],
    mySecret: null,
    myReady: false,

    // The opponent's revealed board + my deductions over it.
    oppBoard: null,        // array of 20 character ids, or null until revealed
    oppReady: false,
    oppSecret: null,       // revealed only once the game is over
    deduction: {},         // { [charId]: true=open, false=crossed-out }

    // Turn state.
    turn: null,            // 'me' | 'opp'
    turnNumber: 0,
    asked: false,          // did I ask a question this turn? (locks guessing)
    guessing: false,       // am I currently in guess-selection mode?
    pendingGuess: false,   // waiting for the opponent to validate my guess
    pendingGuessTs: null,  // ts stamped on my outbound guess (reused when logging the result)
    pendingGuessTurn: null,// turn stamped on my outbound guess (reused when logging the result)

    // Opponent's deduction progress over MY board (they report counts on End Turn).
    oppOpen: BOARD_SIZE,
    oppClosed: 0,

    winner: null,          // 'me' | 'opp'
    lastGuess: null,       // { by:'me'|'opp', id, correct }
    revealed: false,       // have I already sent my secret reveal + full log?

    chat: [],              // live chat/question/answer feed (kept for the sidebar)
    log: [],               // full timestamped activity log (my perspective)
    turnCardActions: [],   // { cardId, action, prev } toggled THIS turn (for undo)
    turnStartOff: new Set(),   // ids crossed out at the start of my current turn
    oppCardLog: [],        // opponent's card actions, received only at game end
  };

  function change() { ev.emit('change', state); }
  function send(msg) { ev.emit('send', msg); }
  function log(text) { ev.emit('log', text); }

  // Append a timestamped entry to the activity log. `ts` and `turn` are the
  // ORIGINATOR's, so the same shared event lands at the same time and in the same
  // round on BOTH clients (their turn counters can otherwise diverge mid-round).
  function logEvent({ ts, turn, by, kind, text, cardId, action, correct, off, on, outloud }) {
    state.log.push({
      ts: ts == null ? clock() : ts,
      turn: turn == null ? state.turnNumber : turn,
      by, kind, text, cardId, action, correct, off, on, outloud,
    });
  }

  const offIds = () => Object.keys(state.deduction).filter((id) => state.deduction[id] === false).map(Number);

  // Begin (or reset) tracking for MY turn: clear the undo stack and snapshot
  // which cards were already crossed out, so End Turn can report NET changes.
  function beginMyTurnTracking() {
    state.turnCardActions = [];
    state.turnStartOff = new Set(offIds());
  }

  // End the game, record the outcome, and reveal my secret + full card log to the
  // opponent exactly once so the results screen can show an identical transcript.
  function concludeGame(winner, lastGuess) {
    state.winner = winner;
    state.lastGuess = lastGuess;
    state.pendingGuess = false;
    state.phase = 'over';
    if (!state.revealed) {
      state.revealed = true;
      send({ type: 'reveal', secret: state.mySecret });
      send({ type: 'fulllog', cards: myCardEvents() });
    }
    change();
  }

  // My individual card actions across the whole game, for the end-game exchange.
  function myCardEvents() {
    return state.log
      .filter((e) => e.kind === 'card' && e.by === 'me')
      .map((e) => ({ ts: e.ts, turn: e.turn, cardId: e.cardId, action: e.action }));
  }

  // Count of characters still standing on my deduction board.
  function myOpenCount() {
    return Object.values(state.deduction).filter(Boolean).length;
  }
  function myClosedCount() {
    return Object.values(state.deduction).filter((v) => v === false).length;
  }

  // Host starts the match once both players have submitted their boards.
  function maybeBegin() {
    if (state.myReady && state.oppReady && state.phase !== 'play' && state.phase !== 'over') {
      if (isHost) {
        // Host is authoritative for turn order; host plays first.
        const first = 'host';
        send({ type: 'begin', first });
        startPlay(first);
      }
      // Guest waits for the explicit `begin` message.
    }
  }

  function startPlay(first) {
    state.phase = 'play';
    state.turnNumber = 1;
    // `first` is expressed from the host's perspective.
    const hostFirst = first === 'host';
    state.turn = (isHost === hostFirst) ? 'me' : 'opp';
    state.asked = false;
    state.guessing = false;
    if (state.turn === 'me') beginMyTurnTracking();
    change();
  }

  /* --------------------------- setup phase --------------------------- */

  // Validate + commit this client's board and secret pick.
  function setupLocal({ board, secret }) {
    if (state.phase !== 'setup') return { ok: false, error: 'Already set up.' };
    if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
      return { ok: false, error: `Pick exactly ${BOARD_SIZE} characters for your board.` };
    }
    const unique = new Set(board);
    if (unique.size !== BOARD_SIZE) return { ok: false, error: 'Board has duplicates.' };
    for (const id of board) {
      if (!Number.isInteger(id) || id < 1 || id > ROSTER_SIZE) {
        return { ok: false, error: 'Board contains an invalid character.' };
      }
    }
    if (!unique.has(secret)) return { ok: false, error: 'Your secret must be one of your 20 cards.' };

    state.myBoard = board.slice();
    state.mySecret = secret;
    state.myReady = true;
    // Always move to a committed 'waiting' state; maybeBegin() flips it to
    // 'play' for the host once both boards are in. Staying on 'setup' would
    // leave the second player on the live builder and let them re-submit.
    state.phase = 'waiting';
    send({ type: 'setup', name: state.myName, board: state.myBoard });
    change();
    maybeBegin();
    return { ok: true };
  }

  /* ------------------------- play-phase actions ---------------------- */

  const myTurn = () => state.phase === 'play' && state.turn === 'me' && !state.pendingGuess;

  // Cross a character off (or back on) MY deduction board. This is now allowed
  // ONLY on my turn — deducing is a turn action, logged so I can see precisely
  // what I crossed off each turn. The opponent learns only a per-turn COUNT (on
  // End Turn), never which cards, until the game ends.
  function toggleCard(id) {
    if (!myTurn()) return false;
    if (!(id in state.deduction)) return false;
    const prev = state.deduction[id];
    state.deduction[id] = !prev;
    const action = state.deduction[id] ? 'on' : 'off';
    state.turnCardActions.push({ cardId: id, action, prev });
    logEvent({ by: 'me', kind: 'card', cardId: id, action });
    change();
    return true;
  }

  // Undo the most recent card change made THIS turn (repeatable). Does not touch
  // earlier turns. Refused when it isn't my turn or nothing was changed.
  function undoLastCard() {
    if (!myTurn() || !state.turnCardActions.length) return false;
    const last = state.turnCardActions.pop();
    state.deduction[last.cardId] = last.prev;
    // Remove the matching (most recent) 'card' entry from the log.
    for (let i = state.log.length - 1; i >= 0; i--) {
      const e = state.log[i];
      if (e.kind === 'card' && e.by === 'me' && e.cardId === last.cardId) { state.log.splice(i, 1); break; }
    }
    change();
    return true;
  }

  // Ask a question this turn. This is what commits you to NOT guessing this turn
  // (you chose to gather info instead). The opponent is notified.
  function askQuestion() {
    if (!myTurn() || state.asked || state.guessing) return false;
    state.asked = true;
    const ts = clock();
    const text = '🗣️ Asked a question out loud';
    // Leave a transcript trace so an out-loud question shows up in chat + logs.
    state.chat.push({ from: 'me', text });
    logEvent({ ts, by: 'me', kind: 'ask', text: 'Asked a question out loud', outloud: true });
    send({ type: 'ask', name: state.myName, ts, turn: state.turnNumber });
    change();
    return true;
  }

  // Ask a *structured* question about ONE trait with one or more values (joined
  // by OR), e.g. { trait:'glasses', values:['none','sun'] }. Like askQuestion it
  // locks guessing this turn. The opponent gives a single yes/no. `text` is the
  // human-readable summary (built by the UI, which owns the trait labels).
  function askStructured(question, text) {
    if (!myTurn() || state.asked || state.guessing) return false;
    if (!question || !question.trait || !Array.isArray(question.values) || !question.values.length) return false;
    state.asked = true;
    const ts = clock();
    state.chat.push({ from: 'me', text: '🙋 ' + (text || 'a question') });
    logEvent({ ts, by: 'me', kind: 'ask', text: text || 'a question' });
    send({ type: 'question', question, text: text || '', ts, turn: state.turnNumber });
    change();
    return true;
  }

  // Answer a structured question with a single yes/no (truth decided UI-side,
  // which owns the roster). `text` is the readable summary.
  function answerStructured(yes, text) {
    const ts = clock();
    state.chat.push({ from: 'me', text: '✅ ' + (text || '') });
    logEvent({ ts, by: 'me', kind: 'answer', text: text || '' });
    send({ type: 'answer', yes: !!yes, text: text || '', ts, turn: state.turnNumber });
    change();
  }

  // Enter "guess" selection mode. Refused once you've asked a question this turn.
  function beginGuess() {
    if (!myTurn() || state.asked) return false;
    state.guessing = true;
    change();
    return true;
  }

  function cancelGuess() {
    if (state.guessing) { state.guessing = false; change(); }
  }

  // Commit a guess of the opponent's secret. Terminal action.
  function makeGuess(id) {
    if (!myTurn() || state.asked || !state.guessing) return false;
    if (!state.oppBoard || !state.oppBoard.includes(id)) return false;
    state.pendingGuess = true;
    state.pendingGuessTs = clock();
    state.pendingGuessTurn = state.turnNumber;
    send({ type: 'guess', id, ts: state.pendingGuessTs, turn: state.pendingGuessTurn });
    change();
    return true;
  }

  // End my turn. Reports my NET deduction changes this turn (how many I crossed
  // off / brought back) so the opponent sees a per-turn count.
  function endTurn() {
    if (!myTurn()) return false;
    state.guessing = false;
    const nowOff = new Set(offIds());
    let off = 0, on = 0;
    for (const id of nowOff) if (!state.turnStartOff.has(id)) off += 1;      // newly crossed off
    for (const id of state.turnStartOff) if (!nowOff.has(id)) on += 1;       // brought back
    send({ type: 'endTurn', open: myOpenCount(), closed: myClosedCount(), off, on, ts: clock(), turn: state.turnNumber });
    state.turn = 'opp';
    state.turnNumber += 1;
    change();
    return true;
  }

  function sendChat(text) {
    const clean = String(text || '').slice(0, 300).trim();
    if (!clean) return;
    const ts = clock();
    state.chat.push({ from: 'me', text: clean });
    logEvent({ ts, by: 'me', kind: 'chat', text: clean });
    send({ type: 'chat', text: clean, ts, turn: state.turnNumber });
    change();
  }

  function requestRematch() {
    send({ type: 'rematch' });
    resetForRematch();
  }

  function resetForRematch() {
    state.phase = 'setup';
    state.myBoard = [];
    state.mySecret = null;
    state.myReady = false;
    state.oppBoard = null;
    state.oppReady = false;
    state.oppSecret = null;
    state.deduction = {};
    state.turn = null;
    state.turnNumber = 0;
    state.asked = false;
    state.guessing = false;
    state.pendingGuess = false;
    state.pendingGuessTs = null;
    state.pendingGuessTurn = null;
    state.oppOpen = BOARD_SIZE;
    state.oppClosed = 0;
    state.winner = null;
    state.lastGuess = null;
    state.revealed = false;
    state.chat = [];
    state.log = [];
    state.turnCardActions = [];
    state.turnStartOff = new Set();
    state.oppCardLog = [];
    change();
  }

  /* ------------------------- inbound messages ------------------------ */

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'setup': {
        state.oppName = msg.name || (isHost ? 'Player 2' : 'Player 1');
        state.oppBoard = Array.isArray(msg.board) ? msg.board.slice(0, BOARD_SIZE) : [];
        state.oppReady = true;
        state.deduction = {};
        for (const id of state.oppBoard) state.deduction[id] = true; // all open
        if (state.phase === 'waiting' || state.phase === 'setup') change();
        maybeBegin();
        break;
      }
      case 'begin': {
        if (!isHost) startPlay(msg.first);
        break;
      }
      case 'endTurn': {
        // Opponent finished their turn; adopt their reported progress + take turn.
        state.oppOpen = Number.isFinite(msg.open) ? msg.open : state.oppOpen;
        state.oppClosed = Number.isFinite(msg.closed) ? msg.closed : state.oppClosed;
        // Log the per-turn count (not which cards) — skip a no-op turn.
        if ((msg.off || 0) + (msg.on || 0) > 0) {
          logEvent({ ts: msg.ts, turn: msg.turn, by: 'opp', kind: 'oppcards', off: msg.off || 0, on: msg.on || 0 });
        }
        if (state.phase === 'play') {
          state.turn = 'me';
          state.asked = false;      // fresh turn: guessing is available again
          state.guessing = false;
          beginMyTurnTracking();    // reset undo stack + snapshot for MY new turn
        }
        change();
        break;
      }
      case 'ask': {
        // Opponent chose to ask a question out loud — surface it so I can answer.
        const who = msg.name || state.oppName || 'Your rival';
        state.chat.push({ from: 'opp', text: '🗣️ ' + who + ' asked a question out loud' });
        logEvent({ ts: msg.ts, turn: msg.turn, by: 'opp', kind: 'ask', text: 'Asked a question out loud', outloud: true });
        ev.emit('ask', who);
        change();
        break;
      }
      case 'question': {
        // Opponent asked a structured question — log it and surface it to answer.
        state.chat.push({ from: 'opp', text: '🙋 ' + (msg.text || 'a question') });
        logEvent({ ts: msg.ts, turn: msg.turn, by: 'opp', kind: 'ask', text: msg.text || 'a question' });
        ev.emit('question', { question: msg.question || null, text: msg.text || '' });
        change();
        break;
      }
      case 'answer': {
        // Reply to a structured question I asked.
        state.chat.push({ from: 'opp', text: '✅ ' + (msg.text || '') });
        logEvent({ ts: msg.ts, turn: msg.turn, by: 'opp', kind: 'answer', text: msg.text || '' });
        ev.emit('answer', { yes: !!msg.yes, text: msg.text || '' });
        change();
        break;
      }
      case 'guess': {
        // Opponent guessed MY secret. My client is the source of truth.
        const correct = msg.id === state.mySecret;
        logEvent({ ts: msg.ts, turn: msg.turn, by: 'opp', kind: 'guess', cardId: msg.id, correct });
        send({ type: 'guessResult', id: msg.id, correct });
        concludeGame(correct ? 'opp' : 'me', { by: 'opp', id: msg.id, correct });
        break;
      }
      case 'guessResult': {
        // Reply to my own guess — reuse the ts I stamped on the outbound guess so
        // both clients log the SAME guess at the SAME time.
        logEvent({ ts: state.pendingGuessTs, turn: state.pendingGuessTurn, by: 'me', kind: 'guess', cardId: msg.id, correct: !!msg.correct });
        concludeGame(msg.correct ? 'me' : 'opp', { by: 'me', id: msg.id, correct: !!msg.correct });
        break;
      }
      case 'reveal': {
        state.oppSecret = msg.secret;
        change();
        break;
      }
      case 'fulllog': {
        // The full card history the opponent kept privately during the game —
        // arrives around game-over (possibly just after) so the complete log can
        // be shown to both. Tolerate arrival while already on the over screen.
        state.oppCardLog = (Array.isArray(msg.cards) ? msg.cards : [])
          .map((c) => ({ ts: c.ts, turn: c.turn, cardId: c.cardId, action: c.action, by: 'opp', kind: 'card' }));
        change();
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 300);
        state.chat.push({ from: 'opp', text });
        logEvent({ ts: msg.ts, turn: msg.turn, by: 'opp', kind: 'chat', text });
        change();
        break;
      }
      case 'rematch': {
        // Only honour a rematch request while still on the game-over screen.
        // Ignoring it otherwise stops a late/duplicate message from wiping a
        // board the receiver has already started building for the next round.
        if (state.phase === 'over') {
          resetForRematch();
          log('Opponent wants a rematch — new round!');
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    state,
    on: ev.on,
    // setup
    setupLocal,
    // play actions
    toggleCard, undoLastCard, askQuestion, askStructured, answerStructured,
    beginGuess, cancelGuess, makeGuess, endTurn,
    sendChat, requestRematch,
    // networking
    handleMessage,
    // derived helpers (used by UI)
    myOpenCount, myClosedCount,
    // constants
    BOARD_SIZE, ROSTER_SIZE,
  };
}

export { BOARD_SIZE, ROSTER_SIZE };
