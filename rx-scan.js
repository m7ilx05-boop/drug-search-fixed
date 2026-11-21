/* rx-scan.js — أنيميشن «سكانر» في صفحة انتظار قراءة الروشتة.
   كله بيتعمل على جهازك: بيلاقي حدود الورقة، يقص ويعدّل الميل، يحسّن الوضوح، ويحدد الأسطر.
   ده عرض بصري بس: الصورة اللي بتتبعت للقراءة هي نفسها ومش بتتغيّر، ومفيش حاجة بتتبعت من هنا. */
(function () {
  "use strict";
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------- معالجة الصورة (دوال صافية على {data,width,height} RGBA) ----------
  function lumOf(img) {
    const { data, width: w, height: h } = img, g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    return g;
  }

  function boxBlur(src, w, h, r) { // أفقي ثم رأسي، الأطراف مثبّتة
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[row + clamp(k, 0, w - 1)];
      for (let x = 0; x < w; x++) { tmp[row + x] = acc / n; acc += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)]; }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = acc / n; acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x]; }
    }
    return out;
  }

  function otsu(g) {
    const hist = new Float64Array(256); let total = g.length;
    for (let i = 0; i < g.length; i++) hist[clamp(Math.round(g[i]), 0, 255)]++;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let wB = 0, sB = 0, best = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sB += t * hist[t];
      const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }

  // بيدوّر على الورقة (أكبر منطقة فاتحة) ويرجّع 4 أركان [فوق شمال، فوق يمين، تحت يمين، تحت شمال] كنسب 0..1، أو null
  function findPaper(img) {
    const w = img.width, h = img.height, n = w * h, g = boxBlur(lumOf(img), w, h, 2), t = otsu(g);
    const mask = new Uint8Array(n); for (let i = 0; i < n; i++) mask[i] = g[i] > t ? 1 : 0;
    const label = new Int32Array(n), stack = new Int32Array(n);
    let best = 0, bestId = 0, id = 0;
    for (let s = 0; s < n; s++) {
      if (!mask[s] || label[s]) continue;
      id++; let sp = 0, area = 0; stack[sp++] = s; label[s] = id;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
        if (p >= w && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[sp++] = p - w; }
        if (p < n - w && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[sp++] = p + w; }
      }
      if (area > best) { best = area; bestId = id; }
    }
    if (best < 0.18 * n) return null;
    const score = [(x, y) => -(x + y), (x, y) => x - y, (x, y) => x + y, (x, y) => y - x]; // فوق شمال، فوق يمين، تحت يمين، تحت شمال
    const mx = [-Infinity, -Infinity, -Infinity, -Infinity];
    for (let p = 0; p < n; p++) if (label[p] === bestId) { const x = p % w, y = (p / w) | 0; for (let k = 0; k < 4; k++) { const v = score[k](x, y); if (v > mx[k]) mx[k] = v; } }
    const acc = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], tol = 2;
    for (let p = 0; p < n; p++) if (label[p] === bestId) { const x = p % w, y = (p / w) | 0; for (let k = 0; k < 4; k++) if (score[k](x, y) >= mx[k] - tol) { acc[k][0] += x; acc[k][1] += y; acc[k][2]++; } }
    let q = acc.map((a) => [a[0] / a[2] / (w - 1), a[1] / a[2] / (h - 1)]);
    // هامش صغير لبره عشان الحافة ما تتقصش، وبعدين نتأكد إن الشكل منطقي
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    q = q.map(([x, y]) => [clamp(cx + (x - cx) * 1.015, 0, 1), clamp(cy + (y - cy) * 1.015, 0, 1)]);
    let area2 = 0, sign = 0, convex = true;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      area2 += a[0] * b[1] - b[0] * a[1];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cr !== 0) { if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) convex = false; }
    }
    if (!convex || Math.abs(area2) / 2 < 0.15) return null;
    return q;
  }

  function solve8(A, B) {
    const n = 8;
    for (let i = 0; i < n; i++) {
      let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [B[i], B[p]] = [B[p], B[i]];
      const pv = A[i][i] || 1e-12;
      for (let r = i + 1; r < n; r++) { const f = A[r][i] / pv; if (!f) continue; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; B[r] -= f * B[i]; }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = B[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / (A[i][i] || 1e-12); }
    return x;
  }

  // مصفوفة بتحوّل نقط s إلى نقط d: [a,b,c,d,e,f,g,h]
  function homography(s, d) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = s[i], [u, v] = d[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    return solve8(A, B);
  }
  const matrix3d = (m) => "matrix3d(" + [m[0], m[3], 0, m[6], m[1], m[4], 0, m[7], 0, 0, 1, 0, m[2], m[5], 0, 1].join(",") + ")";

  // بيفرد المنطقة اللي جوه quad (بكسل الصورة الأصلية) في مستطيل W×H
  function warp(src, quad, W, H) {
    const m = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], hh = m[7];
    const out = new Uint8ClampedArray(W * H * 4), sd = src.data, sw = src.width, sh = src.height;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const den = g * x + hh * y + 1, sx = clamp((a * x + b * y + c) / den, 0, sw - 1.001), sy = clamp((d * x + e * y + f) / den, 0, sh - 1.001);
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, o = (y * W + x) * 4;
        for (let k = 0; k < 3; k++) out[o + k] = (sd[i00 + k] * (1 - fx) + sd[i10 + k] * fx) * (1 - fy) + (sd[i01 + k] * (1 - fx) + sd[i11 + k] * fx) * fy;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: W, height: H };
  }

  // «تنضيف السكانر»: بيشيل ظل الإضاءة (كل قناة على خلفيتها المحلية) فالورقة تطلع بيضا والخط واضح وبيحتفظ بلون الحبر
  function enhance(img) {
    const w = img.width, h = img.height, d = img.data, B = Math.max(8, Math.round(Math.min(w, h) / 36)), bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    const bg = [0, 1, 2].map(() => new Float32Array(bw * bh));
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const mxs = [0, 0, 0], ye = Math.min(h, (by + 1) * B), xe = Math.min(w, (bx + 1) * B);
      for (let y = by * B; y < ye; y += 2) for (let x = bx * B; x < xe; x += 2) { const p = (y * w + x) * 4; for (let k = 0; k < 3; k++) if (d[p + k] > mxs[k]) mxs[k] = d[p + k]; }
      for (let k = 0; k < 3; k++) bg[k][by * bw + bx] = mxs[k];
    }
    const bl = bg.map((a) => boxBlur(a, bw, bh, 1));
    const out = new Uint8ClampedArray(w * h * 4), lo = 0.42, hi = 0.92;
    for (let y = 0; y < h; y++) {
      const gy = clamp((y + 0.5) / B - 0.5, 0, bh - 1), y0 = gy | 0, y1 = Math.min(bh - 1, y0 + 1), fy = gy - y0;
      for (let x = 0; x < w; x++) {
        const gx = clamp((x + 0.5) / B - 0.5, 0, bw - 1), x0 = gx | 0, x1 = Math.min(bw - 1, x0 + 1), fx = gx - x0, p = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) {
          const a = bl[k], bgv = Math.max(30, (a[y0 * bw + x0] * (1 - fx) + a[y0 * bw + x1] * fx) * (1 - fy) + (a[y1 * bw + x0] * (1 - fx) + a[y1 * bw + x1] * fx) * fy);
          let t = clamp((d[p + k] / bgv - lo) / (hi - lo), 0, 1); t = t * t * (3 - 2 * t);
          out[p + k] = t * 255;
        }
        out[p + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }

  // بيحدد أسطر الكتابة (شرايط أفقية فيها حبر) ويرجّع [{x0,y0,x1,y1}] كنسب 0..1
  function findLines(img) {
    const w = img.width, h = img.height, d = img.data, xa = Math.round(w * 0.04), xb = Math.round(w * 0.96);
    const rows = new Float32Array(h), ink = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      for (let x = xa; x < xb; x++) { const p = (y * w + x) * 4; if (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2] < 150) { ink[y * w + x] = 1; c++; } }
      rows[y] = c;
    }
    const sm = boxBlur(rows, 1, h, Math.max(1, Math.round(h * 0.004)));
    const sorted = Float32Array.from(sm).sort(), p90 = sorted[Math.floor(sorted.length * 0.9)];
    const thr = Math.max(p90 * 0.3, (xb - xa) * 0.004);
    let runs = [], s = -1;
    for (let y = 0; y <= h; y++) { const on = y < h && sm[y] > thr; if (on && s < 0) s = y; if (!on && s >= 0) { runs.push([s, y - 1]); s = -1; } }
    const gap = Math.round(h * 0.008), merged = [];
    for (const r of runs) { const l = merged[merged.length - 1]; if (l && r[0] - l[1] <= gap) l[1] = r[1]; else merged.push(r.slice()); }
    const out = [], minH = Math.max(6, h * 0.008);
    for (const [y0, y1] of merged) {
      if (y1 - y0 + 1 < minH) continue;
      const cols = new Uint16Array(w);
      for (let y = y0; y <= y1; y++) for (let x = xa; x < xb; x++) cols[x] += ink[y * w + x];
      const need = Math.max(1, Math.round((y1 - y0 + 1) * 0.06)); let mn = -1, mxx = -1;
      for (let x = xa; x < xb; x++) if (cols[x] >= need) { if (mn < 0) mn = x; mxx = x; }
      if (mn < 0 || mxx - mn < w * 0.06) continue;
      const pad = h * 0.004;
      out.push({ x0: clamp((mn - w * 0.012) / w, 0, 1), x1: clamp((mxx + w * 0.012) / w, 0, 1), y0: clamp((y0 - pad) / h, 0, 1), y1: clamp((y1 + pad) / h, 0, 1) });
      if (out.length >= 14) break;
    }
    return out;
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const fit = (w, h, mw, mh) => { const k = Math.min(mw / w, mh / h); return [Math.round(w * k), Math.round(h * k)]; };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- الأنيميشن ----------
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  function start(file) {
    const root = mk("div", "rxs"), stage = mk("div", "rxs-stage"), frame = mk("div", "rxs-frame");
    const srcC = mk("canvas", "rxs-src"), outC = mk("canvas", "rxs-out"), beam = mk("div", "rxs-beam"), lines = mk("div", "rxs-lines");
    const svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "rxs-quad");
    const cap = mk("div", "rxs-cap"), capT = mk("span"); cap.append(capT, mk("i"), mk("i"), mk("i"));
    outC.style.opacity = "0"; svg.style.opacity = "0"; beam.style.opacity = "0";
    frame.append(srcC, svg, outC, lines, beam); stage.append(frame); root.append(stage, cap);
    const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    let dead = false, raf = 0, ever = false;
    const ctl = { el: root, stop() { dead = true; cancelAnimationFrame(raf); beam.style.opacity = "0"; capT.textContent = ""; cap.hidden = true; } };
    const say = (t) => { if (capT.textContent !== t) capT.textContent = t; };
    say("جاري مسح الروشتة");

    const url = URL.createObjectURL(file), img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); root.remove(); dead = true; };
    img.onload = () => { URL.revokeObjectURL(url); setup(); };
    img.src = url;

    function setup() {
      if (dead) return;
      const cw = root.clientWidth;
      if (!cw) { raf = requestAnimationFrame(setup); return; } // لسه ما اتحطّش في الصفحة
      ever = true;
      const maxW = Math.min(cw - 26, 440), maxH = Math.min(window.innerHeight * 0.58, 540);
      const nw = img.naturalWidth, nh = img.naturalHeight, k = Math.min(1, 1400 / Math.max(nw, nh)), SW = Math.max(2, Math.round(nw * k)), SH = Math.max(2, Math.round(nh * k));
      srcC.width = SW; srcC.height = SH; srcC.getContext("2d").drawImage(img, 0, 0, SW, SH);
      const [w0, h0] = fit(SW, SH, maxW, maxH);
      stage.style.height = maxH + 24 + "px";
      const setFrame = (w, h) => { frame.style.width = w + "px"; frame.style.height = h + "px"; };
      setFrame(w0, h0);
      for (const c of [srcC, svg]) { c.style.width = w0 + "px"; c.style.height = h0 + "px"; }
      svg.setAttribute("viewBox", "0 0 " + w0 + " " + h0);

      const R = { quad: null, w1: w0, h1: h0, bands: [], ready: false, fallback: false };
      const t0 = performance.now();
      // التحليل على دفعات صغيرة عشان الشاشة ما تتجمّدش
      setTimeout(() => {
        if (dead) return;
        try {
          const [sw, sh] = fit(SW, SH, 240, 320), sc = mk("canvas"); sc.width = sw; sc.height = sh;
          const sx = sc.getContext("2d", { willReadFrequently: true }); sx.drawImage(srcC, 0, 0, sw, sh);
          let q = findPaper(sx.getImageData(0, 0, sw, sh));
          if (!q) { R.fallback = true; q = [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]]; }
          R.quad = q;
          setTimeout(() => {
            if (dead) return;
            try {
              const qs = q.map(([x, y]) => [x * (SW - 1), y * (SH - 1)]);
              const ow = Math.max(dist(qs[0], qs[1]), dist(qs[3], qs[2])), oh = Math.max(dist(qs[0], qs[3]), dist(qs[1], qs[2])), kk = Math.min(1, 1100 / Math.max(ow, oh));
              const W = Math.max(40, Math.round(ow * kk)), H = Math.max(40, Math.round(oh * kk));
              const src = srcC.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, SW, SH);
              const clean = enhance(warp(src, qs, W, H));
              outC.width = W; outC.height = H; outC.getContext("2d").putImageData(new ImageData(clean.data, W, H), 0, 0);
              const [w1, h1] = fit(W, H, maxW, maxH); R.w1 = w1; R.h1 = h1;
              outC.style.width = w1 + "px"; outC.style.height = h1 + "px";
              R.bands = findLines(clean);
              lines.style.width = w1 + "px"; lines.style.height = h1 + "px";
              R.bands.forEach((b, i) => {
                const d = mk("div", "rxs-line"); d.style.cssText = "left:" + b.x0 * 100 + "%;top:" + b.y0 * 100 + "%;width:" + (b.x1 - b.x0) * 100 + "%;height:" + (b.y1 - b.y0) * 100 + "%;--i:" + i;
                lines.append(d);
              });
              // رسمة حدود الورقة (فوق الصورة الأصلية)
              const P = q.map(([x, y]) => [x * w0, y * h0]);
              const outer = document.createElementNS(NS, "path"); outer.setAttribute("d", "M0 0H" + w0 + "V" + h0 + "H0Z M" + P.map((p) => p[0] + " " + p[1]).join("L") + "Z"); outer.setAttribute("fill-rule", "evenodd"); outer.setAttribute("class", "rxs-dim");
              const poly = document.createElementNS(NS, "polygon"); poly.setAttribute("points", P.map((p) => p.join(",")).join(" ")); poly.setAttribute("class", "rxs-edge"); poly.setAttribute("pathLength", "1");
              svg.append(outer, poly);
              const dots = P.map((p) => { const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", p[0]); c.setAttribute("cy", p[1]); c.setAttribute("r", "0"); c.setAttribute("class", "rxs-corner"); svg.append(c); return c; });
              R.P = P; R.poly = poly; R.dim = outer; R.dots = dots; R.ready = true;
            } catch (e) { R.err = true; }
          }, 30);
        } catch (e) { R.err = true; }
      }, 40);

      const final = () => { // الحالة النهائية من غير حركة
        setFrame(R.w1, R.h1); srcC.style.display = "none"; svg.style.display = "none"; outC.style.opacity = "1"; outC.style.clipPath = "none";
        lines.querySelectorAll(".rxs-line").forEach((d) => d.classList.add("on")); say("بنقرا الأسطر");
      };
      const mat = (t) => { // تحويل الصورة الأصلية عشان حدود الورقة تملا الإطار
        const D = [[0, 0], [R.w1, 0], [R.w1, R.h1], [0, R.h1]], Dt = R.P.map((p, i) => [lerp(p[0], D[i][0], t), lerp(p[1], D[i][1], t)]);
        return matrix3d(homography(R.P, Dt));
      };
      let phase = "scan", ps = t0, shown = 0;
      const go = (p, now) => { phase = p; ps = now; };
      function tick(now) {
        if (dead) return;
        if (ever && !root.isConnected) { dead = true; return; } // الصفحة اتبدّلت بالنتايج
        const e = now - ps;
        if (R.err) { final(); say("بنقرا الأسطر"); return; }
        if (phase === "scan") {
          say("جاري مسح الروشتة");
          const per = 1300, y = ((now - t0) % per) / per * h0;
          beam.style.opacity = "1"; beam.style.transform = "translateY(" + (y - 56) + "px)";
          if (R.ready && now - t0 > 1500) { beam.style.opacity = "0"; if (reduce) { final(); return; } go("edge", now); }
        } else if (phase === "edge") {
          say(R.fallback ? "بنظبّط الصورة" : "بنحدد حدود الورقة");
          const p = ease(clamp(e / 900, 0, 1));
          svg.style.opacity = "1"; R.poly.style.strokeDashoffset = String(1 - p); R.dim.style.opacity = String(p);
          R.dots.forEach((c) => c.setAttribute("r", String(5 * p)));
          if (e > 1100) go("morph", now);
        } else if (phase === "morph") {
          say("بنقص الأطراف ونعدّل الميل");
          const t = ease(clamp(e / 1300, 0, 1));
          setFrame(lerp(w0, R.w1, t), lerp(h0, R.h1, t));
          const m = mat(t); srcC.style.transform = m; svg.style.transform = m; svg.style.opacity = String(1 - t);
          if (e > 1400) go("clean", now);
        } else if (phase === "clean") {
          say("بنحسّن الوضوح");
          const p = ease(clamp(e / 900, 0, 1));
          outC.style.opacity = "1"; outC.style.clipPath = "inset(0 0 " + (1 - p) * 100 + "% 0)";
          if (e > 1000) { srcC.style.display = "none"; svg.style.display = "none"; outC.style.clipPath = "none"; go("lines", now); }
        } else if (phase === "lines") {
          say("بنحدد الأسطر");
          const all = lines.querySelectorAll(".rxs-line"), want = Math.min(all.length, Math.floor(e / 260) + 1);
          while (shown < want) all[shown++].classList.add("on");
          if (e > all.length * 260 + 500) go("idle", now);
        } else { say("بنقرا الأسطر"); return; } // وقفنا الحركة: الخطوط بتنبض بالـ CSS لحد ما النتيجة تظهر
        raf = requestAnimationFrame(tick);
      }
      raf = requestAnimationFrame(tick);
    }
    return ctl;
  }

  window.RxScan = { start };
  if (typeof module !== "undefined") module.exports = { lumOf, boxBlur, otsu, findPaper, homography, matrix3d, warp, enhance, findLines };
})();
