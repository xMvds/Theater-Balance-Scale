
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

const socket = io();

// Player background: A/B/C/D test controlled from the host (HOST buttons switch PLAYER bg)
const IS_PLAYER_PAGE = !document.body.classList.contains("hostPage") && !document.body.classList.contains("infoPage");
const playerBgBEl = document.getElementById("playerBgB");
const playerBgCEl = document.getElementById("playerBgC");

let currentPlayerBgMode = "A";
let finisherInstance = null;
let finisherModeKey = null;
let finisherConfigSig = null;

// Optional server-provided configs for FinisherHeader (modes C/D)
let finisherCfgCFromServer = null;
let finisherCfgDFromServer = null;

function destroyFinisher(){
  if (!finisherInstance) { finisherModeKey = null; finisherConfigSig = null; return; }
  try{ if (typeof finisherInstance.destroy === "function") finisherInstance.destroy(); }catch(e){}
  finisherInstance = null;
  finisherModeKey = null;
  finisherConfigSig = null;
  try{ if (playerBgCEl) playerBgCEl.innerHTML = ""; }catch(e){}
  try{ if (playerBgCEl) playerBgCEl.style.transform = ""; }catch(e){}
}

function ensureFinisher(modeKey){
  if (!playerBgCEl) return;
  const key = (modeKey === "D") ? "D" : "C";

  if (typeof window.FinisherHeader !== "function") {
    console.warn("FinisherHeader library not loaded (finisher-header.es5.min.js).");
    return;
  }

  // Config defaults (used if server didn't send overrides)
  const cfgCDefault = {
    "count": 6,
    "size": { "min": 207, "max": 304, "pulse": 0.5 },
    "speed": { "x": { "min": 0, "max": 0.1 }, "y": { "min": 0, "max": 0.2 } },
    "colors": { "background": "#0b0d12", "particles": ["#3b3c46"] },
    "blending": "lighten",
    "opacity": { "center": 0.05, "edge": 0 },
    "skew": 0,
    "shapes": ["c"]
  };

  const cfgDDefault = {
    "count": 6,
    "size": { "min": 207, "max": 304, "pulse": 0.5 },
    "speed": { "x": { "min": 0, "max": 0.1 }, "y": { "min": 0, "max": 0.2 } },
    "colors": { "background": "#0b0d12", "particles": ["#3b3c46"] },
    "blending": "lighten",
    "opacity": { "center": 0.1, "edge": 0 },
    "skew": 0,
    "shapes": ["c"]
  };

  const cfg = (key === "D")
    ? (finisherCfgDFromServer || cfgDDefault)
    : (finisherCfgCFromServer || cfgCDefault);

  // If we're already running with the requested config, keep it.
  // (But if the config changed, we restart.)
  const sig = key + "|" + JSON.stringify(cfg || {});
  if (finisherInstance && finisherModeKey === key && finisherConfigSig === sig) return;

  // Otherwise, restart with the new config.
  destroyFinisher();
  finisherConfigSig = sig;

  // Match the visible element background to the config background (avoids flashes while canvas starts).
  try{ playerBgCEl.style.background = (cfg.colors && cfg.colors.background) ? cfg.colors.background : "#151823"; }catch(e){}

  // Optional: apply skew via CSS (matches FinisherHeader "skew" control)
  try{
    const deg = (cfg && cfg.skew != null) ? Number(cfg.skew) : 0;
    playerBgCEl.style.transformOrigin = "center";
    playerBgCEl.style.transform = `skewY(${Number.isFinite(deg) ? deg : 0}deg)`;
  }catch(e){}


  try{
    finisherInstance = new window.FinisherHeader(cfg);
    finisherModeKey = key;
  }catch(e){
    console.error("Failed to init FinisherHeader:", e);
    destroyFinisher();
  }
}

function applyPlayerBgMode(_mode){
  // Background A/B/C/D testing is no longer used.
  // We always run the FinisherHeader background (C) for the full player UI.
  if (!IS_PLAYER_PAGE) return;

  currentPlayerBgMode = "C";
  document.body.classList.remove("playerStaticBg", "playerBgModeB", "playerBgModeD");
  document.documentElement.classList.remove("playerStaticBg", "playerBgModeB", "playerBgModeD");
  document.body.classList.add("playerBgModeC");
  document.documentElement.classList.add("playerBgModeC");

  if (playerBgBEl) playerBgBEl.classList.add("hidden");
  if (playerBgCEl) playerBgCEl.classList.remove("hidden");

  ensureFinisher("C");
}

// Default: FinisherHeader background is always active
applyPlayerBgMode("C");

let picked = null;
let confirmed = false;
let lastPhase = null;

// Player scoreboard should only open after the info screen finished its reveal animation.
// The server broadcasts `revealReadyRound`; players open when revealReadyRound === round.
let pendingRevealState = null;

let visEpoch = 0; // v53A: visibility token to prevent delayed animations


let lastScores = new Map();
// Track previous totals so score animations animate from the last shown value (not a fixed placeholder)
let prevScoresById = new Map();

// Avoid replaying the grid cascade after a refresh mid-game.
// Persist per-tab (sessionStorage) and clear when returning to lobby.
const SS_CASCADE_KEY = "tbs_did_cascade";
let didCascadeThisGame = sessionStorage.getItem(SS_CASCADE_KEY) === "1";

let currentCollectRound = null; // <-- belangrijk: reset UI alleen bij nieuwe ronde

const joinView = document.getElementById("joinView");
const playView = document.getElementById("playView");
const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");
const meLabel = document.getElementById("meLabel");

const lobbyMsg = document.getElementById("lobbyMsg");

function setViews(joined){
  if(joined){
    joinView.classList.add("hidden");
    playView.classList.remove("hidden");
  } else {
    joinView.classList.remove("hidden");
    playView.classList.add("hidden");

    // UX: when the login/join view is visible, focus the name input automatically
    // so the player can start typing immediately (desktop).
    requestAnimationFrame(() => {
      try {
        nameInput.focus();
        nameInput.select();
      } catch {}
    });
  }
}


const panelGame = document.getElementById("panelGame");
const panelScore = document.getElementById("panelScore");

const grid = document.getElementById("grid");
const confirmBtn = document.getElementById("confirmBtn");

const rulesBox = document.getElementById("rules");
const tilesEl = document.getElementById("tiles");
const playerMathRow = document.getElementById("playerMathRow");

const deadNoise = document.getElementById("deadNoise");
const deadGlass = document.getElementById("deadGlass");
const survivedFx = document.getElementById("survivedFx");

// Player-side info reveal overlay (used automatically when the info screen is not connected)
const playerRevealOverlay = document.getElementById("playerRevealOverlay");
const playerRevealBlackout = document.getElementById("playerRevealBlackout");
const playerRevealStage = document.getElementById("playerRevealStage");
const playerRevealRoundRules = document.getElementById("playerRevealRoundRules");
const infoScene = document.getElementById("infoScene");
const infoNamesRow = document.getElementById("infoNamesRow");
const infoGuessesRow = document.getElementById("infoGuessesRow");
const infoMathRow = document.getElementById("infoMathRow");
const infoAvgVal = document.getElementById("infoAvgVal");
const infoTargetVal = document.getElementById("infoTargetVal");
const infoScoresRow = document.getElementById("infoScoresRow");
const infoDeltasRow = document.getElementById("infoDeltasRow");

let localRevealReadyRound = null; // local override (player reveal)
let playerRevealInProgress = false;
let playerRevealPlayedRound = null;
let playerRevealPendingResume = false;
let playerRevealPendingRound = null;
let playerRevealPendingTotalMs = 12000;
let playerRevealTimers = [];
let overlayPrevScores = new Map();

// Round-rule intro overlay (shown when info screen is not connected)
let playerRuleIntroInProgress = false;
let playerRuleIntroPlayedRound = null;
let playerRuleIntroTimers = [];
let priShownAt = 0;
const PRI_SHOW_MS = 3000;
const PRI_FADE_MS = 5000;


// Keep rule-intro logic identical to /info.html: we detect which rules became active
// compared to the previous round and show the "Nieuwe Regel" overlay for those.
let priPrevActiveRules = { r1: false, r2: false, r3: false };
let priDelayTimer = null;
let priDelayRound = null;
let priPendingIntro = null; // { round, lines } when tab was hidden

const SS_KEY = "tbs_player_key";
function getPlayerKey() {
  let k = sessionStorage.getItem(SS_KEY);
  if (!k) {
    k = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2));
    sessionStorage.setItem(SS_KEY, k);
  }
  return k;
}

let hasJoined = false;
let lastState = null;
let autoJoinAttempted = false;


socket.on("connect", () => {
  // Always ask for a fresh snapshot (mobile background/sleep can miss broadcasts).
  try { socket.emit("sync"); } catch {}

  // If this tab was already joined (no full refresh), re-bind our playerKey to this socket.
  // This fixes the case where the phone went to sleep and socket.io reconnects with a new socket id.
  if (hasJoined) {
    try { socket.emit("join", { name: "", playerKey: getPlayerKey() }); } catch {}
  }
});

// iOS Safari may restore pages from bfcache without a full reload.
// When that happens, force a fresh state snapshot + re-bind our key.
window.addEventListener("pageshow", (e) => {
  if (!e || !e.persisted) return;
  try { socket.connect(); } catch {}
  try { socket.emit("sync"); } catch {}
  if (hasJoined) {
    try { socket.emit("join", { name: "", playerKey: getPlayerKey() }); } catch {}
  }
});


// Simple server clock sync (state.serverNow is sent by server)
let serverOffsetMs = 0;
function updateServerClock(state){
  const sn = state && typeof state.serverNow === "number" ? state.serverNow : null;
  if (sn != null && Number.isFinite(sn)) {
    serverOffsetMs = sn - Date.now();
  }
}
function serverNow(){
  return Date.now() + serverOffsetMs;
}
function revealElapsedMs(state){
  const rs = state && typeof state.revealStartedAt === "number" ? state.revealStartedAt : null;
  if (rs == null || !Number.isFinite(rs)) return null;
  return Math.max(0, serverNow() - rs);
}

// rule pulse tracking (10s) + timer to stop without new socket event
let prevRuleActive = { r1: false, r2: false, r3: false };
let pulseUntil = { r1: 0, r2: 0, r3: 0 };
let pulseTimers = { r1: null, r2: null, r3: null };

// delay: show new rule on player 1s later (sync with info)
let ruleIntroDelayTimer = null;
let ruleIntroDelayRound = null;

// Player scoreboard panel animation timings (sync with CSS)
// Keep this equal to the CSS grid-template-rows transition duration.
const SCORE_PANEL_OPEN_MS = 1300;
const SCORE_PANEL_CONTENT_FADE_MS = 750;
const SCORE_PANEL_CONTENT_HIDE_MS = 420;
// User tweak: dead screen should kick in a bit BEFORE the scoreboard finishes.
const DEAD_SCREEN_EARLY_MS = 1400; // v3.0.0.81: 0.4s earlier

function buildGrid() {
  grid.innerHTML = "";

  function makeCell(n) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.textContent = String(n);
    cell.dataset.n = String(n);
    cell.addEventListener("click", () => onPick(n, cell));
    return cell;
  }
  function makeEmpty() {
    const cell = document.createElement("div");
    cell.className = "cell empty";
    cell.dataset.n = "";
    return cell;
  }

  // TOP rows: 91..100, 81..90 ... 1..10
  for (let start = 91; start >= 1; start -= 10) {
    for (let n = start; n <= start + 9; n++) grid.appendChild(makeCell(n));
  }

  // BOTTOM row: 0 then empties
  grid.appendChild(makeCell(0));
  for (let i = 0; i < 9; i++) grid.appendChild(makeEmpty());
}

function onPick(n, cellEl) {
  // na bevestigen: niet opnieuw selecteren
  if (confirmed) return;
  if (grid.classList.contains("lockedAfterConfirm")) return;
  if (grid.classList.contains("animating")) return;
  if (document.body.classList.contains("deadTheme")) return;
  if (grid.classList.contains("revealLock")) return;
  if (document.body.classList.contains("survivedTheme")) return;

  picked = n;
  confirmBtn.disabled = false;

  grid.querySelectorAll(".cell").forEach((c) => c.classList.remove("selected"));
  cellEl.classList.add("selected");
}


function applySubmittedUI(me) {
  if (!me) return;
  const guessVal = (me.lastGuess !== null && me.lastGuess !== undefined) ? Number(me.lastGuess) : NaN;
  if (!me.submitted || !Number.isFinite(guessVal)) return;

  confirmed = true;
  picked = guessVal;
  confirmBtn.disabled = true;

  grid.classList.add("hasConfirmed");
  grid.classList.add("lockedAfterConfirm");
  grid.querySelectorAll(".cell").forEach((c) => {
    c.classList.remove("selected", "confirmed", "muted");
    if (c.dataset.n !== String(picked)) c.classList.add("muted");
  });
  const chosen = grid.querySelector(`.cell[data-n="${guessVal}"]`);
  if (chosen) chosen.classList.add("confirmed");
}

function startGridCascade() {
  grid.classList.add("animating", "cascading");

  grid.querySelectorAll(".cell").forEach((cell) => {
    cell.classList.remove("appear");
    cell.style.animationDelay = "0ms";
  });

  const numberCells = Array.from(grid.querySelectorAll(".cell")).filter((c) => c.dataset.n !== "");
  for (const cell of numberCells) {
    const n = Number(cell.dataset.n);
    const delay = n * 35;
    cell.style.animationDelay = `${delay}ms`;
    void cell.offsetWidth;
    cell.classList.add("appear");
  }

  const totalMs = 35 * 100 + 900 + 160;
  clearTimeout(startGridCascade._t);
  startGridCascade._t = setTimeout(() => {
    grid.classList.remove("cascading", "animating");
  }, totalMs);
}

let isDeadNow = false;
let deadThemePendingRound = null;
let deadThemeTimer = null;
let deadThemeShownRound = null; // once the dead overlay is shown for a revealed round, keep it stable

function clearPendingDeadTheme(){
  if (deadThemeTimer) clearTimeout(deadThemeTimer);
  deadThemeTimer = null;
  deadThemePendingRound = null;
}

function scheduleDeadThemeAfterScoreboard(roundKey, delayMs){
  const rk = Number(roundKey || 0);
  if (!Number.isFinite(rk) || rk <= 0) return;

  // If we've already shown the dead overlay for this revealed round, keep it stable.
  if (deadThemeShownRound === rk && document.body.classList.contains("deadTheme")) return;

  // Avoid rescheduling the same round over and over.
  if (deadThemePendingRound === rk && deadThemeTimer) return;

  const fire = () => {
    deadThemeTimer = null;
    const s = lastState;
    if (!isDeadNow) return;
    if (!s || s.phase !== "revealed") return;
    if (Number(s.round || 0) !== rk) return;
    deadThemeShownRound = rk;
    setDeadTheme(true);
  };

  clearPendingDeadTheme();
  deadThemePendingRound = rk;

  const d = Math.max(0, Number(delayMs || 0));
  if (d === 0) { fire(); return; }

  deadThemeTimer = setTimeout(fire, d);
}

function setDeadTheme(on) {
  document.body.classList.toggle("deadTheme", on);
  deadNoise.classList.toggle("on", on);
  if (deadGlass) deadGlass.classList.toggle("on", on);
  if (on) {
    confirmBtn.disabled = true;
    grid.classList.add("locked", "revealLock");
    grid.classList.add("lockedAfterConfirm");
  }
}

function setSurvivedTheme(on) {
  document.body.classList.toggle("survivedTheme", on);
  survivedFx.classList.toggle("hidden", !on);
  if (on) {
    confirmBtn.disabled = true;
    grid.classList.add("locked", "revealLock");
    grid.classList.add("lockedAfterConfirm");
  }
}

function schedulePulseStop(key) {
  if (pulseTimers[key]) clearTimeout(pulseTimers[key]);
  const ms = Math.max(0, pulseUntil[key] - Date.now()) + 30;
  pulseTimers[key] = setTimeout(() => {
    if (lastState) renderRules(lastState);
  }, ms);
}

function renderRules(state) {
  if (state.phase === "lobby") {
    rulesBox.classList.add("hidden");
    rulesBox.innerHTML = "";
    prevRuleActive = { r1: false, r2: false, r3: false };
    pulseUntil = { r1: 0, r2: 0, r3: 0 };
    for (const k of ["r1", "r2", "r3"]) {
      if (pulseTimers[k]) clearTimeout(pulseTimers[k]);
      pulseTimers[k] = null;
    }
    return;
  }

  const r = state.roundRules;
  if (!r) {
    rulesBox.classList.add("hidden");
    rulesBox.innerHTML = "";
    return;
  }

  const now = {
    r1: !!r.duplicatesInvalid,
    r2: !!r.exactDoublePenalty,
    r3: !!r.zeroHundredSpecial,
  };

  const t = Date.now();
  if (now.r1 && !prevRuleActive.r1) { pulseUntil.r1 = t + 10000; schedulePulseStop("r1"); }
  if (now.r2 && !prevRuleActive.r2) { pulseUntil.r2 = t + 10000; schedulePulseStop("r2"); }
  if (now.r3 && !prevRuleActive.r3) { pulseUntil.r3 = t + 10000; schedulePulseStop("r3"); }

  prevRuleActive = now;

  const rules = [];
  if (now.r1) rules.push({ key: "r1", text: "1. Dubbele getallen zijn ongeldig en leveren -1 punt op." });
  if (now.r2) rules.push({ key: "r2", text: "2. Exact geraden getallen geven de verliezers -2 punten." });
  if (now.r3) rules.push({ key: "r3", text: "3. Kiest een speler 0, dan wint de ander door 100 te kiezen." });

  if (rules.length === 0) {
    rulesBox.classList.add("hidden");
    rulesBox.innerHTML = "";
    return;
  }

  rulesBox.classList.remove("hidden");
  rulesBox.innerHTML = `
    <div class="rulesTitle">Regels</div>
    ${rules
      .map((x) => {
        const pulse = Date.now() < pulseUntil[x.key];
        return `<div class="ruleItem ${pulse ? "pulseOnce" : ""}">${x.text}</div>`;
      })
      .join("")}
  `;
}

function renderRulesWithDelay(state) {
  // als we niet meer in collecting zitten: stop eventuele delay
  if (ruleIntroDelayTimer && (state.phase !== "collecting" || state.round !== ruleIntroDelayRound)) {
    clearTimeout(ruleIntroDelayTimer);
    ruleIntroDelayTimer = null;
  }

  if (state.phase === "lobby") {
    if (ruleIntroDelayTimer) {
      clearTimeout(ruleIntroDelayTimer);
      ruleIntroDelayTimer = null;
    }
    ruleIntroDelayRound = null;
    renderRules(state);
    return;
  }

  const intro = state.ruleIntro || {};
  const hasIntro = !!(intro.r1 || intro.r2 || intro.r3);

  // Alleen bij start van een ronde waarin een NIEUWE regel actief wordt: 1s wachten
  if (hasIntro && state.phase === "collecting" && ruleIntroDelayRound !== state.round) {
    ruleIntroDelayRound = state.round;

    rulesBox.classList.add("hidden");
    rulesBox.innerHTML = "";

    ruleIntroDelayTimer = setTimeout(() => {
      ruleIntroDelayTimer = null;
      renderRules(lastState || state);
    }, 1000);

    return;
  }

  // terwijl we wachten: niets renderen (voorkomt flash)
  if (ruleIntroDelayTimer && state.phase === "collecting" && ruleIntroDelayRound === state.round) return;

  renderRules(state);
}


function clearScoreAnimTimers() {
  const arr = renderScoreboard._animTimers;
  if (!arr || !arr.length) return;
  for (const t of arr) clearTimeout(t);
  arr.length = 0;
}

function animateScore(el, from, to, isBad, delayMs = 300) {
  el.innerHTML = "";

  const oldNode = document.createElement("div");
  oldNode.className = "scoreNum live" + (isBad ? " bad" : " good");
  oldNode.textContent = String(from);

  const newNode = document.createElement("div");
  newNode.className = "scoreNum in " + (isBad ? "bad" : "good");
  newNode.textContent = String(to);

  el.appendChild(oldNode);
  el.appendChild(newNode);

  const __epoch = visEpoch;
  const tid = setTimeout(() => {
    if (__epoch !== visEpoch) return;
    // If the tab was backgrounded, delayed timers can fire on return.
    // Never replay score animations in that case.
    if (document.hidden) return;
    if (renderScoreboard._suppressAnimRound != null) return;
    requestAnimationFrame(() => {
      oldNode.classList.add("out");
      oldNode.classList.remove("live");
      newNode.classList.remove("in");
      newNode.classList.add("live");
    });
  }, delayMs);

  if (!renderScoreboard._animTimers) renderScoreboard._animTimers = [];
  renderScoreboard._animTimers.push(tid);
}

function setScoreStatic(el, value) {
  el.innerHTML = `<div class="scoreNum live good">${value}</div>`;
}

function fmt2(n) {
  if (typeof n !== "number") return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

// Shared close helper for the player scoreboard panel.
// This must be callable from the generic onState handler (collecting/lobby)
// as well as from inside renderScoreboard().
function closeScoreboardPanel() {
  if (!panelScore) return;

  const instant = document.hidden || document.body.classList.contains('noAnim');

  // Cancel any delayed score animations so they can't "catch up" when the tab becomes visible again.
  clearScoreAnimTimers();

  if (playerMathRow) playerMathRow.classList.remove("show");

  // If the tab is in the background, timers/transitions are throttled.
  // Snap to the final closed state immediately so we never "see" a delayed
  // close animation when returning to the tab.
  if (instant) {
    panelScore.classList.remove('scoreShown', 'scoreHiding', 'scoreOpen', 'closing');
    document.body.classList.remove('scoreOpen');
    panelScore.setAttribute('aria-hidden', 'true');
    panelScore.style.height = "";
    if (playerMathRow) {
      playerMathRow.classList.add("hidden");
      playerMathRow.innerHTML = "";
    }
    return;
  }

  // If it isn't open, nothing to do.
  if (!document.body.classList.contains('scoreOpen')) {
    panelScore.classList.remove('scoreShown', 'scoreHiding', 'scoreOpen', 'closing');
    panelScore.setAttribute('aria-hidden', 'true');
    panelScore.style.height = "";
    if (playerMathRow) {
      playerMathRow.classList.add("hidden");
      playerMathRow.innerHTML = "";
    }
    return;
  }

  // Fade out tiles/content first, THEN start collapsing. Starting the collapse
  // too early causes a visible "knip" because content gets clipped.
  panelScore.classList.remove('scoreShown');
  panelScore.classList.add('scoreHiding');

  const FADE_MS = 720;          // matches .tiles opacity transition (700ms)
  const COLLAPSE_MS = SCORE_PANEL_OPEN_MS;     // matches grid-template-rows transition

  clearTimeout(closeScoreboardPanel._tCollapse);
  clearTimeout(closeScoreboardPanel._tReset);

  const __closeEpoch = visEpoch;
  closeScoreboardPanel._tCollapse = window.setTimeout(() => {
    if (__closeEpoch !== visEpoch) return;
    panelScore.classList.remove('scoreOpen');
    document.body.classList.remove('scoreOpen');
  }, FADE_MS);

  const __closeEpoch2 = visEpoch;
  closeScoreboardPanel._tReset = window.setTimeout(() => {
    if (__closeEpoch2 !== visEpoch) return;
    panelScore.classList.remove('scoreHiding', 'closing');
    panelScore.setAttribute('aria-hidden', 'true');
    panelScore.style.height = "";
    if (playerMathRow) {
      playerMathRow.classList.add("hidden");
      playerMathRow.innerHTML = "";
    }
  }, FADE_MS + COLLAPSE_MS + 60);
}


// ---------------- Player-side Info Reveal (optional) ----------------
function prClearTimers() {
  for (const t of playerRevealTimers) clearTimeout(t);
  playerRevealTimers.length = 0;
}

function prSetTimeout(fn, ms) {
  const __epoch = visEpoch;
  const tid = setTimeout(() => {
    if (__epoch !== visEpoch) return;
    if (document.hidden) return;
    fn();
  }, ms);
  playerRevealTimers.push(tid);
  return tid;
}

// ---------------- Round rule intro overlay (player reveal mode) ----------------
function priClearTimers() {
  for (const t of playerRuleIntroTimers) clearTimeout(t);
  playerRuleIntroTimers.length = 0;
}

function priSetTimeout(fn, ms) {
  // Timers are heavily throttled in background tabs.
  // For the rule overlay we prefer correctness over "no replay":
  // when the tab returns, late timers should still advance the overlay and hide it.
  const tid = setTimeout(() => {
    fn();
  }, ms);
  playerRuleIntroTimers.push(tid);
  return tid;
}

function priHideRoundRulesOverlay() {
  if (!playerRevealRoundRules) return;
  playerRevealRoundRules.classList.add("hidden");
  playerRevealRoundRules.classList.remove("show");
  playerRevealRoundRules.classList.remove("fadeOut");
  playerRevealRoundRules.innerHTML = "";
  priShownAt = 0;
}

function priShowRoundRulesOverlayFromLines(lines) {
  if (!playerRevealRoundRules) return;
  if (!lines || lines.length === 0) {
    priHideRoundRulesOverlay();
    return;
  }

  playerRevealRoundRules.innerHTML = `
    <div class="rrTitle">Nieuwe Regel</div>
    <div class="rrBig">
      ${lines.map((t) => `<div class="rrLine">${t}</div>`).join("")}
    </div>
  `;

  playerRevealRoundRules.classList.remove("hidden");
  playerRevealRoundRules.classList.remove("fadeOut");
  playerRevealRoundRules.classList.remove("show");
  requestAnimationFrame(() => requestAnimationFrame(() => playerRevealRoundRules.classList.add("show")));

  // Robust timing: store start time so we can re-arm after background/sleep.
  priShownAt = Date.now();
  priArmHideTimers();
}


function priArmHideTimers() {
  if (!playerRevealRoundRules) return;

  // Restart timers robustly (timers may be throttled/paused while backgrounded).
  priClearTimers();

  // If somehow not visible anymore, bail.
  if (playerRevealRoundRules.classList.contains("hidden")) return;

  const now = Date.now();
  const elapsed = (priShownAt ? (now - priShownAt) : 0);
  const total = PRI_SHOW_MS + PRI_FADE_MS;

  if (elapsed >= total) {
    priHideRoundRulesOverlay();
    return;
  }

  // Ensure we are in the correct fade phase.
  if (elapsed >= PRI_SHOW_MS) {
    playerRevealRoundRules.classList.add("fadeOut");
    playerRevealRoundRules.style.transition = "opacity " + PRI_FADE_MS + "ms ease";
    priSetTimeout(() => { priHideRoundRulesOverlay(); }, Math.max(0, total - elapsed));
    return;
  }

  // Not fading yet: schedule fade + hide.
  playerRevealRoundRules.classList.remove("fadeOut");
  playerRevealRoundRules.style.transition = "opacity 1200ms ease";

  priSetTimeout(() => {
    if (!playerRevealRoundRules) return;
    playerRevealRoundRules.classList.add("fadeOut");
    playerRevealRoundRules.style.transition = "opacity " + PRI_FADE_MS + "ms ease";
  }, Math.max(0, PRI_SHOW_MS - elapsed));

  priSetTimeout(() => {
    priHideRoundRulesOverlay();
  }, Math.max(0, total - elapsed));
}

function priComputeNewRuleLines(state) {
  const rr = state.roundRules || {};
  const now = {
    r1: !!rr.duplicatesInvalid,
    r2: !!rr.exactDoublePenalty,
    r3: !!rr.zeroHundredSpecial,
  };

  const newOn = {
    r1: now.r1 && !priPrevActiveRules.r1,
    r2: now.r2 && !priPrevActiveRules.r2,
    r3: now.r3 && !priPrevActiveRules.r3,
  };

  priPrevActiveRules = now;

  const lines = [];
  if (newOn.r1) lines.push("1. Dubbele getallen zijn ongeldig en leveren -1 punt op.");
  if (newOn.r2) lines.push("2. Exact geraden getallen geven de verliezers -2 punten.");
  if (newOn.r3) lines.push("3. Kiest een speler 0, dan wint de ander door 100 te kiezen.");
  return lines;
}

function stopPlayerRuleIntro() {
  if (priDelayTimer) {
    clearTimeout(priDelayTimer);
    priDelayTimer = null;
  }
  priDelayRound = null;
  priPendingIntro = null;
  priClearTimers();
  playerRuleIntroInProgress = false;
  priHideRoundRulesOverlay();
  // Hide the overlay entirely unless the reveal animation is currently running.
  if (!playerRevealInProgress) prHideOverlay();
}

function startPlayerRuleIntro(state) {
  if (!playerRevealOverlay || !playerRevealBlackout || !playerRevealRoundRules) return;
  if (playerRevealInProgress) return; // don't interfere with the reveal timeline
  if (playerRuleIntroInProgress) return;
  if (playerRuleIntroPlayedRound === state.round) return;

  // Cancel any previous delayed show
  if (priDelayTimer) {
    clearTimeout(priDelayTimer);
    priDelayTimer = null;
  }

  // Only show this overlay when the info screen is NOT connected.
  if ((state.infoClientCount || 0) !== 0) return;

  const lines = priComputeNewRuleLines(state);
  if (!lines.length) return;

  // If hidden, queue it and show when the tab becomes visible again.
  if (document.hidden) {
    priPendingIntro = { round: state.round, lines };
    return;
  }

  playerRuleIntroPlayedRound = state.round;
  playerRuleIntroInProgress = true;
  priDelayRound = state.round;

  // Match /info.html: wait ~1s before showing the "Nieuwe Regel" overlay.
  priDelayTimer = setTimeout(() => {
    priDelayTimer = null;
    if (!lastState) { stopPlayerRuleIntro(); return; }
    if (lastState.phase !== "collecting" || lastState.round !== priDelayRound) { stopPlayerRuleIntro(); return; }
    if ((lastState.infoClientCount || 0) !== 0) { stopPlayerRuleIntro(); return; }

    priHideRoundRulesOverlay();
    prShowOverlay();
    playerRevealOverlay.classList.remove("showStage");
    prSetBlack(true);

    // Show rules overlay (includes its own fade/hide timers)
    priShowRoundRulesOverlayFromLines(lines);

    // When the rules overlay is done, fade back to the player UI
    priSetTimeout(() => {
      if (!playerRevealInProgress) prSetBlack(false);
    }, 8000);

    priSetTimeout(() => {
      if (!playerRevealInProgress) prHideOverlay();
      playerRuleIntroInProgress = false;
    }, 8000 + 460);
  }, 1000);
}

function prFmt2(n) {
  if (typeof n !== "number") return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function prSetScoreStatic(el, value, isBad) {
  el.innerHTML = `<div class="scoreNum live ${isBad ? "bad" : "good"}">${value}</div>`;
}

function prAnimateScoreNumber(el, from, to, isBad) {
  el.innerHTML = "";

  const oldNode = document.createElement("div");
  oldNode.className = "scoreNum live " + (isBad ? "bad" : "good");
  oldNode.textContent = String(from);

  const newNode = document.createElement("div");
  newNode.className = "scoreNum in " + (isBad ? "bad" : "good");
  newNode.textContent = String(to);

  el.appendChild(oldNode);
  el.appendChild(newNode);

  prSetTimeout(() => {
    requestAnimationFrame(() => {
      oldNode.classList.add("out");
      oldNode.classList.remove("live");
      newNode.classList.remove("in");
      newNode.classList.add("live");
    });
  }, 300);
}

function prBuildRevealScene(state, opts = {}) {
  const instant = !!opts.instant;
  if (!infoScene) return { start: () => {}, duration: 0 };

  // reset classes
  infoScene.classList.remove("s1","s2","s3a","s3","s3b","s4a","s4","ready","instant","opDone");
  if (infoNamesRow) infoNamesRow.innerHTML = "";
  if (infoGuessesRow) infoGuessesRow.innerHTML = "";
  if (infoScoresRow) infoScoresRow.innerHTML = "";
  if (infoDeltasRow) infoDeltasRow.innerHTML = "";

  const lr = state.lastRound || {};
  if (infoAvgVal) infoAvgVal.textContent = prFmt2(lr.average);
  if (infoTargetVal) infoTargetVal.textContent = prFmt2(lr.target);

  const list = (state.players || []).slice().sort((a,b)=> String(a.name||"").localeCompare(String(b.name||"")));
  const pendingScoreAnims = [];
  const allScoreCells = [];

  for (const p of list) {
    // Names (hidden at first)
    const nameCell = document.createElement("div");
    nameCell.className = "infoCell infoName";
    nameCell.textContent = p.name;
    infoNamesRow?.appendChild(nameCell);

    // Guess tile
    const guessCell = document.createElement("div");
    guessCell.className = "infoCell infoGuessTile";
    guessCell.innerHTML = `<div class="guessNum">${(typeof p.lastGuess === "number") ? p.lastGuess : "—"}</div>`;
    infoGuessesRow?.appendChild(guessCell);

    const d = (typeof p.lastDelta === "number") ? p.lastDelta : 0;
    const isBad = d < 0;

    // Winner flag (glow is applied later, together with min points)
    const isWinner = Array.isArray(lr.winnerIds) && lr.winnerIds.includes(p.id);
    if (isWinner) {
      guessCell.dataset.winner = "1";
      nameCell.dataset.winner = "1";
    }

    // Total score (animate from previous)
    const scoreCell = document.createElement("div");
    scoreCell.className = "infoCell infoScore";
    const prev = (typeof p.prevScore === "number") ? p.prevScore : (overlayPrevScores.has(p.id) ? overlayPrevScores.get(p.id) : null);
    const from = (typeof prev === "number") ? prev : ((typeof p.score === "number" && typeof d === "number") ? (p.score - d) : p.score);
    const to = p.score;
    allScoreCells.push({ el: scoreCell, to });

    if (instant) {
      const bad = (typeof to === "number") ? (to < 0) : false;
      prSetScoreStatic(scoreCell, to, bad);
    } else {
      scoreCell.innerHTML = `<div class="scoreNum live ${isBad ? "bad" : "good"}">${from}</div>`;
      if (isBad && typeof from === "number" && typeof to === "number" && to !== from) {
        pendingScoreAnims.push({ el: scoreCell, from, to });
      }
    }
    infoScoresRow?.appendChild(scoreCell);
    overlayPrevScores.set(p.id, p.score);

    // Delta (static)
    const deltaCell = document.createElement("div");
    deltaCell.className = "infoCell infoDelta";
    const isBadDelta = d < 0;
    const txt = (typeof d === "number") ? (d === 0 ? "0" : String(d)) : "0";
    deltaCell.innerHTML = `<div class="deltaNum ${isBadDelta ? "bad" : "neutral"}">${txt}</div>`;
    infoDeltasRow?.appendChild(deltaCell);
  }

  const snapToEnd = () => {
    infoScene.classList.add("instant");
    infoScene.classList.add("ready","s1","s2","s3a","s3","s3b","s4a","s4");
    for (const el of document.querySelectorAll('[data-winner="1"]')) el.classList.add("winner");
    for (const sc of allScoreCells) {
      const bad = (typeof sc.to === "number") ? (sc.to < 0) : false;
      prSetScoreStatic(sc.el, sc.to, bad);
    }
  };

  if (instant) {
    snapToEnd();
    return { start: () => {}, duration: 0 };
  }

  const applyAt = (ms) => {
    const t = Math.max(0, Number(ms || 0));
    infoScene.classList.add("instant");
    infoScene.classList.add("ready");
    infoScene.classList.add("s1");
    if (t >= 1600) infoScene.classList.add("s2");
    if (t >= 3000) infoScene.classList.add("s3a");
    if (t >= 3800) infoScene.classList.add("s3");
    if (t >= 4600) infoScene.classList.add("s3b");
    if (t >= 6200) infoScene.classList.add("s4a");
    if (t >= 7600) {
      infoScene.classList.add("s4");
      for (const el of document.querySelectorAll('[data-winner="1"]')) el.classList.add("winner");
    }

    // Late-join / refresh mid-reveal: if the math operator should already be visible,
    // keep it locked so it doesn't replay its reveal once on load.
    infoScene.classList.toggle("opDone", t >= 3800);

    // Catch up scores
    if (t >= 7600) {
      if (t >= 8500) {
        for (const sc of allScoreCells) {
          const bad = (typeof sc.to === "number") ? (sc.to < 0) : false;
          prSetScoreStatic(sc.el, sc.to, bad);
        }
      } else if (pendingScoreAnims.length) {
        const delay = Math.max(0, 8500 - t);
        prSetTimeout(() => {
          for (const a of pendingScoreAnims) {
            prAnimateScoreNumber(a.el, a.from, a.to, true);
          }
        }, delay);
      }
    }

    requestAnimationFrame(() => requestAnimationFrame(() => infoScene.classList.remove("instant")));
  };

  const start = (startAtMs = 0) => {
    const base = Math.max(0, Number(startAtMs || 0));
    if (base >= 10300) {
      snapToEnd();
      return;
    }

    applyAt(base);

    const schedule = (at, fn) => {
      const d = at - base;
      if (d <= 0) return;
      prSetTimeout(fn, d);
    };

    schedule(1600, () => infoScene.classList.add("s2"));
    schedule(3000, () => infoScene.classList.add("s3a"));
    schedule(3800, () => infoScene.classList.add("s3"));
    schedule(4600, () => infoScene.classList.add("s3b"));
    schedule(6200, () => infoScene.classList.add("s4a"));
    schedule(7600, () => {
      infoScene.classList.add("s4");
      for (const el of document.querySelectorAll('[data-winner="1"]')) el.classList.add("winner");
      if (pendingScoreAnims.length) {
        prSetTimeout(() => {
          for (const a of pendingScoreAnims) {
            prAnimateScoreNumber(a.el, a.from, a.to, true);
          }
        }, 900);
      }
    });
  };

  return { start, duration: 10300 };
}

let prHideTimer = null;

function prHideOverlay() {
  if (!playerRevealOverlay) return;

  // Soft-hide: fade out instead of hard-cut (important when skipping the scoreboard animation).
  clearTimeout(prHideTimer);

  // If already hidden, nothing to do.
  if (playerRevealOverlay.classList.contains("hidden")) {
    playerRevealOverlay.classList.remove("black","showStage","hiding");
    playerRevealOverlay.setAttribute("aria-hidden", "true");
    return;
  }

  playerRevealOverlay.classList.add("hiding");
  playerRevealOverlay.classList.remove("black","showStage");
  playerRevealOverlay.setAttribute("aria-hidden", "true");

  prHideTimer = setTimeout(() => {
    playerRevealOverlay.classList.add("hidden");
    playerRevealOverlay.classList.remove("hiding");
  }, 560);
}

function prShowOverlay() {
  if (!playerRevealOverlay) return;
  clearTimeout(prHideTimer);
  playerRevealOverlay.classList.remove("hidden");
  playerRevealOverlay.classList.remove("hiding");
  playerRevealOverlay.setAttribute("aria-hidden", "false");
}
function prSetBlack(on) {
  if (!playerRevealOverlay) return;
  if (on) {
    requestAnimationFrame(() => playerRevealOverlay.classList.add("black"));
  } else {
    playerRevealOverlay.classList.remove("black");
  }
}

function startPlayerReveal(state, opts = {}) {
  if (!playerRevealOverlay || !playerRevealBlackout || !playerRevealStage || !infoScene) return;
  if (playerRevealInProgress) return;
  if (playerRevealPlayedRound === state.round) return;

  const startAtMs = Math.max(0, Number(opts.startAtMs || 0));
  const totalMs = Math.max(1000, Number(opts.durationMs || 12000));

  // If the tab is hidden, don't attempt to run timers; we'll resync when visible.
  if (document.hidden) {
    playerRevealInProgress = true;
    playerRevealPlayedRound = state.round;
    playerRevealPendingResume = true;
    playerRevealPendingRound = state.round;
    playerRevealPendingTotalMs = totalMs;
    return;
  }

  prClearTimers();
  playerRevealInProgress = true;
  playerRevealPlayedRound = state.round;
  localRevealReadyRound = null;

  // Make the player-side reveal feel identical to the info screen:
  // - start the stage fade + timeline immediately (no extra waiting)
  // - fade OUT (back to player UI) slightly slower
  try{ playerRevealBlackout.style.transitionDuration = "420ms"; }catch(e){}

  const resumeNoFade = !!opts.resumeNoFade;

  // Show overlay
  playerRevealOverlay.classList.remove("hidden");
  playerRevealOverlay.setAttribute("aria-hidden", "false");

  // Build DOM for this round
  const { start, duration } = prBuildRevealScene(state, { instant: false });

  if (resumeNoFade) {
    // When returning from a backgrounded tab, do NOT fade from the player UI to black again.
    // Snap instantly to the correct visual state and continue from the right timestamp.
    playerRevealOverlay.classList.add("black", "showStage");
    start(startAtMs);

    // Re-enable animations after the snap so future steps keep animating normally.
    if (document.body.classList.contains("noAnim")) {
      requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("noAnim")));
    }
  } else {
    playerRevealOverlay.classList.remove("black","showStage");

    // Fade to black + show the stage immediately (match info screen feel)
    requestAnimationFrame(() => {
      playerRevealOverlay.classList.add("black");
      playerRevealOverlay.classList.add("showStage");
      // Start the info timeline at the correct point (late-join sync)
      requestAnimationFrame(() => start(startAtMs));
    });
  }

  // End sequence: fade stage out to black, open scoreboard behind, fade back to player UI
  const endAt = 0 + duration;
  // Remaining timeline depends on startAtMs.
  const remaining = Math.max(0, totalMs - startAtMs);
  prSetTimeout(() => {
    playerRevealOverlay.classList.remove("showStage");
  }, Math.max(0, (endAt + 120) - startAtMs));

  // While still black: open scoreboard instantly so it is already open when we fade back.
  prSetTimeout(() => {
    localRevealReadyRound = state.round;
    renderScoreboard._suppressAnimRound = state.round;
    document.body.classList.add("noAnim");

    renderScoreboard(state, { instant: true });

    // If I'm dead, delay the dead screen until after the scoreboard would have finished unfolding.
    if (isDeadNow) {
      const DONE_MS = Math.max(0, SCORE_PANEL_OPEN_MS + SCORE_PANEL_CONTENT_FADE_MS + 120 - DEAD_SCREEN_EARLY_MS);
      scheduleDeadThemeAfterScoreboard(state.round, DONE_MS);
    }

    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("noAnim")));
  }, Math.max(0, (endAt + 520) - startAtMs));

  // Fade from black back to player UI
  const OUT_MS = 900; // slightly slower out-fade (user request)
  prSetTimeout(() => {
    try{ playerRevealBlackout.style.transitionDuration = OUT_MS + "ms"; }catch(e){}
    playerRevealOverlay.classList.remove("black");
  }, Math.max(0, (endAt + 620) - startAtMs));

  // Hide overlay fully (after the slower fade)
  prSetTimeout(() => {
    prHideOverlay();
    playerRevealInProgress = false;
    try{ playerRevealBlackout.style.transitionDuration = "420ms"; }catch(e){}
  }, Math.max(0, (endAt + 620 + OUT_MS + 180) - startAtMs));
}




function renderScoreboard(state, opts = {}) {
  const instant = !!opts.instant;
  // Player scoreboard should only appear after the INFO animation finishes.
  const CONTENT_FADE_MS = SCORE_PANEL_CONTENT_FADE_MS;
  const PANEL_OPEN_MS = SCORE_PANEL_OPEN_MS;
  const CONTENT_EARLY_MS = 400; // user request: start fading ~0.4s earlier
  const GRID_SHIFT_MS = 0;
  let openingNow = false;

  if (state.phase !== "revealed") {
    // Collapse the panel when we leave revealed.
    closeScoreboardPanel();
    return;
  }

  // Defensive: cancel any delayed score animations from earlier renders.
  clearScoreAnimTimers();

  const roundKey = state.round || 0;
  if (renderScoreboard._openForRound !== roundKey) {
    renderScoreboard._closing = false;
    renderScoreboard._openForRound = roundKey;
    openingNow = true;

    clearTimeout(renderScoreboard._tShow);
    clearTimeout(renderScoreboard._tHide);
    clearTimeout(renderScoreboard._tShow2);

    // Ensure clean state.
    panelScore.classList.remove("scoreShown");
    panelScore.classList.remove("scoreOpen");

    // Make sure the panel can actually expand (clear any forced height from a prior close)
    panelScore.style.height = "";
    panelScore.setAttribute("aria-hidden", "false");
    document.body.classList.add("scoreOpen");

    // If the tab is backgrounded, timers/transitions can be heavily throttled.
    // In that case we snap to the final open state so the panel is already open when the user returns.
    if (instant || document.hidden || document.body.classList.contains("noAnim")) {
      panelScore.classList.add("scoreOpen");
      panelScore.classList.add("scoreShown");
    } else {
      // Open smoothly (no "knip"): ensure the browser sees a before/after state for the transition.
      const __openEpoch = visEpoch;
      renderScoreboard._tShow = setTimeout(() => {
        if (__openEpoch !== visEpoch) return;
        // Force reflow then flip the class in rAF.
        void panelScore.offsetHeight;
        requestAnimationFrame(() => panelScore.classList.add("scoreOpen"));

        // Fade content in slightly BEFORE the shell has fully opened.
        const fadeDelay = Math.max(0, PANEL_OPEN_MS - CONTENT_EARLY_MS);
        const __openEpoch2 = visEpoch;
        renderScoreboard._tShow2 = setTimeout(() => {
          if (__openEpoch2 !== visEpoch) return;
          panelScore.classList.add("scoreShown");
          // Fade in all score tiles together (no movement/stagger).
          tilesEl.querySelectorAll(".tile").forEach((t) => t.classList.add("show"));
          // Fade the math row in at the same time as the tiles.
          if (!playerMathRow.classList.contains("hidden")) playerMathRow.classList.add("show");
        }, fadeDelay);
      }, GRID_SHIFT_MS);
    }
  } else {
    // Already open for this round — keep it visible.
    panelScore.style.height = "";
    panelScore.setAttribute("aria-hidden", "false");
    document.body.classList.add("scoreOpen");
    panelScore.classList.add("scoreOpen");
    panelScore.classList.add("scoreShown");
  }

  // Prevent score animations from replaying on background/foreground switches.
  const suppressAnim = (renderScoreboard._suppressAnimRound === roundKey);
  const shouldAnimateScores =
    openingNow && !instant && !document.hidden && !suppressAnim && (renderScoreboard._animPlayedRound !== roundKey);
  if (shouldAnimateScores) renderScoreboard._animPlayedRound = roundKey;

  const winnerIds = (state.lastRound?.winnerIds && state.lastRound.winnerIds.length)
    ? state.lastRound.winnerIds
    : (state.lastRound?.winnerId ? [state.lastRound.winnerId] : []);

  const list = state.players.slice().sort((a, b) => a.name.localeCompare(b.name));

  tilesEl.innerHTML = "";
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const tile = document.createElement("div");
    tile.className = "tile" + (p.eliminated ? " dead" : "") + (winnerIds.includes(p.id) ? " winner" : "");

    const name = document.createElement("div");
    name.className = "tName";
    name.textContent = p.name || "—";

    const box = document.createElement("div");
    box.className = "tGuess";
    box.textContent = (typeof p.lastGuess === "number") ? String(p.lastGuess) : "—";

    const scoreWrap = document.createElement("div");
    scoreWrap.className = "tScoreWrap";

    const baseScore = (typeof p.score === "number") ? p.score : 0;
    const scoreNode = document.createElement("div");
    // Total score (HEBT) lives inside the wrapper so animation positioning works.
    scoreNode.className = "scoreNum live " + ((baseScore < 0) ? "bad" : "good");
    scoreNode.textContent = String(baseScore);
    scoreWrap.appendChild(scoreNode);

    const deltaVal = (p.lastDelta ?? 0);
    const delta = document.createElement("div");
    delta.className = "tDelta" + ((deltaVal < 0) ? " bad" : "");
    delta.textContent = String(deltaVal);

    tile.appendChild(name);
    tile.appendChild(box);
    tile.appendChild(scoreWrap);
    tile.appendChild(delta);
    tilesEl.appendChild(tile);

    // No stagger/slide for tiles on the player screen; tiles will simply fade in
    // when the score panel reaches the "shown" state.

    // Animate total score ONLY when delta < 0 (same behavior as other screens)
    if (shouldAnimateScores && deltaVal < 0) {
      // Animate from the last known total (fixes '-1 -> total' bug)
      const prevKnown = (p && typeof p.id === "string" && prevScoresById && prevScoresById.has(p.id))
        ? prevScoresById.get(p.id)
        : null;
      const fromScore = (typeof prevKnown === "number")
        ? prevKnown
        : ((typeof p.prevScore === "number") ? p.prevScore : (baseScore - deltaVal)); // deltaVal is negative
      const animDelay = (openingNow ? (PANEL_OPEN_MS + 380) : 180) + (i * 40);
      animateScore(scoreWrap, fromScore, baseScore, true, animDelay);
    }
  }

  // If we're snapping open (background tab) or we're already in the open/shown state,
  // ensure newly rendered tiles are visible immediately.
  if (instant || document.hidden || panelScore.classList.contains("scoreShown")) {
    tilesEl.querySelectorAll(".tile").forEach((t) => t.classList.add("show"));
  }

  // Math row fades in together with the scoreboard tiles.
  // Backwards compatible with older logs/servers (avg/average).
  const avg = state.lastRound?.average ?? state.lastRound?.avg;
  const target = state.lastRound?.target;
  if (typeof avg === "number" && typeof target === "number") {
    playerMathRow.classList.remove("hidden");
    playerMathRow.innerHTML = `<span class="mBox">Gemiddelde: <b>${avg.toFixed(2)}</b></span><span class="mOp">× 0.8 =</span><span class="mBox">Target: <b>${target.toFixed(2)}</b></span>`;
    if (instant || document.hidden || panelScore.classList.contains("scoreShown")) {
      playerMathRow.classList.add("show");
    } else {
      playerMathRow.classList.remove("show");
      // show() will be applied in _tShow2 when tiles fade in
    }
  } else {
    playerMathRow.classList.remove("show");
    playerMathRow.classList.add("hidden");
    playerMathRow.innerHTML = "";
  }

}

function showLobbyMessage(name) {
  lobbyMsg.textContent = `Welkom ${name}, wacht totdat het spel start`;
  lobbyMsg.classList.remove("hidden");
}

function hideLobbyMessage() {
  lobbyMsg.classList.add("hidden");
  lobbyMsg.textContent = "";
}

function setGameVisible(visible) {
  panelGame.classList.toggle("hidden", !visible);
}

joinBtn.addEventListener("click", () => {
  const name = nameInput.value;
  const key = getPlayerKey();
  socket.emit("join", { name, playerKey: key });
});

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});

confirmBtn.addEventListener("click", () => {
  if (confirmed) return;
  if (picked === null) return;

  confirmed = true;

  // gekozen vak blijft glowen (confirmed css) + alle anderen donker door hasConfirmed
  grid.classList.add("hasConfirmed");
  grid.classList.add("lockedAfterConfirm"); // <-- voorkomt opnieuw selecteren
  grid.querySelectorAll(".cell").forEach((c) => c.classList.remove("confirmed"));
  const chosen = grid.querySelector(`.cell[data-n="${picked}"]`);
  if (chosen) chosen.classList.add("confirmed");

  confirmBtn.disabled = true;
  socket.emit("submit", picked);
});

socket.on("join_ok", ({ name }) => {
  autoJoinAttempted = false;
  nameInput.disabled = false;
  joinBtn.disabled = false;
  hasJoined = true;
  meLabel.textContent = name;
  setViews(true);
  showLobbyMessage(name);
  buildGrid();
});

socket.on("join_denied", (msg) => {
  autoJoinAttempted = false;
  nameInput.disabled = false;
  joinBtn.disabled = false;
  alert(msg || "Join niet toegestaan.");
});

socket.on("kicked", () => {
  autoJoinAttempted = false;
  nameInput.disabled = false;
  joinBtn.disabled = false;
  hasJoined = false;
  picked = null;
  confirmed = false;
  lastPhase = null;
  didCascadeThisGame = false;
  sessionStorage.removeItem(SS_CASCADE_KEY);
  currentCollectRound = null;
  lastScores.clear();
  lastState = null;

  prevRuleActive = { r1: false, r2: false, r3: false };
  pulseUntil = { r1: 0, r2: 0, r3: 0 };
  for (const k of ["r1", "r2", "r3"]) {
    if (pulseTimers[k]) clearTimeout(pulseTimers[k]);
    pulseTimers[k] = null;
  }

  deadThemeShownRound = null;
  setDeadTheme(false);
  setSurvivedTheme(false);

  meLabel.textContent = "Niet ingelogd";
  setViews(false);
  hideLobbyMessage();

  panelGame.classList.add("hidden");
  // Ensure scoreboard panel starts collapsed/hidden.
  closeScoreboardPanel();
  panelScore.style.height = "";
});

socket.on("state", (state) => {
  const __prevState = lastState;
  lastState = state;
  // capture previous totals for proper score animations
  try {
    if (__prevState && Array.isArray(__prevState.players)) {
      const m = new Map();
      for (const p of __prevState.players) {
        if (p && typeof p.id === "string" && typeof p.score === "number") m.set(p.id, p.score);
      }
      prevScoresById = m;
    } else {
      prevScoresById = new Map();
    }
  } catch (e) {}

  updateServerClock(state);

  // Optional: host can live-edit FinisherHeader configs (modes C/D)
  if (state.playerFinisherConfigs) {
    try{
      if (state.playerFinisherConfigs.C) finisherCfgCFromServer = state.playerFinisherConfigs.C;
      if (state.playerFinisherConfigs.D) finisherCfgDFromServer = state.playerFinisherConfigs.D;
    }catch(e){}
  }

  // Apply host-controlled player background mode (A/B/C/D)
  if (state.playerBgMode) applyPlayerBgMode(state.playerBgMode);


  const myKey = getPlayerKey();
  const me = state.players.find((p) => p.key === myKey);

  // If we refreshed mid-game, auto-rejoin with our existing key (keeps original name).
  if (!hasJoined) {
    const gameStarted = (state.phase !== "lobby") || (state.round > 0);
    if (gameStarted) {
      if (!autoJoinAttempted) {
        autoJoinAttempted = true;
        nameInput.disabled = true;
        joinBtn.disabled = true;
        nameInput.value = "";
        lobbyMsg.textContent = "Herverbinden…";
        lobbyMsg.classList.remove("hidden");
        socket.emit("join", { name: "", playerKey: myKey });
      }
    } else {
      // Pre-game lobby: a refresh should behave like leaving the lobby.
      autoJoinAttempted = false;
      nameInput.disabled = false;
      joinBtn.disabled = false;
    }
    return;
  }

  if (!me) return;

  if (state.phase === "lobby") {
    currentCollectRound = null;
    hideLobbyMessage();
    showLobbyMessage(me.name);

    setGameVisible(false);
    closeScoreboardPanel();
    panelScore.style.height = "";
    rulesBox.classList.add("hidden");
    rulesBox.innerHTML = "";
    playerMathRow.classList.remove("show");
    playerMathRow.classList.add("hidden");
    playerMathRow.innerHTML = "";

    didCascadeThisGame = false;
    sessionStorage.removeItem(SS_CASCADE_KEY);
    deadThemeShownRound = null;
    setDeadTheme(false);
    setSurvivedTheme(false);

    // reset player-reveal overlay state
    prClearTimers();
    playerRevealInProgress = false;
    playerRevealPlayedRound = null;
    localRevealReadyRound = null;
    prHideOverlay();

    // reset rule-intro overlay state
    priClearTimers();
    playerRuleIntroInProgress = false;
    playerRuleIntroPlayedRound = null;
    priHideRoundRulesOverlay();
    return;
  }

  hideLobbyMessage();
  setGameVisible(true);

  const aliveCount = state.players.filter((p) => !p.eliminated).length;
  const iAmDead = !!me.eliminated;
  const iSurvived = !iAmDead && aliveCount === 1 && state.phase === "revealed";

  // Dead screen should NOT appear immediately when reveal starts.
  // We show the scoreboard animation first, then fade into the dead screen.
  isDeadNow = iAmDead;

  setSurvivedTheme(iSurvived);

  if (!iAmDead) {
    clearPendingDeadTheme();
    deadThemeShownRound = null;
    setDeadTheme(false);
  } else if (state.phase !== "revealed") {
    clearPendingDeadTheme();
    setDeadTheme(true);
  } else {
    // During reveal/scoreboard unfold: keep dead theme OFF, schedule later.
    // But once the dead overlay has been shown for this revealed round, keep it on (no flicker).
    const rk = Number(state.round || 0);
    if (!(deadThemeShownRound === rk && document.body.classList.contains("deadTheme"))) {
      setDeadTheme(false);
    }
  }

  const phaseChanged = state.phase !== lastPhase;
  if (phaseChanged) lastPhase = state.phase;

  if (state.phase === "collecting") {
    // reset UI ALLEEN bij start van een nieuwe ronde (niet bij elke state update)
    if (state.round !== currentCollectRound) {
      currentCollectRound = state.round;

      if (!iAmDead && !document.body.classList.contains("survivedTheme")) {
        confirmed = false;
        picked = null;
        confirmBtn.disabled = true;

        grid.classList.remove("revealLock", "locked");
        grid.classList.remove("lockedAfterConfirm");
        grid.querySelectorAll(".cell").forEach((c) => c.classList.remove("selected", "confirmed"));
        grid.classList.remove("hasConfirmed");
      }

      // If the server already has a submitted guess for me (e.g. dev fill / rejoin), reflect it immediately.
      if (!iAmDead && !document.body.classList.contains("survivedTheme")) {
        applySubmittedUI(me);
      }

      // cascade 1e ronde per game
      if (!didCascadeThisGame) {
        didCascadeThisGame = true;
        sessionStorage.setItem(SS_CASCADE_KEY, "1");
        startGridCascade();
      }

      // If the info screen is NOT connected, also show new rule announcements
      // as a full-screen overlay on the player (match the info screen style).
      if ((state.infoClientCount || 0) === 0) {
        startPlayerRuleIntro(state);
      }
    }

    // IMPORTANT: also react to dev-fill (or late server-side submit) DURING the round.
    // Previously we only applied submitted UI on round start, which meant a mid-round
    // dev fill would not show the confirmed glow / muted grid until the reveal.
    if (!iAmDead && !document.body.classList.contains("survivedTheme")) {
      applySubmittedUI(me);
    }

    // Zodra we uit de reveal fase gaan, moet het scoreboard-paneel ook weer inklappen.
    // Scoreboard volledig inklappen (anders blijft er een leeg vlak staan).
    // Also stop any player-side reveal overlay.
    prClearTimers();
    playerRevealInProgress = false;
    playerRevealPlayedRound = null;
    localRevealReadyRound = null;
    if (!playerRuleIntroInProgress) prHideOverlay();
    closeScoreboardPanel();
    pendingRevealState = null;
    renderScoreboard._suppressAnimRound = null;
    renderScoreboard._animPlayedRound = null;
  }


  if (state.phase === "revealed") {
    // If we were showing a rule-intro overlay, stop it when the reveal starts.
    if (playerRuleIntroInProgress) stopPlayerRuleIntro();

    grid.classList.add("revealLock");
    confirmBtn.disabled = true;
    // Make sure my confirmed choice stays visible (even if the collecting update was missed).
    if (!iAmDead && !document.body.classList.contains("survivedTheme")) {
      applySubmittedUI(me);
    }
    pendingRevealState = state;

    const revealDur = (typeof state.revealDurationMs === "number" && Number.isFinite(state.revealDurationMs))
      ? state.revealDurationMs
      : 12000;
    const elapsed = revealElapsedMs(state);
    const shouldPlayerReveal = state.revealDriver === "player";

    // If we're definitely past the reveal duration, allow instant skip -> scoreboard.
    if (shouldPlayerReveal && elapsed != null && elapsed >= revealDur) {
      localRevealReadyRound = state.round;
      playerRevealInProgress = false;
      prClearTimers();
      prHideOverlay();
    }

    const ready = (state.revealReadyRound === state.round) || (localRevealReadyRound === state.round);

    if (shouldPlayerReveal && !ready) {
      // Keep scoreboard closed while animating.
      closeScoreboardPanel();
      startPlayerReveal(state, { startAtMs: elapsed || 0, durationMs: revealDur });
    } else if (ready) {
      // Normal behavior: only open after reveal is ready.
      prClearTimers();
      playerRevealInProgress = false;
      if (!playerRuleIntroInProgress) prHideOverlay();
      renderScoreboard(state, { instant: document.hidden });

      // If I'm dead, wait until the scoreboard unfold has finished before showing the dead screen.
      if (isDeadNow) {
        const DONE_MS = Math.max(0, SCORE_PANEL_OPEN_MS + SCORE_PANEL_CONTENT_FADE_MS + 120 - DEAD_SCREEN_EARLY_MS);
        const sinceReady = (typeof state.revealReadyAt === "number" && Number.isFinite(state.revealReadyAt))
          ? (serverNow() - state.revealReadyAt)
          : 0;
        scheduleDeadThemeAfterScoreboard(state.round, Math.max(0, DONE_MS - sinceReady));
      }

    } else {
      closeScoreboardPanel();
    }
}


  renderRulesWithDelay(state);
});

// Background tabs can heavily throttle timers/animations. When the user returns to the tab,
// make sure the scoreboard panel catches up to the latest reveal state immediately.
document.addEventListener("visibilitychange", () => {
  visEpoch++;
  const s = pendingRevealState || lastState;

  // Cancel delayed timers that could fire unexpectedly after tab throttling.
  clearTimeout(renderScoreboard._tShow);
  clearTimeout(renderScoreboard._tShow2);
  clearTimeout(renderScoreboard._tHide);
  clearTimeout(closeScoreboardPanel._tCollapse);
  clearTimeout(closeScoreboardPanel._tReset);
  clearScoreAnimTimers();

  if (document.hidden) {
    // Stop player-side reveal timers; we'll resync when visible.
    if (s && s.phase === "revealed" && s.revealDriver === "player" && playerRevealInProgress) {
      prClearTimers();
      playerRevealPendingResume = true;
      playerRevealPendingRound = s.round;
      playerRevealPendingTotalMs = (typeof s.revealDurationMs === "number" && Number.isFinite(s.revealDurationMs)) ? s.revealDurationMs : 12000;
    }
    return;
  }

  // Visible again: catch up instantly (no replay).
  if (!s) return;

  document.body.classList.add("noAnim");
  let deferNoAnimRemoval = false;

  if (s.phase === "revealed" && s.revealDriver === "player") {
    const revealDur = (typeof s.revealDurationMs === "number" && Number.isFinite(s.revealDurationMs)) ? s.revealDurationMs : 12000;
    const elapsed = revealElapsedMs(s) || 0;
    const ready = (s.revealReadyRound === s.round) || (localRevealReadyRound === s.round) || (elapsed >= revealDur);

    if (ready) {
      localRevealReadyRound = s.round;
      prClearTimers();
      playerRevealInProgress = false;
      prHideOverlay();
      renderScoreboard._suppressAnimRound = (s.round || 0);
      renderScoreboard(s, { instant: true });

      if (isDeadNow) {
        const DONE_MS = Math.max(0, SCORE_PANEL_OPEN_MS + SCORE_PANEL_CONTENT_FADE_MS + 120 - DEAD_SCREEN_EARLY_MS);
        let sinceReady = 0;
        if (typeof s.revealReadyAt === "number" && Number.isFinite(s.revealReadyAt)) {
          sinceReady = (serverNow() - s.revealReadyAt);
        } else {
          // Player-driven reveal: approximate using how long we're past the reveal duration.
          const pastEnd = Math.max(0, elapsed - revealDur);
          sinceReady = pastEnd;
        }
        scheduleDeadThemeAfterScoreboard(s.round, Math.max(0, DONE_MS - sinceReady));
      }

    } else {
      closeScoreboardPanel();
      // Restart reveal at correct offset.
      prClearTimers();
      playerRevealInProgress = false;
      playerRevealPlayedRound = null;
      const totalMs = playerRevealPendingResume ? playerRevealPendingTotalMs : revealDur;
      playerRevealPendingResume = false;
      deferNoAnimRemoval = true;
      startPlayerReveal(s, { startAtMs: elapsed, durationMs: totalMs, resumeNoFade: true });
    }
  } else if (s.phase === "revealed" && ((s.revealReadyRound === s.round) || (localRevealReadyRound === s.round))) {
    renderScoreboard._suppressAnimRound = (s.round || 0);
    renderScoreboard(s, { instant: true });

    if (isDeadNow) {
      const DONE_MS = Math.max(0, SCORE_PANEL_OPEN_MS + SCORE_PANEL_CONTENT_FADE_MS + 120 - DEAD_SCREEN_EARLY_MS);
      const sinceReady = (typeof s.revealReadyAt === "number" && Number.isFinite(s.revealReadyAt))
        ? (serverNow() - s.revealReadyAt)
        : 0;
      scheduleDeadThemeAfterScoreboard(s.round, Math.max(0, DONE_MS - sinceReady));
    }
  } else {
    closeScoreboardPanel();
  }


// Also request a fresh state snapshot now that we're foregrounded.
// This prevents getting stuck on an old round/phase after the phone slept.
try { socket.emit("sync"); } catch {}
if (hasJoined) {
  try { socket.emit("join", { name: "", playerKey: getPlayerKey() }); } catch {}
}

// If a new rule intro was queued while the tab was hidden, show it now (player reveal mode only).
try {
  if (!document.hidden && priPendingIntro && lastState && lastState.phase === "collecting" && lastState.round === priPendingIntro.round && (lastState.infoClientCount || 0) === 0) {
    const pending = priPendingIntro;
    priPendingIntro = null;

    // Don't interfere with the reveal timeline
    if (!playerRevealInProgress && !playerRuleIntroInProgress && playerRuleIntroPlayedRound !== pending.round) {
      playerRuleIntroPlayedRound = pending.round;
      playerRuleIntroInProgress = true;
      priDelayRound = pending.round;

      priHideRoundRulesOverlay();
      prShowOverlay();
      playerRevealOverlay.classList.remove("showStage");
      prSetBlack(true);
      priShowRoundRulesOverlayFromLines(pending.lines);

      // Fade back after total duration
      priSetTimeout(() => { if (!playerRevealInProgress) prSetBlack(false); }, 8000);
      priSetTimeout(() => { if (!playerRevealInProgress) prHideOverlay(); playerRuleIntroInProgress = false; }, 8460);
    }
  }
} catch (e) {}

  // If the rule overlay is currently visible, re-arm its hide timers now.
  try { if (!document.hidden && playerRevealRoundRules && !playerRevealRoundRules.classList.contains("hidden") && playerRevealRoundRules.classList.contains("show")) { priArmHideTimers(); } } catch(e) {}

// Re-enable animations (unless startPlayerReveal(resumeNoFade) already did it).
if (!deferNoAnimRemoval) {
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("noAnim")));
} else {
  // Safety fallback in case the overlay didn't remove it (shouldn't happen).
  setTimeout(() => document.body.classList.remove("noAnim"), 250);
}

});



/* ===========================
   Hidden Debug UI (player)
   Press "d" 3x quickly to show the debug menu for 5 seconds.
   (Auto-hides; timer resets on interaction.)
   =========================== */
(function setupHiddenDebugUI(){
  if (window.__tbsHiddenDebugUI) return;
  window.__tbsHiddenDebugUI = true;

  const STYLE = `
  #dbgPanel{
    position:fixed; right:10px; bottom:10px;
    z-index:9999;
    width:min(420px, calc(100vw - 20px));
    border-radius:18px;
    border:1px solid rgba(255,255,255,.18);
    background:rgba(0,0,0,.72);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    padding:12px;
    box-shadow: 0 18px 40px rgba(0,0,0,.45);
    opacity:0;
    transform:translateY(10px);
    transition:opacity .18s ease, transform .18s ease;
    pointer-events:none;
  }
  #dbgPanel.show{
    opacity:1;
    transform:translateY(0);
    pointer-events:auto;
  }
  #dbgPanel h4{
    margin:0 0 10px 0;
    font:700 14px/1.1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    color:#fff;
    letter-spacing:.2px;
  }
  #dbgPanel .row{
    display:flex;
    gap:6px;
    flex-wrap:nowrap;
    justify-content:center;
    align-items:stretch;
  }
  #dbgPanel button{
    flex:1 1 0;
    min-width:0;
    height:44px;
    padding: 0 6px;
    border-radius:12px;
    border:1px solid rgba(255,255,255,.18);
    background:rgba(255,255,255,.06);
    color:#fff;
    font:600 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    cursor:pointer;
  }
  #dbgPanel button:active{ transform: translateY(1px); }
  @media (max-width: 360px){
    #dbgPanel button{ font-size:11px; }
  }
  #dbgToast{
    position:fixed; left:14px; bottom:14px;
    z-index:9999;
    padding:10px 12px;
    border-radius:14px;
    border:1px solid rgba(255,255,255,.16);
    background:rgba(0,0,0,.72);
    color:#fff;
    font:600 13px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    opacity:0;
    transition:opacity .18s ease;
    pointer-events:none;
    max-width:min(520px, calc(100vw - 28px));
    text-align:center;
  }
  #dbgToast.show{ opacity:1; }
  `;
  const st = document.createElement("style");
  st.textContent = STYLE;
  document.head.appendChild(st);

  const panel = document.createElement("div");
  panel.id = "dbgPanel";
  panel.innerHTML = `
    <h4>Debug tools</h4>
    <div class="row">
      <button id="dbgCopy" type="button">Kopieer debug</button>
      <button id="dbgHost" type="button">Open host</button>
      <button id="dbgInfo" type="button">Open info</button>
    </div>
  `;
  document.body.appendChild(panel);

  const toast = document.createElement("div");
  toast.id = "dbgToast";
  document.body.appendChild(toast);

  function showToast(msg){
    toast.textContent = String(msg || "");
    toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function copyText(text){
    const t = String(text ?? "");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(() => showToast("Debug gekopieerd.")).catch(() => fallback());
      return;
    }
    fallback();

    function fallback(){
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); showToast("Debug gekopieerd."); }
      catch { showToast("Kopiëren mislukt."); }
      finally { ta.remove(); }
    }
  }

  function buildDebugDump(){
    let key = "";
    try { key = getPlayerKey(); } catch {}
    return {
      ts: new Date().toISOString(),
      url: location.href,
      hidden: document.hidden,
      playerKey: key,
      lastState,
    };
  }

  let autoHideTimer = null;
  function hidePanel(){
    panel.classList.remove("show");
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
  function armAutoHide(){
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(hidePanel, 5000);
  }
  function showPanel(){
    panel.classList.add("show");
    armAutoHide();
  }

  panel.addEventListener("pointerdown", armAutoHide);

  panel.querySelector("#dbgCopy").addEventListener("click", () => {
    armAutoHide();
    copyText(JSON.stringify(buildDebugDump(), null, 2));
  });
  panel.querySelector("#dbgHost").addEventListener("click", () => {
    armAutoHide();
    window.open("/host", "_blank");
  });
  panel.querySelector("#dbgInfo").addEventListener("click", () => {
    armAutoHide();
    window.open("/info", "_blank");
  });

  // Listen to server notices (if any)
  socket.on("debug_notice", (msg) => showToast(msg));

  // Triple 'd' detection
  let dHits = [];
  document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const tag = (document.activeElement && document.activeElement.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;

    if (String(e.key || "").toLowerCase() !== "d") return;
    const now = Date.now();
    dHits = dHits.filter((t) => now - t < 1200);
    dHits.push(now);
    if (dHits.length >= 3) {
      dHits = [];
      showPanel();
    }
  });

  // Touch / pointer shortcut: triple tap or long-press on the header title (works on touchscreens)
  const dbgTarget = document.querySelector(".title");
  if (dbgTarget) {
    let tapHits = [];
    dbgTarget.addEventListener("pointerup", (e) => {
      // Only treat touch/pen as taps (mouse clicks shouldn't accidentally open debug)
      if (e && e.pointerType && e.pointerType === "mouse") return;
      const now = Date.now();
      tapHits = tapHits.filter((t) => now - t < 900);
      tapHits.push(now);
      if (tapHits.length >= 3) {
        tapHits = [];
        showPanel();
      }
    });

    let holdTimer = null;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
    dbgTarget.addEventListener("pointerdown", (e) => {
      if (e && e.pointerType && e.pointerType === "mouse") return;
      clearHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        showPanel();
      }, 700);
    });
    dbgTarget.addEventListener("pointercancel", clearHold);
    dbgTarget.addEventListener("pointerup", clearHold);
    dbgTarget.addEventListener("pointermove", (e) => {
      // Small moves happen during taps; cancel only on bigger drags
      if (!holdTimer) return;
      if (e && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4)) clearHold();
    });
  }

})(); 
