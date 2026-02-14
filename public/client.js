
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

const socket = io();

let picked = null;
let confirmed = false;
let lastPhase = null;

// Player scoreboard should only open after the info screen finished its reveal animation.
// The server broadcasts `revealReadyRound`; players open when revealReadyRound === round.
let pendingRevealState = null;

let visEpoch = 0; // v53A: visibility token to prevent delayed animations


let lastScores = new Map();
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
const survivedFx = document.getElementById("survivedFx");

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

function setDeadTheme(on) {
  document.body.classList.toggle("deadTheme", on);
  deadNoise.classList.toggle("on", on);
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
      const fromScore = (typeof p.prevScore === "number")
        ? p.prevScore
        : (baseScore - deltaVal); // deltaVal is negative
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
  lastState = state;

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
    setDeadTheme(false);
    setSurvivedTheme(false);
    return;
  }

  hideLobbyMessage();
  setGameVisible(true);

  const aliveCount = state.players.filter((p) => !p.eliminated).length;
  const iAmDead = !!me.eliminated;
  const iSurvived = !iAmDead && aliveCount === 1 && state.phase === "revealed";

  setDeadTheme(iAmDead);
  setSurvivedTheme(iSurvived);

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
    }

    // IMPORTANT: also react to dev-fill (or late server-side submit) DURING the round.
    // Previously we only applied submitted UI on round start, which meant a mid-round
    // dev fill would not show the confirmed glow / muted grid until the reveal.
    if (!iAmDead && !document.body.classList.contains("survivedTheme")) {
      applySubmittedUI(me);
    }

    // Zodra we uit de reveal fase gaan, moet het scoreboard-paneel ook weer inklappen.
    // Scoreboard volledig inklappen (anders blijft er een leeg vlak staan).
    closeScoreboardPanel();
    pendingRevealState = null;
    renderScoreboard._suppressAnimRound = null;
    renderScoreboard._animPlayedRound = null;
  }


  if (state.phase === "revealed") {
    grid.classList.add("revealLock");
    confirmBtn.disabled = true;
    // Make sure my confirmed choice stays visible (even if the collecting update was missed).
    if (!iAmDead && !document.body.classList.contains("survivedTheme")) {
      applySubmittedUI(me);
    }
  pendingRevealState = state;

  // Only open the scoreboard when the info screen has finished its reveal animation.
  if (state.revealReadyRound === state.round) {
    renderScoreboard(state, { instant: document.hidden });
  } else {
    // Keep it closed while waiting.
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

  if (document.hidden) {
    document.body.classList.add("noAnim");
    // Cancel delayed timers that could fire on return.
    clearTimeout(renderScoreboard._tShow);
    clearTimeout(renderScoreboard._tShow2);
    clearTimeout(renderScoreboard._tHide);
    clearTimeout(closeScoreboardPanel._tCollapse);
    clearTimeout(closeScoreboardPanel._tReset);
    clearScoreAnimTimers();

    if (!s || s.phase !== "revealed" || s.revealReadyRound !== s.round) {
      closeScoreboardPanel();
      return;
    }

    renderScoreboard._suppressAnimRound = (s.round || 0);
    renderScoreboard(s, { instant: true });
    return;
  }

  // Visible again: keep noAnim while catching up so nothing "replays".
  document.body.classList.add("noAnim");
  if (s && s.phase === "revealed" && s.revealReadyRound === s.round) {
    renderScoreboard(s, { instant: true });
  } else {
    closeScoreboardPanel();
  }
  requestAnimationFrame(() => document.body.classList.remove("noAnim"));
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
    position:fixed; right:14px; bottom:14px;
    z-index:9999;
    width:min(320px, calc(100vw - 28px));
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
    gap:8px;
    flex-wrap:nowrap;
    justify-content:center;
    align-items:stretch;
  }
  #dbgPanel button{
    flex:1 1 0;
    min-width:0;
    width: calc((100% - 16px) / 3);
    height:38px;
    padding: 0 8px;
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
})(); 
