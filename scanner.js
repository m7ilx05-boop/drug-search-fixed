/* scanner.js — وضع المسح الضوئي (USB HID barcode scanner + كاميرا الجهاز).
   بيعرّف: parseScan وأخواتها، واجهة وضع المسح (#scanPanel)، قارئ الكاميرا (BarcodeDetector / ZXing)، سجل المسحات.
   بيعتمد على: core.js (call, el, $, ERR), render.js (card), search.js (clearMore, polling).
   ملاحظة: الكلاس .scan-btn بيستخدمه image-search.js كمان. الـ CSS بتاع الملف ده بيتحقن من الكود تحت. */
(() => {
"use strict";
const GS = "\x1d", DEDUPE_MS = 3000, LOG_MAX = 50;

// ===== تحليل محتوى المسحة =====
const AR = (s) => s.replace(/[\u0660-\u0669]/g, (c) => c.charCodeAt(0) - 0x660).replace(/[\u06F0-\u06F9]/g, (c) => c.charCodeAt(0) - 0x6F0);
const mod10 = (code) => {
  const d = [...code].map(Number), c = d.pop();
  let s = 0; d.reverse().forEach((x, i) => { s += x * (i % 2 ? 1 : 3); });
  return (10 - (s % 10)) % 10 === c;
};
function upcE(c) { // UPC-E (8 أرقام) -> UPC-A (12 رقم)
  if (!/^[01]\d{7}$/.test(c)) return null;
  const ns = c[0], d = c.slice(1, 7), chk = c[7], l = d[5];
  let m, p;
  if ("012".includes(l)) { m = d[0] + d[1] + l + "00"; p = "00" + d[2] + d[3] + d[4]; }
  else if (l === "3") { m = d.slice(0, 3) + "00"; p = "000" + d[3] + d[4]; }
  else if (l === "4") { m = d.slice(0, 4) + "0"; p = "0000" + d[4]; }
  else { m = d.slice(0, 5); p = "0000" + l; }
  const a = ns + m + p + chk;
  return mod10(a) ? a : null;
}
const fmtDate = (s) => {
  if (!/^\d{6}$/.test(s || "")) return s || "";
  const y = "20" + s.slice(0, 2), m = s.slice(2, 4), d = s.slice(4);
  return d === "00" ? y + "-" + m : y + "-" + m + "-" + d;
};
function gs1Result(ai, label) {
  const g = ai["01"];
  if (!g || !/^\d{14}$/.test(g)) return { kind: "gs1", label, error: "بيانات GS1 بدون GTIN (01) أو غير قابلة للتحليل. اضبط السكانر على إرسال فاصل GS." };
  if (!mod10(g)) return { kind: "gs1", label, error: "GTIN داخل GS1 غير صالح (رقم المراجعة خاطئ). أعد المسح." };
  return { kind: "gs1", label, gtins: [g], extra: { expiry: ai["17"] ? fmtDate(ai["17"]) : "", lot: ai["10"] || "", serial: ai["21"] || "" } };
}
function parseGs1(s) {
  const ai = {};
  if (/\(\d{2,4}\)/.test(s)) {
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) ai[m[1]] = m[2].replace(/\x1d/g, "").trim();
  } else {
    const FIX = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2 };
    let i = 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      const k = s.slice(i, i + 2); i += 2;
      if (FIX[k]) { ai[k] = s.slice(i, i + FIX[k]); i += FIX[k]; }
      else if (["10", "21", "22", "30", "37"].includes(k)) { let j = s.indexOf(GS, i); if (j < 0) j = s.length; ai[k] = s.slice(i, j); i = j; }
      else break;
    }
  }
  return gs1Result(ai, "GS1");
}
function parseUrl(raw) {
  let u; try { u = new URL(raw); } catch { return { kind: "url", error: "رابط غير صالح" }; }
  const g = u.pathname.match(/\/01\/(\d{14})(?:\/|$)/);
  if (!g) return { kind: "url", label: "QR (رابط)", error: "الـ QR ده رابط ولا يحتوي على GTIN.", text: raw.slice(0, 120) };
  const seg = (k) => { const m = u.pathname.match(new RegExp("/" + k + "/([^/]+)")); return m ? decodeURIComponent(m[1]) : ""; };
  return gs1Result({ "01": g[1], "10": seg("10"), "21": seg("21"), "17": seg("17") }, "GS1 Digital Link");
}
function parseScan(raw0) {
  const raw = AR(String(raw0)).replace(/[\r\n\t]/g, "").replace(/\u241d/g, GS).trim().replace(/^\][A-Za-z]\d/, "");
  if (!raw) return { kind: "empty" };
  if (/^https?:\/\//i.test(raw)) return parseUrl(raw);
  const c = raw.replace(/\s/g, "");
  if (/^\d+$/.test(c)) {
    const L = { 8: "EAN-8", 12: "UPC-A", 13: "EAN-13", 14: "GTIN-14" };
    if (L[c.length]) {
      if (!mod10(c)) return { kind: "gtin", label: L[c.length], error: "رقم الباركود غير صالح (رقم المراجعة خاطئ). أعد المسح." };
      const gt = [c], e = c.length === 8 ? upcE(c) : null;
      if (e) gt.push(e);
      return { kind: "gtin", label: c.length === 8 && e ? "EAN-8 / UPC-E" : L[c.length], gtins: gt };
    }
    if (c.length >= 16 && c.startsWith("01")) return parseGs1(c);
    return { kind: "gtin", label: "رقم", error: "طول الرقم (" + c.length + ") غير مدعوم. المدعوم: 8 أو 12 أو 13 أو 14." };
  }
  if (/\(\d{2,4}\)/.test(raw) || /^01\d{14}/.test(raw)) return parseGs1(raw);
  return { kind: "text", label: "نص", error: "المحتوى مش رقم منتج ولا GS1.", text: raw.slice(0, 120) };
}

// ===== الواجهة =====
const css = document.createElement("style");
css.textContent = `.scan-btn{display:block;width:100%;margin-top:12px;background:var(--surface);color:var(--accent);border:2px solid var(--accent)}
#scanPanel{margin-top:14px}.scan-box{background:var(--surface);border:2px solid var(--accent);border-radius:12px;padding:14px}
.scan-top{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.scan-state{font-weight:600;padding:3px 12px;border-radius:999px;background:var(--ok-bg);color:var(--ok)}
.scan-state.lost{background:var(--warn-bg);color:var(--warn)}
#scanIn{width:100%;margin-top:10px;direction:ltr;text-align:center;font:inherit;padding:11px 14px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.scan-opt{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:14px;color:var(--muted)}
.scan-msg{padding:12px 14px;border-radius:10px;margin-top:12px;font-weight:500}
.scan-msg.warn{background:var(--warn-bg);color:var(--warn)}.scan-msg.bad{background:var(--bad-bg);color:var(--bad)}
.scan-log{margin-top:18px}.log-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line);cursor:pointer;font-size:14px}
.log-row .g{direction:ltr;font-family:monospace}.log-row .n{flex:1;min-width:120px;overflow-wrap:anywhere}`;
document.head.append(css);

const btn = el("button", "scan-btn", "وضع المسح الضوئي"); btn.type = "button";
$("f").append(btn);

const panel = el("section"); panel.id = "scanPanel"; panel.hidden = true;
const box = el("div", "scan-box");
const top = el("div", "scan-top");
const state = el("span", "scan-state", "جاهز للمسح");
const camBtn = el("button", null, "تشغيل الكاميرا"); camBtn.type = "button";
const phoneBtn = el("button", null, "📷 كاميرا الجوال"); phoneBtn.type = "button"; // بيفتح تطبيق كاميرا الجوال نفسه ويقرا الباركود من الصورة
const phoneIn = el("input"); phoneIn.type = "file"; phoneIn.accept = "image/*"; phoneIn.setAttribute("capture", "environment"); phoneIn.hidden = true;
const stop = el("button", null, "إيقاف وضع المسح"); stop.type = "button";
top.append(state, camBtn, phoneBtn, stop);
const cam = el("div", "cam"); cam.append(Object.assign(el("video"), { muted: true, autoplay: true }), el("div", "frame"));
const video = cam.firstChild; video.setAttribute("playsinline", "");
const camMsg = el("div", "meta");
const inp = el("input"); inp.id = "scanIn"; inp.type = "text"; inp.autocomplete = "off"; inp.spellcheck = false;
inp.setAttribute("inputmode", "none"); // على الموبايل: من غير ما الكيبورد يطلع. السكانر الـ USB بيكتب عادي
inp.setAttribute("aria-label", "حقل استقبال السكانر"); inp.placeholder = "امسح العبوة بالسكانر…";
const optL = el("label", "scan-opt"); const noEnter = el("input"); noEnter.type = "checkbox";
optL.append(noEnter, "السكانر لا يرسل Enter بعد المسح (الاكتشاف التلقائي بالسرعة)");
const note = el("div", "meta");
box.append(top, cam, camMsg, inp, optL, note, phoneIn);
const outBox = el("div"); outBox.setAttribute("aria-live", "polite");
const logTitle = el("h3", "sec", "آخر عمليات المسح"); const logList = el("div", "scan-log");
panel.append(box, outBox, logTitle, logList);
$("f").after(panel);

let active = false, seq = 0, lastKey = "", lastAt = 0, times = [], timer = 0;
const inflight = new Set(), log = [];
const OUT = { found: ["تم العثور", "ok"], ambiguous: ["باركود مشترك", "warn"], not_found: ["غير موجود", "bad"], invalid: ["غير صالح", "bad"], error: ["خطأ", "bad"], pending: ["جاري البحث", "warn"] };
const hideIds = ["f", "out", "more", "status", "imgbox", "fam"];

const setState = () => { const ok = document.activeElement === inp; state.textContent = ok ? "جاهز للمسح" : "التركيز مفقود — اضغط في أي مكان"; state.className = "scan-state" + (ok ? "" : " lost"); };
const refocus = () => { if (active && document.activeElement !== inp) inp.focus({ preventScroll: true }); setState(); };

// ===== مسح بالكاميرا (باركود خطي + QR + DataMatrix) =====
// القراءة بتتم جوه المتصفح: BarcodeDetector لو بيدعم الأنواع المطلوبة، وإلا مكتبة ZXing بتتحمّل أول مرة بس.
// الفيديو ما بيتبعتش لأي سيرفر؛ النص اللي اتقرا بس بيعدّي على نفس مسار السكانر (parseScan -> drug-barcode).
const WANT = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "itf", "qr_code", "data_matrix"];
const ZX_URLS = ["vendor/zxing-0.21.3.min.js", "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js"]; // نسخة على موقعنا الأول، وبعدها CDN
let zxPromise = null, stream = null, camOn = false, camGen = 0, seenText = "", seenAt = 0;

const loadZx = () => zxPromise || (zxPromise = new Promise((res, rej) => {
  if (window.ZXing) return res(window.ZXing);
  const tryLoad = (i) => {
    if (i >= ZX_URLS.length) { zxPromise = null; return rej(new Error("zxing_load_failed")); }
    const s = document.createElement("script");
    s.src = ZX_URLS[i];
    s.onload = () => (window.ZXing ? res(window.ZXing) : tryLoad(i + 1));
    s.onerror = () => { s.remove(); tryLoad(i + 1); };
    document.head.append(s);
  };
  tryLoad(0);
}));

async function makeDetector() {
  if ("BarcodeDetector" in window) {
    try {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      if (["ean_13", "qr_code", "data_matrix"].every((f) => sup.includes(f))) {
        const d = new window.BarcodeDetector({ formats: WANT.filter((f) => sup.includes(f)) });
        return { read: async (v) => { const a = await d.detect(v); return a.length ? a[0].rawValue : null; } };
      }
    } catch { /* نكمّل بـ ZXing */ }
  }
  const Z = await loadZx(), F = Z.BarcodeFormat;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.ITF, F.QR_CODE, F.DATA_MATRIX]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const mfr = new Z.MultiFormatReader(); mfr.setHints(hints);
  const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });
  return {
    read: async (v) => {
      const W = v.videoWidth || v.width, H = v.videoHeight || v.height; // فيديو أو صورة ثابتة (ImageBitmap)
      const k = Math.min(1, (v.videoWidth ? 960 : 1600) / (W || 960));
      cv.width = Math.round(W * k); cv.height = Math.round(H * k);
      ctx.drawImage(v, 0, 0, cv.width, cv.height);
      try { return mfr.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(cv)))).getText(); }
      catch { return null; } // مفيش كود في الفريم ده
    },
  };
}

function camStop() {
  camGen++; camOn = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; video.srcObject = null;
  cam.classList.remove("on"); camBtn.disabled = false; camBtn.textContent = "تشغيل الكاميرا"; seenText = "";
}

async function camStart() {
  if (camOn) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camMsg.textContent = "الكاميرا مش متاحة في المتصفح ده (محتاجة HTTPS ومتصفح حديث)."; return; }
  camBtn.disabled = true; camMsg.textContent = "جاري تشغيل الكاميرا…";
  const gen = ++camGen;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    camBtn.disabled = false;
    camMsg.textContent = e.name === "NotAllowedError" ? "صلاحية الكاميرا اتمنعت. فعّلها من إعدادات المتصفح وجرّب تاني."
      : e.name === "NotFoundError" ? "مفيش كاميرا على الجهاز ده." : "تعذّر تشغيل الكاميرا (" + e.name + ").";
    return;
  }
  if (gen !== camGen) { stream.getTracks().forEach((t) => t.stop()); stream = null; return; }
  video.srcObject = stream;
  cam.classList.add("on"); camMsg.textContent = "الكاميرا اشتغلت. جاري تجهيز قارئ الباركود…";
  try { await video.play(); } catch { /* autoplay هيشتغل أول ما الفريم يجهز */ }
  let det;
  try { det = await makeDetector(); }
  catch (e) { camStop(); camMsg.textContent = "تعذّر تحميل قارئ الباركود (" + e.message + "). تأكد من الإنترنت وجرّب تاني، أو استخدم السكانر أو ابحث بصورة المنتج."; return; }
  if (gen !== camGen) return;
  camOn = true; camBtn.disabled = false; camBtn.textContent = "إيقاف الكاميرا";
  camMsg.textContent = "وجّه الباركود أو الـ QR ناحية الإطار.";
  const tick = async () => {
    if (gen !== camGen) return;
    if (video.readyState >= 2 && video.videoWidth) {
      let text = null;
      try { text = await det.read(video); } catch { /* نكمّل */ }
      if (gen !== camGen) return;
      if (text) {
        const now = Date.now(), fresh = text !== seenText || now - seenAt > 1500;
        seenText = text; seenAt = now; // طول ما الكود قدام الكاميرا ما بيتسجلش تاني
        if (fresh) { try { if (navigator.vibrate) navigator.vibrate(60); } catch { /* مش مدعوم */ } camStop(); camMsg.textContent = "تم التقاط الباركود وقفلنا الكاميرا. اضغط «تشغيل الكاميرا» لمسح تاني."; submit(text); return; }
      }
    }
    setTimeout(tick, 150);
  };
  tick();
}
camBtn.addEventListener("click", () => (camOn ? camStop() : camStart()));
// كاميرا الجوال: بيفتح تطبيق الكاميرا الأصلي، وبعد التصوير بنقرا الباركود من الصورة (جوه المتصفح، الصورة مبتتبعتش لأي سيرفر)
phoneBtn.addEventListener("click", () => { phoneIn.value = ""; phoneIn.click(); });
phoneIn.addEventListener("change", async () => {
  const f = phoneIn.files && phoneIn.files[0]; if (!f) return;
  if (camOn) camStop();
  phoneBtn.disabled = true; camMsg.textContent = "جاري قراءة الباركود من الصورة…";
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
    const det = await makeDetector();
    let text = null;
    try { text = await det.read(bmp); } catch { /* مفيش كود */ }
    if (bmp.close) bmp.close();
    if (text) { try { if (navigator.vibrate) navigator.vibrate(60); } catch { /* مش مدعوم */ } camMsg.textContent = "تم قراءة الباركود من الصورة."; submit(text); }
    else camMsg.textContent = "ما لقيناش باركود واضح في الصورة. قرّب وصوّر الباركود لوحده بإضاءة كويسة وجرّب تاني.";
  } catch (e) {
    camMsg.textContent = "تعذّر قراءة الصورة (" + (e && e.message ? e.message : "خطأ") + "). جرّب تاني.";
  }
  phoneBtn.disabled = false; phoneIn.value = "";
});
document.addEventListener("visibilitychange", () => { if (document.hidden && camOn) { camStop(); camMsg.textContent = "الكاميرا اتقفلت لأنك سبت الصفحة. شغّلها تاني لو عايز."; } });

function start() {
  active = true;
  try { polling++; clearMore(); } catch {}
  hideIds.forEach((id) => { const n = $(id); if (n) n.style.display = "none"; });
  panel.hidden = false; refocus();
}
function end() {
  active = false; camStop(); camMsg.textContent = ""; panel.hidden = true; inp.value = "";
  hideIds.forEach((id) => { const n = $(id); if (n) n.style.display = ""; });
  $("q").focus();
}
btn.addEventListener("click", start);
stop.addEventListener("click", end);

inp.addEventListener("blur", () => setTimeout(() => { const a = document.activeElement; if (active && (!a || a === document.body)) refocus(); else setState(); }, 0));
inp.addEventListener("focus", setState);
panel.addEventListener("click", (e) => { if (e.target !== inp) setTimeout(refocus, 0); });
window.addEventListener("focus", refocus);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refocus(); });
document.addEventListener("keydown", (e) => { // لو التركيز ضاع (مثلاً على زر)، أول حرف من السكانر يرجّعه للحقل
  if (!active || e.target === inp || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || "")) return;
  if (e.key.length === 1 || e.key === "Enter") refocus();
}, true);

function flush() { const v = inp.value; inp.value = ""; times = []; clearTimeout(timer); submit(v); }
inp.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); flush(); }
  else if (e.ctrlKey && e.key === "]") { e.preventDefault(); inp.value += GS; } // بعض السكانرات بتبعت GS كـ Ctrl+]
});
inp.addEventListener("input", () => {
  if (!inp.value) { times = []; return; }
  times.push(performance.now()); clearTimeout(timer);
  if (!noEnter.checked) return;
  timer = setTimeout(() => {
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    if (inp.value.length >= 8 && avg <= 60) flush(); // إدخال سريع = سكانر مش كتابة بإيد
  }, 120);
});

function renderLog() {
  logList.replaceChildren();
  if (!log.length) { logList.append(el("div", "meta", "لسه مفيش عمليات مسح.")); return; }
  log.forEach((e) => {
    const row = el("div", "log-row");
    const [t, c] = OUT[e.outcome];
    row.append(el("span", "meta", e.time.toLocaleTimeString("ar-EG")), el("span", "chip", e.label || e.kind), el("span", "g", e.gtin || ""), el("span", "chip " + c, t), el("span", "n", e.name || e.msg || ""));
    row.addEventListener("click", () => { if (e.outcome !== "pending") show(e); });
    logList.append(row);
  });
}

// في وضع المسح الحقل بتاع السكانر بيسحب التركيز، فمينفعش نحط حقل كتابة هنا: الزر بيقفل المسح ويفتح البحث بالعائلة
const famBtn = () => {
  const b = el("button", "alt-btn", "عايز باقي أفراد عائلة الدواء؟ اكتب اسم الدواء"); b.type = "button";
  b.addEventListener("click", () => {
    end();
    const r = document.querySelector('input[name=t][value="brand_family"]'); if (r) r.checked = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  return b;
};

function show(e) {
  outBox.replaceChildren();
  const p = e.p, parts = [p.label || "", e.gtin ? "GTIN: " + e.gtin : ""].filter(Boolean);
  if (p.extra) { if (p.extra.expiry) parts.push("الصلاحية: " + p.extra.expiry); if (p.extra.lot) parts.push("التشغيلة: " + p.extra.lot); if (p.extra.serial) parts.push("السيريال: " + p.extra.serial); }
  const head = el("div", "meta", parts.join(" — ")); head.style.direction = "ltr"; head.style.textAlign = "start";
  outBox.append(head);
  if (e.outcome === "invalid" || e.outcome === "error") {
    outBox.append(el("div", "scan-msg bad", e.msg + (p.text ? " (" + p.text + ")" : "")));
    // QR/نص مش رقم منتج: لو شكله اسم دواء، نعرض زر يبحث بيه بالبحث العادي
    if (p.kind === "text" && p.text && p.text.length >= 2 && p.text.length <= 100) {
      const sb = el("button", null, "ابحث عن «" + p.text + "» بالاسم"); sb.type = "button"; sb.style.marginTop = "8px";
      sb.addEventListener("click", () => {
        end(); $("q").value = p.text;
        const r = document.querySelector('input[name=t][value="auto"]'); if (r) r.checked = true;
        $("f").requestSubmit();
      });
      outBox.append(sb);
    }
  }
  else if (e.outcome === "not_found") { outBox.append(el("div", "scan-msg warn", "المنتج غير موجود في قاعدة البيانات")); outBox.append(famBtn()); }
  else {
    if (e.outcome === "ambiguous") outBox.append(el("div", "scan-msg warn", "الباركود ده مسجّل لأكتر من منتج في المصدر. راجع الاسم والحجم على العبوة."));
    ((e.data && e.data.results) || []).forEach((r) => outBox.append(card(r, 1)));
    outBox.append(famBtn());
  }
  refocus();
}

async function submit(raw) {
  const p = parseScan(raw);
  if (p.kind === "empty") return;
  const key = AR(String(raw)).trim(), now = Date.now();
  if ((key === lastKey && now - lastAt < DEDUPE_MS) || inflight.has(key)) { lastAt = now; note.textContent = "تم تجاهل مسحة مكررة."; return; }
  note.textContent = ""; lastKey = key; lastAt = now;
  const e = { id: ++seq, time: new Date(), p, label: p.label || p.kind, gtin: (p.gtins || [])[0] || "", outcome: "pending", name: "" };
  log.unshift(e); if (log.length > LOG_MAX) log.pop(); renderLog();
  if (p.error) { e.outcome = "invalid"; e.msg = p.error; renderLog(); show(e); return; }
  inflight.add(key);
  try {
    const d = await call("drug-barcode", { gtins: p.gtins });
    e.data = d; e.outcome = d.found === 0 ? "not_found" : d.ambiguous ? "ambiguous" : "found";
    e.name = (d.results || []).map((r) => r.product_name).join(" | ");
  } catch (err) { e.outcome = "error"; e.msg = ERR[err.code] || "حصلت مشكلة في الاتصال. جرّب تاني."; }
  finally { inflight.delete(key); }
  renderLog();
  if (e.id === seq) show(e); // لو اتمسح كود أحدث، النتيجة القديمة بتتسجل في السجل بس
}
renderLog();
})();
