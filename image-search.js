/* image-search.js — البحث بصورة المنتج: كاميرا أو معرض. النتيجة = نفس المنتج في الصورة بنفس التركيز والشكل
   (الفلترة في الباك اند: match.exact_ids).
   بيعتمد على: core.js, render.js (card), search.js (polling, clearMore), وكلاس .scan-btn من scanner.js. */
(() => {
"use strict";
const MAX_SIDE = 2048; // أكبر ضلع للصورة قبل الإرسال (كان 1280): الخط الصغير على العلبة (التركيز) بيفضل مقروء
const OCR_B64_MAX = 1300000; // OCR.space المجاني بيقبل لحد حوالي 1 ميجا: فوق كده بيتخطّى والقراءة بتتم بـ Gemini بس، فبنضغط الصورة لتحت الحد ده
let lastShot = { w: 0, h: 0 };
const RX_B64_MAX = 3300000; // الروشتة بخط صغير/يد: جودة أعلى من صور العلب (دالة read-prescription بتقبل لحد 4 ميجا)
const RX_SIDES = [[2560, 0.9], [2200, 0.85], [1900, 0.8], [1600, 0.74]];
ERR.vision_unavailable = "قراءة الصورة مش متاحة دلوقتي. جرّب تاني بعد شوية.";
ERR.vision_bad_output = "ما قدرناش نقرا الصورة. جرّب صورة أوضح.";
ERR.invalid_image = "الصورة مش صالحة أو كبيرة قوي. جرّب صورة تانية.";
ERR.invalid_gtin = "الباركود المقروء من الصورة مش صالح.";
ERR.rate_limited = ERR.rate_limited || "عدد المحاولات كبير. استنى كام دقيقة وجرّب تاني.";
ERR.reader_failed = "قراءة الروشتة مش متاحة دلوقتي. جرّب تاني بعد شوية.";
ERR.image_too_large = "صورة الروشتة كبيرة قوي. جرّب صورة أصغر.";
ERR.unsupported_image_type = "نوع الصورة مش مدعوم. استخدم JPG أو PNG أو WebP.";
ERR.image_base64_required = "الصورة مش واصلة صح. جرّب تاني.";
ERR.save_failed = "القراءة خلصت بس تعذّر حفظها. جرّب تاني.";
ERR.no_gemini_key_configured = "قراءة الروشتة مش متاحة دلوقتي (مفيش مفتاح مضبوط).";

const box = $("imgbox");
const fam = el("div"); fam.id = "fam"; fam.setAttribute("aria-live", "polite");
$("out").after(fam); // بعد النتايج مباشرة، وفوق زر البحث في الصيدليات

const mkInput = (capture) => { const i = el("input"); i.type = "file"; i.accept = "image/*"; if (capture) i.setAttribute("capture", "environment"); i.hidden = true; return i; };
const camIn = mkInput(true), galIn = mkInput(false);
const imgBtn = el("button", "scan-btn img-pick", "بحث بصورة"); imgBtn.type = "button";
// ===== صفحة البحث بالصورة (#/img): الكاميرا الحية بتفتح أول ما تدخل الصفحة (حوالي ¾ الشاشة)، والمعرض تحتها.
// فوق الكاميرا زرين صغيرين عايمين: منتج / روشتة (الاتنين شغّالين). =====
let built = false, stream = null, track = null, camGen = 0, shooting = false;
const ipMsg = el("div", "ip-msg"); ipMsg.hidden = true;
const say = (txt, bad) => { ipMsg.hidden = !txt; ipMsg.textContent = txt || ""; ipMsg.className = "ip-msg" + (bad ? " bad" : ""); };
const video = Object.assign(el("video"), { muted: true, autoplay: true }); video.setAttribute("playsinline", "");
const camBox = el("div", "ip-cam off");
const camHint = el("div", "ip-hint", "صوّر الروشتة كاملة من فوق وبإضاءة كويسة"); camHint.hidden = true;
const modes = el("div", "ip-modes");
const prodMode = el("button", "ip-mode on", "منتج"); prodMode.type = "button"; prodMode.setAttribute("aria-pressed", "true");
const rxMode = el("button", "ip-mode", "روشتة"); rxMode.type = "button"; rxMode.setAttribute("aria-pressed", "false");
modes.append(prodMode, rxMode);
// نسخة تانية من الزرين تحت الكاميرا (فوق زراير الكاميرا/المعرض): الاتنين بيتزامنوا مع بعض
const modes2 = el("div", "ip-modes");
const prodMode2 = el("button", "ip-mode on", "منتج"), rxMode2 = el("button", "ip-mode", "روشتة");
prodMode2.type = "button"; rxMode2.type = "button"; prodMode2.setAttribute("aria-pressed", "true"); rxMode2.setAttribute("aria-pressed", "false");
modes2.append(prodMode2, rxMode2);
// وضع الصورة: "prod" = علبة منتج (drug-image-search)، "rx" = روشتة (read-prescription)
let mode = "prod", tipEl = null;
const TIPS = { prod: "", rx: "صوّر الروشتة كاملة من فوق وبإضاءة كويسة، وخلّي كل الأسطر باينة من غير ضل. القراءة آلية وممكن تغلط في اسم أو رقم، فراجع كل سطر مع الصيدلي." };
const SUB = { prod: "صوّر العلبة أو اختار صورة من المعرض", rx: "صوّر الروشتة كاملة أو اختار صورة من المعرض" };
const TTL = { prod: "بحث بصورة", rx: "قراءة روشتة" };
const syncBar = () => { // عنوان الصفحة بيتبع الوضع (منتج / روشتة)
  const t = $("ab-t"), s = $("ab-s");
  if (t) t.textContent = TTL[mode]; if (s) s.textContent = SUB[mode];
};
const setMode = (m) => {
  mode = m;
  camBox.classList.toggle("rx", m === "rx"); camHint.hidden = m !== "rx";
  if (location.hash === "#/img") syncBar();
  [prodMode, prodMode2].forEach((b) => { b.classList.toggle("on", m === "prod"); b.setAttribute("aria-pressed", m === "prod" ? "true" : "false"); });
  [rxMode, rxMode2].forEach((b) => { b.classList.toggle("on", m === "rx"); b.setAttribute("aria-pressed", m === "rx" ? "true" : "false"); });
  if (tipEl && TIPS[m]) tipEl.textContent = TIPS[m];
  shotBtn.setAttribute("aria-label", m === "rx" ? "صوّر الروشتة واقرأها" : "صوّر وابحث");
  say("");
};
[prodMode, prodMode2].forEach((b) => b.addEventListener("click", () => setMode("prod")));
[rxMode, rxMode2].forEach((b) => b.addEventListener("click", () => setMode("rx")));
const shotBtn = el("button", "ip-shot"); shotBtn.type = "button"; shotBtn.setAttribute("aria-label", "صوّر وابحث"); shotBtn.disabled = true;
const retryBtn = el("button", "ip-retry", "تشغيل الكاميرا"); retryBtn.type = "button";
camBox.append(video, el("div", "ip-frame"), modes, camHint, retryBtn, shotBtn); // أزرار منتج/روشتة فوق الكاميرا، ونسخة تانية تحتها
const camRow = el("button", "img-opt photo", "تصوير بكاميرا التليفون (أعلى دقة)"); camRow.type = "button";
camRow.addEventListener("click", () => { camIn.value = ""; camIn.click(); });
const galRow = el("button", "img-opt gal", "استيراد صورة من المعرض"); galRow.type = "button";
galRow.addEventListener("click", () => galIn.click());

function stopCam() {
  camGen++;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; track = null; video.srcObject = null;
  camBox.classList.add("off"); shotBtn.disabled = true;
}
async function startCam() {
  if (stream) return;
  say("");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    say("الكاميرا مش متاحة في المتصفح ده (محتاجة HTTPS ومتصفح حديث). استخدم «استيراد صورة من المعرض».", true);
    return;
  }
  const gen = ++camGen;
  retryBtn.disabled = true;
  let s;
  try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false }); }
  catch (e) {
    retryBtn.disabled = false;
    say(e && e.name === "NotAllowedError" ? "مفيش إذن للكاميرا. فعّله من إعدادات المتصفح واضغط «تشغيل الكاميرا»، أو استخدم المعرض." : "تعذّر فتح الكاميرا (" + ((e && e.name) || "unknown") + "). جرّب تاني أو استخدم المعرض.", true);
    return;
  }
  retryBtn.disabled = false;
  if (gen !== camGen) { s.getTracks().forEach((t) => t.stop()); return; }
  stream = s; video.srcObject = s;
  track = s.getVideoTracks()[0] || null;
  try { // تركيز وتعريض مستمرين لو الجهاز بيدعمهم
    const caps = track && track.getCapabilities ? track.getCapabilities() : {}, adv = [];
    if (caps.focusMode && caps.focusMode.includes("continuous")) adv.push({ focusMode: "continuous" });
    if (caps.exposureMode && caps.exposureMode.includes("continuous")) adv.push({ exposureMode: "continuous" });
    if (adv.length) await track.applyConstraints({ advanced: adv });
  } catch { /* مش مدعوم */ }
  try { await video.play(); } catch { /* هيشتغل أول ما الفريم يجهز */ }
  camBox.classList.remove("off"); shotBtn.disabled = false;
}
// لقطة بدقة الحساس كاملة من نفس الكاميرا (ImageCapture: كروم/سامسونج على أندرويد). غير كده (آيفون) بناخد لقطة من الفيديو.
async function stillPhoto() {
  if (!window.ImageCapture || !track) return null;
  try {
    const ic = new window.ImageCapture(track);
    let opts = null;
    try { // أعلى دقة بيدعمها الجهاز، بسقف 4096 على أطول ضلع عشان الموبايلات الضعيفة (50/108 ميجا) ماتهنجش
      const pc = await ic.getPhotoCapabilities();
      if (pc && pc.imageWidth && pc.imageHeight) {
        const w = pc.imageWidth.max, h = pc.imageHeight.max, k = Math.min(1, 4096 / Math.max(w, h));
        opts = { imageWidth: Math.round(w * k), imageHeight: Math.round(h * k) };
      }
    } catch { /* نلتقط بالإعدادات الافتراضية */ }
    try { return await ic.takePhoto(opts || undefined); }
    catch { return await ic.takePhoto(); }
  } catch { return null; }
}
async function shoot() {
  if (shooting) return;
  if (!stream || !video.videoWidth) { say("الكاميرا لسه بتجهز. استنى ثانية وجرّب تاني.", true); return; }
  shooting = true; shotBtn.disabled = true;
  try {
    if (window.ImageCapture) say("بنصوّر بدقة كاملة… ثبّت الموبايل");
    let blob = await stillPhoto();
    if (!blob) {
      const cv = document.createElement("canvas"); cv.width = video.videoWidth; cv.height = video.videoHeight;
      const ctx = cv.getContext("2d"); if (!ctx) { say("تعذّر التقاط الصورة.", true); return; }
      ctx.drawImage(video, 0, 0, cv.width, cv.height);
      blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.92));
    }
    if (!blob) { say("تعذّر التقاط الصورة.", true); return; }
    stopCam(); say("");
    handle(new File([blob], "photo.jpg", { type: blob.type || "image/jpeg" }));
  } finally { shooting = false; if (stream) shotBtn.disabled = false; }
}
shotBtn.addEventListener("click", shoot);
retryBtn.addEventListener("click", startCam);
document.addEventListener("visibilitychange", () => { if (document.hidden) stopCam(); });

window.imageLeave = stopCam;
window.imagePage = () => {
  const pg = $("imgpage");
  if (window.__imgMode) { const m = window.__imgMode; window.__imgMode = null; setMode(m); } // دخول من زر «قراءة روشتة» أو «بحث بصورة»
  if (!built) {
    built = true;
    const c = el("div", "ip-card");
    c.append(modes2, camRow, galRow, el("p", "ip-tip", "صوّر العلبة من قدّام وبإضاءة كويسة، وخلّي الاسم والتركيز باينين. «كاميرا التليفون» بتفتح تطبيق الكاميرا الأصلي بأعلى دقة."));
    tipEl = c.querySelector(".ip-tip");
    if (tipEl) { TIPS.prod = tipEl.textContent; if (mode === "rx") tipEl.textContent = TIPS.rx; }
    pg.append(camBox, ipMsg, c);
  }
  say("");
  syncBar();
  startCam();
};
const rxBtn = el("button", "scan-btn img-pick rx-pick", "قراءة روشتة"); rxBtn.type = "button";
const openWith = (m) => { window.__imgMode = m; if (window.openImagePage) window.openImagePage(); else location.hash = "#/img"; };
imgBtn.addEventListener("click", () => openWith("prod"));
rxBtn.addEventListener("click", () => openWith("rx"));
$("f").append(imgBtn, rxBtn, camIn, galIn);
const busy = (v) => { imgBtn.disabled = v; rxBtn.disabled = v; };

// أي بحث مش جاي من الصورة بيمسح صندوق العائلة
$("f").addEventListener("submit", () => { if (!window.__keepImg) fam.replaceChildren(); }, true);

async function toJpegBase64(f, cap, ladder) {
  let src, w0, h0;
  try { src = await createImageBitmap(f, { imageOrientation: "from-image" }); w0 = src.width; h0 = src.height; }
  catch {
    src = await new Promise((res, rej) => { const u = URL.createObjectURL(f), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error("image_decode_failed")); }; im.src = u; });
    w0 = src.naturalWidth; h0 = src.naturalHeight;
  }
  if (!w0 || !h0) throw new Error("image_decode_failed");
  // بنبدأ بأعلى دقة، ولو حجم الصورة عدّى حد OCR بنقلّل الجودة ثم الأبعاد لحد ما تدخل تحت الحد
  const toB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = () => rej(new Error("image_read_failed")); fr.readAsDataURL(blob); });
  const cv = document.createElement("canvas"), g = cv.getContext("2d");
  let out = null;
  for (const [side, q] of (ladder || [[MAX_SIDE, 0.88], [MAX_SIDE, 0.78], [1700, 0.8], [1400, 0.78], [1280, 0.72]])) {
    const k = Math.min(1, side / Math.max(w0, h0));
    cv.width = Math.round(w0 * k); cv.height = Math.round(h0 * k);
    lastShot = { w: cv.width, h: cv.height };
    g.drawImage(src, 0, 0, cv.width, cv.height);
    const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", q));
    if (!blob) throw new Error("image_encode_failed");
    out = await toB64(blob);
    if (out.length <= (cap || OCR_B64_MAX)) break;
  }
  return out;
}

// صندوق "باقي منتجات نفس العائلة": الاسم متعبّي من الصورة وتقدر تغيّره (بنادول، سنترم...)
function famBox(family) {
  fam.replaceChildren();
  const b = el("div", "more-box");
  b.append(el("p", null, "عايز تشوف باقي منتجات نفس العائلة (بتراكيز وأشكال تانية)؟ اكتب اسم العائلة، مثل: بنادول أو سنترم."));
  const row = el("div", "row");
  const inp = el("input"); inp.type = "search"; inp.maxLength = 100; inp.value = (family && family.text) || "";
  inp.placeholder = "اسم العائلة"; inp.setAttribute("aria-label", "اسم العائلة التجارية"); inp.dir = "auto";
  const go = el("button", null, "ابحث في العائلة"); go.type = "button";
  const run = () => {
    const v = inp.value.trim();
    if (v.length < 2) { inp.focus(); return; }
    $("q").value = v;
    const radio = document.querySelector('input[name=t][value="brand_family"]'); if (radio) radio.checked = true;
    window.__keepImg = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
    $("f").requestSubmit();
  };
  go.addEventListener("click", run);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  row.append(inp, go); b.append(row); fam.append(b);
}

window.famBox = famBox; // search.js بيستخدمه بعد أي بحث عادي

// قائمة خطوات البحث بالصورة: الخطوة بتظهر بحركة لما دورها يجي، ولما تخلص بتفضل سطر واحد مختصر.
// الضغط على أي خطوة بيفتح تفاصيل اللي حصل فيها (ودي بيانات حقيقية من الرد، مش كلام ثابت).
function stepsUI() {
  const w = el("div", "img-steps"); w.setAttribute("role", "status"); w.setAttribute("aria-live", "polite");
  const items = {}; let cur = null;
  // بيظهر بس الخطوة الشغّالة دلوقتي. الباقي متخبّي، وزر صغير «عرض كل الخطوات» بيفتحهم لو عايز تشوف التفاصيل.
  const allBtn = el("button", "st-all", "عرض كل الخطوات"); allBtn.type = "button"; allBtn.hidden = true;
  allBtn.addEventListener("click", () => { const on = w.classList.toggle("all"); allBtn.textContent = on ? "إخفاء الخطوات السابقة" : "عرض كل الخطوات"; });
  w.append(allBtn);
  const add = (k) => {
    const li = el("div", "st pend"); li.hidden = true;
    const head = el("button", "st-h"); head.type = "button"; head.append(el("i"), el("span", "st-t"), el("b", "st-c"));
    const body = el("div", "st-b"); const inner = el("div", "st-bi"); body.append(inner);
    li.append(head, body);
    head.addEventListener("click", () => { if (li.classList.contains("has-d")) { const o = li.classList.toggle("open"); head.setAttribute("aria-expanded", o ? "true" : "false"); } });
    w.insertBefore(li, allBtn); items[k] = { li, head, inner };
  };
  const set = (k, state, text) => {
    const it = items[k]; if (!it) return;
    const was = it.li.className;
    it.li.className = "st " + state + (was.includes("has-d") ? " has-d" : "") + (was.includes(" open") ? " open" : "") + (was.includes(" gone") ? " gone" : "");
    if (it.li.hidden) { it.li.hidden = false; it.li.classList.add("in"); }
    if (state === "run") { Object.keys(items).forEach((x) => { if (x !== k) items[x].li.classList.add("gone"); }); it.li.classList.remove("gone"); }
    if (Object.values(items).filter((x) => !x.li.hidden).length >= 2) allBtn.hidden = false;
    if (text != null) it.head.querySelector(".st-t").textContent = text;
    if (state === "run") cur = k; else if (cur === k) cur = null;
  };
  // تفاصيل الخطوة: [[التسمية, القيمة], ...] والقيم الفاضية بتتشال
  const lines = (k, rows) => {
    const it = items[k]; if (!it) return;
    const rs = (rows || []).filter((r) => r && r[1] != null && String(r[1]).trim() !== "");
    it.inner.replaceChildren();
    rs.forEach(([l, v]) => { const d = el("div", "st-r"); d.append(el("span", "st-l", l), el("span", "st-v", String(v))); it.inner.append(d); });
    it.li.classList.toggle("has-d", rs.length > 0);
    it.head.setAttribute("aria-expanded", it.li.classList.contains("open") ? "true" : "false");
  };
  const fail = (text, rows) => { if (cur) { set(cur, "bad", text); if (rows) lines(cur, rows); } };
  return { w, add, set, lines, fail };
}

// ===== أقرب تركيز: لو مفيش مطابق تمامًا، بنرتّب باقي المنتجات بقرب تركيزها من المطلوب ونعرض الأقرب في الأول =====
const MASS = { mg: 1, g: 1000, mcg: 0.001, "µg": 0.001, "μg": 0.001, ug: 0.001 };
const normAmt = (v, u) => { u = String(u || "").toLowerCase().trim(); v = Number(v); return u in MASS ? { v: v * MASS[u], c: "mass" } : { v, c: u }; };
const reqAmts = (m, x) => {
  const src = (m && m.strength_checked && (m.required_strength || []).length) ? m.required_strength : String((x && x.strength) || "").split(/[+\/،,]| and /i);
  return src.map((s) => { const mm = String(s).toLowerCase().replace(",", ".").match(/(\d+(?:\.\d+)?)\s*(mg|mcg|µg|μg|ug|g|iu|ml|%)?/); return mm ? normAmt(mm[1], mm[2]) : null; }).filter((a) => a && a.v > 0);
};
const prodAmts = (p) => (p.product_ingredients || []).filter((pi) => pi.strength_value != null && Number(pi.strength_value) > 0).map((pi) => normAmt(pi.strength_value, pi.strength_unit));
function strengthGap(req, prod) {
  if (!req.length || !prod.length) return Infinity;
  const a = req.slice().sort((x, y) => x.v - y.v), b = prod.slice().sort((x, y) => x.v - y.v);
  let s = 4 * Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].c && b[i].c && a[i].c !== b[i].c) s += 8; // وحدتين مختلفتين (مثلًا % و mg)
    s += Math.abs(Math.log(Math.max(a[i].v, b[i].v) / Math.min(a[i].v, b[i].v)));
  }
  return s;
}
const strengthText = (p) => (p.product_ingredients || []).filter((pi) => pi.strength_value != null).map((pi) => fmtStrength(pi)).join(" + ");

const quiet = () => { $("status").className = ""; };                    // من غير شريط حالة: الخطوات هي اللي بتعرض التقدّم
const imgErr = (txt) => { hideSkeleton(); quiet(); toast("error", txt); }; // الخطأ بيظهر في الخطوة + تنبيه واحد
async function handle(f) {
  if (!f) return;
  if (mode === "rx") return handleRx(f);
  if (!/^image\//.test(f.type)) { imgErr("الملف ده مش صورة."); return; }
  const token = ++polling;
  clearMore(); box.replaceChildren(); fam.replaceChildren(); $("out").replaceChildren();
  busy(true); showSkeleton();
  const st = stepsUI(); st.add("prep"); st.add("read"); st.set("prep", "run", "جاري تجهيز الصورة…"); box.append(st.w);
  if (window.showResultsPage) window.showResultsPage("بحث بالصورة"); // من غيرها النتيجة بتتملي في صفحة مخفية
  const ffPrev = window.__ff; window.__ff = ""; // فلتر الشكل الدوائي مش بيأثر على البحث بالصورة
  try {
    const b64 = await toJpegBase64(f);
    if (token !== polling) return;
    st.set("prep", "done", "اتجهّزت الصورة");
    st.lines("prep", [["الأبعاد بعد التصغير", lastShot.w + " × " + lastShot.h + " بكسل"], ["الحجم المبعوت", Math.round(b64.length * 0.75 / 1024) + " كيلوبايت (JPEG)"], ["ملحوظة", "الصورة بتتصغّر وبتتبعت للقراءة بس، ومش بتتحفظ."]]);
    st.set("read", "run", "جاري قراءة نص الصورة…");
    const r = await call("drug-image-search", { image: b64, mime: "image/jpeg" });
    if (token !== polling) return;
    const x = r.extracted || {};
    const nm = x.brand_name || x.arabic_name || (x.active_ingredients || [])[0];
    st.set("read", "done", nm ? "اتقرا: " + nm + (x.strength ? " " + x.strength : "") : "اتقرا النص");
    st.lines("read", [["الاسم التجاري", x.brand_name], ["الاسم بالعربي", x.arabic_name], ["المادة الفعّالة", (x.active_ingredients || []).join("، ")], ["التركيز", x.strength || "مش مكتوب في الصورة"], ["الشكل الدوائي", x.dosage_form], ["الشركة", x.manufacturer], ["الباركود", r.barcode_read ? ((r.gtins || []).length ? r.gtins[0] + " (رقم المراجعة صحيح)" : "اتقرا بس رقم المراجعة مش مطابق") : "ما اتقراش"], ["علبة دواء؟", x.is_medicine_pack ? "أيوه" : "لأ"], ["تنبيه", "قراءة آلية للصورة وممكن تغلط في حرف أو رقم. قارن الاسم والتركيز بالعلبة نفسها قبل ما تعتمد على أي نتيجة."]]);
    if (!x.is_medicine_pack) { st.set("read", "bad", "مش باين في الصورة علبة دواء"); st.lines("read", [["اللي حصل", "القراءة خلصت بس مفيش علبة دواء واضحة في الصورة. صوّر العلبة من قدّام وبإضاءة كويسة."]]); imgErr("مش باين في الصورة علبة دواء. صوّر العلبة من قدّام وبإضاءة كويسة."); return; }
    if (!(r.gtins || []).length && !r.search) { st.set("read", "bad", "ما قدرناش نقرا اسم ولا باركود واضح"); st.lines("read", [["اللي حصل", "القراءة خلصت بس مفيش اسم ولا باركود واضح. جرّب صورة أقرب وأوضح."]]); imgErr("ما قدرناش نقرا اسم ولا باركود واضح من الصورة. جرّب صورة أقرب وأوضح."); return; }
    if (r.family) famBox(r.family);
    else if (r.search && r.search.type !== "ingredient") famBox({ text: r.search.text });

    // 1) باركود صحيح = نفس المنتج بالظبط
    if ((r.gtins || []).length) {
      st.add("bc"); st.set("bc", "run", "جاري فحص الباركود…");
      try {
        const d = await call("drug-barcode", { gtins: r.gtins });
        if (token !== polling) return;
        if (d.found > 0) {
          st.set("bc", "done", "اتعرف على المنتج من الباركود"); st.lines("bc", [["الباركود", (r.gtins || []).join("، ")], ["عدد المنتجات اللي لقيناها", d.found]]);
          const out = $("out");
          out.replaceChildren(el("h3", "sec", "نفس المنتج اللي في الصورة (" + d.found + ")"));
          if (d.ambiguous) out.append(el("div", "scan-msg warn", "الباركود ده مسجّل لأكتر من منتج في المصدر. راجع الاسم والحجم على العبوة."));
          (d.results || []).forEach((p) => out.append(card(p, 1)));
          quiet();
          return;
        }
        st.set("bc", "done", "الباركود مش موجود في القاعدة"); st.lines("bc", [["الباركود", (r.gtins || []).join("، ")], ["النتيجة", "مش مسجّل في قاعدة البيانات، فكمّلنا بالبحث بالاسم."]]);
      } catch { st.set("bc", "done", "تعذّر فحص الباركود"); st.lines("bc", [["النتيجة", "حصلت مشكلة في فحص الباركود، فكمّلنا بالبحث بالاسم."]]); /* نكمّل بالاسم */ }
    }

    // 2) الاسم + التركيز + الشكل: الباك اند حدّد مين هو نفس المنتج، ومخفي أي تركيز أو شكل مختلف
    if (!r.search) { st.add("nm"); st.set("nm", "bad", "مفيش اسم واضح نبحث بيه"); st.lines("nm", [["اللي حصل", "الباركود مش موجود في القاعدة ومفيش اسم واضح في الصورة."]]); imgErr("الباركود المقروء مش موجود في قاعدة البيانات، ومفيش اسم واضح في الصورة نبحث بيه."); return; }
    st.add("srch"); st.add("match"); st.set("srch", "run", "جاري البحث عن «" + r.search.text + "»…");
    const d = await call("drug-search", { query: r.search.text, search_type: r.search.type === "ingredient" ? "ingredient" : "brand" });
    if (token !== polling) return;
    st.set("srch", "done", "البحث عن «" + r.search.text + "» خلص");
    st.lines("srch", [["الاستعلام", r.search.text], ["نوع البحث", r.search.type === "ingredient" ? "مادة فعّالة" : "اسم تجاري"], ["عدد النتايج اللي رجعت", ((d.tiers && d.tiers.official) || d.results || []).length]]);
    st.set("match", "run", "جاري مطابقة الاسم والتركيز والشكل…");
    const list = (d.tiers && d.tiers.official) || d.results || [];
    const m = r.match || {};
    const out = $("out"); out.replaceChildren();

    if (!Array.isArray(m.exact_ids)) {
      st.set("match", "bad", "ما قدرناش نتحقق من التركيز والشكل"); st.lines("match", [["اللي حصل", "التحقق من التركيز والشكل ماتمّش، فالنتايج ممكن تكون لمنتجات مشابهة. قارنها بالعلبة."]]);
      out.append(el("div", "scan-msg warn", "ما قدرناش نتحقق من التركيز والشكل، فالنتايج دي ممكن تكون لمنتجات مشابهة. قارنها بالعلبة."));
      list.forEach((p) => out.append(card(p, 1)));
      quiet();
      return;
    }
    const ex = new Set(m.exact_ids), un = new Set(m.unverified_ids || []);
    let closest = [];
    const exact = list.filter((p) => ex.has(p.dwaprices_id));
    const unv = list.filter((p) => un.has(p.dwaprices_id));
    if (exact.length) {
      out.append(el("h3", "sec", "نفس المنتج اللي في الصورة (" + exact.length + ")"));
      out.append(el("p", "sec-note", "نفس الاسم" + (m.strength_checked ? " والتركيز (" + (m.required_strength || []).join(" + ") + ")" : "") + " والشكل الدوائي."));
      exact.forEach((p) => out.append(card(p, 1)));
    } else {
      out.append(el("div", "scan-msg warn", "ما لقيناش في السجل نفس المنتج بنفس التركيز والشكل."));
      // أقرب تركيز في الأول
      const req = reqAmts(m, x);
      closest = list.filter((p) => !ex.has(p.dwaprices_id) && !un.has(p.dwaprices_id))
        .map((p) => ({ p, g: strengthGap(req, prodAmts(p)) })).filter((o) => isFinite(o.g)).sort((a, b) => a.g - b.g).slice(0, 3);
      if (closest.length) {
        out.append(el("h3", "sec", "أقرب تركيز لقيناه (" + closest.length + ")"));
        out.append(el("p", "sec-note", "التركيز المطلوب: " + ((m.required_strength && m.required_strength.length ? m.required_strength.join(" + ") : x.strength) || "؟") + ". ده أقرب تركيز متاح في السجل، لكنه مش نفس التركيز. قارنه بالعلبة."));
        closest.forEach((o) => out.append(card(o.p, 3)));
      }
    }
    if (unv.length) {
      out.append(el("h3", "sec", "نفس الاسم لكن التركيز مش مكتوب في السجل (" + unv.length + ")"));
      out.append(el("p", "sec-note", "مش قادرين نأكد إنه نفس التركيز. قارنه بالعلبة."));
      unv.forEach((p) => out.append(card(p, 3)));
    }
    st.set("match", "done", exact.length ? "لقينا " + exact.length + " مطابق بنفس الاسم والتركيز والشكل" : closest.length ? "مفيش مطابق، أقرب تركيز: " + (strengthText(closest[0].p) || "—") : "ما لقيناش مطابق بنفس التركيز والشكل");
    st.lines("match", [["التركيز المطلوب", m.strength_checked ? (m.required_strength || []).join(" + ") : "مش متحقق منه"], ["مطابق تمامًا", exact.length], ["أقرب تركيز (لو مفيش مطابق)", closest.length ? closest.map((o) => (o.p.product_name || "") + " — " + strengthText(o.p)).join(" | ") : ""], ["نفس الاسم والتركيز مش مسجّل", unv.length], ["اتخفّى لاختلاف التركيز أو الشكل أو النوع", m.hidden_count || 0]]);
    if (m.hidden_count > 0) out.append(el("p", "sec-note", "اتخفّى " + m.hidden_count + " منتج بنفس العائلة بتركيز أو شكل أو نوع مختلف. تقدر تشوفهم من البحث بالعائلة تحت."));
    quiet();
  } catch (err) {
    st.fail("حصلت مشكلة في الخطوة دي", [["كود الخطأ", (err && (err.code || err.message)) || "unknown"]]);
    const gw = err && err.data && err.data.gateway_error;
    const known = ERR[err && err.code];
    imgErr(known || "حصلت مشكلة في قراءة الصورة (" + ((err && (err.code || err.message)) || "unknown") + (gw ? " / " + gw : "") + ").");
  } finally { window.__ff = ffPrev; busy(false); }
}

// ===== وضع الروشتة: نفس الكاميرا والمعرض، بس الصورة بتتبعت لدالة read-prescription وبتتعرض الأسطر المقروءة مع حالة المطابقة. =====
const RX_ST = { matched: ["مطابق في السجل", "ok"], uncertain: ["محتاج مراجعة", "warn"], no_match: ["مش لاقيينه في السجل", "bad"] };
const RX_SC = { exact: "الاسم والتركيز المكتوب مطابقين لمنتج واحد في السجل.", ambiguous: "أكتر من منتج في السجل بنفس الاسم والتركيز. راجع الشكل والحجم.", partial: "التركيز المكتوب موجود في تركيبة أو أكتر من منتج. راجع المنتج الصح.", dose_not_found: "التركيز المكتوب مش موجود في السجل لنفس الاسم. راجع الروشتة.", no_dose: "مفيش تركيز مقروء نقارن بيه، فالمطابقة بالاسم بس." };
const RX_LEG = { good: "واضح", medium: "متوسط", poor: "ضعيف" };
(() => { const s = document.createElement("style");
  s.textContent = ".rx-block{margin-bottom:18px}.rx-prods{margin-top:8px;display:grid;gap:10px}.rx-prods .card{margin:0}.rx-auto{margin-top:8px;display:grid;gap:10px}.rx-sug-b{cursor:pointer;font:inherit;border:1px solid var(--line);background:transparent;color:var(--text)}.rx-item h2{overflow-wrap:anywhere}.rx-item .rx-go{margin-top:10px}"
    + ".qs .scan-btn.rx-pick::before{-webkit-mask-image:var(--ic-rx);mask-image:var(--ic-rx)}"
    + ":root{--ic-rx:url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M14%202H6a2%202%200%200%200-2%202v16a2%202%200%200%200%202%202h12a2%202%200%200%200%202-2V8z'/%3E%3Cpath%20d='M14%202v6h6M8%2013h8M8%2017h8M8%209h2'/%3E%3C/svg%3E\")}"
    + ".ip-hint{position:absolute;inset-inline:16px;bottom:100px;z-index:2;padding:7px 12px;border-radius:12px;background:rgba(0,0,0,.55);color:#fff;font-size:13px;text-align:center;pointer-events:none}"
    + ".ip-cam.off .ip-hint{display:none}.ip-cam.rx .ip-frame{inset:7% 4% 21%}"
    + ".ip-card .ip-modes{position:static;inset:auto;margin:0 0 12px;gap:8px;pointer-events:auto;justify-content:center}"
    + ".ip-card .ip-mode{flex:1 1 0;max-width:180px;height:40px;font-size:14px;justify-content:center;color:var(--text);border:1px solid var(--line);background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none}"
    + ".ip-card .ip-mode.on{background:var(--accent);color:var(--accent-ink,#fff);border-color:var(--accent)}";
  document.head.append(s); })();

function rxCard(it) {
  const c = el("article", "card rx-item");
  const h = el("h2", null, it.read_name || "سطر غير مقروء"); h.dir = "auto"; c.append(h);
  const bits = [["الجرعة", it.dose], ["التكرار", it.frequency], ["المدة", it.duration]].filter((x) => x[1]);
  if (bits.length) {
    const ul = el("ul", "ing");
    bits.forEach(([l, v]) => { const li = el("li"); const sv = el("span", null, v); sv.dir = "auto"; li.append(el("span", null, l), sv); ul.append(li); });
    c.append(ul);
  }
  if (it.notes_ar) c.append(el("div", "meta", "ملاحظة: " + it.notes_ar));
  const chips = el("div", "chips");
  const [t, cls] = RX_ST[it.match_status] || RX_ST.no_match;
  chips.append(el("span", "chip " + cls, t));
  if (it.unclear) chips.append(el("span", "chip warn", "جزء من السطر مش واضح"));
  if (typeof it.confidence === "number") chips.append(el("span", "chip", "ثقة القراءة: " + Math.round(it.confidence * 100) + "%"));
  c.append(chips);
  const cd = it.candidate;
  if (cd) {
    const nm = [cd.name, cd.name_ar].filter(Boolean).join(" — ");
    if (nm) { const m = el("div", "meta", "أقرب منتج في السجل: " + nm + (cd.scientific_name ? " (" + cd.scientific_name + ")" : "")); m.dir = "auto"; c.append(m); }
    if (RX_SC[cd.strength_check]) c.append(el("div", "meta", RX_SC[cd.strength_check]));
  }
  const q = String(it.read_name || "").trim();
  if (q.length >= 2) {
    const b = el("button", "rx-go", "ابحث عن الدواء"); b.type = "button";
    b.addEventListener("click", () => {
      $("q").value = q;
      const radio = document.querySelector('input[name=t][value="brand"]'); if (radio) radio.checked = true;
      window.scrollTo({ top: 0, behavior: "smooth" });
      $("f").requestSubmit();
    });
    c.append(b);
  }
  return c;
}

// ===== منتجات فعلية لكل دواء في الروشتة: بحث بالاسم + مطابقة التركيز (مطابق تمامًا فقط، وإلا أقرب تركيز بتنبيه واضح) =====
const RX_AMT = /(\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)*)\s*(mg|mcg|µg|μg|ug|gm|g|iu|ml|%)(?![a-z])/gi;
function rxAmts(text) { // أرقام التركيز اللي وراها وحدة بس (عدد الأقراص في العبوة مش بيتحسب)، الكتلة بتتحوّل لـ mg
  const out = []; if (!text) return out;
  String(text).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(RX_AMT, (_m, nums, u) => {
    u = u.toLowerCase(); if (u === "gm") u = "g";
    nums.split("/").forEach((n) => { const a = normAmt(Number(n.replace(",", ".").trim()), u); if (a.v > 0) out.push(a); });
    return _m;
  });
  return out;
}
const sameAmts = (a, b) => { if (a.length !== b.length) return false; const x = a.slice().sort((p, q) => p.v - q.v), y = b.slice().sort((p, q) => p.v - q.v); return x.every((v, i) => v.c === y[i].c && Math.abs(v.v - y[i].v) < 1e-6); };
const rxBrand = (n) => String(n || "").replace(RX_AMT, " ").replace(/\b(tabs?|tablets?|caps?|capsules?|syrup|susp(?:ension)?|drops?|cream|gel|oint(?:ment)?|amps?|ampoules?|inj(?:ection)?|sachets?|supp(?:ositories)?|spray|f\.?c\.?|film|coated)\b\.?/gi, " ").replace(/\b\d+\b/g, " ").replace(/(^|\s)[\/+.,]+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
// جرعة مكتوبة رقم من غير وحدة (زي "75 tab" أو "40"): بنفترضها mg لو الرقم 5 فأكتر (1-4 غالبًا عدد أقراص)
function rxNeed(it) {
  let a = rxAmts(it.dose); if (!a.length) a = rxAmts(it.read_name);
  if (a.length) return { amts: a, assumed: false };
  const m = String(it.dose || "").replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).match(/^\s*(\d+(?:[.,]\d+)?)\s*(?:tabs?|tablets?|caps?|capsules?|قرص|اقراص|أقراص|كبسول\w*)?\s*$/i);
  if (m) { const n = Number(m[1].replace(",", ".")); if (n >= 5) return { amts: [{ v: n, c: "mass" }], assumed: true }; }
  return { amts: [], assumed: false };
}
// مجموعة الشكل الدوائي: صلب (أقراص/كبسول) / سائل / حقن / موضعي. لو المكتوب والمنتج في مجموعتين مختلفتين نعتبره شكل مختلف.
const RX_FORMS = [["inj", /\b(amps?|ampoules?|vials?|inj(?:ection)?)\b|امبول|أمبول|حقن/i], ["liquid", /\b(syrup|susp(?:ension)?|drops?|solution)\b|شراب|معلق|قطر/i], ["topical", /\b(cream|gel|oint(?:ment)?|lotion)\b|كريم|جل|مرهم/i], ["solid", /\b(tabs?|tablets?|caps?|capsules?)\b|قرص|اقراص|أقراص|كبسول/i]];
const rxForm = (t) => { for (const [k, r] of RX_FORMS) if (r.test(String(t || ""))) return k; return null; };
const prodAmtsAll = (p) => { const n = rxAmts(p.product_name); return n.length ? n : prodAmts(p); }; // الاسم الأول (بيشيل لبس العبوات) وبعدين التركيبة المسجّلة

// «قصدك؟»: أقرب أسماء حقيقية من جدول الأدوية المصرية (دالة drug-name-fuzzy)، وبعدها اقتراحات السجل، وبعدها أسماء بتبدأ بنفس أول 4 حروف.
// لو أقرب اسم تشابهه عالي (75٪ فأكتر) بنعرض منتجاته تلقائيًا بتنبيه إنه تخمين. غير كده بنعرض الأسماء للاختيار بس.
const RX_AUTO_MIN = 0.75;
async function rxSuggest(brand, d, it, box, token, auto) {
  let cands = [];
  try {
    const f = await call("drug-name-fuzzy", { name: brand });
    if (token !== polling) return;
    cands = (((f.results || [])[0] || {}).suggestions || []).map((x) => ({ n: x.brand, sci: x.scientific_name, s: Number(x.score) || 0 }));
  } catch { /* نكمّل بباقي المصادر */ }
  if (!cands.length) {
    (d && Array.isArray(d.suggestions) ? d.suggestions : []).filter((x) => x && x.search_type !== "ingredient").forEach((x) => { const n = String(x.text || "").trim(); if (n) cands.push({ n, sci: null, s: 0 }); });
  }
  if (!cands.length && brand.replace(/[^a-z]/gi, "").length >= 4) {
    try {
      const pre = brand.replace(/[^a-z]/gi, "").slice(0, 4);
      const r = await call("drug-search", { query: pre, search_type: "brand" });
      if (token !== polling) return;
      ((r.tiers && r.tiers.official) || r.results || []).forEach((p) => { const n = rxBrand(p.product_name); if (n) cands.push({ n, sci: null, s: 0 }); });
    } catch { /* مفيش اقتراحات */ }
  }
  const seen = new Set([brand.toLowerCase()]), uniq = [];
  cands.forEach((c) => { const k = c.n.toLowerCase(); if (c.n.length >= 2 && !seen.has(k)) { seen.add(k); uniq.push(c); } });
  if (!uniq.length) return;
  const top = uniq[0];
  const w = el("div", "rx-sug");
  w.append(el("p", "sec-note", "قصدك واحد من الأسماء دي؟ (القراءة ممكن تكون غلطت في حرف)"));
  const row = el("div", "chips");
  uniq.slice(0, 6).forEach((c) => {
    const b = el("button", "chip rx-sug-b", c.n + (c.s ? " · " + Math.round(c.s * 100) + "٪" : "")); b.type = "button"; b.dir = "ltr";
    b.addEventListener("click", () => fillRxProducts(it, box, token, { name: c.n, sci: c.sci, auto: true }));
    row.append(b);
  });
  w.append(row); box.append(w);
  if (!auto && top.s >= RX_AUTO_MIN) {
    const sub = el("div", "rx-auto");
    sub.append(el("div", "scan-msg warn", "تخمين: أقرب اسم في سجل الأدوية لـ «" + brand + "» هو «" + top.n + "» (تشابه " + Math.round(top.s * 100) + "٪). مش مؤكد إنه نفس الدواء، راجعه مع الصيدلي."));
    const pb = el("div", "rx-prods"); sub.append(pb); box.append(sub);
    await fillRxProducts(it, pb, token, { name: top.n, sci: top.sci, auto: true });
  }
}

async function fillRxProducts(it, box, token, opt) {
  opt = opt || {};
  const brand = opt.name || rxBrand(it.read_name);
  if (brand.length < 2) { box.remove(); return; }
  const nd = rxNeed(it), need = nd.amts, wantForm = rxForm((it.dose || "") + " " + (it.read_name || ""));
  const formOk = (p) => { const pf = rxForm((p.product_name || "") + " " + (p.dosage_form || "")); return !wantForm || !pf || pf === wantForm; };
  box.replaceChildren(el("div", "meta", "جاري البحث عن «" + brand + "»…"));
  try {
    let d = await call("drug-search", { query: brand, search_type: "brand" });
    if (token !== polling) return;
    let list = (d.tiers && d.tiers.official) || d.results || [];
    let note = "";
    if (!list.length && opt.sci) { // الاسم التجاري مش في دليل الأسعار: نجرّب بالمادة الفعّالة
      const ing = String(opt.sci).split("+")[0].trim();
      if (ing) {
        const d2 = await call("drug-search", { query: ing, search_type: "ingredient" });
        if (token !== polling) return;
        list = (d2.tiers && d2.tiers.official) || d2.results || [];
        if (list.length) note = "«" + brand + "» مش موجود في دليل الأسعار، فدي منتجات بنفس المادة الفعّالة (" + ing + "):";
      }
    }
    box.replaceChildren();
    if (note) box.append(el("p", "sec-note", note));
    if (!list.length) { box.append(el("div", "scan-msg warn", "ما لقيناش «" + brand + "» في السجل.")); await rxSuggest(brand, d, it, box, token, opt.auto); return; }
    if (!need.length) {
      const pref = list.filter(formOk), shown = (pref.length ? pref : list).slice(0, 3);
      box.append(el("p", "sec-note", "التركيز مش مكتوب في الروشتة، فمش قادرين نأكد التركيز. دي أقرب نتايج بالاسم" + (wantForm && !pref.length ? " (ومفيش منها بالشكل المكتوب)" : "") + "، راجع الصيدلي."));
      shown.forEach((p) => box.append(card(p, 3)));
      return;
    }
    const sameS = list.filter((p) => sameAmts(need, prodAmtsAll(p)));
    const exact = sameS.filter(formOk), otherForm = sameS.filter((p) => !formOk(p));
    if (nd.assumed) box.append(el("p", "sec-note", "الجرعة مكتوبة «" + it.dose + "» من غير وحدة، فافترضنا إن الرقم بالـ mg."));
    if (exact.length) {
      box.append(el("p", "sec-note", "نفس الاسم والتركيز المكتوب (" + need.map((a) => a.v).join(" + ") + (nd.assumed ? " mg" : "") + (wantForm ? " والشكل" : "") + ") — " + exact.length + " منتج."));
      exact.slice(0, 5).forEach((p) => box.append(card(p, 1)));
      return;
    }
    if (otherForm.length) {
      box.append(el("div", "scan-msg warn", "لقينا «" + brand + "» بنفس التركيز لكن بشكل دوائي مختلف عن المكتوب (" + (it.dose || it.read_name) + "). مش نفس المنتج غالبًا:"));
      otherForm.slice(0, 3).forEach((p) => box.append(card(p, 3)));
      return;
    }
    const closest = list.map((p) => ({ p, g: strengthGap(need, prodAmtsAll(p)) })).filter((o) => isFinite(o.g)).sort((x, y) => x.g - y.g).slice(0, 2);
    box.append(el("div", "scan-msg warn", "ما لقيناش «" + brand + "» بنفس التركيز المكتوب (" + need.map((a) => a.v).join(" + ") + (nd.assumed ? " mg" : "") + ")."));
    if (closest.length) { box.append(el("p", "sec-note", "أقرب تركيز متاح — مش نفس التركيز المطلوب:")); closest.forEach((o) => box.append(card(o.p, 3))); }
    if (!closest.length) await rxSuggest(brand, d, it, box, token, opt.auto);
  } catch (err) {
    box.replaceChildren(el("div", "scan-msg warn", "تعذّر البحث عن «" + brand + "». جرّب زر «ابحث عن الدواء»."));
  }
}

async function handleRx(f) {
  if (!/^image\//.test(f.type)) { imgErr("الملف ده مش صورة."); return; }
  const token = ++polling;
  clearMore(); box.replaceChildren(); fam.replaceChildren(); $("out").replaceChildren();
  busy(true); showSkeleton();
  const st = stepsUI(); st.add("prep"); st.add("read"); st.set("prep", "run", "جاري تجهيز صورة الروشتة…"); box.append(st.w);
  if (window.showResultsPage) window.showResultsPage("قراءة روشتة");
  try {
    const b64 = await toJpegBase64(f, RX_B64_MAX, RX_SIDES);
    if (token !== polling) return;
    st.set("prep", "done", "اتجهّزت الصورة");
    st.lines("prep", [["الأبعاد بعد التصغير", lastShot.w + " × " + lastShot.h + " بكسل"], ["الحجم المبعوت", Math.round(b64.length * 0.75 / 1024) + " كيلوبايت (JPEG)"], ["ملحوظة", "الصورة نفسها مش بتتحفظ. الأسطر المقروءة بتتسجّل لمراجعة الصيدلي."]]);
    st.set("read", "run", "جاري قراءة الروشتة…");
    const r = await call("read-prescription", { image_base64: b64, mime_type: "image/jpeg" });
    if (token !== polling) return;
    const items = Array.isArray(r.items) ? r.items : [];
    if (!items.length) {
      st.set("read", "bad", "مش باين في الصورة أسطر روشتة مقروءة");
      st.lines("read", [["اللي حصل", "القراءة خلصت بس مفيش أسماء أدوية مقروءة. صوّر الروشتة كاملة وبإضاءة كويسة."]]);
      imgErr("مفيش أسماء أدوية مقروءة في الصورة. صوّر الروشتة كاملة وبإضاءة كويسة.");
      return;
    }
    const matched = items.filter((x) => x.match_status === "matched").length;
    st.set("read", "done", "اتقرا " + items.length + " سطر، " + matched + " مطابق في السجل");
    st.lines("read", [["عدد الأسطر", items.length], ["مطابق في السجل", matched], ["وضوح الخط", RX_LEG[r.overall_legibility] || ""], ["تنبيه", "قراءة آلية وممكن تغلط في حرف أو رقم. كل سطر محتاج مراجعة صيدلي قبل الصرف."]]);
    const out = $("out"); out.replaceChildren(); hideSkeleton();
    out.append(el("h3", "sec", "الأدوية المقروءة من الروشتة (" + items.length + ")"));
    out.append(el("div", "scan-msg warn", "القراءة آلية وممكن تغلط في حرف أو رقم، وكل سطر محتاج مراجعة صيدلي قبل الصرف. قارنها بالروشتة الأصلية."));
    if (r.overall_legibility === "poor") out.append(el("div", "scan-msg warn", "الخط مش واضح، فالقراءة غالبًا ناقصة أو غلط. جرّب تصوّر الروشتة تاني بإضاءة أحسن."));
    const boxes = items.map((it) => { const w = el("section", "rx-block"), pb = el("div", "rx-prods"); w.append(rxCard(it), pb); out.append(w); return { it, pb }; });
    { let i = 0; const worker = async () => { while (i < boxes.length && token === polling) { const o = boxes[i++]; await fillRxProducts(o.it, o.pb, token); } }; Promise.all([worker(), worker(), worker()]); } // 3 بحث في نفس الوقت
    quiet();
  } catch (err) {
    st.fail("حصلت مشكلة في الخطوة دي", [["كود الخطأ", (err && (err.code || err.message)) || "unknown"]]);
    const known = ERR[err && err.code];
    imgErr(known || "حصلت مشكلة في قراءة الروشتة (" + ((err && (err.code || err.message)) || "unknown") + ").");
  } finally { busy(false); }
}

[camIn, galIn].forEach((inp) => inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.value = ""; handle(f); }));
})();
