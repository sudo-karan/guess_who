// app.js — UI + orchestration for Guess Whoo!
import { CHARACTERS, CHAR_BY_ID, renderAvatar, TRAIT_LABELS } from './characters.js';
import { createEngine, BOARD_SIZE } from './engine.js';
import { createOnlineChannel, createLocalPair, peerAvailable } from './net.js';

/* ------------------------------ helpers ----------------------------- */
const $ = (sel) => document.querySelector(sel);
const screens = {
  home: $('#screen-home'), setup: $('#screen-setup'), pass: $('#screen-pass'),
  play: $('#screen-play'), over: $('#screen-over'),
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// Promise-based confirm modal.
function confirmModal({ title, body, okText = 'Confirm', cancelText = 'Cancel' }) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = body;
    $('#modal-ok').textContent = okText;
    $('#modal-cancel').textContent = cancelText;
    const overlay = $('#modal');
    overlay.classList.remove('hidden');
    const done = (val) => {
      overlay.classList.add('hidden');
      $('#modal-ok').onclick = null; $('#modal-cancel').onclick = null;
      resolve(val);
    };
    $('#modal-ok').onclick = () => done(true);
    $('#modal-cancel').onclick = () => done(false);
  });
}

function charCardHTML(ch, idx, extraClass = '') {
  return `<div class="char ${extraClass}" data-id="${ch.id}">
    ${renderAvatar(ch, idx)}<span class="cname">${ch.name}</span>
  </div>`;
}

/* --------------------------- game controller ------------------------ */
const G = {
  mode: null,          // 'online' | 'local'
  channel: null,       // online transport
  A: null, B: null,    // local engines
};
let activeEngine = null;   // engine the play/over UI currently reflects

/* ------------------------------- home ------------------------------- */
function initHome() {
  $('#btn-online').onclick = () => {
    if (!peerAvailable()) toast('Online needs a connection — you can still Pass & Play.');
    $('#online-panel').classList.toggle('hidden');
    $('#how-panel').classList.add('hidden');
  };
  $('#btn-how').onclick = () => {
    $('#how-panel').classList.toggle('hidden');
    $('#online-panel').classList.add('hidden');
  };
  $('#btn-how-close').onclick = () => $('#how-panel').classList.add('hidden');
  $('#btn-local').onclick = startLocal;

  // Online: host
  $('#btn-host').onclick = () => hostOnline();
  $('#btn-join').onclick = () => joinOnline();
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinOnline(); });
  $('#btn-copy').onclick = () => {
    const code = $('#code-value').textContent;
    navigator.clipboard && navigator.clipboard.writeText(code).then(
      () => toast('Code copied!'), () => {});
  };
}

function setNetStatus(msg, kind = '') {
  const el = $('#net-status');
  el.textContent = msg; el.className = 'net-status ' + kind;
}

/* ------------------------------ online ------------------------------ */
function makeOnlineEngine(isHost) {
  const name = ($('#online-name').value || '').trim().slice(0, 14) || (isHost ? 'Player 1' : 'Player 2');
  const engine = createEngine({ isHost, myName: name });
  engine.on('send', (m) => G.channel.send(m));
  engine.on('log', (t) => toast(t));
  engine.on('change', (s) => routeOnline(s));
  activeEngine = engine;
  return engine;
}

function hostOnline() {
  G.mode = 'online';
  G.channel = createOnlineChannel();
  const engine = makeOnlineEngine(true);
  G.channel.onData((m) => engine.handleMessage(m));
  G.channel.onStatus((s) => setNetStatus(s));
  G.channel.onOpen(() => { setNetStatus('Opponent connected!', 'ok'); enterSetup(engine); });
  G.channel.onError(handleNetError);
  G.channel.host((code) => {
    $('#host-code').classList.remove('hidden');
    $('#code-value').textContent = code;
  });
}

function joinOnline() {
  const code = $('#join-code').value.trim();
  if (!code) { setNetStatus('Enter a room code first.', 'error'); return; }
  G.mode = 'online';
  G.channel = createOnlineChannel();
  const engine = makeOnlineEngine(false);
  G.channel.onData((m) => engine.handleMessage(m));
  G.channel.onStatus((s) => setNetStatus(s));
  G.channel.onOpen(() => { setNetStatus('Connected!', 'ok'); enterSetup(engine); });
  G.channel.onError(handleNetError);
  G.channel.join(code);
}

// Route online state changes to the right screen.
function routeOnline(s) {
  if (s.phase === 'setup') {
    // Only reached again after a rematch reset; re-enter the board builder.
    if (!screens.setup.classList.contains('active')) enterSetup(activeEngine);
  } else if (s.phase === 'waiting') {
    showPass({ title: 'Board locked in! 🔒', sub: 'Waiting for your opponent to finish setting up…' });
  } else if (s.phase === 'play') {
    ensurePlayView();
    renderPlay(s);
  } else if (s.phase === 'over') {
    showOver(s);
  }
}

function handleNetError(e) {
  const msg = (e && e.message) || 'Connection problem.';
  setNetStatus(msg, 'error');
  if (screens.home.classList.contains('active')) return; // still in the lobby

  // Past the lobby: a dropped connection would otherwise leave this client stuck
  // forever (e.g. on "Awaiting result…"). Drive it to a terminal screen with a
  // way home instead.
  if (G.mode === 'online' && activeEngine && activeEngine.state.phase !== 'over') {
    showDisconnected();
  } else {
    toast('⚠️ ' + msg);
  }
}

function showDisconnected() {
  $('#over-emoji').textContent = '🔌';
  $('#over-title').textContent = 'Opponent left';
  $('#over-title').style.color = 'var(--ink)';
  $('#over-sub').innerHTML = 'Your opponent disconnected — the game can\'t continue.';
  $('#reveal-row').innerHTML = '';
  $('#btn-rematch').classList.add('hidden');   // nobody to rematch with
  showScreen('over');
}

/* ------------------------------ local ------------------------------- */
function startLocal() {
  // Tear down any half-open online room so a late joiner can't hijack this game.
  if (G.channel) { G.channel.close(); G.channel = null; }
  G.mode = 'local';
  activeEngine = null;
  const pair = createLocalPair();
  const A = createEngine({ isHost: true, myName: 'Player 1' });
  const B = createEngine({ isHost: false, myName: 'Player 2' });
  A.on('send', pair.a.send); pair.a.onData(A.handleMessage);
  B.on('send', pair.b.send); pair.b.onData(B.handleMessage);
  A.on('change', () => onLocalEngineChange(A));
  B.on('change', () => onLocalEngineChange(B));
  // No log->toast wiring in local mode: the only engine log is the rematch
  // notice, which would misleadingly toast the very player who clicked Rematch.
  G.A = A; G.B = B;

  // Sequential hot-seat setup, then first player's turn.
  showPass({
    title: 'Player 1, get ready 🙈', sub: 'Build your board while Player 2 looks away.',
    buttonText: "I'm Player 1",
    onReady: () => enterSetup(A, () => {
      showPass({
        title: 'Player 2, your turn 🙈', sub: 'Build your board while Player 1 looks away.',
        buttonText: "I'm Player 2",
        onReady: () => enterSetup(B, () => {
          // Both boards are in; host (A) has already begun the match.
          beginLocalTurn(A);
        }),
      });
    }),
  });
}

// Re-render the play/over screen when the *currently active* local engine
// changes. Turn hand-off and pass screens are driven explicitly elsewhere.
function onLocalEngineChange(engine) {
  if (engine !== activeEngine) return;
  const s = engine.state;
  if (s.phase === 'over') { showOver(s); return; }
  if (s.phase === 'play' && screens.play.classList.contains('active')) renderPlay(s);
}

// Show the play view for `engine` after a pass-the-device screen.
function beginLocalTurn(engine) {
  activeEngine = engine;
  const s = engine.state;
  if (s.phase === 'over') { showOver(s); return; }
  showPass({
    title: `${engine.state.myName}, it's your turn! 🎲`,
    sub: 'Make sure your opponent isn\'t peeking, then play.',
    buttonText: 'Start my turn',
    onReady: () => { ensurePlayView(); renderPlay(engine.state); },
  });
}

/* ------------------------------ setup ------------------------------- */
let setupCtx = null;
function enterSetup(engine, onDone) {
  setupCtx = { engine, onDone, picked: new Set(), secret: null, step: 1 };
  $('#setup-player').textContent = engine.state.myName;
  $('#setup-step').textContent = 'Step 1 of 2 — pick 20 characters';
  $('#setup-grid').innerHTML = CHARACTERS.map((c, i) => charCardHTML(c, i)).join('');
  $('#setup-confirm').classList.add('hidden');
  $('#setup-next').classList.remove('hidden');
  $('#setup-clear').classList.remove('hidden');
  $('#setup-random').classList.remove('hidden');
  updateSetupUI();
  showScreen('setup');
}

function updateSetupUI() {
  const { picked, step, secret } = setupCtx;
  const cards = $('#setup-grid').querySelectorAll('.char');
  cards.forEach((el) => {
    const id = Number(el.dataset.id);
    el.classList.remove('picked', 'secret', 'dim');
    if (step === 1) {
      if (picked.has(id)) el.classList.add('picked');
    } else {
      // Step 2: only picked cards are choosable; the rest are dimmed.
      if (!picked.has(id)) el.classList.add('dim');
      else if (secret === id) el.classList.add('secret');
      else el.classList.add('picked');
    }
  });
  if (step === 1) {
    $('#setup-hint').innerHTML = `Tap characters to add them to your board. <b><span id="pick-count">${picked.size}</span>/20</b> chosen.`;
    $('#setup-next').disabled = picked.size !== BOARD_SIZE;
  } else {
    $('#setup-hint').innerHTML = `Now tap <b>one</b> of your 20 to be your <b>secret character</b> ⭐.`;
    $('#setup-confirm').disabled = secret == null;
  }
}

function onSetupCardClick(id) {
  const c = setupCtx;
  if (c.step === 1) {
    if (c.picked.has(id)) c.picked.delete(id);
    else {
      if (c.picked.size >= BOARD_SIZE) { toast(`You've already picked ${BOARD_SIZE}!`); return; }
      c.picked.add(id);
    }
  } else {
    if (!c.picked.has(id)) return;      // can only pick secret among the 20
    c.secret = id;
  }
  updateSetupUI();
}

function initSetupControls() {
  $('#setup-grid').addEventListener('click', (e) => {
    const el = e.target.closest('.char'); if (!el) return;
    onSetupCardClick(Number(el.dataset.id));
  });
  $('#setup-clear').onclick = () => { setupCtx.picked.clear(); setupCtx.secret = null; updateSetupUI(); };
  $('#setup-random').onclick = () => {
    const ids = CHARACTERS.map((c) => c.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    setupCtx.picked = new Set(ids.slice(0, BOARD_SIZE));
    setupCtx.secret = null;
    updateSetupUI();
  };
  $('#setup-next').onclick = () => {
    if (setupCtx.picked.size !== BOARD_SIZE) return;
    setupCtx.step = 2;
    $('#setup-step').textContent = 'Step 2 of 2 — pick your secret';
    $('#setup-next').classList.add('hidden');
    $('#setup-clear').classList.add('hidden');
    $('#setup-random').classList.add('hidden');
    $('#setup-confirm').classList.remove('hidden');
    updateSetupUI();
  };
  $('#setup-confirm').onclick = () => {
    const { engine, picked, secret, onDone } = setupCtx;
    const res = engine.setupLocal({ board: [...picked], secret });
    if (!res.ok) { toast(res.error); return; }
    if (onDone) onDone();
  };
}

/* ------------------------------- pass ------------------------------- */
function showPass({ title, sub, buttonText, onReady }) {
  $('#pass-title').textContent = title;
  $('#pass-sub').textContent = sub;
  const btn = $('#pass-ready');
  if (buttonText) {
    btn.classList.remove('hidden');
    btn.textContent = buttonText;
    btn.onclick = () => { btn.onclick = null; onReady && onReady(); };
  } else {
    btn.classList.add('hidden'); btn.onclick = null;
  }
  showScreen('pass');
}

/* ------------------------------- play ------------------------------- */
let legendBuilt = false;
function buildLegend() {
  if (legendBuilt) return;
  const rows = Object.values(TRAIT_LABELS).map((t) => {
    const vals = Object.values(t.values).filter((v) => v !== 'None').join(', ');
    return `<div class="lg-row"><span class="lg-name">${t.name}</span><span class="lg-vals">${vals}</span></div>`;
  }).join('');
  $('#legend').innerHTML = rows;
  legendBuilt = true;
}

function ensurePlayView() {
  buildLegend();
  // Only switch (and scroll) on the first entry into the board — otherwise every
  // state change would re-scroll the page to the top mid-game.
  if (!screens.play.classList.contains('active')) showScreen('play');
}

function renderPlay(s) {
  // Turn pill + scoreboard.
  const myTurn = s.turn === 'me' && !s.pendingGuess;
  const pill = $('#turn-pill');
  if (s.pendingGuess) { pill.textContent = 'Awaiting result…'; pill.className = 'turn-pill waiting'; }
  else if (myTurn) { pill.textContent = 'Your turn!'; pill.className = 'turn-pill'; }
  else { pill.textContent = `${s.oppName || 'Rival'}'s turn`; pill.className = 'turn-pill waiting'; }

  $('#score-you-name').textContent = s.myName;
  $('#score-opp-name').textContent = s.oppName || 'Rival';
  const open = Object.values(s.deduction).filter(Boolean).length;
  const closed = Object.values(s.deduction).filter((v) => v === false).length;
  $('#you-open').textContent = open;
  $('#you-closed').textContent = closed;
  $('#opp-open').textContent = s.oppOpen;
  $('#opp-closed').textContent = s.oppClosed;

  // A private reminder of your own secret character (only ever your own, and in
  // pass-and-play the opponent has already looked away for your turn).
  const mine = CHAR_BY_ID[s.mySecret];
  $('#my-secret').innerHTML = mine
    ? `${renderAvatar(mine, mine.id)}<span class="ms-name">${mine.name}</span>`
    : '';

  // Board of the opponent's characters (my deduction surface).
  const grid = $('#play-grid');
  const guessing = s.turnMode === 'guess' && myTurn;
  grid.innerHTML = (s.oppBoard || []).map((id, i) => {
    const ch = CHAR_BY_ID[id];
    const isClosed = s.deduction[id] === false;
    let extra = '';
    if (isClosed) extra += ' closed';
    if (guessing && !isClosed) extra += ' guessable';
    if (!myTurn) extra += ' disabled-cursor';
    return charCardHTML(ch, i, extra.trim());
  }).join('');

  renderChat(s);
  updateControls(s);
}

function updateControls(s) {
  const myTurn = s.turn === 'me' && !s.pendingGuess && s.phase === 'play';
  const guessBtn = $('#btn-guess');
  const endBtn = $('#btn-endturn');
  const banner = $('#mode-banner');
  banner.className = 'mode-banner hidden';

  if (!myTurn) {
    guessBtn.disabled = true; endBtn.disabled = true;
    guessBtn.textContent = '🎯 Make a Guess';
    if (s.pendingGuess) { banner.textContent = 'Your guess is on its way…'; banner.className = 'mode-banner guess'; }
    return;
  }

  if (s.turnMode === 'guess') {
    guessBtn.disabled = false; guessBtn.textContent = '✖ Cancel guess';
    endBtn.disabled = true;
    banner.textContent = '🎯 Guess mode — tap the character you think is your rival\'s secret.';
    banner.className = 'mode-banner guess';
  } else if (s.turnMode === 'disable') {
    guessBtn.disabled = true; guessBtn.textContent = '🚫 Guessing locked';
    endBtn.disabled = false;
    banner.textContent = '🚫 Disable mode — cross out who doesn\'t fit, then End Turn. (No guessing this turn.)';
    banner.className = 'mode-banner disable';
  } else {
    guessBtn.disabled = false; guessBtn.textContent = '🎯 Make a Guess';
    endBtn.disabled = false;
  }
}

function renderChat(s) {
  const log = $('#chat-log');
  log.innerHTML = s.chat.map((m) =>
    `<div class="chat-msg ${m.from === 'me' ? 'me' : 'opp'}">${escapeHTML(m.text)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}
function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------ play interactions ------------------------- */
async function handleBoardClick(id) {
  const e = activeEngine; if (!e) return;
  const s = e.state;
  if (s.phase !== 'play' || s.turn !== 'me' || s.pendingGuess) return;

  if (s.turnMode === 'guess') {
    if (s.deduction[id] === false) { toast('That one is crossed out — pick an open card.'); return; }
    const ch = CHAR_BY_ID[id];
    const ok = await confirmModal({
      title: `Guess ${ch.name}?`,
      body: `You think your rival's secret is <b>${ch.name}</b>.<br>Guess right and you <b>win</b> 🏆 — but if you're <b>wrong you lose!</b>`,
      okText: `Yes, it's ${ch.name}!`, cancelText: 'Wait, no',
    });
    if (ok) { e.makeGuess(id); afterLocalMaybeOver(); }
    return;
  }

  if (s.turnMode === 'disable') { e.toggleCard(id); return; }

  // turnMode is null → this click means "start disabling". Confirm first.
  const ok = await confirmModal({
    title: 'Start crossing out?',
    body: 'Once you cross out a card this turn, you <b>can\'t make a guess</b> until your next turn.<br>Ready to disable?',
    okText: 'Yes, let\'s disable', cancelText: 'Cancel',
  });
  if (ok) { e.beginDisable(); e.toggleCard(id); }
}

// In local mode, message passing is synchronous — check for game over right away.
function afterLocalMaybeOver() {
  if (G.mode === 'local' && activeEngine.state.phase === 'over') showOver(activeEngine.state);
}

function initPlayControls() {
  $('#play-grid').addEventListener('click', (e) => {
    const el = e.target.closest('.char'); if (!el) return;
    handleBoardClick(Number(el.dataset.id));
  });

  $('#btn-guess').onclick = () => {
    const e = activeEngine; const s = e.state;
    if (s.turn !== 'me' || s.pendingGuess) return;
    if (s.turnMode === 'guess') { e.cancelGuess(); return; }
    if (s.turnMode === 'disable') { toast('You chose to disable this turn — no guessing now.'); return; }
    e.beginGuess();
  };

  $('#btn-endturn').onclick = () => {
    const e = activeEngine; const s = e.state;
    if (s.turn !== 'me' || s.pendingGuess) return;
    if (s.turnMode === 'guess') { toast('Finish or cancel your guess first.'); return; }
    const ended = e.endTurn();
    if (!ended) return;
    if (G.mode === 'local') {
      const other = e === G.A ? G.B : G.A;
      beginLocalTurn(other);
    }
  };

  $('#chat-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    activeEngine.sendChat(text);
    input.value = '';
    renderChat(activeEngine.state);
  });
}

/* ------------------------------- over ------------------------------- */
function showOver(s) {
  // Restore the rematch button (a prior disconnect screen may have hidden/disabled it).
  $('#btn-rematch').classList.remove('hidden');
  $('#btn-rematch').disabled = false;

  const iWon = s.winner === 'me';
  $('#over-emoji').textContent = iWon ? '🏆' : '😅';
  $('#over-title').textContent = iWon ? 'You win! 🎉' : 'You lose!';
  $('#over-title').style.color = iWon ? 'var(--green)' : 'var(--red)';

  let sub = '';
  if (s.lastGuess) {
    const guessed = CHAR_BY_ID[s.lastGuess.id];
    if (s.lastGuess.by === 'me') {
      sub = s.lastGuess.correct
        ? `You correctly guessed <b>${guessed.name}</b>!`
        : `You guessed <b>${guessed.name}</b> — but that wasn't it.`;
    } else {
      sub = s.lastGuess.correct
        ? `${s.oppName || 'Your rival'} guessed your secret (<b>${guessed.name}</b>).`
        : `${s.oppName || 'Your rival'} guessed <b>${guessed.name}</b> and got it wrong!`;
    }
  }
  $('#over-sub').innerHTML = sub;

  // Reveal both secrets.
  const mine = CHAR_BY_ID[s.mySecret];
  const theirs = s.oppSecret != null ? CHAR_BY_ID[s.oppSecret] : null;
  const cards = [];
  if (mine) cards.push(revealCardHTML('Your secret', mine));
  if (theirs) cards.push(revealCardHTML(`${s.oppName || 'Rival'}'s secret`, theirs));
  $('#reveal-row').innerHTML = cards.join('');

  showScreen('over');
}
function revealCardHTML(label, ch) {
  return `<div class="reveal-card"><span class="rc-label">${label}</span>
    ${renderAvatar(ch, ch.id)}<span class="rc-name">${ch.name}</span></div>`;
}

function initOverControls() {
  $('#btn-rematch').onclick = () => {
    $('#btn-rematch').disabled = true;   // debounce: one rematch request per game-over
    if (G.mode === 'online') {
      // Resets both engines to 'setup'; routeOnline re-opens the board builder
      // for both players.
      activeEngine.requestRematch();
    } else {
      // Local: reset both engines and run the hot-seat setup again.
      G.A.requestRematch();               // resets A and notifies B (which resets too)
      showPass({
        title: 'Rematch! Player 1 first 🙈', sub: 'Build a new board while Player 2 looks away.',
        buttonText: "I'm Player 1",
        onReady: () => enterSetup(G.A, () => {
          showPass({
            title: 'Player 2, new board 🙈', sub: 'Build yours while Player 1 looks away.',
            buttonText: "I'm Player 2",
            onReady: () => enterSetup(G.B, () => beginLocalTurn(G.A)),
          });
        }),
      });
    }
  };
  $('#btn-home').onclick = () => {
    if (G.channel) { G.channel.close(); G.channel = null; }
    G.mode = null; G.A = null; G.B = null; activeEngine = null;
    location.reload();
  };
}

/* ------------------------------- init ------------------------------- */
initHome();
initSetupControls();
initPlayControls();
initOverControls();
