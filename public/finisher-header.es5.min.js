/*!
 * Minimal FinisherHeader-style particles for Theater Balance Scale (host BG test: C)
 * This is a small, self-contained canvas particle background.
 */
(function(w){
  function clamp(v,min,max){ return v<min?min:(v>max?max:v); }
  function hexToRgb(hex){
    hex = String(hex||"").replace("#","").trim();
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var n = parseInt(hex, 16);
    if (!isFinite(n)) return {r:85,g:94,b:111};
    return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
  }
  function rand(min,max){ return min + Math.random()*(max-min); }

  function FinisherHeader(opts){
    opts = opts || {};
    this.opts = opts;

    // attach to the first element with .finisher-header
    var el = document.querySelector(".finisher-header");
    this.el = el;
    if (!el) return;

    // ensure element has size
    if (!el.style.height && el.getBoundingClientRect().height < 2){
      // fallback if user forgot sizing
      el.style.height = "300px";
    }
    if (getComputedStyle(el).position === "static"){
      el.style.position = "relative";
    }

    var c = document.createElement("canvas");
    c.setAttribute("aria-hidden","true");
    c.style.position = "absolute";
    c.style.left = "0";
    c.style.top = "0";
    c.style.width = "100%";
    c.style.height = "100%";
    c.style.pointerEvents = "none";
    c.style.display = "block";
    el.appendChild(c);

    this.canvas = c;
    this.ctx = c.getContext("2d");
    this.running = true;
    this.dpr = w.devicePixelRatio || 1;

    this._onResize = this.resize.bind(this);
    w.addEventListener("resize", this._onResize, { passive: true });

    this.resize();
    this.initParticles();
    this.lastT = (w.performance && performance.now) ? performance.now() : Date.now();

    this._raf = null;
    this.loop = this.loop.bind(this);
    this._raf = w.requestAnimationFrame(this.loop);
  }

  FinisherHeader.prototype.resize = function(){
    if (!this.canvas || !this.el) return;
    var r = this.el.getBoundingClientRect();
    var dpr = this.dpr = (w.devicePixelRatio || 1);
    this.w = Math.max(2, Math.floor(r.width));
    this.h = Math.max(2, Math.floor(r.height));
    this.canvas.width = Math.floor(this.w * dpr);
    this.canvas.height = Math.floor(this.h * dpr);
    if (this.ctx) this.ctx.setTransform(dpr,0,0,dpr,0,0);
  };

  FinisherHeader.prototype.initParticles = function(){
    var o = this.opts || {};
    var count = (o.count|0) || 12;
    var size = o.size || {};
    var spd = o.speed || {};
    var sx = (spd.x || {});
    var sy = (spd.y || {});
    var colors = (o.colors || {});
    var particles = colors.particles || ["#555e6f"];

    this.bg = colors.background || "#151823";
    this.blending = (o.blending || "lighten");

    this.opacityCenter = clamp(((o.opacity||{}).center != null ? (o.opacity||{}).center : 0.25), 0, 1);
    this.opacityEdge = clamp(((o.opacity||{}).edge != null ? (o.opacity||{}).edge : 0), 0, 1);

    var minR = (size.min != null ? size.min : 220);
    var maxR = (size.max != null ? size.max : 360);
    var pulse = (size.pulse != null ? size.pulse : 0.5);

    var vxMin = (sx.min != null ? sx.min : 0);
    var vxMax = (sx.max != null ? sx.max : 0.3);
    var vyMin = (sy.min != null ? sy.min : 0);
    var vyMax = (sy.max != null ? sy.max : 0.2);

    this.pulse = pulse;
    this.particles = [];
    for (var i=0;i<count;i++){
      var col = particles[i % particles.length];
      var rgb = hexToRgb(col);
      var baseR = rand(minR, maxR);
      var phase = rand(0, Math.PI*2);
      var x = rand(0, this.w);
      var y = rand(0, this.h);

      // Treat speed ranges as "fractions" scaled to pixels/sec.
      var vx = rand(vxMin, vxMax) * 120 * (Math.random()<0.5?-1:1);
      var vy = rand(vyMin, vyMax) * 120 * (Math.random()<0.5?-1:1);

      this.particles.push({ x:x, y:y, vx:vx, vy:vy, baseR:baseR, phase:phase, rgb:rgb });
    }
  };

  FinisherHeader.prototype.loop = function(t){
    if (!this.running) return;
    var now = (t != null) ? t : ((w.performance && performance.now) ? performance.now() : Date.now());
    var dt = (now - this.lastT) / 1000;
    this.lastT = now;

    this.update(dt);
    this.draw();

    this._raf = w.requestAnimationFrame(this.loop);
  };

  FinisherHeader.prototype.update = function(dt){
    var ps = this.particles || [];
    for (var i=0;i<ps.length;i++){
      var p = ps[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.phase += dt;

      // wrap around edges
      var r = p.baseR * 0.6;
      if (p.x < -r) p.x = this.w + r;
      if (p.x > this.w + r) p.x = -r;
      if (p.y < -r) p.y = this.h + r;
      if (p.y > this.h + r) p.y = -r;
    }
  };

  FinisherHeader.prototype.draw = function(){
    var ctx = this.ctx;
    if (!ctx) return;

    // background
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = this.bg;
    ctx.fillRect(0,0,this.w,this.h);

    // blending
    var b = String(this.blending || "lighten").toLowerCase();
    var op = "source-over";
    if (b === "lighten") op = "lighter";
    else if (b === "overlay") op = "overlay";
    else if (b === "screen") op = "screen";
    else if (b === "multiply") op = "multiply";
    else if (b === "none" || b === "normal") op = "source-over";
    else op = "source-over";
    ctx.globalCompositeOperation = op;

    var ps = this.particles || [];
    for (var i=0;i<ps.length;i++){
      var p = ps[i];
      var pulse = 1 + Math.sin(p.phase) * (this.pulse * 0.12);
      var r = p.baseR * pulse;

      var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      var a0 = this.opacityCenter;
      var a1 = this.opacityEdge;
      g.addColorStop(0, "rgba("+p.rgb.r+","+p.rgb.g+","+p.rgb.b+","+a0+")");
      g.addColorStop(1, "rgba("+p.rgb.r+","+p.rgb.g+","+p.rgb.b+","+a1+")");

      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI*2);
      ctx.fill();
    }
  };

  FinisherHeader.prototype.destroy = function(){
    this.running = false;
    try{ if (this._raf) w.cancelAnimationFrame(this._raf); }catch(e){}
    try{ w.removeEventListener("resize", this._onResize); }catch(e){}
    try{ if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas); }catch(e){}
    this.canvas = null;
    this.ctx = null;
    this.particles = null;
  };

  w.FinisherHeader = FinisherHeader;
})(window);
