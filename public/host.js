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

  const hostHint = document.getElementById("hostHint");
  const startBtn = document.getElementById("startBtn");
  const revealBtn = document.getElementById("revealBtn");
  const nextBtn = document.getElementById("nextBtn");
  const devFillBtn = document.getElementById("devFillBtn");
  const resetBtn = document.getElementById("resetBtn");

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

    // Make reset the obvious action when the game has ended.
    resetBtn?.classList.toggle("resetPulse", isGameOver);

    renderHostPlayers(state);
    renderMath(state);
    renderRulesHost(state);
  });

  // Ask the server for the latest state now that listeners are ready.
  socket.emit("host_hello");


  socket.on("kicked", () => {});
});
