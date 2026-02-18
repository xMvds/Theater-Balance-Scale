document.addEventListener("DOMContentLoaded", () => {
  function requireAccessCode(){
    try{
      if (sessionStorage.getItem("tbs_access_ok") === "1") return true;
    }catch(e){}
    const code = prompt("Code nodig om host te openen:");
    if (String(code || "").trim() === "0909"){
      try{ sessionStorage.setItem("tbs_access_ok","1"); }catch(e){}
      return true;
    }
    alert("Onjuiste code.");
    location.replace("/");
    return false;
  }
  if (!requireAccessCode()) return;

  // Unlock host UI only after access code is accepted
  document.body.classList.remove("hostLocked");

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
  if (rs == null || !Number.isFinite(rs)) return null;
  return Math.max(0, serverNow() - rs);
}

function updateNextVisual(state){
  if (!nextBtn) return;

  // Keep the host button reactive even if no further state packets arrive.
  if (window.__tbsNextVisualTimer) {
    clearTimeout(window.__tbsNextVisualTimer);
    window.__tbsNextVisualTimer = null;
  }

  // Default label
  const DEFAULT_LABEL = "Next";

  // Reset styling
  nextBtn.classList.remove("nextLocked", "nextReady", "nextWaiting");
  nextBtn.removeAttribute("title");

  const isGameOver = !!state?.gameOver;
  if (isGameOver) {
    nextBtn.textContent = DEFAULT_LABEL;
    return;
  }

  // Only show countdown styling during revealed
  if (state?.phase !== "revealed") {
    nextBtn.textContent = DEFAULT_LABEL;
    return;
  }

  const HOST_SCOREBOARD_LOCK_MS = 1400; // keep in sync with player/info unfold window
  const now = serverNow();

  // Prefer deterministic timing, even if reveal_ready packets were missed.
  const rs = (typeof state.revealStartedAt === "number" && Number.isFinite(state.revealStartedAt)) ? state.revealStartedAt : null;
  const dur = (typeof state.revealDurationMs === "number" && Number.isFinite(state.revealDurationMs)) ? state.revealDurationMs : null;
  const readyAt = (typeof state.revealReadyAt === "number" && Number.isFinite(state.revealReadyAt))
    ? state.revealReadyAt
    : ((rs != null && dur != null) ? (rs + dur) : null);

  const animDoneAt = (readyAt != null) ? (readyAt + HOST_SCOREBOARD_LOCK_MS) : null;

  // If we can't compute a reliable end time, fall back to red indicator.
  if (animDoneAt == null) {
    nextBtn.classList.add("nextLocked");
    nextBtn.setAttribute("title", "Animatie loopt nog…");
    nextBtn.textContent = DEFAULT_LABEL;
    return;
  }

  const msLeft = animDoneAt - now;

  if (msLeft > 0){
    nextBtn.classList.add("nextLocked");
    // Countdown display (still clickable)
    const sLeft = Math.max(0, msLeft / 1000);
    nextBtn.textContent = `Next (${sLeft.toFixed(1)}s)`;
    nextBtn.setAttribute("title", "Animatie loopt nog… (je kunt wel skippen)");

    // Update countdown at a smooth cadence and flip to green at the end.
    const waitMs = Math.max(20, Math.min(100, msLeft));
    window.__tbsNextVisualTimer = setTimeout(() => {
      try { updateNextVisual(window.__tbsLastHostState || state); } catch(e) {}
    }, waitMs);
  } else {
    nextBtn.classList.add("nextReady");
    nextBtn.setAttribute("title", "Klaar voor volgende ronde");
    nextBtn.textContent = DEFAULT_LABEL;
  }
}



  const hostHint = document.getElementById("hostHint");
  const startBtn = document.getElementById("startBtn");
  const revealBtn = document.getElementById("revealBtn");
  const nextBtn = document.getElementById("nextBtn");
  const devFillBtn = document.getElementById("devFillBtn");
  const resetBtn = document.getElementById("resetBtn");
  // Player reveal is automatic (option 2): if no info screen is connected, players run the reveal.

  // --- Player background test (A/B/C/D) ---
// These buttons live on the HOST page, but they switch the BACKGROUND on all PLAYER screens.
// A = static image background (bg_player_static_c.png)
// B = animated blobs (experimental)
// C = FinisherHeader particles (DEFAULT)
// D = FinisherHeader particles (alt config)
const bgTestA = document.getElementById("bgTestA");
const bgTestB = document.getElementById("bgTestB");
const bgTestC = document.getElementById("bgTestC");
const bgTestD = document.getElementById("bgTestD");

const LS_BG_MODE = "tbs_player_bg_mode";
let playerBgMode = "C";
try{
  const saved = localStorage.getItem(LS_BG_MODE);
  if (saved === "A" || saved === "B" || saved === "C" || saved === "D") playerBgMode = saved;
}catch(e){}


// Reconnect-safe: when a laptop sleeps, socket.io can reconnect with a new socket id.
// We must re-send host_hello so the server re-marks this socket as host (otherwise host controls stop working).
socket.on("connect", () => {
  try { socket.emit("host_hello"); } catch {}
  try { socket.emit("sync"); } catch {}

  // Re-apply the chosen player BG mode (server ignores until host_hello was processed).
  setTimeout(() => {
    try { socket.emit("host_player_bg_mode", { mode: playerBgMode }); } catch {}
  }, 40);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  try { socket.emit("host_hello"); } catch {}
  try { socket.emit("sync"); } catch {}
  setTimeout(() => {
    try { socket.emit("host_player_bg_mode", { mode: playerBgMode }); } catch {}
  }, 40);
});

const applyPlayerBgUi = (mode) => {
  bgTestA?.classList.toggle("active", mode === "A");
  bgTestB?.classList.toggle("active", mode === "B");
  bgTestC?.classList.toggle("active", mode === "C");
  bgTestD?.classList.toggle("active", mode === "D");
};

const commitPlayerBgMode = (mode) => {
  playerBgMode = (mode === "B" || mode === "C" || mode === "D") ? mode : "A";
  applyPlayerBgUi(playerBgMode);
  try{ localStorage.setItem(LS_BG_MODE, playerBgMode); }catch(e){}
  socket.emit("host_player_bg_mode", { mode: playerBgMode });
};

bgTestA?.addEventListener("click", () => commitPlayerBgMode("A"));
bgTestB?.addEventListener("click", () => commitPlayerBgMode(playerBgMode === "B" ? "A" : "B"));
bgTestC?.addEventListener("click", () => commitPlayerBgMode(playerBgMode === "C" ? "A" : "C"));
bgTestD?.addEventListener("click", () => commitPlayerBgMode(playerBgMode === "D" ? "A" : "D"));


/* === BG editor (host): live edit FinisherHeader config (player BG mode C) === */
const bgEditorBtn = document.getElementById("bgEditorBtn");
const bgEditorModal = document.getElementById("bgEditorModal");
const bgEditorCloseBtn = document.getElementById("bgEditorCloseBtn");
const bgEditorResetBtn = document.getElementById("bgEditorResetBtn");
const bgEditorCopyBtn = document.getElementById("bgEditorCopyBtn");

const bgCount = document.getElementById("bgCount");
const bgSizeMin = document.getElementById("bgSizeMin");
const bgSizeMax = document.getElementById("bgSizeMax");
const bgPulse = document.getElementById("bgPulse");
const bgSpeedX = document.getElementById("bgSpeedX");
const bgSpeedY = document.getElementById("bgSpeedY");
const bgBgColor = document.getElementById("bgBgColor");
const bgParticleColor = document.getElementById("bgParticleColor");
const bgOpCenter = document.getElementById("bgOpCenter");
const bgOpEdge = document.getElementById("bgOpEdge");
const bgSkew = document.getElementById("bgSkew");

const bgValCount = document.getElementById("bgValCount");
const bgValSize = document.getElementById("bgValSize");
const bgValPulse = document.getElementById("bgValPulse");
const bgValSpeedX = document.getElementById("bgValSpeedX");
const bgValSpeedY = document.getElementById("bgValSpeedY");
const bgValBg = document.getElementById("bgValBg");
const bgValParticle = document.getElementById("bgValParticle");
const bgValBlend = document.getElementById("bgValBlend");
const bgValOpCenter = document.getElementById("bgValOpCenter");
const bgValOpEdge = document.getElementById("bgValOpEdge");
const bgValSkew = document.getElementById("bgValSkew");
const bgValShapes = document.getElementById("bgValShapes");

const blendBtns = [
  document.getElementById("bgBlendNone"),
  document.getElementById("bgBlendOverlay"),
  document.getElementById("bgBlendScreen"),
  document.getElementById("bgBlendLighten"),
].filter(Boolean);

const shapeBtns = [
  document.getElementById("bgShapeC"),
  document.getElementById("bgShapeS"),
  document.getElementById("bgShapeT"),
].filter(Boolean);

const BG_DEFAULT_C = {
  "count": 7,
  "size": { "min": 298, "max": 506, "pulse": 0.19 },
  "speed": { "x": { "min": 0, "max": 0.06 }, "y": { "min": 0, "max": 0.1 } },
  "colors": { "background": "#0b0d12", "particles": ["#2e2f33"] },
  "blending": "screen",
  "opacity": { "center": 0.09, "edge": 0 },
  "skew": 0,
  "shapes": ["c"]
};

let bgEditorOpen = false;
let _bgEditorLocalCfgC = JSON.parse(JSON.stringify(BG_DEFAULT_C));
let _bgEditorLatestCfgC = null;
let _bgEditorDirtyAt = 0;
let _bgEditorEmitT = null;

const _bgEditorIsDirty = () => (Date.now() - _bgEditorDirtyAt) < 1200;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const toNum = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const toHex = (s, fallback) => {
  const x = String(s || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(x) ? x : fallback;
};
const deepCopy = (o) => JSON.parse(JSON.stringify(o));

function bgEditorNormalizeCfg(cfg){
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const out = {
    count: Math.round(clamp(toNum(c.count, 7), 1, 40)),
    size: {
      min: Math.round(clamp(toNum(c.size?.min, 298), 20, 1200)),
      max: Math.round(clamp(toNum(c.size?.max, 506), 20, 1600)),
      pulse: clamp(toNum(c.size?.pulse, 0.19), 0, 1),
    },
    speed: {
      x: { min: clamp(toNum(c.speed?.x?.min, 0), -2, 2), max: clamp(toNum(c.speed?.x?.max, 0.06), -2, 2) },
      y: { min: clamp(toNum(c.speed?.y?.min, 0), -2, 2), max: clamp(toNum(c.speed?.y?.max, 0.1), -2, 2) },
    },
    colors: {
      background: toHex(c.colors?.background, "#0b0d12"),
      particles: [toHex((c.colors?.particles && c.colors.particles[0]) || "##2e2f33", "#3b3c46")],
    },
    blending: String(c.blending || "screen"),
    opacity: {
      center: clamp(toNum(c.opacity?.center, 0.09), 0, 1),
      edge: clamp(toNum(c.opacity?.edge, 0), 0, 1),
    },
    skew: clamp(toNum(c.skew, 0), -20, 20),
    shapes: Array.isArray(c.shapes) && c.shapes.length ? c.shapes.map((x)=>String(x)) : ["c"],
  };
  if (out.size.min > out.size.max) {
    const t = out.size.min; out.size.min = out.size.max; out.size.max = t;
  }
  return out;
}

function bgEditorSetFromCfg(cfg){
  const c = bgEditorNormalizeCfg(cfg);
  _bgEditorLocalCfgC = deepCopy(c);

  if (bgCount) bgCount.value = String(c.count);
  if (bgSizeMin) bgSizeMin.value = String(c.size.min);
  if (bgSizeMax) bgSizeMax.value = String(c.size.max);
  if (bgPulse) bgPulse.value = String(c.size.pulse);
  if (bgSpeedX) bgSpeedX.value = String(c.speed.x.max);
  if (bgSpeedY) bgSpeedY.value = String(c.speed.y.max);
  if (bgBgColor) bgBgColor.value = c.colors.background;
  if (bgParticleColor) bgParticleColor.value = c.colors.particles[0];
  if (bgOpCenter) bgOpCenter.value = String(c.opacity.center);
  if (bgOpEdge) bgOpEdge.value = String(c.opacity.edge);
  if (bgSkew) bgSkew.value = String(c.skew);

  blendBtns.forEach((b) => {
    const v = b.getAttribute("data-blend");
    b.classList.toggle("active", String(v) === String(c.blending));
  });
  shapeBtns.forEach((b) => {
    const v = b.getAttribute("data-shape");
    b.classList.toggle("active", c.shapes.includes(String(v)));
  });

  // Value labels
  if (bgValCount) bgValCount.textContent = String(c.count);
  if (bgValSize) bgValSize.textContent = `${c.size.min} – ${c.size.max}`;
  if (bgValPulse) bgValPulse.textContent = String(c.size.pulse.toFixed(2));
  if (bgValSpeedX) bgValSpeedX.textContent = `0 – ${Number(c.speed.x.max).toFixed(2)}`;
  if (bgValSpeedY) bgValSpeedY.textContent = `0 – ${Number(c.speed.y.max).toFixed(2)}`;
  if (bgValBg) bgValBg.textContent = c.colors.background.toUpperCase();
  if (bgValParticle) bgValParticle.textContent = c.colors.particles[0].toUpperCase();
  if (bgValBlend) bgValBlend.textContent = String(c.blending);
  if (bgValOpCenter) bgValOpCenter.textContent = String(Number(c.opacity.center).toFixed(2));
  if (bgValOpEdge) bgValOpEdge.textContent = String(Number(c.opacity.edge).toFixed(2));
  if (bgValSkew) bgValSkew.textContent = String(c.skew);
  if (bgValShapes) bgValShapes.textContent = c.shapes.join(", ");
}

function bgEditorCommitLocal(){
  const c = bgEditorNormalizeCfg({
    count: toNum(bgCount?.value, _bgEditorLocalCfgC.count),
    size: { 
      min: toNum(bgSizeMin?.value, _bgEditorLocalCfgC.size.min),
      max: toNum(bgSizeMax?.value, _bgEditorLocalCfgC.size.max),
      pulse: toNum(bgPulse?.value, _bgEditorLocalCfgC.size.pulse),
    },
    speed: { 
      x: { min: 0, max: toNum(bgSpeedX?.value, _bgEditorLocalCfgC.speed.x.max) },
      y: { min: 0, max: toNum(bgSpeedY?.value, _bgEditorLocalCfgC.speed.y.max) },
    },
    colors: {
      background: bgBgColor?.value,
      particles: [bgParticleColor?.value],
    },
    blending: _bgEditorLocalCfgC.blending,
    opacity: {
      center: toNum(bgOpCenter?.value, _bgEditorLocalCfgC.opacity.center),
      edge: toNum(bgOpEdge?.value, _bgEditorLocalCfgC.opacity.edge),
    },
    skew: toNum(bgSkew?.value, _bgEditorLocalCfgC.skew),
    shapes: _bgEditorLocalCfgC.shapes,
  });

  _bgEditorLocalCfgC = deepCopy(c);
  bgEditorSetFromCfg(_bgEditorLocalCfgC);
}

function bgEditorEmit(){
  if (!socket) return;
  socket.emit("host_player_bg_finisher_config", { key: "C", config: _bgEditorLocalCfgC });
}

function bgEditorEmitDebounced(){
  _bgEditorDirtyAt = Date.now();
  if (_bgEditorEmitT) clearTimeout(_bgEditorEmitT);
  _bgEditorEmitT = setTimeout(() => {
    _bgEditorEmitT = null;
    bgEditorCommitLocal();
    bgEditorEmit();
  }, 60);
}

function bgEditorOpenModal(){
  bgEditorOpen = true;
  bgEditorModal?.classList.remove("hidden");
  // helpful default: switch players to C so you can see changes immediately
  commitPlayerBgMode("C");

  const use = _bgEditorLatestCfgC || _bgEditorLocalCfgC || BG_DEFAULT_C;
  bgEditorSetFromCfg(use);
}

function bgEditorCloseModal(){
  bgEditorOpen = false;
  bgEditorModal?.classList.add("hidden");
}

bgEditorBtn?.addEventListener("click", () => bgEditorOpenModal());
bgEditorCloseBtn?.addEventListener("click", () => bgEditorCloseModal());
bgEditorModal?.addEventListener("click", (e) => {
  if (e.target === bgEditorModal) bgEditorCloseModal();
});

bgEditorResetBtn?.addEventListener("click", () => {
  bgEditorSetFromCfg(BG_DEFAULT_C);
  _bgEditorDirtyAt = Date.now();
  bgEditorEmit();
});

bgEditorCopyBtn?.addEventListener("click", async () => {
  try{
    await navigator.clipboard.writeText(JSON.stringify(_bgEditorLocalCfgC, null, 2));
    // small feedback: reuse existing "Gekopieerd" toast if present
    const t = document.getElementById("debugToast");
    if (t){ t.classList.remove("hidden"); setTimeout(()=>t.classList.add("hidden"), 900); }
  }catch(e){}
});

// Input handlers (live)
[
  bgCount, bgSizeMin, bgSizeMax, bgPulse, bgSpeedX, bgSpeedY,
  bgBgColor, bgParticleColor, bgOpCenter, bgOpEdge, bgSkew
].filter(Boolean).forEach((el) => {
  el.addEventListener("input", () => bgEditorEmitDebounced());
});

blendBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    _bgEditorLocalCfgC.blending = String(btn.getAttribute("data-blend") || "none");
    blendBtns.forEach((b) => b.classList.toggle("active", b === btn));
    bgEditorEmitDebounced();
  });
});

shapeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const s = String(btn.getAttribute("data-shape") || "c");
    const set = new Set(_bgEditorLocalCfgC.shapes || []);
    if (set.has(s)) set.delete(s); else set.add(s);
    _bgEditorLocalCfgC.shapes = Array.from(set);
    shapeBtns.forEach((b) => {
      const v = String(b.getAttribute("data-shape") || "");
      b.classList.toggle("active", _bgEditorLocalCfgC.shapes.includes(v));
    });
    bgEditorEmitDebounced();
  });
});
/* === END BG editor (host) === */


// Apply UI immediately; broadcast after host_hello so the server recognizes this socket as host.
applyPlayerBgUi(playerBgMode);
// --- end Player background test ---
  // --- Settings panel (host) ---
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");

  const closeSettings = () => {
    if (!settingsPanel) return;
    settingsPanel.classList.add("hidden");
  };

  settingsBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!settingsPanel) return;
    settingsPanel.classList.toggle("hidden");
  });

  settingsPanel?.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  document.addEventListener("click", () => closeSettings());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettings();
  });




  // --- Debug capture (host) ---
  const debugCopyBtn = document.getElementById("debugCopyBtn");
  const debugToast = document.getElementById("debugToast");

  const __dbg = (() => {
    const LIMIT = 60;
    const logs = [];
    const events = [];
    const errs = [];
    let latestState = null;

    const push = (arr, obj) => {
      arr.push(obj);
      if (arr.length > LIMIT) arr.shift();
    };

    // capture console (without breaking it)
    const cLog = console.log.bind(console);
    const cWarn = console.warn.bind(console);
    const cErr = console.error.bind(console);

    const safe = (v) => {
      try {
        if (typeof v === "string") return v;
        const s = JSON.stringify(v);
        return s.length > 2000 ? (s.slice(0, 2000) + "…(truncated)") : s;
      } catch {
        return String(v);
      }
    };

    console.log = (...a) => { push(logs, { t: Date.now(), type: "log", a: a.map(safe) }); cLog(...a); };
    console.warn = (...a) => { push(logs, { t: Date.now(), type: "warn", a: a.map(safe) }); cWarn(...a); };
    console.error = (...a) => { push(logs, { t: Date.now(), type: "error", a: a.map(safe) }); cErr(...a); };

    window.addEventListener("error", (e) => {
      push(errs, { t: Date.now(), msg: e.message, src: e.filename, line: e.lineno, col: e.colno });
    });
    window.addEventListener("unhandledrejection", (e) => {
      push(errs, { t: Date.now(), msg: String(e.reason || "unhandledrejection") });
    });

    // auto-track socket traffic
    const _on = socket.on.bind(socket);
    socket.on = (name, fn) => _on(name, (...args) => {
      push(events, { t: Date.now(), dir: "in", name, payload: safe(args[0]) });
      if (name === "state") latestState = args[0];
      return fn(...args);
    });

    const _emit = socket.emit.bind(socket);
    socket.emit = (name, payload, ...rest) => {
      push(events, { t: Date.now(), dir: "out", name, payload: safe(payload) });
      return _emit(name, payload, ...rest);
    };

    const buildDump = () => ({
      t: new Date().toISOString(),
      page: "host",
      url: location.href,
      ua: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      latestState,
      events,
      logs,
      errors: errs
    });

    const copy = async () => {
      const txt = JSON.stringify(buildDump(), null, 2);
      try {
        await navigator.clipboard.writeText(txt);
        return true;
      } catch {
        const ta = document.createElement("textarea");
        ta.value = txt;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      }
    };

    const download = (txt) => {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `balance80-debug-host-${ts}.txt`;
        const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        // best-effort: download is optional
      }
    };

    const toast = () => {
      if (!debugToast) return;
      debugToast.classList.remove("hidden");
      setTimeout(() => debugToast.classList.add("hidden"), 900);
    };

    if (debugCopyBtn) {
      debugCopyBtn.addEventListener("click", async () => {
        const txt = JSON.stringify(buildDump(), null, 2);
        // 1) Copy to clipboard (same behavior as before)
        let ok = false;
        try {
          await navigator.clipboard.writeText(txt);
          ok = true;
        } catch {
          const ta = document.createElement("textarea");
          ta.value = txt;
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand("copy");
          ta.remove();
        }
        // 2) Also save it as a .txt file so you don't have to paste it in chat
        download(txt);
        if (ok) toast();
      });
    }

    return { buildDump };
  })();
  // --- end debug capture ---

  const hostTiles = document.getElementById("hostTiles");
  const mathRow = document.getElementById("mathRow");
  const hostRules = document.getElementById("hostRules");

  

  // Dev tool: auto-fill random guesses for all alive players (for fast testing)

let resetArmed = false;
  let resetTimer = null;

  const tileById = new Map();
  const scoreElById = new Map();
  let prevScores = new Map();

  // rules: show always, pulse when a rule becomes active (10s), then stop
  let prevRuleActive = { r1: false, r2: false, r3: false };
  let pulseUntil = { r1: 0, r2: 0, r3: 0 };
  let pulseTimers = { r1: null, r2: null, r3: null };
  let lastState = null;

  const kickArmed = new Map();
  const kickTimers = new Map();


  function setHint(text) {
    if (hostHint) hostHint.textContent = text;
  }

  startBtn?.addEventListener("click", () => socket.emit("host_start"));
  revealBtn?.addEventListener("click", () => socket.emit("host_reveal"));
  nextBtn?.addEventListener("click", () => socket.emit("host_next"));

  // Player reveal is automatic now (option 2). No toggle.

  devFillBtn?.addEventListener("click", () => socket.emit("host_devfill"));

  resetBtn?.addEventListener("click", () => {
    if (!resetArmed) {
      resetArmed = true;
      resetBtn.textContent = "Weet je het zeker? (klik opnieuw)";
      resetBtn.classList.add("primary");
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        resetArmed = false;
        resetBtn.textContent = "Reset";
        resetBtn.classList.remove("primary");
      }, 2500);
      return;
    }

    resetArmed = false;
    resetBtn.textContent = "Reset";
    resetBtn.classList.remove("primary");
    clearTimeout(resetTimer);

    prevScores.clear();
    tileById.clear();
    scoreElById.clear();
    if (hostTiles) hostTiles.innerHTML = "";

    prevRuleActive = { r1: false, r2: false, r3: false };
    pulseUntil = { r1: 0, r2: 0, r3: 0 };
    for (const k of ["r1", "r2", "r3"]) {
      if (pulseTimers[k]) clearTimeout(pulseTimers[k]);
      pulseTimers[k] = null;
    }

    kickArmed.clear();
    for (const t of kickTimers.values()) clearTimeout(t);
    kickTimers.clear();

    socket.emit("host_reset");
  });

  function fmt2(n) {
    if (typeof n !== "number") return "—";
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  // Compute a "live" average/target during collecting, based on submitted guesses so far.
  function calcLiveMath(state) {
    try {
      const vals = (state.players || [])
        .filter((p) => p && !p.eliminated && p.submitted && typeof p.lastGuess === "number")
        .map((p) => ({ id: p.id, v: p.lastGuess }));

      if (!vals.length) return null;

      const avg = vals.reduce((s, o) => s + o.v, 0) / vals.length;
      const target = avg * 0.8;

      let best = Infinity;
      let winners = [];
      for (const o of vals) {
        const d = Math.abs(o.v - target);
        if (d < best - 1e-9) { best = d; winners = [o.id]; }
        else if (Math.abs(d - best) <= 1e-9) { winners.push(o.id); }
      }
      return { average: avg, target, winnerIds: winners };
    } catch {
      return null;
    }
  }


  function animateScore(el, from, to, isBad) {
    if (!el) return;
    if (Number(el.dataset.current ?? NaN) === to) return;

    const prevShown = (el.dataset.current !== undefined) ? Number(el.dataset.current) : from;
    el.dataset.current = String(to);

    el.innerHTML = "";
    const oldNode = document.createElement("div");
    oldNode.className = "scoreNum live" + (isBad ? " bad" : " good");
    oldNode.textContent = String(prevShown);

    const newNode = document.createElement("div");
    newNode.className = "scoreNum in " + (isBad ? "bad" : "good");
    newNode.textContent = String(to);

    el.appendChild(oldNode);
    el.appendChild(newNode);

    requestAnimationFrame(() => {
      oldNode.classList.add("out");
      oldNode.classList.remove("live");
      newNode.classList.remove("in");
      newNode.classList.add("live");
    });
  }

  function armKick(id, btn) {
    kickArmed.set(id, true);
    btn.textContent = "!!";
    btn.classList.add("armed");

    if (kickTimers.has(id)) clearTimeout(kickTimers.get(id));
    const t = setTimeout(() => {
      kickArmed.delete(id);
      btn.textContent = "✕";
      btn.classList.remove("armed");
      kickTimers.delete(id);
    }, 2200);
    kickTimers.set(id, t);
  }

  function ensureTile(p) {
    if (tileById.has(p.id)) return tileById.get(p.id);

    const tile = document.createElement("div");
    tile.className = "tile hostTile";
    tile.innerHTML = `
      <div class="tHeadRow">
        <div class="tName"></div>
        <button class="kickBtn" title="Kick">✕</button>
      </div>
      <div class="tGuess">—</div>
      <div class="tScoreWrap"></div>
      <div class="tDelta">0</div>
    `;

    const kickBtn = tile.querySelector(".kickBtn");
    kickBtn.addEventListener("click", () => {
      const id = p.id;

      if (!kickArmed.get(id)) {
        armKick(id, kickBtn);
        return;
      }

      kickArmed.delete(id);
      if (kickTimers.has(id)) { clearTimeout(kickTimers.get(id)); kickTimers.delete(id); }
      kickBtn.textContent = "✕";
      kickBtn.classList.remove("armed");

      socket.emit("host_kick", id);
    });

    tileById.set(p.id, tile);
    scoreElById.set(p.id, tile.querySelector(".tScoreWrap"));

    hostTiles?.appendChild(tile);
    requestAnimationFrame(() => tile.classList.add("show"));
    return tile;
  }

  function renderHostPlayers(state) {
    const list = state.players.slice().sort((a, b) => a.name.localeCompare(b.name));
        const liveMath = (state.phase === "collecting") ? calcLiveMath(state) : null;
    const winnerIds = (state.phase === "collecting" && liveMath)
      ? (liveMath.winnerIds || [])
      : ((state.lastRound?.winnerIds && state.lastRound.winnerIds.length)
        ? state.lastRound.winnerIds
        : (state.lastRound?.winnerId ? [state.lastRound.winnerId] : []));
    const winnerIdsFinal = (state.phase === "revealed" || state.phase === "collecting") ? winnerIds : [];

    const liveIds = new Set(list.map((p) => p.id));
    for (const [id, el] of tileById.entries()) {
      if (!liveIds.has(id)) {
        el.remove();
        tileById.delete(id);
        scoreElById.delete(id);
        prevScores.delete(id);
        kickArmed.delete(id);
        if (kickTimers.has(id)) { clearTimeout(kickTimers.get(id)); kickTimers.delete(id); }
      }
    }

    for (const p of list) {
      const tile = ensureTile(p);

      tile.querySelector(".tName").textContent = p.name;
      tile.querySelector(".tGuess").textContent =
        (typeof p.lastGuess === "number") ? String(p.lastGuess) : "—";
      const deltaEl = tile.querySelector(".tDelta");
      const deltaVal = Number(p.lastDelta ?? 0);
      if (deltaEl) {
        deltaEl.textContent = String(deltaVal);
        deltaEl.classList.toggle("bad", deltaVal < 0);
      }

      const glow = state.phase === "collecting" && p.submitted && !p.eliminated;

      tile.classList.toggle("dead", !!p.eliminated);
      tile.classList.toggle("glow", !!glow);
      tile.classList.toggle("winner", winnerIdsFinal.includes(p.id));

      const delta = Number(p.lastDelta ?? 0);
      const prev = prevScores.has(p.id) ? prevScores.get(p.id) : (p.score - delta);
      const isBad = (state.phase === "revealed") && (delta < 0);

      if (p.score !== prev) animateScore(scoreElById.get(p.id), prev, p.score, isBad);
      else {
        const el = scoreElById.get(p.id);
        if (el) el.innerHTML = `<div class="scoreNum live good">${p.score}</div>`;
      }

      prevScores.set(p.id, p.score);

      const kickBtn = tile.querySelector(".kickBtn");
      if (kickArmed.get(p.id)) {
        kickBtn.textContent = "!!";
        kickBtn.classList.add("armed");
      } else {
        kickBtn.textContent = "✕";
        kickBtn.classList.remove("armed");
      }
    }

    for (const p of list) hostTiles?.appendChild(tileById.get(p.id));
  }

  
  function renderMath(state) {
    // Keep the math row stable: it appears when the game starts (like the rules panel)
    // and it never re-mounts per reveal, so the buttons don't jump.
    if (!mathRow) return;
    if (state.phase === "lobby" && state.round === 0) {
      mathRow.classList.add("hidden");
      mathRow.innerHTML = "";
      return;
    }
    mathRow.classList.remove("hidden");

    // During collecting we show a "live" average/target based on submitted guesses so far.
    const live = (state.phase === "collecting") ? calcLiveMath(state) : null;

    let avg = null;
    let target = null;
    let dim = true;

    if (state.phase === "revealed" && state.lastRound) {
      avg = state.lastRound.average;
      target = state.lastRound.target;
      dim = false;
    } else if (state.phase === "collecting" && live) {
      avg = live.average;
      target = live.target;
      dim = false; // show as real numbers (still not the final reveal)
    } else {
      // Lobby / no submissions yet: keep placeholders but keep the row visible.
      avg = null;
      target = null;
      dim = true;
    }

    mathRow.classList.toggle("dim", dim);
    mathRow.innerHTML = `
      <div class="mathBox">
        <div class="mathLabel">Gemiddelde</div>
        <div class="mathValue">${fmt2(avg)}</div>
      </div>
      <div class="mathOp">× 0.8 =</div>
      <div class="mathBox">
        <div class="mathLabel">Target</div>
        <div class="mathValue">${fmt2(target)}</div>
      </div>
    `;
  }

  function schedulePulseStop(key) {
    if (pulseTimers[key]) clearTimeout(pulseTimers[key]);
    const ms = Math.max(0, pulseUntil[key] - Date.now()) + 30;
    pulseTimers[key] = setTimeout(() => {
      if (lastState) renderRulesHost(lastState);
    }, ms);
  }

  function renderRulesHost(state) {
    // vóór start (lobby round 0): geen regels-paneel tonen
    if (state.phase === "lobby" && state.round === 0) {
      hostRules.classList.add("hidden");
      hostRules.innerHTML = "";
      prevRuleActive = { r1: false, r2: false, r3: false };
      pulseUntil = { r1: 0, r2: 0, r3: 0 };
      return;
    }

    hostRules.classList.remove("hidden");

    const rr = state.roundRules || { duplicatesInvalid:false, exactDoublePenalty:false, zeroHundredSpecial:false };
    const now = {
      r1: !!rr.duplicatesInvalid,
      r2: !!rr.exactDoublePenalty,
      r3: !!rr.zeroHundredSpecial,
    };

    const t = Date.now();

    if (state.phase === "lobby") {
      prevRuleActive = { r1: false, r2: false, r3: false };
      pulseUntil = { r1: 0, r2: 0, r3: 0 };
    } else {
      // pulse alleen wanneer regel actief WORDT
      if (now.r1 && !prevRuleActive.r1) { pulseUntil.r1 = t + 10000; schedulePulseStop("r1"); }
      if (now.r2 && !prevRuleActive.r2) { pulseUntil.r2 = t + 10000; schedulePulseStop("r2"); }
      if (now.r3 && !prevRuleActive.r3) { pulseUntil.r3 = t + 10000; schedulePulseStop("r3"); }
      prevRuleActive = now;
    }

    const items = [
      { key:"r1", title:"Regel 1", body:"Dubbele getallen zijn ongeldig en leveren -1 punt op.", at:"Actief bij 4 spelers", active: now.r1 },
      { key:"r2", title:"Regel 2", body:"Exact geraden getallen geven de verliezers -2 punten.", at:"Actief bij 3 spelers", active: now.r2 },
      { key:"r3", title:"Regel 3", body:"Kiest een speler 0, dan wint de ander door 100 te kiezen.", at:"Actief bij 2 spelers", active: now.r3 },
    ];

    hostRules.innerHTML = `
      <div class="rhTitle">Regel</div>
      ${items.map((x) => {
        const pulse = Date.now() < pulseUntil[x.key];
        const statusClass = x.active ? "active" : "inactive";
        const statusText = x.active ? "actief" : "inactief";
        return `
          <div class="rhItem ${pulse ? "pulseOnce" : ""}">
            <div class="rhHead">
              ${x.title} — <span class="status ${statusClass}">${statusText}</span>
            </div>
            <div class="rhBody">
              ${x.body}<br><span style="opacity:.65">(${x.at})</span>
            </div>
          </div>
        `;
      }).join("")}
    `;
  }

  socket.on("state", (state) => {
    lastState = state;
    window.__tbsLastHostState = state;
    updateServerClock(state);

    // Keep BG test buttons in sync with the current PLAYER background mode
    if (state.playerBgMode) {
      playerBgMode = (state.playerBgMode === "B" || state.playerBgMode === "C" || state.playerBgMode === "D") ? state.playerBgMode : "A";
      applyPlayerBgUi(playerBgMode);
    }

    // Sync current Finisher configs for the BG editor
    if (state.playerFinisherConfigs && state.playerFinisherConfigs.C) {
      _bgEditorLatestCfgC = state.playerFinisherConfigs.C;
      if (bgEditorOpen && !_bgEditorIsDirty()) bgEditorSetFromCfg(_bgEditorLatestCfgC);
    }
const playersTotal = state.players?.length ?? 0;
    const isGameOver = !!state.gameOver;

    if (isGameOver) {
      setHint(`GAME OVER • Round ${state.round} • players: ${playersTotal} • RESET nodig`);
    } else {
      setHint(`${String(state.phase).toUpperCase()} • Round ${state.round} • players: ${playersTotal}`);
    }

    startBtn.disabled = isGameOver || !(state.phase === "lobby" || state.phase === "revealed");
    revealBtn.disabled = isGameOver || !(state.phase === "collecting");
    nextBtn.disabled = isGameOver || !(state.phase === "revealed");
    devFillBtn.disabled = isGameOver || !(state.phase === "collecting");

    updateNextVisual(state);

    // (no player reveal toggle)

    // Make reset the obvious action when the game has ended.
    resetBtn?.classList.toggle("resetPulse", isGameOver);

    renderHostPlayers(state);
    renderMath(state);
    renderRulesHost(state);
  });

  // Ask the server for the latest state now that listeners are ready.
  socket.emit("host_hello");
  // Now that the server marked this socket as host, broadcast the chosen player BG mode.
  commitPlayerBgMode(playerBgMode);


  socket.on("kicked", () => {});
});
