// engine.js
// Pure, framework-free game engine for a single client's view of a match.
// It holds this client's state, processes local actions + remote messages,
// and emits `change` (new state) and `send` (outbound message) events.
//
// The two clients are symmetric: each only ever knows its OWN secret. A guess
// is validated by the *owner's* client, which replies with the result, so no
// client can read the opponent's secret from the game state.

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

export function createEngine({ isHost, myName }) {
  const ev = emitter();

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

    // Opponent's deduction progress over MY board (they report counts on End Turn).
    oppOpen: BOARD_SIZE,
    oppClosed: 0,

    winner: null,          // 'me' | 'opp'
    lastGuess: null,       // { by:'me'|'opp', id, correct }
    revealed: false,       // have I already sent my secret reveal?
    chat: [],
  };

  function change() { ev.emit('change', state); }
  function send(msg) { ev.emit('send', msg); }
  function log(text) { ev.emit('log', text); }

  // End the game, record the outcome, and reveal my secret to the opponent
  // exactly once so the results screen can show both answers.
  function concludeGame(winner, lastGuess) {
    state.winner = winner;
    state.lastGuess = lastGuess;
    state.pendingGuess = false;
    state.phase = 'over';
    if (!state.revealed) {
      state.revealed = true;
      send({ type: 'reveal', secret: state.mySecret });
    }
    change();
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

  // Cross a character off (or back on) MY deduction board. This is private note-
  // taking, so it is allowed at ANY time — my turn or not — and never blocks a
  // future guess. Progress is reported live so the opponent's counter updates.
  function toggleCard(id) {
    if (state.phase !== 'play') return false;
    if (!(id in state.deduction)) return false;
    state.deduction[id] = !state.deduction[id];
    send({ type: 'progress', open: myOpenCount(), closed: myClosedCount() });
    change();
    return true;
  }

  // Ask a question this turn. This is what commits you to NOT guessing this turn
  // (you chose to gather info instead). The opponent is notified.
  function askQuestion() {
    if (!myTurn() || state.asked || state.guessing) return false;
    state.asked = true;
    send({ type: 'ask', name: state.myName });
    change();
    return true;
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
    send({ type: 'guess', id });
    change();
    return true;
  }

  // End my turn.
  function endTurn() {
    if (!myTurn()) return false;
    state.guessing = false;
    // Report my deduction progress so the opponent can see how close I am.
    send({ type: 'endTurn', open: myOpenCount(), closed: myClosedCount() });
    state.turn = 'opp';
    state.turnNumber += 1;
    change();
    return true;
  }

  function sendChat(text) {
    const clean = String(text || '').slice(0, 300).trim();
    if (!clean) return;
    state.chat.push({ from: 'me', text: clean });
    send({ type: 'chat', text: clean });
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
    state.oppOpen = BOARD_SIZE;
    state.oppClosed = 0;
    state.winner = null;
    state.lastGuess = null;
    state.revealed = false;
    state.chat = [];
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
        if (state.phase === 'play') {
          state.turn = 'me';
          state.asked = false;      // fresh turn: guessing is available again
          state.guessing = false;
        }
        change();
        break;
      }
      case 'progress': {
        // Opponent updated their deduction (they can cross cards off any time).
        state.oppOpen = Number.isFinite(msg.open) ? msg.open : state.oppOpen;
        state.oppClosed = Number.isFinite(msg.closed) ? msg.closed : state.oppClosed;
        change();
        break;
      }
      case 'ask': {
        // Opponent chose to ask a question this turn — surface it so I can answer.
        ev.emit('ask', msg.name || state.oppName || 'Your rival');
        break;
      }
      case 'guess': {
        // Opponent guessed MY secret. My client is the source of truth.
        const correct = msg.id === state.mySecret;
        send({ type: 'guessResult', id: msg.id, correct });
        concludeGame(correct ? 'opp' : 'me', { by: 'opp', id: msg.id, correct });
        break;
      }
      case 'guessResult': {
        // Reply to my own guess.
        concludeGame(msg.correct ? 'me' : 'opp', { by: 'me', id: msg.id, correct: !!msg.correct });
        break;
      }
      case 'reveal': {
        state.oppSecret = msg.secret;
        change();
        break;
      }
      case 'chat': {
        state.chat.push({ from: 'opp', text: String(msg.text || '').slice(0, 300) });
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
    toggleCard, askQuestion, beginGuess, cancelGuess, makeGuess, endTurn,
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
