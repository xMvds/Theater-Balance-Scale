(function requireAccessCode(){
  try{
    if (sessionStorage.getItem("tbs_access_ok") === "1") return;
  }catch(e){}
  const code = prompt("Code nodig om info te openen:");
  if (String(code || "").trim() === "0909"){
    try{ sessionStorage.setItem("tbs_access_ok","1"); }catch(e){}
    return;
  }
  alert("Onjuiste code.");
  location.replace("/");
  throw new Error("Access denied");
})();

const socket = io();

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
  if (rs == null || !Number.isFinite(rs)) return 0;
  return Math.max(0, serverNow() - rs);
}

socket.on("connect", () => {
  socket.emit("info_hello");
  socket.emit("sync");
});


document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  try { socket.emit("sync"); } catch {}
});

// iOS Safari bfcache: ensure we request fresh state on restore
window.addEventListener("pageshow", (e) => {
  if (!e || !e.persisted) return;
  try { socket.connect(); } catch {}
  try { socket.emit("sync"); } catch {}
});


const blackout = document.getElementById("infoBlackout");
const stage = document.getElementById("infoStage");

const scene = document.getElementById("infoScene");
const namesRow = document.getElementById("infoNamesRow");
const guessesRow = document.getElementById("infoGuessesRow");
const scoresRow = document.getElementById("infoScoresRow");
const deltasRow = document.getElementById("infoDeltasRow");

const mathRow = document.getElementById("infoMathRow");
const avgValEl = document.getElementById("infoAvgVal");
const targetValEl = document.getElementById("infoTargetVal");
const mathOpEl = document.getElementById("infoMathOp");

const roundRulesEl = document.getElementById("infoRoundRules");

let prevScores = new Map();
let lastPhase = null;
// Prevent re-running the reveal animation when the info screen receives
// duplicate 'state' updates for the same revealed round (e.g. when a player
// reconnects/refreshes).
let lastRevealKey = null;

function stableRevealKey(state){
  // Gebruik stabiele velden en een vaste sortering zodat een player-refresh
  // (socket id verandert / connect toggles) niet onbedoeld de volledige
  // reveal-animatie opnieuw start.
  const players = (state.players || [])
    .map(p => ({
      key: p.key || p.id || "",
      name: p.name || "",
      score: p.score ?? 0,
      eliminated: !!p.eliminated,
      lastGuess: p.lastGuess ?? null,
      lastDelta: p.lastDelta ?? 0,
    }))
    .sort((a,b) => String(a.key).localeCompare(String(b.key)));
  const lr = state.lastRound || null;
  return JSON.stringify({
    round: state.round,
    phase: state.phase,
    players,
    lastRound: lr ? { average: lr.average, target: lr.target, winnerIds: lr.winnerIds } : null,
  });
}

let fadeHideTimer = null;
let rulesDelayTimer = null;
let lastState = null;

let lastCollectRound = null;
let prevActiveRules = { r1: false, r2: false, r3: false };

let animTimers = [];
function clearAnimTimers() {
  for (const t of animTimers) clearTimeout(t);
  animTimers = [];
}

function fmt2(n) {
  if (typeof n !== "number") return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function animateScoreNumber(el, from, to, isBad) {
  el.innerHTML = "";

  const oldNode = document.createElement("div");
  oldNode.className = "scoreNum live " + (isBad ? "bad" : "good");
  oldNode.textContent = String(from);

  const newNode = document.createElement("div");
  newNode.className = "scoreNum in " + (isBad ? "bad" : "good");
  newNode.textContent = String(to);

  el.appendChild(oldNode);
  el.appendChild(newNode);

  // iets rustiger
  animTimers.push(setTimeout(() => {
    requestAnimationFrame(() => {
      oldNode.classList.add("out");
      oldNode.classList.remove("live");
      newNode.classList.remove("in");
      newNode.classList.add("live");
    });
  }, 300));
}

function setScoreStatic(el, value, isBad) {
  el.innerHTML = `<div class="scoreNum live ${isBad ? "bad" : "good"}">${value}</div>`;
}

function setDeltaStatic(el, delta) {
  const isBad = delta < 0;
  const txt = delta === 0 ? "0" : String(delta);
  el.innerHTML = `<div class="deltaNum ${isBad ? "bad" : "neutral"}">${txt}</div>`;
}

function animateDeltaNumber(el, delta) {
  // Alleen animeren als iemand echt minpunten krijgt
  if (typeof delta !== "number" || delta >= 0) {
    setDeltaStatic(el, typeof delta === "number" ? delta : 0);
    return;
  }

  el.innerHTML = "";

  const oldNode = document.createElement("div");
  oldNode.className = "deltaNum live neutral";
  oldNode.textContent = "0";

  const newNode = document.createElement("div");
  newNode.className = "deltaNum in bad";
  newNode.textContent = String(delta);

  el.appendChild(oldNode);
  el.appendChild(newNode);

  animTimers.push(setTimeout(() => {
    requestAnimationFrame(() => {
      oldNode.classList.add("out");
      oldNode.classList.remove("live");
      newNode.classList.remove("in");
      newNode.classList.add("live");
    });
  }, 380));
}

function hideRoundRulesOverlay() {
  roundRulesEl.classList.add('hidden');
  roundRulesEl.classList.remove('showBg','textOn','fadeOut');
  roundRulesEl.innerHTML = '';
}

function showRoundRulesOverlayFromLines(lines) {
  if (!lines || lines.length === 0) {
    hideRoundRulesOverlay();
    return;
  }

  const BG_IN_MS = 650;
  const SHOW_MS = 3000;
  const FADE_MS = 5000;

  roundRulesEl.innerHTML = `
    <div class="rrContent">
      <div class="rrTitle">Nieuwe Regel</div>
      <div class="rrBig">
        ${lines.map((t) => `<div class="rrLine">${t}</div>`).join("")}
      </div>
    </div>
  `;

  roundRulesEl.classList.remove('hidden');
  roundRulesEl.classList.remove('showBg','textOn','fadeOut');

  // Fade the black screen in first...
  requestAnimationFrame(() => roundRulesEl.classList.add('showBg'));

  clearTimeout(showRoundRulesOverlayFromLines._t1);
  clearTimeout(showRoundRulesOverlayFromLines._t2);
  clearTimeout(showRoundRulesOverlayFromLines._t3);

  // ...then pop the text in (no fade-in)
  showRoundRulesOverlayFromLines._t1 = setTimeout(() => {
    roundRulesEl.classList.add('textOn');
  }, BG_IN_MS);

  // Hold for 3s, then fade BOTH bg + text out together
  showRoundRulesOverlayFromLines._t2 = setTimeout(() => {
    roundRulesEl.classList.add('fadeOut');
  }, BG_IN_MS + SHOW_MS);

  showRoundRulesOverlayFromLines._t3 = setTimeout(() => {
    hideRoundRulesOverlay();
  }, BG_IN_MS + SHOW_MS + FADE_MS + 80);
}

function showStage() {
  clearTimeout(fadeHideTimer);
  stage.classList.remove("hidden");
  requestAnimationFrame(() => stage.classList.add("visible"));
}

function fadeOutStageAndHide() {
  stage.classList.remove("visible");

  clearTimeout(fadeHideTimer);
  fadeHideTimer = setTimeout(() => {
    stage.classList.add("hidden");
    // leegmaken
    clearAnimTimers();
    scene.classList.remove("s1","s2","s3a","s3","s3b","s4a","s4","ready","instant","opDone");
    namesRow.innerHTML = "";
    guessesRow.innerHTML = "";
    scoresRow.innerHTML = "";
    deltasRow.innerHTML = "";
  }, 1400);
}

function computeNewRuleLines(state) {
  const rr = state.roundRules || {
    duplicatesInvalid: false,
    exactDoublePenalty: false,
    zeroHundredSpecial: false,
  };

  const now = {
    r1: !!rr.duplicatesInvalid,
    r2: !!rr.exactDoublePenalty,
    r3: !!rr.zeroHundredSpecial,
  };

  const newOn = {
    r1: now.r1 && !prevActiveRules.r1,
    r2: now.r2 && !prevActiveRules.r2,
    r3: now.r3 && !prevActiveRules.r3,
  };

  prevActiveRules = now;

  const lines = [];
  if (newOn.r1) lines.push("1. Dubbele getallen zijn ongeldig en leveren -1 punt op.");
  if (newOn.r2) lines.push("2. Exact geraden getallen geven de verliezers -2 punten.");
  if (newOn.r3) lines.push("3. Kiest een speler 0, dan wint de ander door 100 te kiezen.");
  return lines;
}

function buildRevealScene(state, opts = {}) {
  const instant = !!opts.instant;
  const startAtMs = Math.max(0, Number(opts.startAtMs || 0));
  clearAnimTimers();

  // reset classes
  scene.classList.remove("s1","s2","s3a","s3","s3b","s4a","s4","ready","instant","opDone");
  namesRow.innerHTML = "";
  guessesRow.innerHTML = "";
  scoresRow.innerHTML = "";
  deltasRow.innerHTML = "";

  // data
  const lr = state.lastRound || {};
  const avg = lr.average;
  const target = lr.target;

  avgValEl.textContent = fmt2(avg);
  targetValEl.textContent = fmt2(target);

  const list = (state.players || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const pendingScoreAnims = [];
  const allScoreCells = [];

  // Build aligned cells (same count per row)
  for (const p of list) {
    // Names (hidden at first)
    const nameCell = document.createElement("div");
    nameCell.className = "infoCell infoName";
    nameCell.textContent = p.name;
    namesRow.appendChild(nameCell);

    // Guess tile
    const guessCell = document.createElement("div");
    guessCell.className = "infoCell infoGuessTile";
    guessCell.innerHTML = `<div class="guessNum">${(typeof p.lastGuess === "number") ? p.lastGuess : "—"}</div>`;
    guessesRow.appendChild(guessCell);

    // Total score
    const scoreCell = document.createElement("div");
    scoreCell.className = "infoCell infoScore";
    const d = (typeof p.lastDelta === "number") ? p.lastDelta : 0;
    const isBad = d < 0;

    // Winner glow (apply at the very end, together with min points)
    const isWinner = Array.isArray(lr.winnerIds) && lr.winnerIds.includes(p.id);
    if (isWinner) {
      guessCell.dataset.winner = "1";
      nameCell.dataset.winner = "1";
    }

    // Build score cell with OLD score, animate only when score row becomes visible.
    const prev = prevScores.has(p.id) ? prevScores.get(p.id) : null;
    const from = (typeof prev === "number") ? prev : (typeof d === "number" ? (p.score - d) : p.score);
    const to = p.score;

    allScoreCells.push({ el: scoreCell, to });

    if (instant) {
      const bad = (typeof to === "number") ? (to < 0) : false;
      setScoreStatic(scoreCell, to, bad);
    } else {
      scoreCell.innerHTML = `<div class="scoreNum live ${isBad ? "bad" : "good"}">${from}</div>`;
      if (isBad && typeof from === "number" && typeof to === "number" && to !== from) {
        pendingScoreAnims.push({ el: scoreCell, from, to });
      }
    }

    scoresRow.appendChild(scoreCell);
    prevScores.set(p.id, p.score);

    // Delta
    const deltaCell = document.createElement("div");
    deltaCell.className = "infoCell infoDelta";
    setDeltaStatic(deltaCell, d);
    deltasRow.appendChild(deltaCell);
  }

  const snapToEnd = () => {
    scene.classList.add("instant");
    scene.classList.add("ready","s1","s2","s3a","s3","s3b","s4a","s4");
    for (const el of document.querySelectorAll("[data-winner=\"1\"]")) {
      el.classList.add("winner");
    }
    // Ensure totals are at final values
    for (const sc of allScoreCells) {
      const bad = (typeof sc.to === "number") ? (sc.to < 0) : false;
      setScoreStatic(sc.el, sc.to, bad);
    }
    socket.emit("info_reveal_done", { round: state.round });
  };

  if (instant) {
    snapToEnd();
    return;
  }

  // If we join late, jump to the correct visual state without replaying past transitions.
  const applyAt = (ms) => {
    const t = Math.max(0, ms);
    scene.classList.add("instant");
    scene.classList.add("ready");
    scene.classList.add("s1");
    if (t >= 1600) scene.classList.add("s2");
    if (t >= 3000) scene.classList.add("s3a");
    if (t >= 3800) scene.classList.add("s3");
    if (t >= 4600) scene.classList.add("s3b");
    if (t >= 6200) scene.classList.add("s4a");
    if (t >= 7600) {
      scene.classList.add("s4");
      for (const el of document.querySelectorAll("[data-winner=\"1\"]")) {
        el.classList.add("winner");
      }
    }

    // Late-join / refresh mid-reveal: if the math operator should already be visible,
    // keep it locked in the final state so it doesn't replay its fade/clip once on load.
    scene.classList.toggle("opDone", t >= 3800);

    // Catch up score animations
    if (t >= 7600) {
      if (t >= 8500) {
        for (const sc of allScoreCells) {
          const bad = (typeof sc.to === "number") ? (sc.to < 0) : false;
          setScoreStatic(sc.el, sc.to, bad);
        }
      } else if (pendingScoreAnims.length) {
        const delay = Math.max(0, 8500 - t);
        animTimers.push(setTimeout(() => {
          for (const a of pendingScoreAnims) {
            animateScoreNumber(a.el, a.from, a.to, true);
          }
        }, delay));
      }
    }

    // Remove instant after layout so future steps can animate normally.
    requestAnimationFrame(() => requestAnimationFrame(() => scene.classList.remove("instant")));
  };

  // If we're already past the end, snap.
  if (startAtMs >= 10300) {
    snapToEnd();
    return;
  }

  applyAt(startAtMs);

  const schedule = (at, fn) => {
    const d = at - startAtMs;
    if (d <= 0) return;
    animTimers.push(setTimeout(fn, d));
  };

  schedule(1600, () => scene.classList.add("s2"));
  schedule(3000, () => scene.classList.add("s3a"));
  schedule(3800, () => scene.classList.add("s3"));
  schedule(4600, () => scene.classList.add("s3b"));
  schedule(6200, () => scene.classList.add("s4a"));
  schedule(7600, () => {
    scene.classList.add("s4");
    for (const el of document.querySelectorAll("[data-winner=\"1\"]")) {
      el.classList.add("winner");
    }
    if (pendingScoreAnims.length) {
      animTimers.push(setTimeout(() => {
        for (const a of pendingScoreAnims) {
          animateScoreNumber(a.el, a.from, a.to, true);
        }
      }, 900));
    }
  });

  schedule(10300, () => {
    socket.emit("info_reveal_done", { round: state.round });
  });
}

socket.on("state", (state) => {
  lastState = state;
  updateServerClock(state);

  // reset bij lobby (nieuwe game/reset)
  if (state.phase === "lobby") {
    lastCollectRound = null;
    prevActiveRules = { r1: false, r2: false, r3: false };
    hideRoundRulesOverlay();
  }

  // Nieuwe ronde start (collecting): toon alleen NIEUWE regel(s), 1 seconde later
  if (state.phase === "collecting" && state.round !== lastCollectRound) {
    lastCollectRound = state.round;

    const lines = computeNewRuleLines(state);
    clearTimeout(rulesDelayTimer);

    if (lines.length > 0) {
      rulesDelayTimer = setTimeout(() => {
        if (!lastState) return;
        if (lastState.phase !== "collecting") return;
        if (lastState.round !== state.round) return;
        showRoundRulesOverlayFromLines(lines);
      }, 1000);
    } else {
      // geen nieuwe regel => zwart
      hideRoundRulesOverlay();
    }
  }

  // zodra reveal start: overlay weg
  if (state.phase === "revealed" && lastPhase !== "revealed") {
    hideRoundRulesOverlay();
  }

  // NON-reveal: scoreboard weg (met fade) en verder zwart
  if (state.phase !== "revealed") {
    if (lastPhase === "revealed") {
      fadeOutStageAndHide();
    } else {
      stage.classList.add("hidden");
      stage.classList.remove("visible");
      clearAnimTimers();
      scene.classList.remove("s1","s2","s3a","s3","s3b","s4a","s4","ready","instant","opDone");
      namesRow.innerHTML = "";
      guessesRow.innerHTML = "";
      scoresRow.innerHTML = "";
      deltasRow.innerHTML = "";
    }
    lastPhase = state.phase;
    // Leaving revealed phase: allow the next reveal to animate again.
    lastRevealKey = null;
    return;
  }

  // REVEAL
  lastPhase = state.phase;
  showStage();
  // Only rebuild the reveal scene once per revealed round; repeated identical
  // state broadcasts (e.g. when a player reconnects) should not restart the
  // reveal animation.
  const revealKey = stableRevealKey(state);
  if (revealKey !== lastRevealKey) {
    lastRevealKey = revealKey;
    const instant = state.revealReadyRound === state.round;
    const startAtMs = instant ? 0 : revealElapsedMs(state);
    buildRevealScene(state, { instant, startAtMs });
  }
});