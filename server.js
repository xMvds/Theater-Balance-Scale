// server.js — VERVANG VOLLEDIG
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Friendly routes (optional, but handy on Render)
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/player", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/host", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});
app.get("/info", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "info.html"));
});


const game = {
  phase: "lobby", // lobby | collecting | revealed
  round: 0,
  players: {}, // socketId -> player
  byKey: {}, // playerKey -> socketId
  lastRound: null,

  // Reveal sync (option 2):
  // If no info screen is connected when the host presses Reveal,
  // players will run the reveal locally based on a shared start timestamp.
  revealDriver: null, // "info" | "player" | null
  revealStartedAt: null, // epoch ms
  revealDurationMs: null,
  revealReadyAt: null, // epoch ms when reveal became ready (score known / scoreboard may open)
  infoClientCount: 0,

  // Player background mode, controlled from the host
  // A = static image, B = animated blobs, C/D = FinisherHeader particles
  // Default is C.
  playerBgMode: "C",


  // FinisherHeader configs for player background modes C and D (editable from host BG editor).
  playerFinisherConfigs: {
    C: {
      "count": 7,
      "size": { "min": 298, "max": 506, "pulse": 0.19 },
      "speed": { "x": { "min": 0, "max": 0.06 }, "y": { "min": 0, "max": 0.1 } },
      "colors": { "background": "#0b0d12", "particles": ["#2e2f33"] },
      "blending": "screen",
      "opacity": { "center": 0.09, "edge": 0 },
      "skew": 0,
      "shapes": ["c"]
    },
    D: {
      "count": 7,
      "size": { "min": 298, "max": 506, "pulse": 0.19 },
      "speed": { "x": { "min": 0, "max": 0.06 }, "y": { "min": 0, "max": 0.1 } },
      "colors": { "background": "#0b0d12", "particles": ["#2e2f33"] },
      "blending": "screen",
      "opacity": { "center": 0.09, "edge": 0 },
      "skew": 0,
      "shapes": ["c"]
    }
  },

  // snapshot rules for the current round (set ONLY at round start)
  roundRules: null,
  ruleIntro: null,

  // Players only open their scoreboard when revealReadyRound === round.
  revealReadyRound: 0,

  // When true, the game has ended (only 0-1 players alive). Host can only reset.
  gameOver: false,

  // Host auto-next (optional): after totals are shown, auto-advance after a delay.
  autoNextDelayMs: 0, // 0 = off
  autoNextAt: null,   // epoch ms when auto-next will fire
};

// Reveal timing (must match the front-end timelines)
// Info screen emits `info_reveal_done` at ~10300ms.
const INFO_ANIM_TOTAL_MS = 10300; // ms
// Player-side reveal includes the info timeline + slower fade-out back to UI.
const PLAYER_REVEAL_TOTAL_MS = 12000; // ms
// Host button countdown includes a short "scoreboard settle" window after the reveal is ready.
// Keep this aligned with public/host.js (HOST_SCOREBOARD_LOCK_MS).
const HOST_SCOREBOARD_LOCK_MS = 1400; // ms
let revealReadyTimer = null;
let autoNextTimer = null;

// Allow dev fill from player debug UI only when explicitly enabled.
const DEBUG_DEVFILL = process.env.DEBUG_DEVFILL === "1";

function markRevealReady(round) {
  if (game.revealReadyRound === round) return;
  game.revealReadyRound = round;
  game.revealReadyAt = Date.now();
  io.emit("reveal_ready", { round });
  broadcastState();
}

function clearRevealReady() {
  game.revealReadyRound = 0;
  game.revealReadyAt = null;
  if (revealReadyTimer) {
    clearTimeout(revealReadyTimer);
    revealReadyTimer = null;
  }
}

function clearRevealSync() {
  game.revealDriver = null;
  game.revealStartedAt = null;
  game.revealDurationMs = null;
  cancelAutoNext();
  clearRevealReady();
}


function cancelAutoNext() {
  if (autoNextTimer) {
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }
  game.autoNextAt = null;
}

// Auto-next must trigger *after totals are visible*, not after the full reveal is over.
// This matches the front-end timelines (info.js / client.js): totals lock-in at ~8500ms.
const TOTALS_AT_MS = 8500;

function scheduleAutoNextAfterTotals(round) {
  cancelAutoNext();

  const delay = Number(game.autoNextDelayMs || 0);
  if (!Number.isFinite(delay) || delay <= 0) return;
  if (game.gameOver) return;
  if (game.phase !== "revealed") return;
  if (round !== game.round) return;

  const now = Date.now();
  const rs = (typeof game.revealStartedAt === "number" && Number.isFinite(game.revealStartedAt))
    ? game.revealStartedAt
    : now;

  // Fire after totals moment (or immediately if we're already past it), plus chosen delay.
  const base = Math.max(now, rs + TOTALS_AT_MS);
  const fireAt = base + delay;

  game.autoNextAt = fireAt;

  autoNextTimer = setTimeout(() => {
    // Guard: only if we're still in the same reveal.
    if (game.phase !== "revealed") return;
    if (game.gameOver) return;
    if (game.round !== round) return;

    game.phase = "collecting";
    game.round += 1;
    clearRevealSync();
    resetForNewRound();
    setRoundRulesSnapshot();
    broadcastState();
  }, Math.max(0, fireAt - now));
}


function sanitizeName(name) {
  // Keep it user-provided (may be empty) — defaults are handled in join().
  let s = String(name ?? "").trim();
  // collapse whitespace
  s = s.replace(/\s+/g, " ");
  if (s.length > 18) s = s.slice(0, 18);
  return s;
}

function currentNameSetLower(exceptSid = null) {
  const set = new Set();
  for (const [sid, p] of Object.entries(game.players)) {
    if (!p) continue;
    if (exceptSid && sid === exceptSid) continue;
    const n = String(p.name ?? "").trim();
    if (!n) continue;
    set.add(n.toLowerCase());
  }
  return set;
}

function nextAutoPlayerName() {
  const used = currentNameSetLower();
  for (let i = 1; i < 9999; i++) {
    const cand = `Speler ${i}`;
    if (!used.has(cand.toLowerCase())) return cand;
  }
  return `Speler ${Math.floor(Math.random() * 9999)}`;
}

function aliveIds() {
  return Object.entries(game.players)
    .filter(([_, p]) => p && !p.eliminated)
    .map(([id]) => id);
}

function rulesNow() {
  const alive = aliveIds().length;
  return {
    alive,
    duplicatesInvalid: alive <= 4, // Rule 1
    exactDoublePenalty: alive <= 3, // Rule 2
    zeroHundredSpecial: alive <= 2, // Rule 3
  };
}

function setRoundRulesSnapshot() {
  const next = rulesNow();
  const prev = game.roundRules || {
    alive: Infinity,
    duplicatesInvalid: false,
    exactDoublePenalty: false,
    zeroHundredSpecial: false,
  };

  game.ruleIntro = {
    r1: next.duplicatesInvalid && !prev.duplicatesInvalid,
    r2: next.exactDoublePenalty && !prev.exactDoublePenalty,
    r3: next.zeroHundredSpecial && !prev.zeroHundredSpecial,
  };

  game.roundRules = next;
}


function makeStatePayload() {
  const aliveNow = aliveIds().length;

  const playersList = Object.entries(game.players).map(([id, p]) => ({
    id,
    key: p.key,
    name: p.name,
    score: p.score,
    eliminated: p.eliminated,
    submitted: p.submitted,
    lastGuess: p.lastGuess,
    lastDelta: p.lastDelta,
    connected: !!p.connected,
  }));

  return {
    phase: game.phase,
    round: game.round,
    aliveNow,
    // Reveal sync metadata (option 2)
    revealDriver: game.revealDriver,
    revealStartedAt: game.revealStartedAt,
    revealDurationMs: game.revealDurationMs,
    revealReadyAt: game.revealReadyAt,
    infoClientCount: game.infoClientCount || 0,
    serverNow: Date.now(),
    playerBgMode: game.playerBgMode || "C",
    playerFinisherConfigs: game.playerFinisherConfigs || null,
    roundRules: game.roundRules,
    ruleIntro: game.ruleIntro,
    players: playersList,
    lastRound: game.lastRound,
    revealReadyRound: game.revealReadyRound,
    gameOver: game.gameOver,
    autoNextDelayMs: game.autoNextDelayMs || 0,
    autoNextAt: game.autoNextAt || null,
  };
}

function broadcastState() {
  io.emit("state", makeStatePayload());
}

function resetForNewRound() {
  for (const p of Object.values(game.players)) {
    if (!p) continue;
    p.submitted = false;
    p.lastGuess = null;
    p.lastDelta = 0;
  }
  game.lastRound = null;
}

function eliminateIfNeeded() {
  for (const p of Object.values(game.players)) {
    if (!p) continue;
    if (!p.eliminated && p.score <= -10) p.eliminated = true;
  }
}

function endRoundAndScore() {
  const rules = game.roundRules || rulesNow();
  const alive = aliveIds();

  const guesses = alive.map((id) => ({ id, guess: game.players[id].lastGuess }));

  const missingIds = new Set(
    guesses.filter((g) => typeof g.guess !== "number").map((g) => g.id)
  );

  // Rule 1: duplicates invalid (only when active)
  const dupIds = new Set();
  if (rules.duplicatesInvalid) {
    const freq = new Map();
    for (const g of guesses) {
      if (typeof g.guess === "number") freq.set(g.guess, (freq.get(g.guess) || 0) + 1);
    }
    for (const g of guesses) {
      if (typeof g.guess === "number" && (freq.get(g.guess) || 0) >= 2) dupIds.add(g.id);
    }
  }

  // Missing/duplicate => -1
  const autoBad = new Set([...missingIds, ...dupIds]);
  for (const id of autoBad) {
    const p = game.players[id];
    if (!p || p.eliminated) continue;
    p.score -= 1;
    p.lastDelta = -1;
  }

  const numeric = guesses.filter((g) => typeof g.guess === "number");

  // Always compute math on ALL chosen numbers (numeric), even if duplicates become invalid.
  const avgAll = numeric.length
    ? numeric.reduce((sum, g) => sum + g.guess, 0) / numeric.length
    : null;
  const target = typeof avgAll === "number" ? avgAll * 0.8 : null;

  // Contenders for winning:
  // - If Rule 1 active: exclude duplicates + missing.
  // - If Rule 1 not active: duplicates are allowed and can tie-win.
  let contenders = numeric.filter((g) => !missingIds.has(g.id));
  if (rules.duplicatesInvalid) contenders = contenders.filter((g) => !dupIds.has(g.id));

  if (!contenders.length || typeof target !== "number") {
    eliminateIfNeeded();
    game.lastRound = {
      average: avgAll,
      target,
      winnerId: null,
      winnerIds: [],
      note: "Geen geldige keuzes.",
    };
    return;
  }

  // Find winner(s): closest to target (ties allowed)
  const EPS = 1e-9;
  let bestDist = Infinity;
  for (const g of contenders) {
    const d = Math.abs(g.guess - target);
    if (d + EPS < bestDist) bestDist = d;
  }
  let winners = contenders.filter((g) => Math.abs(Math.abs(g.guess - target) - bestDist) <= EPS);

  // Rule 3: if someone picked 0, someone else can win by picking 100 (when active)
  if (rules.zeroHundredSpecial) {
    const has0 = contenders.some((g) => g.guess === 0);
    const has100 = contenders.some((g) => g.guess === 100);
    if (has0 && has100) winners = contenders.filter((g) => g.guess === 100);
  }

  const winnerIds = winners.map((w) => w.id);
  const winnerId = winnerIds[0] || null;

  // Rule 2: "exact" means integer guess equals rounded target (e.g. 22.93 -> 23)
  const exactHit =
    rules.exactDoublePenalty &&
    winners.some((w) => w.guess === Math.round(target));

  const loserPenalty = exactHit ? 2 : 1;

  // Apply penalties to contenders that are NOT winners (autoBad already handled)
  for (const g of contenders) {
    if (winnerIds.includes(g.id)) continue;
    const p = game.players[g.id];
    if (!p || p.eliminated) continue;
    p.score -= loserPenalty;
    p.lastDelta = -loserPenalty;
  }

  // Winners get 0 delta
  for (const id of winnerIds) {
    const p = game.players[id];
    if (!p || p.eliminated) continue;
    p.lastDelta = 0;
  }

  eliminateIfNeeded();
  game.lastRound = { average: avgAll, target, winnerId, winnerIds, note: null };
}

function kickAll() {
  for (const sid of Object.keys(game.players)) { io.to(sid).emit("kicked"); } // silent on clients
  game.players = {};
  game.byKey = {};
  game.phase = "lobby";
  game.round = 0;
  game.lastRound = null;
  game.roundRules = null;
  game.ruleIntro = null;
  game.gameOver = false;
  game.autoNextDelayMs = 0;
  game.autoNextAt = null;
  clearRevealSync();
  broadcastState();
}

function kickOne(socketId) {
  const p = game.players[socketId];
  if (!p) return false;

  if (p.key && game.byKey[p.key] === socketId) delete game.byKey[p.key];
  io.to(socketId).emit("kicked");
  delete game.players[socketId];
  broadcastState();
  return true;
}

io.on("connection", (socket) => {
  socket.on("host_hello", () => {
    socket.data.isHost = true;
	    // Do NOT auto-kick players when the host opens/refreshes the host page.
	    // This keeps the current lobby/game intact when the host comes in later.
	    broadcastState();
  });

  // Info screen announces itself so we can auto-switch the reveal driver.
  socket.on("info_hello", () => {
    if (socket.data.isInfo) return;
    socket.data.isInfo = true;
    game.infoClientCount = Math.max(0, (game.infoClientCount || 0) + 1);
    broadcastState();
  });


// Clients can request a fresh state snapshot (useful after mobile background/sleep).
socket.on("sync", () => {
  socket.emit("state", makeStatePayload());
});


  // Host can switch the PLAYER background for quick A/B/C/D testing.
socket.on("host_player_bg_mode", ({ mode } = {}) => {
  if (!socket.data.isHost) return;
  const next = (mode === "B" || mode === "C" || mode === "D") ? mode : "A";
  if (game.playerBgMode === next) return;
  game.playerBgMode = next;
  broadcastState();
});

  // Host can update FinisherHeader configs (for player BG modes C/D) live from the BG editor.
  socket.on("host_player_bg_finisher_config", ({ key, config } = {}) => {
    if (!socket.data.isHost) return;
    const k = (key === "D") ? "D" : "C";

    // Basic sanitization / clamping (keeps state safe-ish, even if someone sends nonsense).
    const toNum = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

    const cfg = config && typeof config === "object" ? config : {};
    const out = {
      count: Math.round(clamp(toNum(cfg.count, 7), 1, 40)),
      size: {
        min: Math.round(clamp(toNum(cfg.size?.min, 298), 20, 1200)),
        max: Math.round(clamp(toNum(cfg.size?.max, 506), 20, 1600)),
        pulse: clamp(toNum(cfg.size?.pulse, 0.19), 0, 1),
      },
      speed: {
        x: {
          min: clamp(toNum(cfg.speed?.x?.min, 0), -2, 2),
          max: clamp(toNum(cfg.speed?.x?.max, 0.06), -2, 2),
        },
        y: {
          min: clamp(toNum(cfg.speed?.y?.min, 0), -2, 2),
          max: clamp(toNum(cfg.speed?.y?.max, 0.1), -2, 2),
        },
      },
      colors: {
        background: String(cfg.colors?.background || "#0b0d12"),
        particles: Array.isArray(cfg.colors?.particles) && cfg.colors.particles.length
          ? cfg.colors.particles.map((c) => String(c))
          : ["#2e2f33"],
      },
      blending: String(cfg.blending || "screen"),
      opacity: {
        center: clamp(toNum(cfg.opacity?.center, 0.09), 0, 1),
        edge: clamp(toNum(cfg.opacity?.edge, 0), 0, 1),
      },
      skew: clamp(toNum(cfg.skew, 0), -45, 45),
      shapes: Array.isArray(cfg.shapes) && cfg.shapes.length ? cfg.shapes.map((s)=>String(s)) : ["c"],
    };

    // Ensure size min <= max
    if (out.size.min > out.size.max) {
      const t = out.size.min; out.size.min = out.size.max; out.size.max = t;
    }

    if (!game.playerFinisherConfigs) game.playerFinisherConfigs = {};
    game.playerFinisherConfigs[k] = out;
    broadcastState();
  });


  // Host can enable auto-next after totals (flow helper).
  socket.on("host_auto_next", ({ ms } = {}) => {
    if (!socket.data.isHost) return;
    const n = Number(ms);
    game.autoNextDelayMs = (Number.isFinite(n) && n >= 0 && n <= 60000) ? Math.round(n) : 0;

    // If we're currently revealing, re-plan immediately.
    if (game.phase === "revealed") scheduleAutoNextAfterTotals(game.round);

    broadcastState();
  });







// Info screen signals when its reveal animation is finished.
socket.on("info_reveal_done", ({ round }) => {
  const r = Number(round);
  if (!Number.isFinite(r)) return;
  if (game.phase !== "revealed") return;
  if (r !== game.round) return;
  markRevealReady(r);
});


  

socket.on("host_devfill", () => {
  if (!socket.data.isHost) return;
  if (game.phase !== "collecting") return;

  for (const sid of Object.keys(game.players)) {
    const p = game.players[sid];
    if (!p || p.eliminated) continue;
    if (p.submitted) continue;
    const n = Math.floor(Math.random() * 101);
    p.lastGuess = n;
    p.submitted = true;
  }
  broadcastState();
});

socket.on("debug_devfill", () => {
  if (!DEBUG_DEVFILL && !socket.data.isHost) {
    socket.emit("debug_notice", "Dev fill is uitgeschakeld. Zet DEBUG_DEVFILL=1 op de server om dit toe te staan.");
    return;
  }
  if (game.phase !== "collecting") return;

  for (const sid of Object.keys(game.players)) {
    const p = game.players[sid];
    if (!p || p.eliminated) continue;
    if (p.submitted) continue;
    const n = Math.floor(Math.random() * 101);
    p.lastGuess = n;
    p.submitted = true;
  }
  broadcastState();
});


socket.on("join", ({ name, playerKey }) => {
    const rawName = sanitizeName(name);
    const key = String(playerKey || "").trim();

    if (!key) {
      socket.emit("join_denied", "Geen playerKey.");
      return;
    }

    // Rejoin allowed if key existed (even after disconnect), by swapping socket id
    const existingSid = game.byKey[key];
    if (existingSid && game.players[existingSid]) {
      const old = game.players[existingSid];
      delete game.players[existingSid];

      game.players[socket.id] = {
        ...old,
        // Keep reserved name on rejoin.
        name: old.name,
        connected: true,
      };
      game.byKey[key] = socket.id;

      socket.emit("join_ok", { rejoined: true, name: game.players[socket.id].name });
      broadcastState();
      return;
    }

    // New joins locked after start
    if (game.phase !== "lobby" || game.round > 0) {
      socket.emit("join_denied", "Game is al gestart. Wacht tot reset.");
      return;
    }

    // Enforce unique names (case-insensitive).
    // Empty name -> auto assign Speler 1/2/3...
    const desiredName = rawName ? rawName : nextAutoPlayerName();
    const used = currentNameSetLower();
    if (used.has(desiredName.toLowerCase())) {
      socket.emit("join_denied", "Deze naam is al in gebruik. Kies een andere naam.");
      return;
    }

    game.byKey[key] = socket.id;
    game.players[socket.id] = {
      key,
      name: desiredName,
      score: 0,
      eliminated: false,
      submitted: false,
      lastGuess: null,
      lastDelta: 0,
      connected: true,
    };

    socket.emit("join_ok", { rejoined: false, name: desiredName });
    broadcastState();
  });

  socket.on("submit", (guess) => {
    const p = game.players[socket.id];
    if (!p || p.eliminated) return;
    if (game.phase !== "collecting") return;
    if (p.submitted) return; // lock-in after confirm (prevents refresh/resubmit)

    const n = Number(guess);
    if (!Number.isInteger(n) || n < 0 || n > 100) return;

    p.lastGuess = n;
    p.submitted = true;
    broadcastState();
  });

  socket.on("host_start", () => {
    if (!socket.data.isHost) return;
    if (game.gameOver) return;
    if (game.phase === "collecting") return;

    game.phase = "collecting";
    game.round += 1;

    clearRevealSync();
    resetForNewRound();
    setRoundRulesSnapshot(); // snapshot rules at ROUND START

    broadcastState();
  });

  socket.on("host_reveal", () => {
    if (!socket.data.isHost) return;
    if (game.phase !== "collecting") return;

    endRoundAndScore();
    game.phase = "revealed";

    // Game ends when 0-1 players are alive after scoring.
    game.gameOver = aliveIds().length <= 1;

    clearRevealReady();

    // Option 2: automatic driver.
    // If no info screen is connected when reveal starts, players will run the reveal locally.
    game.revealDriver = (game.infoClientCount || 0) > 0 ? "info" : "player";
    game.revealStartedAt = Date.now();
    game.revealDurationMs = (game.revealDriver === "player") ? PLAYER_REVEAL_TOTAL_MS : INFO_ANIM_TOTAL_MS;

    // Deterministic unlock time so late-joining tabs can skip the reveal.
    revealReadyTimer = setTimeout(() => {
      if (game.phase === "revealed" && game.revealReadyRound !== game.round) {
        markRevealReady(game.round);
      }
    }, game.revealDurationMs);

    // Optional auto-next: schedule only after totals are visible.
    scheduleAutoNextAfterTotals(game.round);

    broadcastState();
  });

  socket.on("host_next", () => {
    if (!socket.data.isHost) return;
    if (game.gameOver) return;
    if (game.phase !== "revealed") return;

    // UX (updated):
    // If the host presses "Next" while the reveal/scoreboard timer is still running,
    // immediately fade out/abort the reveal and start the next round so players can
    // enter a new guess right away.
    // (If the host wants to watch the scores, they simply wait until the timer is done.)

    const now = Date.now();
    const rs = (typeof game.revealStartedAt === "number" && Number.isFinite(game.revealStartedAt)) ? game.revealStartedAt : null;
    const dur = (typeof game.revealDurationMs === "number" && Number.isFinite(game.revealDurationMs)) ? game.revealDurationMs : null;
    const readyAt = (typeof game.revealReadyAt === "number" && Number.isFinite(game.revealReadyAt))
      ? game.revealReadyAt
      : ((rs != null && dur != null) ? (rs + dur) : null);
    const animDoneAt = (readyAt != null) ? (readyAt + HOST_SCOREBOARD_LOCK_MS) : null;

    const timerRunning = (animDoneAt == null)
      ? (game.revealReadyRound !== game.round)
      : (now < animDoneAt);

    if (timerRunning) {
      // Start next round immediately.
      game.phase = "collecting";
      game.round += 1;
      clearRevealSync();
      resetForNewRound();
      setRoundRulesSnapshot();
      broadcastState();
      return;
    }

    // Normal next (after timer): advance to next round.
    game.phase = "collecting";
    game.round += 1;
    clearRevealSync();
    resetForNewRound();
    setRoundRulesSnapshot(); // snapshot rules for the new round
    broadcastState();
  });


  

  // Dev tool: auto-fill random guesses for all alive players (for fast testing)
  socket.on("host_dev_fill", () => {
    if (!socket.data.isHost) return;
    if (game.phase !== "collecting") return;

    for (const p of Object.values(game.players)) {
      if (!p || p.eliminated || !p.connected) continue;
      if (p.submitted) continue;
      p.lastGuess = Math.floor(Math.random() * 101);
      p.submitted = true;
    }
    broadcastState();
  });

socket.on("host_reset", () => {
    if (!socket.data.isHost) return;
    for (const p of Object.values(game.players)) {
      if (!p) continue;
      p.score = 0;
      p.eliminated = false;
      p.submitted = false;
      p.lastGuess = null;
      p.lastDelta = 0;
      p.connected = true;
    }
    game.phase = "lobby";
    game.round = 0;
    game.lastRound = null;
    game.roundRules = null;
    game.ruleIntro = null;
  game.gameOver = false;
  clearRevealSync();

    broadcastState();
  });

  socket.on("host_kick", (socketId) => {
    if (!socket.data.isHost) return;
    kickOne(String(socketId || ""));
  });

  socket.on("disconnect", () => {
    if (socket.data && socket.data.isInfo) {
      game.infoClientCount = Math.max(0, (game.infoClientCount || 0) - 1);
    }
    const p = game.players[socket.id];
    if (!p) {
      broadcastState();
      return;
    }

    // If the game has not started yet, a refresh/leave should remove the player from the lobby.
    if (game.phase === "lobby" && game.round === 0) {
      if (p.key && game.byKey[p.key] === socket.id) delete game.byKey[p.key];
      delete game.players[socket.id];
      broadcastState();
      return;
    }

    // During the game we keep the player reserved so they can reconnect.
    p.connected = false;
    broadcastState();
  });

  broadcastState();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
