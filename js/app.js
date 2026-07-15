// app.js — UI + orchestration for Guess Whoo!
import { generateRoster, renderAvatar, renderTraitStrip, TRAIT_LABELS, traitRows } from './characters.js';
import { createEngine, BOARD_SIZE } from './engine.js';
import { createOnlineChannel, createLocalPair, peerAvailable } from './net.js';

// The roster (name → randomised look) for the current match. Regenerated every
// game; in online play the host generates it and sends it so both sides match.
let ROSTER = [];
let CHAR_BY_ID = {};
function setRoster(arr) {
  ROSTER = arr || [];
  CHAR_BY_ID = Object.fromEntries(ROSTER.map((c) => [c.id, c]));
}

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

// Notice modal: a single OK button, for one-way alerts (e.g. "X is asking…").
function noticeModal({ title, body, okText = 'OK' }) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = body;
    $('#modal-ok').textContent = okText;
    const cancel = $('#modal-cancel');
    cancel.style.display = 'none';
    const overlay = $('#modal');
    overlay.classList.remove('hidden');
    $('#modal-ok').onclick = () => {
      overlay.classList.add('hidden');
      $('#modal-ok').onclick = null;
      cancel.style.display = '';   // restore for future confirm modals
      resolve(true);
    };
  });
}

function charCardHTML(ch, idx, extraClass = '') {
  return `<div class="char ${extraClass}" data-id="${ch.id}">
    <div class="char-face">${renderAvatar(ch, idx)}</div>
    <span class="cname">${ch.name}</span>
    ${renderTraitStrip(ch)}
  </div>`;
}

// Build the section-wise tooltip markup for a character.
function tooltipHTML(ch) {
  const rows = traitRows(ch).map((r) =>
    `<div class="tt-row"><span class="tt-label">${r.label}</span><span class="tt-val">${r.value}</span></div>`
  ).join('');
  return `<div class="tt-name">${ch.name}</div>${rows}`;
}

// Floating tooltip that shows a character's full trait breakdown on hover.
function initTooltip() {
  const tip = $('#tooltip');
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest('.char, .ms-card, .reveal-card');
    const ch = el && CHAR_BY_ID[Number(el.dataset.id)];
    if (!ch) { tip.classList.add('hidden'); return; }
    tip.innerHTML = tooltipHTML(ch);
    tip.classList.remove('hidden');
    const pad = 16;
    const r = tip.getBoundingClientRect();
    let left = e.clientX + pad, top = e.clientY + pad;
    if (left + r.width > window.innerWidth - 8) left = e.clientX - r.width - pad;
    if (top + r.height > window.innerHeight - 8) top = e.clientY - r.height - pad;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }, { passive: true });
  // Hide when the pointer leaves the window entirely.
  document.addEventListener('mouseleave', () => tip.classList.add('hidden'));
}

/* --------------------------- game controller ------------------------ */
const G = {
  mode: null,          // 'online' | 'local'
  channel: null,       // online transport
  A: null, B: null,    // local engines
};
let activeEngine = null;   // engine the play/over UI currently reflects
// Highlight filters (UI-only). Multi-select: { traitKey: Set(values) }.
// A card lights up when it matches EVERY active section (AND across sections),
// matching ANY selected value within a section (OR within a section).
let activeFilters = {};
function anyFilter() { return Object.values(activeFilters).some((set) => set.size > 0); }
function cardMatchesFilters(ch) {
  for (const [trait, vals] of Object.entries(activeFilters)) {
    if (vals.size && !vals.has(ch[trait])) return false;
  }
  return true;
}
function clearFilters() { activeFilters = {}; }

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
  engine.on('ask', (who) => noticeModal({
    title: `💬 ${who} is asking a question`,
    body: `<b>${escapeHTML(who)}</b> chose to ask a question this turn. Answer them (use the chat if you like) — they can't guess this turn.`,
    okText: 'Got it',
  }));
  engine.on('question', ({ question }) => showAnswerUI(engine, question));
  engine.on('answer', ({ text }) => toast('💬 Rival answered — ' + text));
  activeEngine = engine;
  return engine;
}

// Intercept the app-level `roster` message; everything else is an engine message.
function onOnlineMessage(m, engine) {
  if (m && m.type === 'roster') {
    setRoster(m.roster);
    // The guest opens the board builder once it has received the roster (the
    // host already did after generating it). During a rematch the engine reset
    // drives this instead, so only fire on a fresh, pre-setup engine.
    if (engine.state.phase === 'setup' && !engine.state.myReady
        && !screens.setup.classList.contains('active')) {
      enterSetup(engine);
    }
    return;
  }
  engine.handleMessage(m);
}

function hostOnline() {
  G.mode = 'online';
  G.channel = createOnlineChannel();
  const engine = makeOnlineEngine(true);
  G.channel.onData((m) => onOnlineMessage(m, engine));
  G.channel.onStatus((s) => setNetStatus(s));
  G.channel.onOpen(() => {
    setNetStatus('Opponent connected!', 'ok');
    const roster = generateRoster();          // host is authoritative for the cast
    setRoster(roster);
    G.channel.send({ type: 'roster', roster });
    enterSetup(engine);
  });
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
  G.channel.onData((m) => onOnlineMessage(m, engine));
  G.channel.onStatus((s) => setNetStatus(s));
  G.channel.onOpen(() => setNetStatus('Connected! Dealing the characters…', 'ok'));
  G.channel.onError(handleNetError);
  G.channel.join(code);
}

// Route online state changes to the right screen.
let prevOnlineTurn = null;
function routeOnline(s) {
  if (s.phase === 'setup') {
    prevOnlineTurn = null;
    // Only reached again after a rematch reset; re-enter the board builder.
    if (!screens.setup.classList.contains('active')) enterSetup(activeEngine);
  } else if (s.phase === 'waiting') {
    prevOnlineTurn = null;
    showPass({ title: 'Board locked in! 🔒', sub: 'Waiting for your opponent to finish setting up…' });
  } else if (s.phase === 'play') {
    ensurePlayView();
    // Announce when control passes TO me (i.e. the opponent just ended their turn).
    if (s.turn === 'me' && prevOnlineTurn === 'opp' && !s.pendingGuess) showTurnPopup();
    prevOnlineTurn = s.turn;
    renderPlay(s);
  } else if (s.phase === 'over') {
    prevOnlineTurn = null;
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
  setRoster(generateRoster());     // fresh random cast for this match
  const pair = createLocalPair();
  const A = createEngine({ isHost: true, myName: 'Player 1' });
  const B = createEngine({ isHost: false, myName: 'Player 2' });
  A.on('send', pair.a.send); pair.a.onData(A.handleMessage);
  B.on('send', pair.b.send); pair.b.onData(B.handleMessage);
  A.on('change', () => onLocalEngineChange(A));
  B.on('change', () => onLocalEngineChange(B));
  // Pass-and-play: the opponent isn't looking, so each engine answers a
  // structured question truthfully from its own secret. The answer shows in chat.
  A.on('question', ({ question }) => autoAnswer(A, question));
  B.on('question', ({ question }) => autoAnswer(B, question));
  A.on('answer', ({ text }) => { if (activeEngine === A) toast('💬 Answer — ' + text); });
  B.on('answer', ({ text }) => { if (activeEngine === B) toast('💬 Answer — ' + text); });
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
  clearFilters();          // a new game (or rematch) starts with no highlight
  setupCtx = { engine, onDone, picked: new Set(), secret: null, step: 1 };
  $('#setup-player').textContent = engine.state.myName;
  $('#setup-step').textContent = 'Step 1 of 2 — pick 20 characters';
  $('#setup-grid').innerHTML = ROSTER.map((c, i) => charCardHTML(c, i)).join('');
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
    const ids = ROSTER.map((c) => c.id);
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
function ensurePlayView() {
  // Only switch (and scroll) on the first entry into the board — otherwise every
  // state change would re-scroll the page to the top mid-game. (Filters persist
  // across turns and are only reset for a new game, in enterSetup.)
  if (!screens.play.classList.contains('active')) showScreen('play');
}

// Build the left-hand filter rail from the deduction board. Each trait value
// present on the board becomes a chip showing how many still-open cards have it;
// values whose cards are all crossed out are shown disabled. Multiple chips can
// be selected at once.
function renderFilters(s) {
  const panel = $('#filter-panel');
  const board = s.oppBoard || [];
  if (!board.length) { panel.innerHTML = ''; return; }
  const isOpen = (id) => s.deduction[id] !== false;

  // Header: how many open cards match the current selection, plus a Clear.
  let header = '';
  if (anyFilter()) {
    const matches = board.filter((id) => isOpen(id) && cardMatchesFilters(CHAR_BY_ID[id])).length;
    header = `<div class="filter-tally">
      <span><b>${matches}</b> match${matches === 1 ? '' : 'es'}</span>
      <button class="filter-clear" data-clear="1">Clear all</button>
    </div>`;
  }

  const sections = Object.entries(TRAIT_LABELS).map(([key, meta]) => {
    // Only values that actually appear on this board, in canonical order.
    const present = Object.keys(meta.values).filter((val) => board.some((id) => CHAR_BY_ID[id][key] === val));
    if (!present.length) return '';
    const sel = activeFilters[key];
    const chips = present.map((val) => {
      const count = board.filter((id) => CHAR_BY_ID[id][key] === val && isOpen(id)).length;
      const active = sel && sel.has(val);
      const off = count === 0;
      return `<button class="fchip${active ? ' active' : ''}${off ? ' off' : ''}"
        data-trait="${key}" data-value="${val}"${off ? ' disabled' : ''}>
        ${meta.values[val]} <span class="fc-n">${count}</span></button>`;
    }).join('');
    return `<div class="filter-sec"><div class="fs-title">${meta.name}</div><div class="fs-chips">${chips}</div></div>`;
  }).join('');
  panel.innerHTML = header + sections;
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
    ? `<div class="ms-card" data-id="${mine.id}">
         ${renderAvatar(mine, mine.id)}<span class="ms-name">${mine.name}</span>
       </div>`
    : '';

  // Drop only filter values whose last matching open card is gone — never on an
  // unrelated card being crossed out. (This is why the highlight now persists
  // while you disable cards.)
  for (const trait of Object.keys(activeFilters)) {
    for (const v of [...activeFilters[trait]]) {
      const stillThere = (s.oppBoard || []).some((id) =>
        s.deduction[id] !== false && CHAR_BY_ID[id][trait] === v);
      if (!stillThere) activeFilters[trait].delete(v);
    }
    if (activeFilters[trait].size === 0) delete activeFilters[trait];
  }

  // Board of the opponent's characters (my deduction surface). Cards are always
  // clickable — crossing them off is private note-taking allowed any time.
  const grid = $('#play-grid');
  const guessing = s.guessing && myTurn;
  const filtering = anyFilter();
  grid.classList.toggle('filtering', filtering);
  grid.innerHTML = (s.oppBoard || []).map((id, i) => {
    const ch = CHAR_BY_ID[id];
    const isClosed = s.deduction[id] === false;
    let extra = '';
    if (isClosed) extra += ' closed';
    if (guessing && !isClosed) extra += ' guessable';
    if (filtering && !isClosed && cardMatchesFilters(ch)) extra += ' lit';
    return charCardHTML(ch, i, extra.trim());
  }).join('');

  renderFilters(s);
  renderChat(s);
  updateControls(s);
}

function updateControls(s) {
  const myTurn = s.turn === 'me' && !s.pendingGuess && s.phase === 'play';
  const askBtn = $('#btn-ask');
  const guessBtn = $('#btn-guess');
  const endBtn = $('#btn-endturn');
  const banner = $('#mode-banner');
  banner.className = 'mode-banner hidden';
  guessBtn.textContent = '🎯 Make a Guess';
  askBtn.textContent = '💬 Ask a Question';

  if (!myTurn) {
    askBtn.disabled = true; guessBtn.disabled = true; endBtn.disabled = true;
    if (s.pendingGuess) { banner.textContent = 'Your guess is on its way…'; banner.className = 'mode-banner guess'; }
    else { banner.textContent = '✍️ Not your turn — but you can still cross cards off as you deduce.'; banner.className = 'mode-banner note'; }
    return;
  }

  if (s.guessing) {
    // In guess-selection mode: tap a card to guess, or cancel.
    askBtn.disabled = true;
    guessBtn.disabled = false; guessBtn.textContent = '✖ Cancel guess';
    endBtn.disabled = false;
    banner.textContent = '🎯 Guess mode — tap your rival\'s secret, or Cancel to keep deducing.';
    banner.className = 'mode-banner guess';
  } else if (s.asked) {
    // Asked a question this turn → guessing is locked until next turn.
    askBtn.disabled = true; askBtn.textContent = '💬 Question asked';
    guessBtn.disabled = true;
    endBtn.disabled = false;
    banner.textContent = '💬 You asked a question — no guessing this turn. Cross off who doesn\'t fit, then End Turn.';
    banner.className = 'mode-banner ask';
  } else {
    askBtn.disabled = false;
    guessBtn.disabled = false;
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
  if (s.phase !== 'play') return;

  // Guess-selection mode (only on my turn): tap a card to guess it.
  if (s.guessing && s.turn === 'me' && !s.pendingGuess) {
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

  // Otherwise a click just crosses the card off (or back on) — your private
  // notes, allowed any time, even when it isn't your turn.
  e.toggleCard(id);
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

  $('#btn-ask').onclick = () => openQuestionBuilder();

  $('#btn-guess').onclick = () => {
    const e = activeEngine; const s = e.state;
    if (s.turn !== 'me' || s.pendingGuess) return;
    if (s.guessing) { e.cancelGuess(); return; }
    if (s.asked) { toast('You asked a question this turn — no guessing now.'); return; }
    e.beginGuess();
  };

  $('#btn-endturn').onclick = () => {
    const e = activeEngine; const s = e.state;
    if (s.turn !== 'me' || s.pendingGuess) return;
    if (s.guessing) e.cancelGuess();   // back out of an un-made guess, then pass
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

  // Filter rail: tap trait chips (any number) to light up matching cards.
  $('#filter-panel').addEventListener('click', (e) => {
    if (!activeEngine) return;
    if (e.target.closest('[data-clear]')) { clearFilters(); renderPlay(activeEngine.state); return; }
    const btn = e.target.closest('.fchip');
    if (!btn || btn.disabled) return;
    const trait = btn.dataset.trait, value = btn.dataset.value;
    const set = activeFilters[trait] || (activeFilters[trait] = new Set());
    if (set.has(value)) set.delete(value); else set.add(value);   // toggle
    if (set.size === 0) delete activeFilters[trait];
    renderPlay(activeEngine.state);
  });
}

/* --------------------- "it's your turn" popup (online) -------------- */
let turnPopupTimer = null;
function showTurnPopup() {
  const el = $('#turn-popup');
  el.classList.remove('hidden');
  clearTimeout(turnPopupTimer);
  turnPopupTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}
function initTurnPopup() {
  $('#tp-ok').onclick = () => { clearTimeout(turnPopupTimer); $('#turn-popup').classList.add('hidden'); };
}

/* -------------------- structured (predefined) questions ------------- */
// One question is about a SINGLE trait with one or more values (joined by OR),
// e.g. { trait:'glasses', values:['none','sun'] } → "Glasses: None or Sunglasses".
let qbTrait = null;          // the chosen section (trait key), or null
let qbValues = new Set();    // the picked values within that section

const buildQuestionText = (q) => {
  const meta = TRAIT_LABELS[q.trait];
  if (!meta) return '';
  return `${meta.name}: ${q.values.map((v) => meta.values[v]).join(' or ')}`;
};
const buildAnswerText = (q, yes) => `${buildQuestionText(q)} → ${yes ? 'Yes' : 'No'}`;
const computeTruth = (secretId, q) => {
  const ch = CHAR_BY_ID[secretId];
  return !!ch && q.values.includes(ch[q.trait]);
};
const qbQuestion = () => (qbTrait && qbValues.size ? { trait: qbTrait, values: [...qbValues] } : null);

function openQuestionBuilder() {
  const e = activeEngine; if (!e) return;
  const s = e.state;
  if (s.turn !== 'me' || s.pendingGuess || s.asked || s.guessing) return;
  qbTrait = null; qbValues = new Set();
  renderQBuilder();
  $('#qbuilder').classList.remove('hidden');
}

function renderQBuilder() {
  $('#qb-panel').innerHTML = Object.entries(TRAIT_LABELS).map(([key, meta]) => {
    // Once a section is chosen, the others are locked (one section per question).
    const locked = qbTrait && qbTrait !== key;
    const chips = Object.entries(meta.values).map(([val, label]) => {
      const active = qbTrait === key && qbValues.has(val);
      return `<button class="fchip${active ? ' active' : ''}${locked ? ' off' : ''}" data-trait="${key}" data-value="${val}"${locked ? ' disabled' : ''}>${label}</button>`;
    }).join('');
    return `<div class="filter-sec${locked ? ' locked' : ''}"><div class="fs-title">${meta.name}</div><div class="fs-chips">${chips}</div></div>`;
  }).join('');
  const q = qbQuestion();
  $('#qb-summary').innerHTML = q
    ? `<b>Your question:</b> ${escapeHTML(buildQuestionText(q))}?`
    : '<span class="qb-empty">Pick one section, then one or more options (they count as “or”). Or just ask out loud in the chat.</span>';
  $('#qb-send').disabled = !q;
}

// The opponent answers a structured question (online), one yes/no. Honesty is
// enforced: clicking the untruthful button warns instead of recording.
function showAnswerUI(engine, question) {
  if (!question) return;
  const rows = $('#qa-rows');
  $('#qa-title').textContent = `🙋 ${engine.state.oppName || 'Your rival'} asks:`;
  rows.innerHTML = `<div class="qa-row">
    <div class="qa-q">Does your character have <b>${escapeHTML(buildQuestionText(question))}</b>?</div>
    <div class="qa-btns">
      <button class="btn ghost" data-ans="yes">Yes</button>
      <button class="btn ghost" data-ans="no">No</button>
    </div></div>`;
  $('#qanswer').classList.remove('hidden');
  const truth = computeTruth(engine.state.mySecret, question);
  rows.onclick = async (ev) => {
    const btn = ev.target.closest('button[data-ans]'); if (!btn) return;
    const said = btn.dataset.ans === 'yes';
    if (said !== truth) {
      await noticeModal({
        title: '🚫 Answer honestly!',
        body: `Your character <b>${truth ? 'does' : 'does not'}</b> match <b>${escapeHTML(buildQuestionText(question))}</b>. Please answer truthfully.`,
        okText: 'Oops — ok',
      });
      return;
    }
    engine.answerStructured(said, buildAnswerText(question, said));
    $('#qanswer').classList.add('hidden');
    rows.onclick = null;
  };
}

// In pass-and-play the opponent isn't looking, so the app answers truthfully
// from their (the other engine's) secret automatically.
function autoAnswer(engine, question) {
  if (!question) return;
  const yes = computeTruth(engine.state.mySecret, question);
  engine.answerStructured(yes, buildAnswerText(question, yes));
}

function initQuestionUI() {
  $('#qb-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('.fchip'); if (!btn || btn.disabled) return;
    const t = btn.dataset.trait, v = btn.dataset.value;
    if (qbTrait !== t) { qbTrait = t; qbValues = new Set(); }   // switching sections resets
    if (qbValues.has(v)) qbValues.delete(v); else qbValues.add(v);
    if (qbValues.size === 0) qbTrait = null;                     // fully cleared → any section
    renderQBuilder();
  });
  $('#qb-cancel').onclick = () => $('#qbuilder').classList.add('hidden');
  $('#qb-outloud').onclick = () => {
    $('#qbuilder').classList.add('hidden');
    const e = activeEngine;
    if (e && e.askQuestion()) toast('Question asked out loud — cross off who doesn\'t fit, then End Turn.');
  };
  $('#qb-send').onclick = () => {
    const e = activeEngine; if (!e) return;
    const q = qbQuestion();
    if (!q) return;
    if (e.askStructured(q, buildQuestionText(q))) {
      $('#qbuilder').classList.add('hidden');
      toast(G.mode === 'online' ? 'Question sent — waiting for a reply.' : 'Question asked!');
    }
  };
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

  // Full chat transcript, labelled with who said what — so you can see who lied.
  const meName = s.myName || 'You';
  const oppName = s.oppName || 'Rival';
  const chatEl = $('#over-chat');
  if (s.chat && s.chat.length) {
    const lines = s.chat.map((m) => {
      const who = m.from === 'me' ? meName : oppName;
      return `<div class="oc-line ${m.from === 'me' ? 'me' : 'opp'}">
        <span class="oc-who">${escapeHTML(who)}</span>
        <span class="oc-text">${escapeHTML(m.text)}</span></div>`;
    }).join('');
    chatEl.innerHTML = `<h4 class="oc-title">💬 What was said</h4><div class="oc-log">${lines}</div>`;
    chatEl.classList.remove('hidden');
  } else {
    chatEl.innerHTML = '';
    chatEl.classList.add('hidden');
  }

  showScreen('over');
}
function revealCardHTML(label, ch) {
  return `<div class="reveal-card" data-id="${ch.id}"><span class="rc-label">${label}</span>
    ${renderAvatar(ch, ch.id)}<span class="rc-name">${ch.name}</span></div>`;
}

function initOverControls() {
  $('#btn-rematch').onclick = () => {
    $('#btn-rematch').disabled = true;   // debounce: one rematch request per game-over
    if (G.mode === 'online') {
      // Deal a fresh cast, share it, then reset both engines to 'setup';
      // routeOnline re-opens the board builder for both players.
      const roster = generateRoster();
      setRoster(roster);
      G.channel.send({ type: 'roster', roster });
      activeEngine.requestRematch();
    } else {
      // Local: fresh cast, reset both engines, run the hot-seat setup again.
      G.A.requestRematch();               // resets A and notifies B (which resets too)
      setRoster(generateRoster());
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
initTooltip();
initTurnPopup();
initQuestionUI();
