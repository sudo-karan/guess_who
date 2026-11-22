// app.js — UI + orchestration for Guess Whoo!
import { generateRoster, renderAvatar, TRAIT_LABELS, traitRows } from './characters.js';
import { createEngine, BOARD_SIZE } from './engine.js';
import { createLocalPair, savedTurn, saveTurn } from './net.js';
import { createGameChannel } from './channel.js';
import { createReliableChannel } from './reliable.js';
import { saveSession, loadSession, clearSession } from './session.js';
import { relayAvailable } from './relay.js';
import { createLobby, ROOM_STATUS } from './lobby.js';
import { commonTraitsText, netBatchesByTurnActor } from './loganalysis.js';
import { robotSetup, openCandidates, chooseQuestion, shouldGuess, cardsToCrossOff, pickGuess } from './ai.js';

// The roster (name → randomised look) for the current match. Regenerated every
// game; in online play the host generates it and sends it so both sides match.
let ROSTER = [];
let CHAR_BY_ID = {};
function setRoster(arr) {
  ROSTER = arr || [];
  CHAR_BY_ID = Object.fromEntries(ROSTER.map((c) => [c.id, c]));
  // The cast is part of a saved game, and this is the only moment it changes.
  // Saving only on an engine change meant a reload during board building
  // restored a game with no characters in it at all, which there is no way out
  // of. Harmless in the other modes: the save no-ops unless a room is live.
  saveSessionNow();
}

/* ------------------------------ helpers ----------------------------- */
const $ = (sel) => document.querySelector(sel);
const screens = {
  home: $('#screen-home'), setup: $('#screen-setup'), pass: $('#screen-pass'),
  play: $('#screen-play'), over: $('#screen-over'),
};
function showScreen(name) {
  closeCardDetail();
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
  closeCardDetail();
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
  closeCardDetail();
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
    ${renderAvatar(ch, idx)}<span class="cname">${ch.name}</span>
  </div>`;
}

// Build the section-wise tooltip markup for a character.
function tooltipHTML(ch) {
  const rows = traitRows(ch).map((r) =>
    `<div class="tt-row"><span class="tt-label">${r.label}</span><span class="tt-val">${r.value}</span></div>`
  ).join('');
  return `<div class="tt-name">${ch.name}</div>${rows}`;
}

const CARD_SEL = '.char, .ms-card, .reveal-card, .log-card';

// Does this device point with a finger rather than a mouse? Checked once per
// call rather than cached, so a tablet with a keyboard attached behaves sensibly
// either way.
function isTouch() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(hover: none), (pointer: coarse)').matches
    : false;
}

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 12;   // a finger that drifts this far is scrolling, not holding
const BACKDROP_GRACE_MS = 300;

// Which kind of pointer was used last. A Windows touchscreen laptop and an iPad
// with a trackpad do both, and report `hover: hover` while still sending touch
// events, so no media query can answer this. Each event says what it was.
let lastPointer = 'mouse';

// The card panel covers the whole screen, so anything else that takes the screen
// over has to close it first. Left open, it sat on top of modals whose only
// button was then impossible to reach, and floated over the next screen.
function closeCardDetail() {
  const p = $('#card-detail');
  if (!p) return;
  if (p.open) { try { p.close(); } catch (_) { p.removeAttribute('open'); } }
  else p.removeAttribute('open');
}

// Two ways to see a character's traits, one per kind of device.
//
// With a mouse, the tooltip follows the pointer. On a touch screen that same
// code used to fire on a plain tap (browsers synthesise mouse events from taps)
// and then stay on screen, because there is no pointer to move away. So touch
// devices get a panel you open by pressing and holding, and close deliberately.
// A plain tap is left alone, since that is how you pick and cross off cards.
function initTooltip() {
  const tip = $('#tooltip');
  const panel = $('#card-detail');
  const body = $('#cd-body');

  if (isTouch()) { document.body.classList.add('touch'); lastPointer = 'touch'; }

  /* ---------------------------- mouse ---------------------------- */
  // pointermove rather than mousemove, because it says whether this was a real
  // mouse. A tap synthesises mouse events, and acting on those put a tooltip on
  // screen with no pointer to move away from it, so it stayed there. Keying off
  // the device instead cost hybrid machines the hover tooltip altogether.
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType) lastPointer = e.pointerType;
    // A pen hovers like a mouse and sends no touch events, so it gets the
    // tooltip too. Without it a stylus-only machine has no way at all to read a
    // card: no hover, and no press-and-hold to fall back on.
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') {
      tip.classList.add('hidden');
      return;
    }
    const el = e.target.closest(CARD_SEL);
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
  document.addEventListener('mouseleave', () => tip.classList.add('hidden'));

  // A real mouse coming back means the browser's own text selection and callout
  // on cards are wanted again.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType) lastPointer = e.pointerType;
    if (e.pointerType === 'mouse') document.body.classList.remove('touch');
  }, { passive: true });

  /* ------------------------ press and hold ----------------------- */
  let timer = null, startX = 0, startY = 0, swallowClick = false;
  let pressId = null;      // the finger that started this press
  let openedAt = 0;

  const endPress = () => { clearTimeout(timer); timer = null; pressId = null; };
  const findTouch = (list, id) => {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  };

  // Anything already demanding an answer wins. Closing the panel when an overlay
  // arrives only fixed one of the two orderings; a hold that starts while one is
  // already up would still have covered it.
  const overlayUp = () => ['#modal', '#qanswer', '#qbuilder']
    .some((sel) => {
      const el = $(sel);
      return el && !el.classList.contains('hidden');
    });

  const open = (ch) => {
    if (overlayUp()) return;
    body.innerHTML = tooltipHTML(ch);
    openedAt = Date.now();
    if (!panel.open) {
      try { panel.showModal(); } catch (_) { panel.setAttribute('open', ''); }
    }
    const btn = $('#cd-close');
    if (btn) btn.focus();
  };

  document.addEventListener('touchstart', (e) => {
    lastPointer = 'touch';
    document.body.classList.add('touch');
    if (timer) return;      // a hold is already running: a stray second finger is not its business
    // Starting a new touch always clears the last one's leftovers. Without this,
    // a long press that the browser does not follow with a click would leave the
    // flag set and swallow the player's next tap instead.
    swallowClick = false;
    if (e.touches.length > 1) { endPress(); return; }
    const t = e.changedTouches[0];
    const el = t && t.target && t.target.closest ? t.target.closest(CARD_SEL) : null;
    const ch = el && CHAR_BY_ID[Number(el.dataset.id)];
    if (!ch) { endPress(); return; }
    pressId = t.identifier;
    startX = t.clientX; startY = t.clientY;
    timer = setTimeout(() => {
      timer = null;
      swallowClick = true;      // the tap that ends this hold must not also play the card
      tip.classList.add('hidden');
      open(ch);
    }, LONG_PRESS_MS);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!timer || pressId === null) return;
    // Follow the finger that started the press, not whichever is first in the
    // list. With one finger resting on a card while another pinches, the first
    // one never moves, so the hold used to fire in the middle of a pinch-zoom.
    const t = findTouch(e.touches, pressId);
    if (!t || e.touches.length > 1) { endPress(); return; }
    const dx = t.clientX - startX, dy = t.clientY - startY;
    if (Math.hypot(dx, dy) > LONG_PRESS_SLOP) endPress();   // they are scrolling
  }, { passive: true });

  // Non-passive on purpose. Once the hold has fired, this stops the browser
  // synthesising a mouse sequence on release, which was blurring the panel's
  // close button the instant it appeared and letting the same release count as a
  // tap on the backdrop. A second finger lifting is not the end of the press.
  // The click we are guarding against, if the platform sends one at all, follows
  // within a moment. Give up waiting for it rather than leaving the guard armed:
  // a keyboard press on the focused close button also arrives as a click, and
  // swallowing that left no way to shut the panel without a mouse.
  const disarmSoon = () => {
    if (swallowClick) setTimeout(() => { swallowClick = false; }, 400);
  };

  document.addEventListener('touchend', (e) => {
    if (swallowClick && e.cancelable) e.preventDefault();
    if (pressId === null || findTouch(e.changedTouches, pressId)) endPress();
    disarmSoon();
  }, { passive: false });
  // A gesture the browser takes over (a scroll it decides to own, an incoming
  // call) ends in a cancel rather than an end. Disarm there too, or the guard
  // stays up for the life of the page and eats the next tap on a card.
  document.addEventListener('touchcancel', () => { endPress(); disarmSoon(); }, { passive: true });

  // Backstop for platforms that send the click anyway. Only over a card, which
  // is the thing worth guarding: holding a card to read it must not also cross it
  // off. Swallowing every click instead ate a deliberate tap on the close button
  // in the moment after the release, which is exactly when it gets tapped.
  document.addEventListener('click', (e) => {
    if (!swallowClick) return;
    if (!e.target.closest(CARD_SEL)) return;
    swallowClick = false;
    e.preventDefault(); e.stopPropagation();
  }, true);

  // Android pops its own menu on a long press; ours replaces it. Only for a
  // finger: a right-click on a touchscreen laptop still deserves the real menu.
  document.addEventListener('contextmenu', (e) => {
    if (lastPointer !== 'mouse' && e.target.closest(CARD_SEL)) e.preventDefault();
  });

  $('#cd-close').onclick = closeCardDetail;
  // Tapping the dim area closes it, but not with the very gesture that opened it.
  panel.addEventListener('click', (e) => {
    if (e.target !== panel) return;
    if (Date.now() - openedAt < BACKDROP_GRACE_MS) return;
    closeCardDetail();
  });
  // A modal dialog handles Escape itself. This is for the fallback path, where
  // showModal was unavailable and the panel was opened by hand: there is no
  // native Escape there, and without this it could only be closed by tapping.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.open) closeCardDetail();
  });
  panel.addEventListener('close', () => { body.innerHTML = ''; });
}

/* --------------------------- game controller ------------------------ */
const G = {
  mode: null,          // 'online' | 'local'
  channel: null,       // online transport
  A: null, B: null,    // local engines
};
let activeEngine = null;   // engine the play/over UI currently reflects
let lobby = null;          // serverless room-discovery client (online only)
let hostedRoom = null;     // the code of the room THIS browser is hosting, if any
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
    if (!relayAvailable()) toast('Online needs a connection. You can still Pass & Play.');
    $('#online-panel').classList.toggle('hidden');
    $('#how-panel').classList.add('hidden');
    // Start room discovery the moment the online panel is opened.
    if (!$('#online-panel').classList.contains('hidden')) ensureLobby();
  };
  $('#btn-how').onclick = () => {
    $('#how-panel').classList.toggle('hidden');
    $('#online-panel').classList.add('hidden');
  };
  $('#btn-how-close').onclick = () => $('#how-panel').classList.add('hidden');
  $('#btn-local').onclick = startLocal;

  // Play a robot: reveal the difficulty picker, then start on a choice.
  $('#btn-robot').onclick = () => {
    $('#robot-panel').classList.toggle('hidden');
    $('#online-panel').classList.add('hidden');
    $('#how-panel').classList.add('hidden');
  };
  $('#robot-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('.diff');
    if (btn) startRobot(btn.dataset.diff);
  });

  // Online: host
  $('#btn-host').onclick = () => hostOnline();
  $('#btn-join').onclick = () => joinOnline();
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinOnline(); });

  // A saved game we already gave up on: try that room again, or let it go.
  $('#btn-resume').onclick = () => {
    const saved = loadSession();
    $('#resume-row').classList.add('hidden');
    if (!saved) { setNetStatus('That game has expired. Create a new room instead.'); return; }
    setNetStatus(saved.isHost ? 'Re-opening your room…' : 'Reconnecting…');
    if (saved.isHost) hostOnline(saved);
    else joinOnline(null, saved);
  };
  $('#btn-forget').onclick = () => {
    forgetSession();
    $('#resume-row').classList.add('hidden');
    setNetStatus('');
  };

  // Room browser: refresh + "request to join" a listed room.
  $('#btn-refresh-rooms').onclick = () => ensureLobby();
  $('#room-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.rb-join');
    if (btn && btn.dataset.code) joinOnline(btn.dataset.code);
  });
  $('#btn-copy').onclick = () => {
    const code = $('#code-value').textContent;
    navigator.clipboard && navigator.clipboard.writeText(code).then(
      () => toast('Code copied!'), () => {});
  };

  // Advanced escape hatch: your own TURN server, for a direct connection on a
  // network that blocks peer-to-peer. Stored only in this browser.
  const turn = savedTurn();
  if (turn) {
    $('#turn-url').value = [].concat(turn.urls)[0] || '';
    $('#turn-user').value = turn.username || '';
    $('#turn-pass').value = turn.credential || '';
  }
  wireNetDetails();
  $('#btn-save-turn').onclick = () => {
    const urls = $('#turn-url').value.trim();
    if (!urls) { saveTurn(null); toast('TURN server cleared.'); return; }
    saveTurn({ urls, username: $('#turn-user').value.trim(), credential: $('#turn-pass').value.trim() });
    toast('Saved. It will be used the next time you host or join.');
  };
}

function setNetStatus(msg, kind = '') {
  const el = $('#net-status');
  el.textContent = msg; el.className = 'net-status ' + kind;
}

/* ------------------------- connection diagnostics ------------------------- */
// Say which route the game found. Falling back to the relay is a success, not a
// fault — but it should never look like one, or like a bug.
function noteTransport() {
  hideNetDetails();
  if (G.channel && G.channel.mode && G.channel.mode() === 'relay') {
    toast('🔁 Connected through the relay, because your network blocked a direct link.');
  }
}

// Show what is actually happening. Available (collapsed) for the whole of an
// online attempt and opened automatically on a failure — a room that just sits
// there waiting never raises an error, which is precisely when a player most
// needs to see whether anything is listening.
function showNetDetails(open = true) {
  const box = $('#net-details'), body = $('#net-details-body');
  if (!box || !body) return;
  renderNetDetails();
  box.classList.remove('hidden');
  if (open) box.open = true;
}

function renderNetDetails() {
  const body = $('#net-details-body');
  if (!body) return;
  const d = (G.channel && G.channel.diagnostics && G.channel.diagnostics()) || {};
  const rows = { ...d, page: (typeof location !== 'undefined' && location.host) || 'local' };
  body.textContent = Object.entries(rows)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function hideNetDetails() {
  const box = $('#net-details');
  if (box) { box.classList.add('hidden'); box.open = false; }
}

// Re-read the live state each time the player opens the panel, so what they copy
// to us is current rather than a snapshot from when it was first revealed.
function wireNetDetails() {
  const box = $('#net-details');
  if (box) box.addEventListener('toggle', () => { if (box.open) renderNetDetails(); });
}

/* ------------------------------ lobby ------------------------------- */
// Start (or refresh) serverless room discovery. Populates the room browser.
let lobbyGotRooms = false;      // has the coordinator ever answered us?
let lobbyWatchdog = null;
function ensureLobby() {
  if (lobby) { lobby.refresh(); return; }
  if (!relayAvailable()) {
    renderRoomsMessage('Online room discovery needs an internet connection. You can still Pass & Play.');
    return;
  }
  lobbyGotRooms = false;
  lobby = createLobby({ onRooms: renderRooms, onStatus: onLobbyStatus });
  lobby.start();
  lobby.refresh();
  // If the room list never answers, say so instead of showing a bare "no rooms"
  // (which reads as "my room isn't listed"). Joining by code always still works.
  clearTimeout(lobbyWatchdog);
  lobbyWatchdog = setTimeout(() => {
    if (!lobbyGotRooms) {
      renderRoomsMessage('Couldn\'t reach the shared room list. Share your room code directly, which still works.');
    }
  }, 12000);
}

function onLobbyStatus(kind) {
  // Only surface a message while the list is still empty, so we don't stomp on
  // a populated list once rooms come in.
  const el = $('#room-list');
  if (!el || el.querySelector('.room-card')) return;
  if (kind === 'reconnecting') renderRoomsMessage('Reconnecting to the room list…');
  else if (kind === 'throttled') renderRoomsMessage('The room list is rate-limited right now. Hosting and joining by code still work.');
  else if (kind === 'error') renderRoomsMessage('Couldn\'t reach the room list right now. Hosting and joining by code still work.');
}

function renderRoomsMessage(msg) {
  const el = $('#room-list');
  if (el) el.innerHTML = `<p class="rb-empty">${escapeHTML(msg)}</p>`;
}

// Render the live list of rooms. Your OWN room is shown too (marked "Your room")
// so you can confirm it's being advertised — you just can't join it.
function renderRooms(rooms) {
  const el = $('#room-list');
  if (!el) return;
  lobbyGotRooms = true;
  const shown = (rooms || []).filter((r) => r.status !== ROOM_STATUS.ENDED);
  if (!shown.length) {
    renderRoomsMessage('No open rooms yet. Host one above and share the code, or wait for a friend to appear here.');
    return;
  }
  el.innerHTML = shown.map((r) => {
    const mine = r.code === hostedRoom;
    const joinable = r.status === ROOM_STATUS.OPEN && !mine;
    const chip = mine
      ? '<span class="rb-chip mine">Your room</span>'
      : (r.status === ROOM_STATUS.OPEN
        ? '<span class="rb-chip open">Open</span>'
        : '<span class="rb-chip playing">In game</span>');
    return `<div class="room-card${mine ? ' mine' : ''}">
      <div class="rc-info"><span class="rc-host">${escapeHTML(r.hostName)}'s room</span>${chip}</div>
      ${mine
        ? `<button class="btn tiny" disabled>Code ${escapeHTML(r.code)}</button>`
        : joinable
        ? `<button class="btn tiny primary rb-join" data-code="${escapeHTML(r.code)}">Request to join</button>`
        : '<button class="btn tiny" disabled>Game in progress</button>'}
    </div>`;
  }).join('');
}

// Host: a guest is asking to join — approve or decline. Requests are SERIALISED
// through one queue: confirmModal reuses a single shared #modal, so two overlapping
// prompts would clobber each other's handlers and strand the first guest.
let approvalQueue = [];
let approvalBusy = false;
function showJoinApproval(who, ctl) {
  approvalQueue.push({ who, ctl });
  drainApprovals();
}
async function drainApprovals() {
  if (approvalBusy) return;
  approvalBusy = true;
  // try/finally matters more than it looks: if anything in here threw, the busy
  // flag would stay set and EVERY later join request would be queued and silently
  // never shown — the host just never gets a popup.
  try {
    while (approvalQueue.length) {
      const { who, ctl } = approvalQueue.shift();
      // eslint-disable-next-line no-await-in-loop
      const ok = await confirmModal({
        title: '🙋 Join request',
        body: `<b>${escapeHTML(who)}</b> wants to join your room. Let them in?`,
        okText: 'Approve', cancelText: 'Decline',
      });
      try { if (ok) ctl.accept(); else ctl.deny(); } catch (_) { /* that guest is gone */ }
    }
  } finally {
    approvalBusy = false;
  }
}

// Mark this browser's hosted room as finished and drop it from the lobby.
function endHostedRoom() {
  if (lobby && hostedRoom) {
    lobby.setStatus(hostedRoom, ROOM_STATUS.ENDED);
    lobby.unpublish(hostedRoom);
  }
  hostedRoom = null;
}

// Tear down any current online game channel + hosted-room advertisement, so we
// never leave a second (stale, "unavailable") room behind or a dangling peer.
function teardownOnline() {
  netRecovered();        // a pending countdown must not outlive the game that lit it
  const offer = $('#resume-row');
  if (offer) offer.classList.add('hidden');   // starting or leaving a game makes it moot
  endHostedRoom();
  if (G.channel) { try { G.channel.close(); } catch (_) {} G.channel = null; }
}

/* ------------------------------ online ------------------------------ */
function makeOnlineEngine(isHost, forcedName) {
  const name = forcedName
    || ($('#online-name').value || '').trim().slice(0, 14)
    || (isHost ? 'Player 1' : 'Player 2');
  const engine = createEngine({ isHost, myName: name });
  engine.on('send', (m) => G.channel.send(m));
  engine.on('log', (t) => toast(t));
  engine.on('change', (s) => { routeOnline(s); saveSessionNow(); });
  engine.on('ask', (who) => noticeModal({
    title: `💬 ${who} is asking a question`,
    body: `<b>${escapeHTML(who)}</b> chose to ask a question this turn. Answer them (use the chat if you like). They can't guess this turn.`,
    okText: 'Got it',
  }));
  engine.on('question', ({ question }) => showAnswerUI(engine, question));
  engine.on('answer', ({ text }) => toast('💬 Rival answered: ' + text));
  activeEngine = engine;
  return engine;
}

// Intercept the app-level `roster` message; everything else is an engine message.
function onOnlineMessage(m, engine) {
  // Traffic arriving is proof the opponent is still connected: clear any
  // interruption warning and cancel the countdown to "Opponent left".
  netRecovered();
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

// `resume` is a saved game being picked back up after a reload, in which case
// the room keeps its old code and the engine is restored rather than rebuilt.
function hostOnline(resume) {
  const name = resume ? resume.myName
    : (($('#online-name').value || '').trim().slice(0, 14) || 'Player 1');
  // Re-hosting must not leak a second room or leave the old game peer alive.
  teardownOnline();
  G.mode = 'online';
  gaveUp = !!(resume && resume.gaveUp);   // keep it until we are genuinely back in
  G.channel = createReliableChannel(createGameChannel());
  const engine = makeOnlineEngine(true, name);
  // Is there actually a match to protect? The cast is dealt the moment the first
  // guest is let in, so having one is the test. A host that reloads while still
  // waiting in the lobby has nothing to restore, and treating that as a match in
  // progress stranded it on an empty board builder with a room that refused
  // everyone who tried to join, for as long as the tab stayed open.
  const inProgress = !!(resume && resume.roster && resume.roster.length);
  if (resume) {
    // The token has to go back into this module too, not just into the channel:
    // the transports only announce a token at the moment they mint one, so a
    // restored host is never told it again. Without this every save after a
    // refresh wrote token: null, and the SECOND refresh locked the opponent out.
    sessionToken = resume.token;
    resumeEpoch = resume.epoch || 0;
    G.channel.useSessionToken(resume.token);
  }
  if (inProgress) {
    setRoster(resume.roster);
    engine.restore(resume.engine);
    // Put back whatever was in flight when the page went, now, while the channel
    // exists but has nowhere to send. It sits in the outbox, so it is in every
    // save from here on, and goes out under fresh numbering once the opponent is
    // back. Waiting for that moment meant the first attempt had already saved an
    // empty list over it, and a second attempt had nothing left to replay.
    G.channel.requeue(resume.pending);
  }
  G.channel.onData((m) => onOnlineMessage(m, engine));
  G.channel.onStatus((s) => setNetStatus(s));
  G.channel.onJoinRequest((who, ctl) => {
    // A restored match is already underway. Its own opponent comes back holding a
    // token and is recognised before ever reaching here, so anyone who does reach
    // here is a stranger knocking mid-game. Approving them would deal a
    // brand-new cast over both players' boards.
    if (inProgress) {
      ctl.deny();
      setNetStatus(`${who} asked to join, but your game is already in progress.`);
      return;
    }
    showJoinApproval(who, ctl);
  });
  G.channel.onHealthy(netRecovered);
  G.channel.onToken((t) => { sessionToken = t; saveSessionNow(); });
  G.channel.onPending(saveSessionNow);
  G.channel.onResumed(() => {
    stopRejoining();
    gaveUp = false;           // they are back: this game is live again
    setNetStatus('Opponent reconnected.', 'ok');
    netRecovered();
    saveSessionNow();
    routeOnline(engine.state);        // back to whatever screen the game was on
  });
  G.channel.onOpen(() => {
    if (inProgress) return;   // backstop: a restored match never deals a new cast
    setNetStatus('Opponent connected!', 'ok');
    noteTransport();
    if (lobby && hostedRoom) lobby.setStatus(hostedRoom, ROOM_STATUS.PLAYING);  // room now in-game
    const roster = generateRoster();          // host is authoritative for the cast
    setRoster(roster);
    G.channel.send({ type: 'roster', roster });
    enterSetup(engine);
  });
  G.channel.onError(handleNetError);
  G.channel.host((code) => {
    $('#host-code').classList.remove('hidden');
    $('#code-value').textContent = code;
    showNetDetails(false);   // available, collapsed: lets the host confirm it is listening
    hostedRoom = code;
    resumeCtx = { code, isHost: true, myName: name };
    saveSessionNow();
    if (inProgress) { setNetStatus('Room re-opened. Waiting for your opponent to come back…'); return; }
    // Advertise the room so friends can find it in the browser.
    ensureLobby();
    if (lobby) lobby.publish({ code, hostName: name, status: ROOM_STATUS.OPEN });
  }, resume && resume.code);
}

/* ------------------- surviving a reload, online only ------------------ */
// What it takes to pick this game back up: which room, which side, the cast,
// the token that proves we were already in it, and the engine's own state.
let resumeCtx = null;       // { code, isHost, myName }
let sessionToken = null;
let gaveUp = false;         // we already told this player the connection was lost
let resumeEpoch = 0;        // how many times we have come back to this game

function saveSessionNow() {
  if (G.mode !== 'online' || !resumeCtx || !activeEngine) return;
  const st = activeEngine.state;
  if (st.phase === 'over') { clearSession(); return; }
  // A room with no cast yet is still worth saving, so a reload keeps the code
  // the other player may already have. What must not happen is RESTORING a game
  // out of it: see `inProgress` in hostOnline and joinOnline.
  saveSession({
    code: resumeCtx.code,
    isHost: resumeCtx.isHost,
    myName: resumeCtx.myName,
    token: sessionToken,
    gaveUp,
    epoch: resumeEpoch,
    // Messages we sent that the opponent has not confirmed. If the page goes now,
    // these are the ones nobody can resend, and a lost hand-over is a match that
    // sits waiting forever on both sides.
    pending: (G.channel && G.channel.pending) ? G.channel.pending() : [],
    roster: ROSTER,        // the cast itself: the guest is sent it, not told how to build it
    engine: activeEngine.snapshot(),
  });
}

function forgetSession() {
  stopRejoining();
  resumeCtx = null; sessionToken = null; gaveUp = false; resumeEpoch = 0;
  clearSession();
}

// Remember that we have already shown this player a "connection lost" screen, so
// a reload offers the room back instead of silently re-dialling it. Without this
// the only way out of a dead room was the Home button: every reload walked
// straight back in and spent another 45 seconds failing.
function markGaveUp() {
  if (G.mode !== 'online' || !resumeCtx || !activeEngine) return;
  if (activeEngine.state.phase === 'over') return;
  gaveUp = true;
  saveSessionNow();
}

// On load, put the player back where they were. There is nothing to decide
// here: they did not ask to leave, so we go straight back and tell them.
function resumeSavedGame() {
  const saved = loadSession();
  if (!saved) return false;
  $('#online-panel').classList.remove('hidden');
  // A game we already declared lost: offer it, don't re-enter it.
  if (saved.gaveUp) {
    $('#resume-text').textContent =
      `Your game in room ${saved.code} lost its connection.`;
    $('#resume-row').classList.remove('hidden');
    return true;
  }
  setNetStatus(saved.isHost
    ? 'Picking your game back up. Re-opening your room…'
    : 'Picking your game back up. Reconnecting…');
  if (saved.isHost) hostOnline(saved);
  else joinOnline(null, saved);
  return true;
}

// The host keeps its room open and simply waits, since its opponent knows the
// code and holds a token. The guest has to go back and knock again.
let rejoinTimer = null, rejoinTries = 0;
const REJOIN_TRIES = 5;
// Longer than the direct transport takes to give up on a network it cannot
// cross (9s), or every attempt is torn down three seconds before it would have
// fallen back to the relay, and the automatic rejoin never asks the relay at
// all. Five of these still fit inside the grace period with room to spare, and
// the loop stops early the moment the opponent is back.
const REJOIN_EVERY_MS = 12000;

function scheduleRejoin() {
  if (rejoinTimer || !resumeCtx || resumeCtx.isHost) return;
  const go = () => {
    rejoinTimer = null;
    if (!resumeCtx) return;
    if (G.channel && G.channel.isOpen()) { rejoinTries = 0; return; }
    if (rejoinTries >= REJOIN_TRIES) {
      showDisconnected('🔌', 'Opponent left',
        'Your opponent did not come back. The game can\'t continue.');
      return;
    }
    rejoinTries++;
    const saved = loadSession();
    if (!saved) return;
    setNetStatus('Trying to get back into the game…');
    joinOnline(null, saved);
    rejoinTimer = setTimeout(go, REJOIN_EVERY_MS);
  };
  rejoinTimer = setTimeout(go, 2500);
}

function stopRejoining() { clearTimeout(rejoinTimer); rejoinTimer = null; rejoinTries = 0; }

let joinWaitHint = null;
function joinOnline(codeArg, resume) {
  const code = resume ? resume.code : String(codeArg || $('#join-code').value).trim().toUpperCase();
  if (!code) { setNetStatus('Enter a room code first.', 'error'); return; }
  if (!resume && hostedRoom && code === hostedRoom) {
    setNetStatus("That's your own room. Share the code with a friend so they can join.", 'error');
    return;
  }
  const name = resume ? resume.myName
    : (($('#online-name').value || '').trim().slice(0, 14) || 'Player 2');
  // Leaving our own room (or a half-open prior attempt) to join someone else:
  // tear it down so we don't strand a dead, still-advertised room.
  teardownOnline();
  G.mode = 'online';
  gaveUp = !!(resume && resume.gaveUp);   // keep it until we are genuinely back in
  G.channel = createReliableChannel(createGameChannel());
  const engine = makeOnlineEngine(false, name);
  // Same test as hostOnline: was there actually a game, or only a room? A saved
  // session exists from the moment we knock, so a reload while still waiting to
  // be let in would otherwise restore a board builder with no characters in it
  // and no way forward. With no cast, just knock again on the same code.
  const inProgress = !!(resume && resume.roster && resume.roster.length);
  if (inProgress) {
    setRoster(resume.roster);
    engine.restore(resume.engine);
    // See hostOnline: put the in-flight messages back now, not when the resume
    // lands, or the next attempt reads back an empty list we wrote ourselves.
    G.channel.requeue(resume.pending);
  }
  G.channel.onData((m) => onOnlineMessage(m, engine));
  G.channel.onStatus((s) => setNetStatus(s));
  G.channel.onHealthy(netRecovered);
  G.channel.onToken((t) => { sessionToken = t; saveSessionNow(); });
  G.channel.onPending(saveSessionNow);
  G.channel.onResumed(() => {
    clearTimeout(joinWaitHint);
    stopRejoining();
    gaveUp = false;           // we are back in: this game is live again
    setNetStatus('Reconnected.', 'ok');
    netRecovered();
    saveSessionNow();
    routeOnline(engine.state);
  });
  G.channel.onOpen(() => {
    clearTimeout(joinWaitHint);
    setNetStatus('Connected! Dealing the characters…', 'ok');
    noteTransport();
  });
  G.channel.onError(handleNetError);
  resumeCtx = { code, isHost: false, myName: name };
  // Each return attempt gets a number one higher than the last, so the host can
  // tell a genuinely new one from a repeat of the one it already let back in.
  if (resume) { sessionToken = resume.token; resumeEpoch = (resume.epoch || 0) + 1; }
  else resumeEpoch = 0;
  saveSessionNow();
  G.channel.join(code, name, resume && resume.token, resumeEpoch);
  // Waiting on a host who may never have heard us raises no error at all, so
  // surface the details panel once the wait stops looking normal.
  clearTimeout(joinWaitHint);
  joinWaitHint = setTimeout(() => {
    if (!(G.channel && G.channel.isOpen())) showNetDetails(false);
  }, 10000);
}

// Route online state changes to the right screen.
let prevOnlineTurn = null;
function routeOnline(s) {
  if (s.phase === 'setup') {
    prevOnlineTurn = null;
    // Only reached again after a rematch reset; re-enter the board builder.
    if (!screens.setup.classList.contains('active')) enterSetup(activeEngine);
    showOppSetupState(s);
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
  if (screens.home.classList.contains('active')) {
    // Still on the home screen: the attempt died before the match began. Stop
    // advertising the room — otherwise it lingers in everyone's browser as an
    // "Open" room whose code leads straight back to this same failure.
    endHostedRoom();
    $('#host-code').classList.add('hidden');
    showNetDetails();
    return;
  }

  // Past the lobby: a dropped connection would otherwise leave this client stuck
  // forever (e.g. on "Awaiting result…"). Drive it to a terminal screen with a
  // way home instead — but ONLY when the game really is over.
  if (G.mode === 'online' && activeEngine && activeEngine.state.phase !== 'over') {
    // These five mean this room cannot be re-entered at all, so there is nothing
    // worth keeping: a reload should land on the front page, not offer it back.
    if (TERMINAL_NET_ERRORS.includes(e && e.type)) {
      teardownOnline(); forgetSession(); showDisconnected(); return;
    }
    if (e && e.type === 'closed' && resumeCtx) {
      softNetTrouble('Your opponent dropped out.');
      scheduleRejoin();
      return;
    }
    softNetTrouble(msg);
    return;
  }
  toast('⚠️ ' + msg);
}

/* --------------------- recoverable vs terminal trouble -------------------- */
// Only these mean the game is genuinely over. Everything else — a dropped
// signalling socket, a relay subscription being rebuilt, a rate limit — is an
// interruption the connection recovers from on its own, and must NOT tear down a
// live match. Getting this wrong told the player whose turn it wasn't, sitting
// idle and receiving nothing, that their opponent had left.
// 'closed' is deliberately NOT here. A connection closing is exactly what the
// other player refreshing their page looks like from this side, and it is also
// what a phone backgrounding a tab looks like. We hold the game open for a
// while and let them come back instead of ending a match nobody meant to end.
const TERMINAL_NET_ERRORS = ['denied', 'full', 'nosuchroom', 'unsupported', 'code'];
const NET_GRACE_MS = 45000;   // how long a silent interruption may last before we call it

let netGraceTimer = null;

// Warn without destroying anything, and escalate only if it really doesn't come back.
function softNetTrouble(msg) {
  const el = $('#net-banner');
  if (el) {
    el.textContent = '⚠️ ' + msg + ' Trying to reconnect. Your game is still here.';
    el.classList.remove('hidden');
  }
  if (netGraceTimer) return;              // already counting down
  const forGame = activeEngine;
  netGraceTimer = setTimeout(() => {
    netGraceTimer = null;
    // Still OUR connection we are judging, not the opponent's presence — we have
    // no way to know that. Say only what is true, and don't fire into a game that
    // has since ended or been replaced.
    if (G.mode === 'online' && activeEngine === forGame && activeEngine
        && activeEngine.state.phase !== 'over') {
      showDisconnected('🔌', 'Connection lost',
        'We lost the connection and couldn\'t get it back. Your opponent may still be waiting, so '
        + 'check your internet and start a new room.');
    }
  }, NET_GRACE_MS);
}

// Clear the warning. Called both when game traffic arrives AND when the transport
// reports it has reconnected — the player whose turn it isn't receives nothing for
// minutes at a time, so traffic alone is not a usable test of whether we are still
// connected. Judging them by silence is exactly what produced the false
// "Opponent left" in the first place.
function netRecovered() {
  clearTimeout(netGraceTimer);
  netGraceTimer = null;
  const el = $('#net-banner');
  if (el && !el.classList.contains('hidden')) {
    el.classList.add('hidden');
    setNetStatus('');
  }
}

function showDisconnected(emoji, title, sub) {
  netRecovered();                        // stop any pending escalation
  markGaveUp();                          // a reload must not walk straight back in
  endHostedRoom();                       // room can't continue — drop it from the lobby
  $('#over-emoji').textContent = emoji || '🔌';
  $('#over-title').textContent = title || 'Opponent left';
  $('#over-title').style.color = 'var(--ink)';
  $('#over-sub').innerHTML = sub || 'Your opponent disconnected, so the game can\'t continue.';
  $('#reveal-row').innerHTML = '';
  $('#btn-rematch').classList.add('hidden');   // nobody to rematch with
  showScreen('over');
}

/* ------------------------------ local ------------------------------- */
function startLocal() {
  // Tear down any online room/channel so we don't leave a stale room advertised
  // and a late joiner can't hijack this game.
  forgetSession();      // choosing another mode gives up on the online game
  teardownOnline();
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
  A.on('answer', ({ text }) => { if (activeEngine === A) toast('💬 Answer: ' + text); });
  B.on('answer', ({ text }) => { if (activeEngine === B) toast('💬 Answer: ' + text); });
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

/* ------------------------------ robot ------------------------------- */
// Solo play vs the computer. Reuses the local two-engine wiring: engine A is you
// (always the shown engine); engine B is the robot, driven automatically. There
// are no pass screens — after you End Turn the robot takes its turn with a short
// "thinking" beat, then hands back to you.
let robotBusy = false;      // guards against overlapping robot turns
let robotPendingQ = null;   // the structured question the robot is awaiting an answer to

function startRobot(difficulty) {
  forgetSession();      // choosing another mode gives up on the online game
  teardownOnline();
  G.mode = 'robot';
  G.difficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
  robotBusy = false; robotPendingQ = null;
  setRoster(generateRoster());
  const pair = createLocalPair();
  const A = createEngine({ isHost: true, myName: 'You' });
  const B = createEngine({ isHost: false, myName: 'Robot 🤖' });
  A.on('send', pair.a.send); pair.a.onData(A.handleMessage);
  B.on('send', pair.b.send); pair.b.onData(B.handleMessage);
  A.on('change', () => onLocalEngineChange(A));   // only YOU are ever the shown engine
  // Both sides auto-answer structured questions truthfully from their own secret.
  A.on('question', ({ question }) => autoAnswer(A, question));   // you answer the robot
  B.on('question', ({ question }) => autoAnswer(B, question));   // robot answers you
  A.on('answer', ({ text }) => toast('💬 Answer: ' + text));    // robot's reply to your question
  B.on('answer', ({ yes }) => robotOnAnswer(B, yes));            // your reply to the robot's question
  G.A = A; G.B = B;
  activeEngine = A;

  // You build your board; the robot sets up instantly; you play first.
  enterSetup(A, () => {
    B.setupLocal(robotSetup(ROSTER, Math.random));   // triggers begin (host A first)
    ensurePlayView();
    renderPlay(A.state);
  });
}

function showRobotThinking(on) {
  const el = $('#robot-thinking');
  if (el) el.classList.toggle('hidden', !on);
}
// A little jitter so the robot doesn't feel robotic-instant.
const robotDelay = (base = 850) => base + Math.floor(Math.random() * 500);

// The robot's turn: guess if confident, otherwise ask a splitting question (the
// cross-off + End Turn happen in robotOnAnswer once you've answered).
function robotTurn(B) {
  if (robotBusy) return;
  robotBusy = true;
  showRobotThinking(true);
  setTimeout(() => {
    const s = B.state;
    if (s.phase !== 'play' || s.turn !== 'me') { robotBusy = false; showRobotThinking(false); return; }
    const cands = openCandidates(s.deduction, s.oppBoard);
    const guess = () => {
      const id = pickGuess(cands.length ? cands : s.oppBoard, Math.random);
      B.beginGuess(); B.makeGuess(id);
      robotBusy = false; showRobotThinking(false);
      afterLocalMaybeOver();
    };
    if (cands.length === 0 || shouldGuess(cands.length, G.difficulty, Math.random)) { guess(); return; }
    const q = chooseQuestion(cands, CHAR_BY_ID, G.difficulty, Math.random);
    if (!q) { guess(); return; }
    robotPendingQ = q;
    B.askStructured(q, buildQuestionText(q));   // -> you auto-answer -> robotOnAnswer
  }, robotDelay());
}

// After you answer the robot's question: cross off the ruled-out cards, then End Turn.
function robotOnAnswer(B, yes) {
  if (G.mode !== 'robot' || !robotPendingQ) return;
  const q = robotPendingQ; robotPendingQ = null;
  setTimeout(() => {
    if (B.state.phase === 'play' && B.state.turn === 'me') {
      const cands = openCandidates(B.state.deduction, B.state.oppBoard);
      for (const id of cardsToCrossOff(cands, q, yes, CHAR_BY_ID)) B.toggleCard(id);
    }
    setTimeout(() => {
      if (B.state.phase === 'play' && B.state.turn === 'me') B.endTurn();   // hand back to you
      robotBusy = false;
      showRobotThinking(false);
    }, robotDelay(450));
  }, robotDelay(450));
}

/* ------------------------------ setup ------------------------------- */
let setupCtx = null;
function enterSetup(engine, onDone) {
  clearFilters();          // a new game (or rematch) starts with no highlight
  setupCtx = { engine, onDone, picked: new Set(), secret: null, step: 1 };
  $('#setup-player').textContent = engine.state.myName;
  $('#setup-step').textContent = 'Step 1 of 2 · pick 20 characters';
  $('#setup-grid').innerHTML = ROSTER.map((c, i) => charCardHTML(c, i)).join('');
  $('#setup-confirm').classList.add('hidden');
  $('#setup-next').classList.remove('hidden');
  $('#setup-clear').classList.remove('hidden');
  $('#setup-random').classList.remove('hidden');
  updateSetupUI();
  oppWasReady = false;
  if (G.mode === 'online') showOppSetupState(engine.state);
  else $('#setup-opp').classList.add('hidden');
  showScreen('setup');
}

// While you are still building your board, say whether the other player is
// still choosing too or has already locked in and is waiting on you. Without
// this, setup is the one part of an online game where you get no sign at all
// that anyone else is there.
let oppWasReady = false;
function showOppSetupState(s) {
  const el = $('#setup-opp');
  if (!el || G.mode !== 'online') return;
  const name = (s && s.oppName) || 'Your opponent';
  if (s && s.oppReady) {
    el.textContent = `🔒 ${name} has locked in their board and is waiting for you.`;
    el.className = 'setup-opp waiting';
    if (!oppWasReady) toast(`🔒 ${name} locked in their board.`);
    oppWasReady = true;
  } else {
    el.textContent = `⏳ ${name} is still building their board.`;
    el.className = 'setup-opp';
    oppWasReady = false;
  }
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
    $('#setup-step').textContent = 'Step 2 of 2 · pick your secret';
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
  // "X / 20 active" — how many cards are still standing on each board.
  $('#you-open').textContent = open;
  $('#opp-open').textContent = s.oppOpen;

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

  // Board of the opponent's characters (my deduction surface). Crossing cards
  // off is a TURN action now, so off-turn the grid reads as locked.
  const grid = $('#play-grid');
  const guessing = s.guessing && myTurn;
  const filtering = anyFilter();
  grid.classList.toggle('filtering', filtering);
  grid.classList.toggle('locked', !myTurn);
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
  const undoBtn = $('#btn-undo');
  const banner = $('#mode-banner');
  banner.className = 'mode-banner hidden';
  banner.textContent = '';               // don't leave stale banner text behind when hidden
  guessBtn.textContent = '🎯 Make a Guess';
  askBtn.textContent = '💬 Ask a Question';
  // Undo is available only on my turn, and only if I changed something this turn.
  if (undoBtn) undoBtn.disabled = !(myTurn && s.turnCardActions && s.turnCardActions.length);

  if (!myTurn) {
    askBtn.disabled = true; guessBtn.disabled = true; endBtn.disabled = true;
    if (s.pendingGuess) { banner.textContent = 'Your guess is on its way…'; banner.className = 'mode-banner guess'; }
    else { banner.textContent = '⏳ Not your turn. Deducing unlocks when it\'s your turn.'; banner.className = 'mode-banner note'; }
    return;
  }

  if (s.guessing) {
    // In guess-selection mode: tap a card to guess, or cancel.
    askBtn.disabled = true;
    guessBtn.disabled = false; guessBtn.textContent = '✖ Cancel guess';
    endBtn.disabled = false;
    banner.textContent = '🎯 Guess mode. Tap your rival\'s secret, or Cancel to keep deducing.';
    banner.className = 'mode-banner guess';
  } else if (s.asked) {
    // Asked a question this turn → guessing is locked until next turn.
    askBtn.disabled = true; askBtn.textContent = '💬 Question asked';
    guessBtn.disabled = true;
    endBtn.disabled = false;
    banner.textContent = '💬 You asked a question, so no guessing this turn. Cross off who doesn\'t fit, then End Turn.';
    banner.className = 'mode-banner ask';
  } else {
    askBtn.disabled = false;
    guessBtn.disabled = false;
    endBtn.disabled = false;
  }
}

// Two-digit local clock time for a log entry.
function fmtTime(ts) {
  if (ts == null) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A small avatar chip for a card referenced in the log (hover shows full traits).
function logCardHTML(id) {
  const ch = CHAR_BY_ID[id];
  if (!ch) return '';
  return `<span class="log-card" data-id="${id}">${renderAvatar(ch, id)}<span class="lc-name">${escapeHTML(ch.name)}</span></span>`;
}

// One activity-log row (my perspective: I see my own card actions in detail but
// only a per-turn COUNT of the opponent's).
function logRowHTML(ev, s) {
  const who = ev.by === 'me' ? 'You' : (s.oppName || 'Rival');
  const time = fmtTime(ev.ts);
  let body = '';
  switch (ev.kind) {
    case 'chat': body = escapeHTML(ev.text); break;
    case 'ask': body = ev.outloud ? '🗣️ asked a question out loud' : `🙋 asked: ${escapeHTML(ev.text)}`; break;
    case 'answer': body = `✅ answered: ${escapeHTML(ev.text)}`; break;
    case 'card': body = `${ev.action === 'off' ? '🚫 crossed off' : '↩︎ brought back'} ${logCardHTML(ev.cardId)}`; break;
    case 'oppcards': body = `made ${ev.off} card${ev.off === 1 ? '' : 's'} inactive${ev.on ? ` (and ${ev.on} active again)` : ''}`; break;
    case 'guess': body = `🎯 guessed ${logCardHTML(ev.cardId)}: ${ev.correct ? 'correct! 🏆' : 'wrong'}`; break;
    default: return '';
  }
  return `<div class="log-row ${ev.by === 'me' ? 'me' : 'opp'}">
    <span class="lr-meta"><b>${escapeHTML(who)}</b> · ${time}</span>
    <span class="lr-body">${body}</span></div>`;
}

// Render the live activity log into the sidebar.
function renderChat(s) {
  const el = $('#chat-log');
  el.innerHTML = (s.log || []).map((ev) => logRowHTML(ev, s)).join('');
  el.scrollTop = el.scrollHeight;
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
    if (s.deduction[id] === false) { toast('That one is crossed out. Pick an open card.'); return; }
    const ch = CHAR_BY_ID[id];
    const ok = await confirmModal({
      title: `Guess ${ch.name}?`,
      body: `You think your rival's secret is <b>${ch.name}</b>.<br>Guess right and you <b>win</b> 🏆, but if you're <b>wrong you lose!</b>`,
      okText: `Yes, it's ${ch.name}!`, cancelText: 'Wait, no',
    });
    if (ok) { e.makeGuess(id); afterLocalMaybeOver(); }
    return;
  }

  // Otherwise a click crosses the card off (or back on) — a turn action now.
  if (s.turn !== 'me' || s.pendingGuess) {
    toast('Hold on. You can only cross cards off on your turn.');
    return;
  }
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

  $('#btn-undo').onclick = () => {
    const e = activeEngine; if (!e) return;
    if (e.undoLastCard()) toast('Undid your last cross-off.');
  };

  $('#btn-guess').onclick = () => {
    const e = activeEngine; const s = e.state;
    if (s.turn !== 'me' || s.pendingGuess) return;
    if (s.guessing) { e.cancelGuess(); return; }
    if (s.asked) { toast('You asked a question this turn, so no guessing now.'); return; }
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
    } else if (G.mode === 'robot') {
      robotTurn(G.B);                 // your turn is over — let the robot play
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
  closeCardDetail();
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
  closeCardDetail();
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
  closeCardDetail();      // this overlay has no escape hatch: it must not be covered
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
        okText: 'Oops, ok',
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
  // Also dismiss the builder by clicking the backdrop or pressing Escape — same
  // as Cancel (nothing is asked), so it never feels like you're trapped in it.
  $('#qbuilder').addEventListener('click', (e) => {
    if (e.target.id === 'qbuilder') $('#qbuilder').classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#qbuilder').classList.contains('hidden')) {
      $('#qbuilder').classList.add('hidden');
    }
  });
  $('#qb-outloud').onclick = async () => {
    const e = activeEngine;
    if (!e) return;
    // Asking commits you to NOT guessing this turn and can't be undone, so make
    // sure it wasn't an accidental tap before locking the turn.
    $('#qbuilder').classList.add('hidden');
    const ok = await confirmModal({
      title: '🗣️ Ask out loud?',
      body: 'Say your question to your opponent out loud (or type it in the chat). Heads up: asking uses your turn, so <b>you won\'t be able to guess until next turn</b>.',
      okText: 'Yes, ask', cancelText: 'Back',
    });
    if (!ok) { $('#qbuilder').classList.remove('hidden'); return; }   // back out — builder reopens
    if (e.askQuestion()) toast('Question asked out loud. Cross off who doesn\'t fit, then End Turn.');
  };
  $('#qb-send').onclick = () => {
    const e = activeEngine; if (!e) return;
    const q = qbQuestion();
    if (!q) return;
    if (e.askStructured(q, buildQuestionText(q))) {
      $('#qbuilder').classList.add('hidden');
      toast(G.mode === 'online' ? 'Question sent. Waiting for a reply.' : 'Question asked!');
    }
  };
}

/* ------------------------------- over ------------------------------- */
function showOver(s) {
  endHostedRoom();                       // the match is finished — mark the room ended
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
        : `You guessed <b>${guessed.name}</b>, but that wasn't it.`;
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

  // The complete, detailed game log — now visible to BOTH players, turn by turn:
  // every question/answer/chat/guess with who + time, and each player's crossed-
  // off cards (with photos) plus the common traits of that turn's batch.
  renderCompleteLog(s);

  showScreen('over');
}

function overEventLine(e, s) {
  const name = e.by === 'me' ? (s.myName || 'You') : (s.oppName || 'Rival');
  const time = fmtTime(e.ts);
  let body = '';
  switch (e.kind) {
    case 'chat': body = escapeHTML(e.text); break;
    case 'ask': body = e.outloud ? '🗣️ asked a question out loud' : `🙋 asked: ${escapeHTML(e.text)}`; break;
    case 'answer': body = `✅ answered: ${escapeHTML(e.text)}`; break;
    case 'guess': body = `🎯 guessed ${logCardHTML(e.cardId)}: ${e.correct ? 'correct 🏆' : 'wrong'}`; break;
    default: return '';
  }
  return `<div class="ol-line ${e.by === 'me' ? 'me' : 'opp'}"><span class="oll-meta"><b>${escapeHTML(name)}</b> · ${time}</span><span class="oll-body">${body}</span></div>`;
}

// The set of values present for each trait across a board — the value-space a
// deduction over that board distinguishes within (lets the log say "not Brown").
function boardTraitValues(boardIds) {
  const m = {};
  for (const id of (boardIds || [])) {
    const ch = CHAR_BY_ID[id]; if (!ch) continue;
    for (const trait of Object.keys(TRAIT_LABELS)) { (m[trait] = m[trait] || new Set()).add(ch[trait]); }
  }
  return m;
}

function batchBlockHTML(by, name, action, ids, boardValues) {
  if (!ids.length) return '';
  const cards = ids.map((id) => logCardHTML(id)).join('');
  const chars = ids.map((id) => CHAR_BY_ID[id]).filter(Boolean);
  const verb = action === 'off' ? '🚫 crossed off' : '↩︎ brought back';
  const commonLine = ids.length >= 2
    ? `<div class="olb-common">Common features: <b>${escapeHTML(commonTraitsText(chars, boardValues))}</b></div>`
    : '';
  return `<div class="ol-batch ${by === 'me' ? 'me' : 'opp'}">
    <div class="olb-head"><b>${escapeHTML(name)}</b> ${verb} ${ids.length} card${ids.length === 1 ? '' : 's'}</div>
    <div class="olb-cards">${cards}</div>
    ${commonLine}
  </div>`;
}

function renderCompleteLog(s) {
  const el = $('#over-chat');
  // Card events (mine, plus the opponent's exchanged at game end); everything else
  // (chat/ask/answer/guess) is the narrative timeline. `oppcards` count-summaries
  // are dropped — the detailed opponent batches replace them here.
  const cardEvents = [
    ...(s.log || []).filter((e) => e.kind === 'card' && e.by === 'me'),
    ...(s.oppCardLog || []),
  ];
  const nonCard = (s.log || []).filter((e) => e.kind !== 'card' && e.kind !== 'oppcards');
  if (!cardEvents.length && !nonCard.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }

  const nameOf = (by) => by === 'me' ? (s.myName || 'You') : (s.oppName || 'Rival');
  // Stable actor order (host first) so both players see identical ordering.
  const actorRank = (by) => (((by === 'me') ? !!s.isHost : !s.isHost) ? 0 : 1);

  // Net card batches per turn per actor (replayed vs turn-start state — a card
  // crossed off then brought back within a turn nets to nothing, matching the
  // per-turn count the opponent saw live).
  const batches = netBatchesByTurnActor(cardEvents);

  // Value-space each player deduced within: YOU cross off the opponent's board,
  // the opponent crosses off YOUR board. Enables "not Brown"-style common features.
  const refBoard = { me: boardTraitValues(s.oppBoard), opp: boardTraitValues(s.myBoard) };

  // Narrative events, grouped by turn (ordered by ts, host-first on ties).
  nonCard.sort((a, b) => (a.turn - b.turn) || ((a.ts || 0) - (b.ts || 0)) || (actorRank(a.by) - actorRank(b.by)));
  const nonCardByTurn = new Map();
  for (const e of nonCard) { if (!nonCardByTurn.has(e.turn)) nonCardByTurn.set(e.turn, []); nonCardByTurn.get(e.turn).push(e); }

  const turns = [...new Set([...nonCardByTurn.keys(), ...Object.keys(batches).map(Number)])].sort((a, b) => a - b);
  const turnsHTML = turns.map((turn) => {
    const lines = (nonCardByTurn.get(turn) || []).map((e) => overEventLine(e, s)).join('');
    const tb = batches[turn] || {};
    const batchHTML = Object.keys(tb)
      .sort((a, b) => actorRank(a) - actorRank(b))
      .map((by) => batchBlockHTML(by, nameOf(by), 'off', tb[by].off, refBoard[by]) + batchBlockHTML(by, nameOf(by), 'on', tb[by].on, refBoard[by]))
      .join('');
    if (!lines && !batchHTML) return '';
    return `<div class="ol-turn"><div class="ol-turn-h">Turn ${turn}</div>${lines}${batchHTML}</div>`;
  }).join('');

  el.innerHTML = `<h4 class="oc-title">📜 Complete game log</h4><div class="ol-body">${turnsHTML}</div>`;
  el.classList.remove('hidden');
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
    } else if (G.mode === 'robot') {
      // Rematch vs the robot: a fresh solo game at the same difficulty (not pass & play).
      startRobot(G.difficulty);
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
    forgetSession();        // leaving on purpose is not something to resume
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
// If this tab was in the middle of an online game before it reloaded, go back
// to it rather than dropping the player on the front page.
resumeSavedGame();
