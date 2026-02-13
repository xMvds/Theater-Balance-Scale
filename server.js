// server.js — VERVANG VOLLEDIG
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const game = {
  phase: "lobby", // lobby | collecting | revealed
  round: 0,
  players: {}, // socketId -> player
  byKey: {}, // playerKey -> socketId
  lastRound: null,

  // snapshot rules for the current round (set ONLY at round start)
  roundRules: null,
  ruleIntro: null,

  // Players only open their scoreboard when revealReadyRound === round.
  revealReadyRound: 0,

  // When true, the game has ended (only 0-1 players alive). Host can only reset.
  gameOver: false,
};

// Fallback: if the info screen never signals completion (e.g. not open),
// auto-unlock the player scoreboard after the expected animation duration.
const INFO_ANIM_TOTAL_MS = 11000; // ms
let revealReadyTimer = null;

function markRevealReady(round) {
  if (game.revealReadyRound === round) return;
  game.revealReadyRound = round;
  io.emit("reveal_ready", { round });
  broadcastState();
}

function clearRevealReady() {
  game.revealReadyRound = 0;
  if (revealReadyTimer) {
    clearTimeout(revealReadyTimer);
    revealReadyTimer = null;
  }
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

function broadcastState() {
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

  io.emit("state", {
    phase: game.phase,
    round: game.round,
    aliveNow,
    roundRules: game.roundRules,
    ruleIntro: game.ruleIntro,
    players: playersList,
    lastRound: game.lastRound,
    revealReadyRound: game.revealReadyRound,
    gameOver: game.gameOver,
  });
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
  clearRevealReady();
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
    // Host refresh => kick everyone
    kickAll();
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
    if (game.gameOver) return;
    if (game.phase === "collecting") return;

    game.phase = "collecting";
    game.round += 1;

    clearRevealReady();
    resetForNewRound();
    setRoundRulesSnapshot(); // snapshot rules at ROUND START

    broadcastState();
  });

  socket.on("host_reveal", () => {
    if (game.phase !== "collecting") return;

    endRoundAndScore();
    game.phase = "revealed";

    // Game ends when 0-1 players are alive after scoring.
    game.gameOver = aliveIds().length <= 1;

    clearRevealReady();
    // Fallback unlock if info isn't running
    revealReadyTimer = setTimeout(() => {
      if (game.phase === "revealed" && game.revealReadyRound !== game.round) {
        markRevealReady(game.round);
      }
    }, INFO_ANIM_TOTAL_MS);

    broadcastState();
  });

  socket.on("host_next", () => {
    if (game.gameOver) return;
    if (game.phase !== "revealed") return;

    game.phase = "collecting";
    game.round += 1;

    clearRevealReady();
    resetForNewRound();
    setRoundRulesSnapshot(); // snapshot rules for the new round

    broadcastState();
  });

  

  // Dev tool: auto-fill random guesses for all alive players (for fast testing)
  socket.on("host_dev_fill", () => {
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
  clearRevealReady();

    broadcastState();
  });

  socket.on("host_kick", (socketId) => {
    kickOne(String(socketId || ""));
  });

  socket.on("disconnect", () => {
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
