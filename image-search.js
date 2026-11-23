/* image-search.js — البحث بصورة المنتج: كاميرا أو معرض. النتيجة = نفس المنتج في الصورة بنفس التركيز والشكل
   (الفلترة في الباك اند: match.exact_ids).
   بيعتمد على: core.js, render.js (card), search.js (polling, clearMore), وكلاس .scan-btn من scanner.js. */
(() => {
"use strict";
const MAX_SIDE = 2048; // أكبر ضلع للصورة قبل الإرسال (كان 1280): الخط الصغير على العلبة (التركيز) بيفضل مقروء
const OCR_B64_MAX = 1300000; // OCR.space المجاني بيقبل لحد حوالي 1 ميجا: فوق كده بيتخطّى والقراءة بتتم بـ Gemini بس، فبنضغط الصورة لتحت الحد ده
let lastShot = { w: 0, h: 0 };
const RX_B64_MAX = 1200000; // صورة أصغر = رفع أسرع وقراءة أسرع من جوجل (كانت 3300000)
const RX_SIDES = [[1800, 0.82], [1600, 0.78], [1400, 0.74], [1200, 0.7]];
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
const TIPS = { prod: "", rx: "صوّر الروشتة كاملة من فوق وبإضاءة كويسة، وخلّي كل الأسطر باينة من غير ضل. القراءة آلية وممكن تغلط في اسم أو رقم، فاقرأ وراجع الجرعة والشكل الدوائي قبل الصرف." };
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
          if (d.ambiguous) out.append(el("div", "scan-msg warn", "الباركود لأكتر من منتج، راجع العبوة."));
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
      out.append(el("div", "scan-msg warn", "التركيز والشكل ما اتأكدوش، قارن بالعلبة."));
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
      out.append(el("p", "sec-note ok", "نفس الاسم" + (m.strength_checked ? " والتركيز (" + (m.required_strength || []).join(" + ") + ")" : "") + " والشكل الدوائي."));
      exact.forEach((p) => out.append(card(p, 1)));
    } else {
      out.append(el("div", "scan-msg warn", "مفيش نفس التركيز والشكل في السجل."));
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
  s.textContent = ".rx-block{margin-bottom:18px;scroll-margin-top:120px}.rx-item{display:block!important;border:1px solid var(--line);border-inline-start:5px solid var(--line);padding:16px 16px 14px}.rx-item.st-ok{border-inline-start-color:var(--ok)}.rx-item.st-warn{border-inline-start-color:var(--warn)}.rx-item.st-bad{border-inline-start-color:var(--bad)}.rx-head{display:flex;align-items:center;gap:12px;margin-bottom:6px}.rx-head h2{margin:0;flex:1;min-width:0}.rx-crop{margin:0 0 12px}.rx-crop small{display:block;font-size:12.5px;color:var(--muted);margin:0 2px 5px}.rx-crop canvas{display:block;width:100%;height:auto;max-height:140px;object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:10px}.rx-num{flex:none;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--accent);color:var(--accent-ink,#fff);font-weight:700;font-size:16px;font-variant-numeric:tabular-nums}.rx-item .chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px}.rx-item .rx-go{width:100%;height:42px;border-radius:12px;border:1px solid var(--accent);background:transparent;color:var(--accent);font:inherit;font-weight:600;cursor:pointer}.rx-cmp{position:relative;margin:12px 0;background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:0 4px 18px rgba(20,90,160,.18);overflow:hidden}.rx-cmp-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px;font-size:13.5px;font-weight:600;color:var(--muted)}.rx-cmp-h button{font:inherit;font-size:13px;border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:999px;padding:3px 12px;cursor:pointer}.rx-cmp img{display:block;width:100%;height:auto;max-height:none;object-fit:contain;background:#fff;cursor:crosshair;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-user-drag:none}.rx-lens{position:fixed;left:0;top:0;width:300px;height:170px;border-radius:10px;border:3px solid #fff;box-shadow:0 6px 24px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.25);background-color:#fff;background-repeat:no-repeat;pointer-events:none;z-index:1000;will-change:transform}.rx-lens::after{content:\"\";position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;border:1.5px solid rgba(220,30,30,.85);box-sizing:border-box}.rx-cmp.min img{display:none}.rx-prods{margin-top:8px;display:grid;gap:10px}.rx-prods .card{margin:0}.rx-auto{margin-top:8px;display:grid;gap:10px}.rx-sug-b{cursor:pointer;font:inherit;border:1px solid var(--line);background:transparent;color:var(--text)}.rx-item h2{overflow-wrap:anywhere}.rx-item .rx-go{margin-top:10px}"
    + ".qs .scan-btn.rx-pick::before{-webkit-mask-image:var(--ic-rx);mask-image:var(--ic-rx)}"
    + ":root{--ic-rx:url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M14%202H6a2%202%200%200%200-2%202v16a2%202%200%200%200%202%202h12a2%202%200%200%200%202-2V8z'/%3E%3Cpath%20d='M14%202v6h6M8%2013h8M8%2017h8M8%209h2'/%3E%3C/svg%3E\")}"
    + ".ip-hint{position:absolute;inset-inline:16px;bottom:100px;z-index:2;padding:7px 12px;border-radius:12px;background:rgba(0,0,0,.55);color:#fff;font-size:13px;text-align:center;pointer-events:none}"
    + ".ip-cam.off .ip-hint{display:none}.ip-cam.rx .ip-frame{inset:7% 4% 21%}"
    + ".ip-card .ip-modes{position:static;inset:auto;margin:0 0 12px;gap:8px;pointer-events:auto;justify-content:center}"
    + ".ip-card .ip-mode{flex:1 1 0;max-width:180px;height:40px;font-size:14px;justify-content:center;color:var(--text);border:1px solid var(--line);background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none}"
    + ".ip-card .ip-mode.on{background:var(--accent);color:var(--accent-ink,#fff);border-color:var(--accent)}";
  document.head.append(s); })();

function rxCrop(it) { // الاسم المكتوب بخط اليد مقصوص من صورة الروشتة. القص بيتم على جهازك بس.
  const b = it && it.name_box;
  if (!Array.isArray(b) || b.length !== 4 || !rxImgUrl || b.some((x) => !Number.isFinite(Number(x)))) return null;
  const wrap = el("div", "rx-crop"), cv = document.createElement("canvas");
  const cap = el("div", "rx-crop-h"), hint = el("b"); // عنوان صغير + تلميح إن القصاصة بتفتح الروشتة
  hint.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'; hint.append("عرض الروشتة كاملة");
  cap.append(el("span", null, "المكتوب في الروشتة"), hint);
  wrap.className += " tap"; wrap.tabIndex = 0; wrap.setAttribute("role", "button"); wrap.setAttribute("aria-label", "افتح الروشتة كاملة مع تحديد مكان الاسم");
  const open = () => rxViewer(b);
  wrap.addEventListener("click", open); wrap.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  wrap.append(cap, cv);
  const im = new Image();
  im.onload = () => {
    const nw = im.naturalWidth, nh = im.naturalHeight; if (!nw || !nh) { wrap.remove(); return; }
    let [y0, x0, y1, x1] = b.map(Number);
    const px = Math.max(18, (x1 - x0) * 0.18), py = Math.max(14, (y1 - y0) * 0.45); // هامش حوالين الاسم عشان ما يتقصش الحرف
    x0 = Math.max(0, x0 - px); x1 = Math.min(1000, x1 + px); y0 = Math.max(0, y0 - py); y1 = Math.min(1000, y1 + py);
    const sx = (x0 / 1000) * nw, sy = (y0 / 1000) * nh, sw = Math.max(8, ((x1 - x0) / 1000) * nw), sh = Math.max(8, ((y1 - y0) / 1000) * nh);
    const k = Math.min(1, 1000 / sw); cv.width = Math.round(sw * k); cv.height = Math.round(sh * k);
    cv.getContext("2d").drawImage(im, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  };
  im.onerror = () => wrap.remove();
  im.src = rxImgUrl;
  return wrap;
}
// ===== شكل نتيجة الروشتة: شريط أزرق بالرقم واسم الدواء، وتحته صف منتجات بالعرض (اسحب يمين وشمال لو فيه أكتر من تركيز) =====
function rxBand(it, n) {
  const w = el("div", "rx-band");
  const num = el("span", "rx-num", "Rx" + (n || it.line_no || "")); num.setAttribute("aria-label", "دواء رقم " + (n || it.line_no || ""));
  const h = el("h2", null, it.read_name || "سطر غير مقروء"); h.dir = "auto";
  const [t, cls] = RX_ST[it.match_status] || RX_ST.no_match;
  const st = el("span", "rx-st " + cls, it.unclear || hasWild(it.read_name) ? "راجع الاسم" : t); st.title = st.textContent; st.setAttribute("aria-label", st.textContent);
  w.append(num, h, st);
  return w;
}
// أسهم التنقل: السابق "<" على الشمال، والتالي ">" على اليمين
const RX_ICO = { prev: "M15 6l-6 6 6 6", next: "M9 6l6 6-6 6" };
const rxArrow = (kind, label, extra) => { const b = el("button", "rx-arr" + (extra ? " " + extra : "")); b.type = "button"; b.setAttribute("aria-label", label); b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + RX_ICO[kind] + '"/></svg>'; return b; };
// الشريط بحجم ثابت على السطر، وعلى نفس الخط: السابق على الشمال والتالي على اليمين (الأسهم بتظهر بس لو فيه أكتر من Rx، والتنقل بيتم في rxPager)
function rxHead(band) {
  const head = el("div", "rx-head");
  const go = (d) => () => head.dispatchEvent(new CustomEvent("rxgo", { bubbles: true, detail: d }));
  const prev = rxArrow("prev", "الدواء السابق", "rx-harr rx-hprev"), next = rxArrow("next", "الدواء التالي", "rx-harr rx-hnext");
  prev.addEventListener("click", go(-1)); next.addEventListener("click", go(1));
  head.append(prev, band, next);
  return head;
}
const rxStrengthOf = (p) => {
  const ings = p.product_ingredients || [];
  if (ings.length && ings.every((pi) => pi.strength_value != null)) return ings.map(fmtStrength).join(" + ");
  return String(p.strength || "").trim();
};
const rxStrengthNum = (p) => { const m = rxStrengthOf(p).match(/\d+(?:[.,]\d+)?/); return m ? parseFloat(m[0].replace(",", ".")) : Infinity; };
function rxTile(p, tier) {
  const t = el("button", "rx-tile" + (tier === 3 ? " rx-near" : "")); t.type = "button";
  const pic = el("div", "rx-pic");
  const u = (() => { try { const x = new URL(p.image && p.image.url); return x.protocol === "https:" ? x.href : null; } catch { return null; } })();
  if (p.image && p.image.has_image && u) {
    const im = el("img"); im.src = u; im.alt = p.product_name || ""; im.loading = "lazy"; im.referrerPolicy = "no-referrer";
    im.onerror = () => { pic.replaceChildren("💊"); };
    pic.append(im);
  } else pic.append("💊");
  const body = el("div", "rx-body");
  const nm = el("div", "rx-nm", p.product_name || p.arabic_name || "منتج"); nm.dir = "auto";
  body.append(nm);
  const sub = [p.dosage_form, p.pack_size && "العبوة: " + p.pack_size].filter(Boolean).join(" · ");
  const st = rxStrengthOf(p), cur = p.current_price != null ? p.current_price : p.price;
  if (sub || st) {
    const meta = el("div", "rx-meta");
    if (sub) meta.append(el("span", "rx-sub", sub));
    if (st) { const b = el("span", "rx-str", st); b.dir = "ltr"; meta.append(b); }
    body.append(meta);
  }
  const foot = el("div", "rx-foot");
  if (cur != null) foot.append(el("span", "rx-pr", Number(cur).toLocaleString("ar-EG") + " ج.م"));
  foot.append(el("span", "rx-open", "افتح صفحة المنتج ←"));
  body.append(foot);
  try { const ab = window.rxCart && window.rxCart.addBtn(p, true); if (ab) body.append(ab); } catch { /* الفاتورة اختيارية */ }
  if (tier === 3) { body.append(el("div", "rx-warn", "غير المكتوب")); t.title = "مش نفس التركيز/الشكل المكتوب"; }
  t.append(pic, body);
  t.addEventListener("click", () => { if (window.openProductDirect) window.openProductDirect(p, tier); });
  return t;
}
function rxRow(list, tier) {
  const row = el("div", "rx-row" + (list.length === 1 ? " one" : ""));
  list.forEach((p) => row.append(rxTile(p, tier)));
  if (list.length < 2) return row;
  // شريط تحت الكارت: بيبيّن إن فيه منتجات تانية وإنت واقف على أنهي واحد
  const wrap = el("div", "rx-rowwrap"), strip = el("div", "rx-strip"), bars = el("div", "rx-bars"), lab = el("span", "rx-lab");
  const segs = list.map((_, i) => {
    const s = el("button", "rx-seg"); s.type = "button"; s.setAttribute("aria-label", "منتج " + (i + 1));
    s.addEventListener("click", () => row.children[i].scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" }));
    bars.append(s); return s;
  });
  const nf = (x) => Number(x).toLocaleString("ar-EG");
  let cur = -1;
  const set = (i) => { cur = i; segs.forEach((s, k) => s.classList.toggle("on", k === i)); lab.textContent = nf(i + 1) + " من " + nf(list.length) + " · اسحب لمنتجات تانية"; };
  row.addEventListener("scroll", () => {
    const t = row.firstElementChild, w = t ? t.offsetWidth + 14 : 0; if (!w) return;
    const i = Math.max(0, Math.min(list.length - 1, Math.round(Math.abs(row.scrollLeft) / w)));
    if (i !== cur) set(i);
  }, { passive: true });
  set(0);
  strip.append(bars, lab); wrap.append(row, strip);
  return wrap;
}
function rxCard(it, n) {
  const c = el("article", "card rx-item st-" + ((RX_ST[it.match_status] || RX_ST.no_match)[1]));
  const bits = [["الجرعة", it.dose], ["الطريقة", it.route], ["التكرار", it.frequency], ["المدة", it.duration]].filter((x) => x[1]);
  if (bits.length) {
    const ul = el("ul", "ing");
    bits.forEach(([l, v]) => { const li = el("li"); const sv = el("span", null, v); sv.dir = "auto"; li.append(el("span", null, l), sv); ul.append(li); });
    c.append(ul);
  }
  if (it.notes_ar) c.append(el("div", "meta", "ملاحظة: " + it.notes_ar));
  const chips = el("div", "chips");
  const [t, cls] = RX_ST[it.match_status] || RX_ST.no_match;
  if (!hasWild(it.read_name)) chips.append(el("span", "chip " + cls, t));
  if (it.unclear) chips.append(el("span", "chip warn", hasWild(it.read_name) ? "فيه حرف مش واضح (_)" : "جزء من السطر مش واضح"));
  if (typeof it.confidence === "number") chips.append(el("span", "chip", "ثقة القراءة: " + Math.round(it.confidence * 100) + "%"));
  c.append(chips);
  const cd = it.candidate;
  if (cd) {
    const nm = [cd.name, cd.name_ar].filter(Boolean).join(" — ");
    if (nm) { const m = el("div", "meta", "أقرب منتج في السجل: " + nm + (cd.scientific_name ? " (" + cd.scientific_name + ")" : "")); m.dir = "auto"; c.append(m); }
    if (RX_SC[cd.strength_check]) c.append(el("div", "meta", RX_SC[cd.strength_check]));
  }
  const q = String(it.read_name || "").trim();
  if (q.length >= 2 && !hasWild(q)) {
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
// حرف مش واضح في اسم الدواء: _ (والـ * القديمة بتتعامل زيها)
const hasWild = (t) => /[*_]/.test(String(t || ""));
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
// طريقة الإعطاء المكتوبة في الروشتة (بتتقرا زي ما هي، مش بتتخمّن): وريد/عضل/تحت الجلد/محلول وريدي = حقن، وفم/oral = أقراص أو كبسول أو سائل
const rxRoute = (t) => {
  const s = String(t || "").trim(); if (!s) return null;
  if (/(?<![a-z])(i\.?v|i\.?m|s\.?c|inj(?:ection)?|inf(?:usion)?|drip|intravenous|intramuscular|subcutaneous)(?![a-z])|وريد|عضل|حقن|تحت الجلد/i.test(s)) return "inj";
  if (/(?<![a-z])(oral|p\.?o|per os|by mouth)(?![a-z])|بالفم|فم/i.test(s)) return "oral";
  return null;
};
const prodAmtsAll = (p) => { const n = rxAmts(p.product_name); return n.length ? n : prodAmts(p); }; // الاسم الأول (بيشيل لبس العبوات) وبعدين التركيبة المسجّلة

// «قصدك؟»: أقرب أسماء حقيقية من جدول الأدوية المصرية (دالة drug-name-fuzzy)، وبعدها اقتراحات السجل، وبعدها أسماء بتبدأ بنفس أول 4 حروف.
// لو أقرب اسم تشابهه عالي (75٪ فأكتر) بنعرض منتجاته تلقائيًا بتنبيه إنه تخمين. غير كده بنعرض الأسماء للاختيار بس.
const RX_AUTO_MIN = 0.75;
async function rxSuggest(brand, d, it, box, token, auto) {
  const wild = hasWild(brand); // _ = حرف واحد مش واضح: بنطابق الحروف الواضحة بس من غير ما نفترض حرف
  let cands = [];
  try {
    const f = await call("drug-name-fuzzy", { name: brand });
    if (token !== polling) return false;
    cands = (((f.results || [])[0] || {}).suggestions || []).map((x) => ({ n: x.brand, sci: x.scientific_name, s: Number(x.score) || 0 }));
  } catch { /* نكمّل بباقي المصادر */ }
  if (!cands.length && !wild) {
    (d && Array.isArray(d.suggestions) ? d.suggestions : []).filter((x) => x && x.search_type !== "ingredient").forEach((x) => { const n = String(x.text || "").trim(); if (n) cands.push({ n, sci: null, s: 0 }); });
  }
  if (!cands.length && !wild && brand.replace(/[^a-z]/gi, "").length >= 4) {
    try {
      const pre = brand.replace(/[^a-z]/gi, "").slice(0, 4);
      const r = await call("drug-search", { query: pre, search_type: "brand" });
      if (token !== polling) return false;
      ((r.tiers && r.tiers.official) || r.results || []).forEach((p) => { const n = rxBrand(p.product_name); if (n) cands.push({ n, sci: null, s: 0 }); });
    } catch { /* مفيش اقتراحات */ }
  }
  const seen = new Set([brand.toLowerCase()]), uniq = [];
  cands.forEach((c) => { const k = c.n.toLowerCase(); if (c.n.length >= 2 && !seen.has(k)) { seen.add(k); uniq.push(c); } });
  if (!uniq.length) return false;
  const top = uniq[0];
  const w = el("div", "rx-sug");
  w.append(el("p", "sec-note", wild ? "أسماء بتطابق الحروف الواضحة في «" + brand + "» (الـ _ = حرف مش واضح):" : "قصدك واحد من الأسماء دي؟ (القراءة ممكن تكون غلطت في حرف)"));
  const row = el("div", "chips");
  uniq.slice(0, 6).forEach((c) => {
    const b = el("button", "chip rx-sug-b", c.n + (c.s ? " · " + Math.round(c.s * 100) + "٪" : "")); b.type = "button"; b.dir = "ltr";
    b.addEventListener("click", () => fillRxProducts(it, box, token, { name: c.n, sci: c.sci, auto: true }));
    row.append(b);
  });
  w.append(row); box.append(w);
  if (!auto && top.s >= RX_AUTO_MIN && (!wild || uniq.length === 1)) {
    const sub = el("div", "rx-auto");
    sub.append(el("div", "scan-msg warn", "تخمين: «" + top.n + "» (تشابه " + Math.round(top.s * 100) + "٪). راجع الجرعة والشكل الدوائي قبل الصرف."));
    const pb = el("div", "rx-prods"); sub.append(pb); box.append(sub);
    await fillRxProducts(it, pb, token, { name: top.n, sci: top.sci, auto: true });
  }
  return true;
}

// بحث + انتظار: لو الدواء مش محفوظ، drug-search بيبدأ مهمة جلب من المصادر في الخلفية (job_id). بنتابعها بنفس طريقة شاشة البحث العادية
// (drug-job-status كل 3 ثواني، لحد حوالي دقيقة)، وبعد ما تخلص بنعيد البحث عشان نجيب اللي اتحفظ.
async function rxSearchWait(query, type, token, say) {
  let d = await call("drug-search", { query, search_type: type });
  let list = (d.tiers && d.tiers.official) || d.results || [];
  if (list.length || !d.job_id || !["queued", "running"].includes(d.refresh_status)) return { d, list, job: null };
  let job = null;
  for (let i = 0; i < 20 && token === polling; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (token !== polling) return { d, list, job: null, stop: true };
    let j; try { j = await call("drug-job-status", { job_id: d.job_id }); } catch { continue; }
    if (j.status === "completed" || j.status === "failed") { job = j; break; }
    if (say) say("جاري جلب «" + query + "» من المصادر… (" + (i + 1) * 3 + " ث)");
  }
  if (job && job.status === "completed") {
    try { const d2 = await call("drug-search", { query, search_type: type }); d = d2; list = (d2.tiers && d2.tiers.official) || d2.results || []; } catch { /* نفضل على الأول */ }
  }
  return { d, list, job, timedOut: !job };
}

async function fillRxProducts(it, box, token, opt) {
  opt = opt || {};
  const brand = opt.name || rxBrand(it.read_name);
  if (brand.length < 2) { box.remove(); return; }
  const nd = rxNeed(it), need = nd.amts, wantForm = rxForm((it.dose || "") + " " + (it.read_name || "") + " " + (it.read_form || "")) || rxRoute(it.route);
  const formOk = (p) => { const pf = rxForm((p.product_name || "") + " " + (p.dosage_form || "")); return !wantForm || !pf || (wantForm === "oral" ? (pf === "solid" || pf === "liquid") : pf === wantForm); };
  box.replaceChildren(el("div", "meta", "جاري البحث عن «" + brand + "»…"));
  if (hasWild(brand)) { // اسم فيه حرف مش واضح: مفيش بحث بالاسم الناقص، بنطابق الحروف الباقية بس
    try {
      box.replaceChildren(el("p", "sec-note", "فيه حرف مش واضح في «" + brand + "» (الـ _). بنطابق الحروف الواضحة مع كل أدوية الدليل من غير ما نفترض الحرف الناقص."));
      const ok = await rxSuggest(brand, null, it, box, token, false);
      if (token !== polling) return;
      if (!ok) box.append(el("div", "scan-msg warn", "مفيش اسم بيطابق الحروف الواضحة. اقرأ الروشتة بنفسك."));
    } catch { box.replaceChildren(el("div", "scan-msg warn", "تعذّرت المطابقة، جرّب تاني.")); }
    return;
  }
  try {
    const say = (t) => { const m = box.querySelector(".meta"); if (m) m.textContent = t; };
    let { d, list, job, stop } = await rxSearchWait(brand, "brand", token, say);
    if (stop || token !== polling) return;
    let note = "";
    if (!list.length && opt.sci) { // الاسم التجاري مش في دليل الأسعار: نجرّب بالمادة الفعّالة
      const ing = String(opt.sci).split("+")[0].trim();
      if (ing) {
        say("جاري البحث بالمادة الفعّالة (" + ing + ")…");
        const r2 = await rxSearchWait(ing, "ingredient", token, say);
        if (r2.stop || token !== polling) return;
        list = r2.list;
        if (list.length) note = "«" + brand + "» مش موجود في دليل الأسعار، فدي منتجات بنفس المادة الفعّالة (" + ing + "):";
      }
    }
    box.replaceChildren();
    if (note) box.append(el("p", "sec-note", note));
    if (!list.length) {
      const pend = (job && Array.isArray(job.pending_products) ? job.pending_products : []).filter((x) => x && typeof x.name === "string");
      const dym = (job && Array.isArray(job.did_you_mean) ? job.did_you_mean : []).filter((x) => typeof x === "string" && x.trim());
      if (job) d = Object.assign({}, d, { suggestions: (d.suggestions || []).concat(dym.map((t) => ({ text: t, kind: "brand", search_type: "auto" }))) });
      if (pend.length) box.append(el("div", "scan-msg warn", "لقيناه على الإنترنت وفي انتظار المراجعة: " + pend.slice(0, 3).map((x) => x.name).join("، ")));
      else if (job && job.message_ar) box.append(el("div", "scan-msg warn", job.message_ar));
      else box.append(el("div", "scan-msg warn", (job ? "مفيش نتيجة مؤكدة في المصادر." : "مش في السجل.") + " مش معناها إنه مش موجود في السوق."));
      await rxSuggest(brand, d, it, box, token, opt.auto); return;
    }
    if (!need.length) {
      const pref = list.filter(formOk), seen = new Set();
      const shown = (pref.length ? pref : list).filter((p) => { const k = normKey(p.product_name) + "|" + rxStrengthOf(p); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((x, y) => rxStrengthNum(x) - rxStrengthNum(y)).slice(0, 12);
      box.append(el("p", "sec-note", "التركيز مش مكتوب في الروشتة، فعرضنا كل التركيزات المتاحة" + (wantForm && !pref.length ? " (ومفيش منها بالشكل المكتوب)" : "") + (shown.length > 1 ? " — اسحب يمين وشمال" : "") + ". راجع الجرعة قبل الصرف."));
      box.append(rxRow(shown, 3));
      return;
    }
    const sameS = list.filter((p) => sameAmts(need, prodAmtsAll(p)));
    const exact = sameS.filter(formOk), otherForm = sameS.filter((p) => !formOk(p));
    if (nd.assumed) box.append(el("p", "sec-note", "الجرعة مكتوبة «" + it.dose + "» من غير وحدة، فافترضنا إن الرقم بالـ mg."));
    if (exact.length) {
      box.append(el("p", "sec-note ok", "نفس الاسم والتركيز المكتوب (" + need.map((a) => a.v).join(" + ") + (nd.assumed ? " mg" : "") + (wantForm ? " والشكل" : "") + ") — " + exact.length + " منتج."));
      box.append(rxRow(exact.slice(0, 8), 1));
      return;
    }
    if (otherForm.length) {
      box.append(el("div", "scan-msg warn", "نفس التركيز لكن بشكل دوائي مختلف عن (" + (it.dose || it.read_name) + "):"));
      box.append(rxRow(otherForm.slice(0, 6), 3));
      return;
    }
    const closest = list.map((p) => ({ p, g: strengthGap(need, prodAmtsAll(p)) })).filter((o) => isFinite(o.g)).sort((x, y) => x.g - y.g).slice(0, 2);
    box.append(el("div", "scan-msg warn", "مفيش بنفس التركيز المكتوب (" + need.map((a) => a.v).join(" + ") + (nd.assumed ? " mg" : "") + ")."));
    if (closest.length) { box.append(el("p", "sec-note", "أقرب تركيز متاح — مش نفس التركيز المطلوب:")); box.append(rxRow(closest.map((o) => o.p), 3)); }
    if (!closest.length) await rxSuggest(brand, d, it, box, token, opt.auto);
  } catch (err) {
    box.replaceChildren(el("div", "scan-msg warn", "تعذّر البحث، جرّب «ابحث عن الدواء»."));
  }
}

let rxImgUrl = null;
function rxLens(im, url) { // عدسة مكبّرة: اضغط مطولًا على الصورة وحرّك صباعك. من غير ما تفتح الصورة.
  const Z = 3, DW = 300, DH = 170, HOLD = 250;
  document.querySelectorAll(".rx-lens").forEach((n) => n.remove());
  const lens = el("div", "rx-lens"); lens.hidden = true; document.body.append(lens);
  let timer = 0, active = false, sx = 0, sy = 0;
  const area = () => { // مساحة الصورة الفعلية جوه الإطار (object-fit: contain)
    const b = im.getBoundingClientRect(), nw = im.naturalWidth || 1, nh = im.naturalHeight || 1;
    const k = Math.min(b.width / nw, b.height / nh), w = nw * k, h = nh * k;
    return { x: b.left + (b.width - w) / 2, y: b.top + (b.height - h) / 2, w, h };
  };
  const show = (cx, cy) => {
    const r = area();
    const px = Math.min(Math.max(cx, r.x), r.x + r.w), py = Math.min(Math.max(cy, r.y), r.y + r.h);
    const u = (px - r.x) / r.w, v = (py - r.y) / r.h;
    lens.style.backgroundImage = "url(" + url + ")";
    lens.style.backgroundSize = r.w * Z + "px " + r.h * Z + "px";
    lens.style.backgroundPosition = DW / 2 - u * r.w * Z - 3 + "px " + (DH / 2 - v * r.h * Z - 3) + "px";
    // العدسة متمركزة على النقطة اللي بتضغط عليها بالظبط، والمحتوى المكبّر هو اللي تحت صباعك
    lens.style.transform = "translate(" + (cx - DW / 2) + "px," + (cy - DH / 2) + "px)";
    lens.hidden = false;
  };
  const end = () => { clearTimeout(timer); active = false; lens.hidden = true; };
  im.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY; clearTimeout(timer);
    timer = setTimeout(() => { active = true; show(sx, sy); if (navigator.vibrate) navigator.vibrate(8); }, HOLD);
  });
  im.addEventListener("pointermove", (e) => {
    if (!active) { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clearTimeout(timer); return; }
    show(e.clientX, e.clientY);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) => im.addEventListener(t, end));
  im.addEventListener("touchmove", (e) => { if (active) e.preventDefault(); }, { passive: false }); // ما يتسكرلش الصفحة وانت بتحرّك العدسة
  im.addEventListener("contextmenu", (e) => e.preventDefault());
}
(function () { const s = document.createElement("style");
  s.textContent = ".rx-block[hidden]{display:none!important}"
    + ".rx-note{font-size:13px;line-height:1.7;padding:10px 14px;border-radius:14px;margin:6px 0 14px}"
    // شريط التنقل: سهمين ناعمين وبينهم العدّاد ونقط صغيرة
    + ".rx-pg{margin:6px 0 14px}.rx-nav{display:flex;align-items:center;gap:12px}"
    + ".rx-arr{flex:none;width:44px;height:44px;border:0;background:transparent;color:var(--accent);display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;transition:transform .12s,opacity .2s;-webkit-tap-highlight-color:transparent}"
    + ".rx-arr svg{width:28px;height:28px;stroke:currentColor;fill:none;stroke-width:2.8;stroke-linecap:round;stroke-linejoin:round}.rx-arr:active:not(:disabled){transform:scale(.93)}.rx-arr:disabled{opacity:.3;box-shadow:none;cursor:default}"
    + ".rx-mid{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:6px}.rx-cnt{font-size:14px;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums}.rx-cnt b{color:var(--ink);font-size:15px}"
    + ".rx-dots{display:flex;flex-wrap:wrap;justify-content:center;gap:0}"
    + ".rx-dot{position:relative;width:24px;height:22px;padding:0;border:0;background:transparent;cursor:pointer;-webkit-tap-highlight-color:transparent}"
    + ".rx-dot::before{content:\"\";position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:99px;background:var(--dc);opacity:.45;transition:width .2s,margin .2s,opacity .2s}"
    + ".rx-dot.ok{--dc:var(--ok)}.rx-dot.warn{--dc:var(--accent)}.rx-dot.bad{--dc:var(--bad)}"
    + ".rx-dot.on::before{width:20px;margin-left:-10px;opacity:1}"
    + ".rx-pg.low{margin:14px 0 4px}.rx-pg.low .rx-arr{width:40px;height:40px}";
  document.head.append(s); })();
function rxPager(pages, blocks, items) { // كل Rx في صفحة لوحده: أسهم (جنب الشريط وتحت)، عدّاد، نقط للقفز، وسحب يمين وشمال
  const n = blocks.length; let cur = 0;
  if (n < 2) return;
  pages.classList.add("multi");
  pages.addEventListener("rxgo", (e) => go(cur + (e.detail || 0))); // أسهم الشريط (rxHead) بتبعت الحدث ده
  const cls = (it) => (RX_ST[it.match_status] || RX_ST.no_match)[1];
  const arrow = rxArrow;
  const mk = (withDots) => {
    const wrap = el("div", "rx-pg" + (withDots ? "" : " low")), nav = el("div", "rx-nav");
    const prev = arrow("prev", "السابق"), next = arrow("next", "التالي"), mid = el("div", "rx-mid"), cnt = el("span", "rx-cnt");
    prev.addEventListener("click", () => go(cur - 1)); next.addEventListener("click", () => go(cur + 1));
    let dots = [];
    if (withDots) {
      const row = el("div", "rx-dots");
      dots = items.map((it, k) => { const d = el("button", "rx-dot " + cls(it)); d.type = "button"; d.setAttribute("aria-label", "الدواء رقم " + (k + 1) + ": " + (it.read_name || "")); d.addEventListener("click", () => go(k)); row.append(d); return d; });
      mid.append(row);
    }
    // الواجهة RTL: أول عنصر على اليمين، يعني التالي يمين والسابق شمال. الأسهم اللي فوق في الشريط نفسه، فالعدّاد والنقط بس هنا
    if (withDots) nav.append(mid); else nav.append(next, mid, prev);
    wrap.append(nav);
    return { wrap, prev, next, cnt, dots };
  };
  const top = mk(true), bot = mk(false);
  const sync = () => {
    blocks.forEach((b, k) => { b.hidden = k !== cur; });
    pages.classList.toggle("at-first", cur === 0); pages.classList.toggle("at-last", cur === n - 1);
    [top, bot].forEach((p) => {
      p.prev.disabled = cur === 0; p.next.disabled = cur === n - 1;
      p.dots.forEach((d, k) => { d.classList.toggle("on", k === cur); if (k === cur) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current"); });
    });
  };
  function go(k) {
    k = Math.max(0, Math.min(n - 1, k)); if (k === cur) return;
    cur = k; sync();
    const r = top.wrap.getBoundingClientRect(); if (r.top < 0 || r.top > window.innerHeight * 0.5) top.wrap.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  pages.prepend(top.wrap); pages.append(bot.wrap); sync();
  // سحب: ناحية الشمال = التالي، ناحية اليمين = السابق (زي الكاروسيل: المحتوى بيتحرك شمال وبيجيلك اللي على اليمين). مش بنعمل سحب جوه صف المنتجات الأفقي
  let sx = 0, sy = 0, ok = false;
  pages.addEventListener("touchstart", (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; ok = e.touches.length === 1 && !e.target.closest(".rx-row,.rx-dots,input,textarea,[contenteditable]"); }, { passive: true });
  pages.addEventListener("touchend", (e) => {
    if (!ok) return; ok = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) go(dx < 0 ? cur + 1 : cur - 1);
  }, { passive: true });
}
function rxSetImage(f) { // صورة الروشتة الأصلية بتتحفظ في الذاكرة بس (على جهازك) وبتتفتح لما تضغط على قصاصة اسم.
  if (rxImgUrl) URL.revokeObjectURL(rxImgUrl);
  rxImgUrl = URL.createObjectURL(f);
}
(function () { const s = document.createElement("style");
  s.textContent = ".rx-crop{margin:12px 0 14px;padding:10px 10px 12px;background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:0 2px 10px rgba(20,90,160,.06)}"
    + ".rx-crop.tap{cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .12s}.rx-crop.tap:active{transform:scale(.99)}"
    + ".rx-crop-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 2px 8px;font-size:12.5px;color:var(--muted)}"
    + ".rx-crop-h b{display:inline-flex;align-items:center;gap:5px;font-weight:600;color:var(--accent);white-space:nowrap}.rx-crop-h svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}"
    + ".rx-crop canvas{border:0;border-radius:12px;background:#fbfaf6;max-height:150px}"
    + ".rx-view{position:fixed;inset:0;z-index:900;overscroll-behavior:contain;touch-action:none;display:flex;flex-direction:column;background:#0e131a}"
    + ".rx-view-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:calc(12px + env(safe-area-inset-top,0px)) 16px 12px;color:#fff}"
    + ".rx-view-h div{min-width:0;line-height:1.5}.rx-view-h strong{display:block;font-size:16px;font-weight:700}.rx-view-h small{display:block;font-size:12.5px;color:rgba(255,255,255,.62)}"
    + ".rx-view-h button{flex:none;width:40px;height:40px;border-radius:50%;border:0;background:rgba(255,255,255,.14);color:#fff;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer}.rx-view-h button svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round}"
    + ".rx-view-sc{flex:1;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y pinch-zoom;padding:0 8px calc(12px + env(safe-area-inset-bottom,0px))}"
    + ".rx-view-st{position:relative;width:100%;max-width:900px;margin:0 auto;background:#fff;line-height:0;border-radius:10px;overflow:hidden}"
    + ".rx-view-st img{display:block;width:100%;height:auto;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-user-drag:none}"
    + ".rx-mark{position:absolute;box-sizing:border-box;border:2px solid #e5484d;border-radius:8px;background:rgba(229,72,77,.10);box-shadow:0 0 0 3px rgba(255,255,255,.7);pointer-events:none}";
  document.head.append(s); })();
function rxViewer(b) { // الروشتة كاملة، والجزء اللي اتقرا منه الاسم متحدد بمربع أحمر.
  if (!rxImgUrl) return;
  const ov = el("div", "rx-view"), bar = el("div", "rx-view-h");
  const hasBox = Array.isArray(b) && b.length === 4 && b.every((x) => Number.isFinite(Number(x)));
  const t = el("div"); t.append(el("strong", null, "الروشتة الكاملة"), el("small", null, hasBox ? "المربع الأحمر هو الاسم المقروء · اضغط مطولًا للتكبير" : "اضغط مطولًا على أي مكان للتكبير"));
  const x = el("button"); x.type = "button"; x.setAttribute("aria-label", "إغلاق"); x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  bar.append(t, x);
  const sc = el("div", "rx-view-sc"), st = el("div", "rx-view-st");
  const im = new Image(); im.alt = "صورة الروشتة الأصلية"; im.draggable = false;
  st.append(im);
  let mark = null;
  if (hasBox) {
    let [y0, x0, y1, x1] = b.map(Number);
    const px = 6, py = 4; // هامش صغير حوالين الاسم
    x0 = Math.max(0, x0 - px); x1 = Math.min(1000, x1 + px); y0 = Math.max(0, y0 - py); y1 = Math.min(1000, y1 + py);
    mark = el("div", "rx-mark");
    mark.style.left = x0 / 10 + "%"; mark.style.top = y0 / 10 + "%"; mark.style.width = (x1 - x0) / 10 + "%"; mark.style.height = (y1 - y0) / 10 + "%";
    st.append(mark);
  }
  sc.append(st); ov.append(bar, sc);
  // الرجوع (زر الموبايل أو المتصفح) بيقفل الصورة بس ويفضل في النتايج: بنسجّل خطوة في السجل بنفس الرابط (من غير ما الراوتر يتحرك)
  const bs = document.body.style, y0 = window.scrollY, prev = { pos: bs.position, top: bs.top, w: bs.width, ov: bs.overflow };
  let closed = false;
  const onKey = (e) => { if (e.key === "Escape") close(false); };
  const onPop = () => close(true);
  function close(fromPop) {
    if (closed) return; closed = true;
    document.removeEventListener("keydown", onKey); window.removeEventListener("popstate", onPop);
    document.querySelectorAll(".rx-lens").forEach((n) => n.remove());
    bs.position = prev.pos; bs.top = prev.top; bs.width = prev.w; bs.overflow = prev.ov; // نرجّع القائمة مكانها بالظبط
    ov.remove(); window.scrollTo(0, y0);
    if (!fromPop) history.back(); // قفل بالزر: نشيل الخطوة اللي سجّلناها
  }
  bar.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  x.addEventListener("click", () => close(false)); document.addEventListener("keydown", onKey);
  history.pushState({ rxv: 1 }, "", location.href); window.addEventListener("popstate", onPop);
  im.onload = () => { // نوصّل للمربع في نص الشاشة
    if (!mark) return;
    const r = mark.getBoundingClientRect(), c = sc.getBoundingClientRect();
    sc.scrollTop += r.top - c.top - (c.height - r.height) / 2;
    sc.scrollLeft += r.left - c.left - (c.width - r.width) / 2;
  };
  bs.position = "fixed"; bs.top = -y0 + "px"; bs.width = "100%"; bs.overflow = "hidden"; document.body.append(ov); // القائمة اللي ورا ما تتحركش
  im.src = rxImgUrl; rxLens(im, rxImgUrl);
}

// تعديل الاسم اللي الذكاء الصناعي قراه (غلطة حرف مثلًا): قلم في الشريط الأزرق، وبعد التعديل بيتبحث بالاسم الجديد
function rxEditName(band, it, pb, token) {
  const h = band.querySelector("h2"), st = band.querySelector(".rx-st");
  if (!h || !st) return;
  h.classList.add("rx-tap"); h.tabIndex = 0; h.setAttribute("role", "button"); h.setAttribute("aria-label", "اضغط لتعديل اسم الدواء");
  let busy = false;
  const open = () => {
    if (band.querySelector(".rx-edit")) return;
    const f = el("form", "rx-edit");
    const inp = el("input"); inp.type = "text"; inp.value = h.textContent; inp.maxLength = 100; inp.dir = "auto";
    inp.setAttribute("autocomplete", "off"); inp.setAttribute("autocapitalize", "off"); inp.setAttribute("autocorrect", "off"); inp.setAttribute("spellcheck", "false"); inp.setAttribute("enterkeyhint", "search"); inp.setAttribute("aria-label", "اسم الدواء");
    const go = el("button", "rx-edit-go", "ابحث بالاسم الجديد"); go.type = "submit";
    const x = el("button", "rx-edit-x", "إلغاء"); x.type = "button";
    f.append(inp, go, x);
    const close = () => { f.remove(); h.hidden = false; st.hidden = false; };
    x.addEventListener("click", close);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const nv = inp.value.trim().replace(/\s+/g, " ");
      if (nv.length < 2) { inp.focus(); return; }
      busy = true; close();
      if (nv !== h.textContent) { h.textContent = nv; st.textContent = "تعديل يدوي"; st.title = "تعديل يدوي"; st.setAttribute("aria-label", "تعديل يدوي"); st.className = "rx-st warn"; }
      try { await fillRxProducts(Object.assign({}, it, { read_name: nv, unclear: false }), pb, token); } finally { busy = false; }
    });
    h.hidden = true; st.hidden = true;
    h.after(f); inp.focus(); inp.select();
  };
  h.addEventListener("click", open);
  h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
}

// ===== المرحلة التانية للروشتة: rx-resolve (نفس الصورة + الأسطر المقروءة). لو وقعت أو اتأخرت بنرجع للنتيجة القديمة زي ما هي =====
const RX_RESOLVE_MS = 60000;
async function rxResolve(b64, items) {
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), RX_RESOLVE_MS);
  try {
    const r = await fetch(BASE + "/rx-resolve", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + ANON, apikey: ANON },
      body: JSON.stringify({ image_base64: b64, mime_type: "image/jpeg", items }), signal: ac.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { map: new Map(), error: (j && j.error) || "http_" + r.status, ms: null };
    return { map: new Map((j.items || []).map((x) => [x.line_no, x])), error: null, ms: j.ms ?? null };
  } catch (e) { return { map: new Map(), error: (e && e.name) || "error", ms: null }; } finally { clearTimeout(tm); }
}
// ===== المرحلة التالتة للروشتة: rx-sig (طريقة الاستعمال المكتوبة جنب كل دواء). بتشتغل بالتوازي مع rx-resolve ومش بتعطّل النتيجة. لو وقعت السطر بيتعلّم «ما اتقراتش» ومفيش جرعة بتتخمّن =====
const RX_SIG_MS = 90000;
let rxSigCur = null; // { res: {map, error} | null, p: Promise } للروشتة الحالية
async function rxSig(b64, items) {
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), RX_SIG_MS);
  try {
    const r = await fetch(BASE + "/rx-sig", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + ANON, apikey: ANON },
      body: JSON.stringify({ image_base64: b64, mime_type: "image/jpeg", items: items.map((x, i) => ({ line_no: x.line_no || i + 1, read_name: x.read_name, name_box: x.name_box || null })) }), signal: ac.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { map: new Map(), error: (j && j.error) || "http_" + r.status };
    return { map: new Map((j.items || []).map((x) => [x.line_no, x])), error: null };
  } catch (e) { return { map: new Map(), error: (e && e.name) || "error" }; } finally { clearTimeout(tm); }
}
// عرض طريقة الاستعمال لسطر واحد: الجملة الجاهزة (من الحقول المتأكدة بس) + النص زي ما هو مكتوب. أي شك = «راجع بنفسك»
function rxSigView(s) {
  const box = el("div", "rx-sig");
  if (!s || s.status === "not_read") {
    box.classList.add("warn"); box.append(el("strong", null, "طريقة الاستعمال: ما اتقراتش"), el("small", null, "اقراها من الروشتة الأصلية."));
    return box;
  }
  if (s.status === "none_written") { box.classList.add("none"); box.append(el("strong", null, "طريقة الاستعمال: مش مكتوبة جنب الدواء")); return box; }
  const g = s.sig || {};
  const main = el("strong", null, g.display_ar || "الجرعة مش متأكدة، اقرا المكتوب"); box.append(main);
  if (g.sig_text_ar) { const raw = el("small", "rx-sig-raw"); raw.append("المكتوب: "); const t = el("bdi", null, g.sig_text_ar); t.dir = "auto"; raw.append(t); box.append(raw); }
  const notes = [];
  if (g.ambiguous_pattern) notes.push("النمط المكتوب ممكن يتفسر بأكتر من طريقة (عدد المرات أو الكمية)");
  if (g.where === "general") notes.push("جملة عامة مكتوبة مرة واحدة للروشتة كلها");
  if (g.unclear) notes.push("جزء من الكتابة مش واضح");
  if (Array.isArray(g.conflicts) && g.conflicts.length) notes.push("القراءات اختلفت في بعض التفاصيل (اتحسمت بالأغلبية أو اتسابت فاضية)");
  if (s.sig && s.sig.needs_review) { box.classList.add("warn"); notes.unshift("راجع الجرعة بنفسك من الروشتة الأصلية"); }
  notes.forEach((t) => box.append(el("small", null, t)));
  return box;
}
// مكان طريقة الاستعمال تحت شريط اسم الدواء. بيتبني تاني مع كل rxLine (يعني بيفضل موجود بعد «النتيجة مش صح؟ أعد البحث»)
function rxSigSlot(w, n) {
  const cur = rxSigCur; if (!cur) return;
  const slot = el("div", "rx-sig-slot"), head = w.querySelector(".rx-head");
  if (head) head.after(slot); else w.prepend(slot);
  const show = (res) => { slot.replaceChildren(rxSigView(res.error ? null : res.map.get(n) || null)); };
  if (cur.res) show(cur.res);
  else { slot.append(el("div", "rx-sig pend", "جاري قراءة طريقة الاستعمال…")); cur.p.then(show); }
}
{
  const st = document.createElement("style");
  st.textContent = ".rx-sig{display:flex;flex-direction:column;gap:2px;margin:8px 2px 0;padding:9px 12px;border-radius:14px;background:var(--soft);color:var(--soft-ink);font-size:14px;line-height:1.5}"
    + ".rx-sig strong{font-size:15px}.rx-sig small{color:var(--muted);font-size:12.5px}.rx-sig-raw bdi{color:var(--ink)}"
    + ".rx-sig.warn{background:var(--warn-bg);color:var(--warn)}.rx-sig.warn small{color:var(--warn)}"
    + ".rx-sig.none,.rx-sig.pend{background:transparent;border:1px dashed var(--line);color:var(--muted)}";
  document.head.append(st);
}
// الحالة المعروضة لسطر واحد: matched / brand_only / choices / legacy / none
function rxDisplay(item, r) {
  if (r && r.status === "matched") return { state: "matched", brand: r.matched_brand, product_id: r.product_id, note: null, excluded: r.excluded || [] };
  if (r && r.status === "matched_brand") return { state: "brand_only", brand: r.matched_brand, product_id: null, note: "البراند مؤكد من الصورة والتركيز للصيدلي", excluded: r.excluded || [] };
  if (r && r.status === "choices" && Array.isArray(r.choices) && r.choices.length) {
    // الاسم المقروء بيطابق براند واحد حرفيًا، وتركيزه مطابق أو مش مكتوب، والصورة اتفحصت مرتين ومتوافقة: ده هو، والباقي أسماء قريبة بس
    const nb = (x) => String(x || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""), rb = nb(rxBrand(item.read_name));
    const same = rb.length >= 3 && !hasWild(item.read_name) && !(r.want && r.want.assumed) ? r.choices.filter((c) => nb(c.brand) === rb) : [];
    if (same.length === 1 && same[0].vision === "both_compatible" && (same[0].strength_check === "exact" || same[0].strength_check === "none_written")) {
      return { state: "brand_only", brand: same[0].brand, product_id: null, note: same[0].strength_check === "exact" ? "الاسم المكتوب مطابق تمامًا للبراند ده، والتركيز مطابق. راجع الشكل الدوائي قبل الصرف." : "الاسم المكتوب مطابق تمامًا للبراند ده، والتركيز مش مكتوب. راجع الجرعة والشكل الدوائي قبل الصرف.", excluded: r.excluded || [], others: r.choices.filter((c) => c !== same[0]) };
    }
  }
  if (r && r.status === "choices" && Array.isArray(r.choices) && r.choices.length) return { state: "choices", options: r.choices, excluded: r.excluded || [], note: (r.notes || [])[0] ?? null };
  const old = item.selected_product ?? item.candidate ?? null;
  return { state: old ? "legacy" : "none", excluded: (r && r.excluded) || [], note: ((r && r.notes) || [])[0] ?? null };
}
const RX_STRC = { exact: "التركيز مطابق", partial: "التركيز جزئي", unknown: "التركيز مش مسجّل", none_written: "التركيز مش مكتوب", absent: "" };
const RX_VIS = { both_compatible: "الصورة متوافقة", one_read: "الصورة اتقرت مرة واحدة", not_checked: "الصورة ما اتفحصتش" };
const RX_STAGE = { form: "الشكل", strength: "التركيز", vision: "الصورة" };
function rxExcluded(list) {
  if (!list || !list.length) return null;
  const d = el("details", "rx-excl"); d.append(el("summary", null, "اتستبعد " + list.length + " اسم"));
  const ul = el("ul", "ing");
  list.forEach((x) => { const li = el("li"); const b = el("span", null, x.brand); b.dir = "auto"; li.append(b, el("span", null, (RX_STAGE[x.stage] ? RX_STAGE[x.stage] + ": " : "") + (x.reason || ""))); ul.append(li); });
  d.append(ul); return d;
}
// اختيارات البراند: المنتجات بتتحمّل لما الصيدلي يختار، مش بنخمّن
function rxChoices(it, d, box, token) {
  const w = el("div", "rx-choices");
  w.append(el("p", "sec-note", d.title || ("الاسم مش مؤكد: اختار البراند الصح" + (d.note ? " — " + d.note : ""))));
  const prod = el("div", "rx-chosen"); const btns = [];
  d.options.forEach((c) => {
    const b = el("button", "rx-choice"); b.type = "button";
    const n = el("strong", null, c.brand); n.dir = "auto";
    const sub = [RX_STRC[c.strength_check], RX_VIS[c.vision]].filter(Boolean).join(" · ");
    b.append(n); if (sub) b.append(el("small", null, sub));
    b.addEventListener("click", () => {
      btns.forEach((x) => x.classList.remove("on")); b.classList.add("on");
      // أول ما تختار: قايمة الاختيارات تتقفل، ويفضل اسم اللي اخترته ومعاه زر صغير لو عايز تغيّر
      w.style.display = "none";
      const nm = el("strong", null, c.brand); nm.dir = "auto";
      const re = el("button", "rx-rechoose", "غيّر الاختيار"); re.type = "button";
      re.addEventListener("click", () => { picked.hidden = true; w.style.display = ""; prod.replaceChildren(); btns.forEach((x) => x.classList.remove("on")); });
      picked.replaceChildren(el("span", null, "اخترت:"), nm, re); picked.hidden = false;
      fillRxProducts(it, prod, token, { name: c.brand });
    });
    btns.push(b); w.append(b);
  });
  const picked = el("div", "rx-picked"); picked.hidden = true;
  box.append(w, picked, prod);
  const ex = rxExcluded(d.excluded); if (ex) box.append(ex);
}

// ===== سطر واحد في الروشتة: بيتبني (وبيتعاد بناؤه لو ضغطت «النتيجة مش صح؟») جوه الـ section بتاعه =====
function rxLine(w, it, n, rsItem, token, poor) {
  const pb = el("div", "rx-prods");
  const det = el("details", "rx-more"); det.append(el("summary", null, "تفاصيل السطر وقراءة الروشتة"), rxCard(it, n));
  det.open = false; // مقفولة دايمًا لحد ما تضغط عليها
  const d = rxDisplay(it, rsItem || null);
  if (d.note && d.state !== "choices") det.append(el("p", "sec-note" + (/والتركيز مطابق/.test(d.note) ? " ok" : ""), d.note));
  if (d.state !== "choices") { const ex = rxExcluded(d.excluded); if (ex) det.append(ex); }
  if (d.others && d.others.length) { const dd = el("details", "rx-excl"); dd.append(el("summary", null, "أسماء قريبة تانية (" + d.others.length + ")")); rxChoices(it, { options: d.others, excluded: [], title: "لو الاسم المقروء غلط، اختار البراند الصح:" }, dd, token); det.append(dd); }
  const band = rxBand(it, n), crop = rxCrop(it); const src = el("div", "rx-src"); if (crop) src.append(crop);
  src.append(det, el("div", "scan-msg warn rx-note", "اقرأ وراجع الجرعة والشكل الدوائي قبل الصرف." + (poor ? " الخط مش واضح، صوّر تاني بإضاءة أحسن." : "")));
  src.append(pb);
  if (Array.isArray(it.name_box) && it.name_box.length === 4 && rxImgUrl) src.append(rxRedo(w, it, n, token, poor));
  w.replaceChildren(rxHead(band), src);
  rxSigSlot(w, n);
  rxEditName(band, it, pb, token);
  if (d.state === "matched" || d.state === "brand_only") return () => fillRxProducts(it, pb, token, { name: d.brand });
  if (d.state === "choices") return async () => { rxChoices(it, d, pb, token); };
  return () => fillRxProducts(it, pb, token);
}
// السطر ده بس من الروشتة الأصلية (على جهازك) بصورة أوضح، بعرض الصفحة كلها عشان الجرعة والشكل يطلعوا مع الاسم
function rxLineB64(it) {
  return new Promise((res) => {
    const b = it && it.name_box;
    if (!Array.isArray(b) || b.length !== 4 || !rxImgUrl || b.some((x) => !Number.isFinite(Number(x)))) return res(null);
    const im = new Image();
    im.onload = () => {
      const nw = im.naturalWidth, nh = im.naturalHeight; if (!nw || !nh) return res(null);
      let [y0, , y1] = b.map(Number);
      const py = Math.max(20, (y1 - y0) * 0.9);
      y0 = Math.max(0, y0 - py); y1 = Math.min(1000, y1 + py);
      const sy = (y0 / 1000) * nh, sh = Math.max(16, ((y1 - y0) / 1000) * nh);
      const k = Math.min(1, 1800 / nw), cv = document.createElement("canvas");
      cv.width = Math.round(nw * k); cv.height = Math.round(sh * k);
      cv.getContext("2d").drawImage(im, 0, sy, nw, sh, 0, 0, cv.width, cv.height);
      try { res(cv.toDataURL("image/jpeg", 0.9).split(",")[1] || null); } catch { res(null); }
    };
    im.onerror = () => res(null); im.src = rxImgUrl;
  });
}
// زر «النتيجة مش صح؟ أعد البحث»: يقص السطر ده بس، يقراه تاني، يطابقه مع الداتا بيز (rx-resolve بيفحص الخط مقابل أسماء المرشحين) ويعرض النتيجة الجديدة
function rxRedo(w, it, n, token, poor) {
  const wrap = el("div", "rx-redo-wrap"), b = el("button", "rx-redo", "النتيجة مش صح؟ أعد البحث"), msg = el("div", "rx-redo-msg");
  b.type = "button"; wrap.append(b, msg);
  const fail = (text) => { msg.replaceChildren(el("div", "scan-msg warn", text)); b.disabled = false; b.textContent = "النتيجة مش صح؟ أعد البحث"; };
  b.addEventListener("click", async () => {
    if (b.disabled) return;
    b.disabled = true; msg.replaceChildren();
    try {
      b.textContent = "جاري قص السطر…";
      const b64 = await rxLineB64(it);
      if (!b64) return fail("ما قدرناش نقص السطر من الروشتة.");
      b.textContent = "جاري إعادة قراءة السطر…";
      const r = await call("read-prescription", { image_base64: b64, mime_type: "image/jpeg" });
      if (token !== polling) return;
      const list = (Array.isArray(r.items) ? r.items : []).filter((x) => x && x.read_name);
      if (!list.length) return fail("ما قدرناش نقرا السطر ده تاني. جرّب تعدّل الاسم بإيدك.");
      const mid = (x) => (Array.isArray(x.name_box) && x.name_box.length === 4 ? Math.abs((Number(x.name_box[0]) + Number(x.name_box[2])) / 2 - 500) : 9999);
      const ni = list.slice().sort((a, c) => mid(a) - mid(c))[0]; // أقرب سطر لنص القصاصة
      const nit = Object.assign({}, it, ni, { line_no: it.line_no, name_box: it.name_box });
      b.textContent = "جاري المقارنة بالداتا بيز…";
      const key = it.line_no || n;
      const rs = await rxResolve(b64, [Object.assign({}, nit, { line_no: key, name_box: null })]);
      if (token !== polling) return;
      const run = rxLine(w, nit, n, rs.map.get(key) || null, token, poor);
      const same = String(nit.read_name).trim().toLowerCase() === String(it.read_name || "").trim().toLowerCase();
      const note = el("p", "sec-note" + (same ? " ok" : ""), (same ? "القراءة التانية طلعت نفس الاسم." : "القراءة اتغيّرت من «" + it.read_name + "» لـ «" + nit.read_name + "».") + (rs.error ? " المقارنة بالداتا بيز ما اشتغلتش." : ""));
      const srcEl = w.querySelector(".rx-src"); if (srcEl) srcEl.insertBefore(note, srcEl.querySelector(".rx-prods"));
      await run();
    } catch (e) {
      fail(ERR[e && e.code] || "ما قدرناش نعيد البحث دلوقتي (" + ((e && (e.code || e.message)) || "unknown") + "). جرّب تاني.");
    }
  });
  return wrap;
}

// بطاقة بيانات الروشتة: تخصص الدكتور وعمر المريض والتشخيص زي ما هي مكتوبة (من دالة read-prescription-header، من غير أسماء ومش بتتحفظ في أي مكان)
const RX_GEN = { male: "ذكر", female: "أنثى" };
const RX_ICON = {
  steth: "M5 3v5a4 4 0 0 0 8 0V3M9 12v3a5 5 0 0 0 10 0v-1M19 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  clip: "M9 4h6v3H9zM7 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1M8 12h8M8 16h5",
};
function rxInfoCard(h) {
  const extra = [RX_GEN[h.patient_gender], h.patient_weight].filter(Boolean);
  const rows = [];
  if (h.doctor_specialty) rows.push(["steth", "تخصص الدكتور", h.doctor_specialty, []]);
  if (h.patient_age) rows.push(["user", "عمر المريض", h.patient_age, extra]);
  else if (extra.length) rows.push(["user", "المريض", extra.join(" · "), []]);
  if (h.diagnosis) rows.push(["clip", "التشخيص", h.diagnosis, []]);
  if (!rows.length) return null;
  const c = el("section", "rx-info");
  rows.forEach(([ic, label, val, chips]) => {
    const r = el("div", "rx-info-r"), b = el("span", "rx-info-ic"), t = el("div", "rx-info-tx"), v = el("strong", null, val);
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + RX_ICON[ic] + '"/></svg>';
    v.dir = "auto";
    t.append(el("small", null, label), v);
    r.append(b, t);
    chips.forEach((x) => { const ch = el("span", "rx-info-chip", x); ch.dir = "auto"; r.append(ch); });
    c.append(r);
  });
  c.append(el("p", "rx-info-n", "مقروءة آليًا من الورقة وممكن تغلط، راجعها. مش بتتحفظ."));
  return c;
}
async function handleRx(f) {
  if (!/^image\//.test(f.type)) { imgErr("الملف ده مش صورة."); return; }
  const token = ++polling;
  clearMore(); box.replaceChildren(); fam.replaceChildren(); $("out").replaceChildren();
  busy(true); showSkeleton();
  const st = stepsUI(); st.add("prep"); st.add("read"); st.add("resolve"); st.set("prep", "run", "جاري تجهيز صورة الروشتة…"); const scan = window.RxScan ? window.RxScan.start(f) : null; if (scan) box.append(scan.el);
  box.append(st.w);
  if (window.showResultsPage) window.showResultsPage("قراءة روشتة");
  try {
    const b64 = await toJpegBase64(f, RX_B64_MAX, RX_SIDES);
    if (token !== polling) return;
    st.set("prep", "done", "اتجهّزت الصورة");
    st.lines("prep", [["الأبعاد بعد التصغير", lastShot.w + " × " + lastShot.h + " بكسل"], ["الحجم المبعوت", Math.round(b64.length * 0.75 / 1024) + " كيلوبايت (JPEG)"], ["ملحوظة", "الصورة بتتعرض على جهازك بس للمقارنة، ومش بتتحفظ. الأسطر المقروءة بتتسجّل للمراجعة."]]);
    st.set("read", "run", "جاري قراءة الروشتة…");
    // بيانات الروشتة (تخصص الدكتور، المريض، السن…) بتتقرا بالتوازي ومش بتعطّل النتيجة: لو فشلت أو مش مكتوبة ببساطة مش بتظهر
    // المسار الجديد: طلبين بس على الموديل الأقوى بيرجّعوا الأسماء + طريقة الاستعمال + بيانات الورقة مع بعض (read-prescription-v2).
    // لو الموديل الأقوى مش متاح (كوتا خلصت في كل المفاتيح أو وقع) أو حصل أي خطأ غير أخطاء الصورة، بنرجع للمسار القديم على الـ lite من غير ما المستخدم يحس
    let r = null, hdrP = null, v2 = false;
    try {
      r = await call("read-prescription-v2", { image_base64: b64, mime_type: "image/jpeg" });
      v2 = true;
    } catch (e) {
      if (e && ["rate_limited", "image_base64_required", "unsupported_image_type", "image_too_large", "invalid_json"].includes(e.code)) throw e;
    }
    if (v2) hdrP = Promise.resolve(r.header || null);
    else {
      hdrP = call("read-prescription-header", { image_base64: b64, mime_type: "image/jpeg" }).then((x) => (x && x.header) || null).catch(() => null);
      r = await call("read-prescription", { image_base64: b64, mime_type: "image/jpeg" });
    }
    if (token !== polling) return;
    const items = Array.isArray(r.items) ? r.items : [];
    if (!items.length) {
      if (scan) scan.stop(); st.set("read", "bad", "مش باين في الصورة أسطر روشتة مقروءة");
      st.lines("read", [["اللي حصل", "القراءة خلصت بس مفيش أسماء أدوية مقروءة. صوّر الروشتة كاملة وبإضاءة كويسة."]]);
      imgErr("مفيش أسماء أدوية مقروءة في الصورة. صوّر الروشتة كاملة وبإضاءة كويسة.");
      return;
    }
    const matched = items.filter((x) => x.match_status === "matched").length;
    st.set("read", "done", "اتقرا " + items.length + " سطر، " + matched + " مطابق في السجل");
    st.lines("read", [["عدد الأسطر", items.length], ["مطابق في السجل", matched], ["وضوح الخط", RX_LEG[r.overall_legibility] || ""], ["تنبيه", "قراءة آلية وممكن تغلط في حرف أو رقم. اقرأ وراجع الجرعة والشكل الدوائي في كل سطر قبل الصرف."]]);
    st.set("resolve", "run", "جاري مطابقة الأسماء مع السجل…");
    if (v2) rxSigCur = { res: { map: new Map((r.sig_items || []).map((x) => [x.line_no, x])), error: null }, p: Promise.resolve() }; // طريقة الاستعمال جاية جاهزة من نفس القراءة
    else { const sc = { res: null, p: null }; sc.p = rxSig(b64, items).then((x) => (sc.res = x)); rxSigCur = sc; } // المسار القديم: طريقة الاستعمال بالتوازي، ومش بنستناها
    const rs = await rxResolve(b64, items);
    if (token !== polling) return;
    if (rs.error) { st.set("resolve", "bad", "المطابقة التانية ما اشتغلتش، فعرضنا القراءة العادية"); st.lines("resolve", [["السبب", rs.error]]); }
    else st.set("resolve", "done", "اتطابقت الأسماء" + (rs.ms ? " (" + Math.round(rs.ms / 1000) + " ث)" : ""));
    const out = $("out"); out.replaceChildren(); hideSkeleton();
    // قايمة الخطوات بتختفي أول ما النتايج تظهر (لو المطابقة التانية فشلت بنسيب تنبيه واحد بس)
    box.replaceChildren(); if (rs.error) box.append(el("div", "scan-msg warn", "المطابقة التانية ما اشتغلتش، فعرضنا القراءة العادية."));
    const hbox = el("div", "rx-info-slot"); out.append(hbox); // مكان بيانات الروشتة: بتتملي لما توصل
    hdrP.then((h) => { if (token !== polling || !h) return; const c = rxInfoCard(h); if (c) hbox.append(c); });
    out.append(el("h3", "sec rx-sec-mid", "الأدوية المقروءة من الروشتة (" + items.length + ")"));
    rxSetImage(f);
    if (!items.some((it) => Array.isArray(it.name_box) && it.name_box.length === 4)) { const ob = el("button", "rx-go", "فتح الروشتة الأصلية"); ob.type = "button"; ob.addEventListener("click", () => rxViewer(null)); out.append(ob); } // لو مفيش قصاصات، زر واحد يفتح الصورة
    const pages = el("div", "rx-pages"); out.append(pages);
    const boxes = items.map((it, i) => {
      const n = it.line_no || i + 1, w = el("section", "rx-block");
      const run = rxLine(w, it, n, rs.map.get(it.line_no || i + 1) || null, token, r.overall_legibility === "poor");
      pages.append(w);
      return { it, run, w };
    });
    rxPager(pages, boxes.map((o) => o.w), items);
    { let i = 0; const worker = async () => { while (i < boxes.length && token === polling) { const o = boxes[i++]; await o.run(); } }; Promise.all([worker(), worker(), worker()]); } // 3 بحث في نفس الوقت
    quiet();
  } catch (err) {
    if (scan) scan.stop();
    st.fail("حصلت مشكلة في الخطوة دي", [["كود الخطأ", (err && (err.code || err.message)) || "unknown"]]);
    const code = (err && (err.code || err.message)) || "unknown";
    const known = ERR[err && err.code];
    imgErr(known || "ما قدرناش نقرا الروشتة دلوقتي (" + code + "). الصورة لسه موجودة، اضغط «حاول تاني».");
    if (token === polling) { // زر يعيد القراءة بنفس الصورة من غير ما تصوّر تاني
      const rb = el("button", "ip-retry-rx", "حاول تاني"); rb.type = "button";
      rb.addEventListener("click", () => handleRx(f));
      const o = $("out"); o.replaceChildren(el("div", "scan-msg warn", "فشلت قراءة الروشتة (" + code + "). أعد المحاولة."), rb);
    }
  } finally { busy(false); }
}

[camIn, galIn].forEach((inp) => inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.value = ""; handle(f); }));
})();

// ===== فاتورة الروشتة: بتجمع المنتجات اللي اخترتها من نتايج الروشتة وتحسب الإجمالي (علبة / شريط) =====
// السعر من دليل الأسعار (current_price = سعر العلبة). major_unit_qty = عدد الشرايط (أو الأمبولات/الأكياس) في العلبة.
(() => {
  const KEY = "rxcart.v1";
  const r2 = (x) => Math.round(x * 100) / 100;
  const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const money = (v) => Number(v).toLocaleString("ar-EG", { maximumFractionDigits: 2 }) + " ج.م";
  const cnt = (v) => Number(v).toLocaleString("ar-EG");
  const subLabel = (t) => /amp|أمبول|امبول/i.test(t) ? "أمبولة" : /vial|فيال/i.test(t) ? "فيال" : /sachet|كيس|اكياس|أكياس/i.test(t) ? "كيس" : /tab|cap|قرص|أقراص|اقراص|كبسول/i.test(t) ? "شريط" : "وحدة";
  const valid = (l) => l && typeof l.id === "string" && typeof l.name === "string" && num(l.price) !== null && l.price > 0
    && Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= 999 && Number.isInteger(l.major) && l.major >= 1 && (l.unit === "box" || l.unit === "sub");
  let lines = [], discount = 0;
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (s && Array.isArray(s.lines)) lines = s.lines.filter(valid);
    if (s && num(s.discount) !== null) discount = Math.min(100, Math.max(0, s.discount));
  } catch { /* مفيش تخزين: الفاتورة بتفضل في الصفحة بس */ }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ lines, discount })); } catch { /* ignore */ } };

  const unitPrice = (l) => (l.unit === "sub" && l.major > 1 ? l.price / l.major : l.price);
  const lineTotal = (l) => r2(l.qty * unitPrice(l));
  const unitName = (l) => (l.unit === "sub" ? l.sub : "علبة");
  const totals = () => { const sub = r2(lines.reduce((a, l) => a + lineTotal(l), 0)); const d = r2(sub * discount / 100); return { sub, d, total: r2(sub - d) }; };
  const idOf = (p) => String(p.dwaprices_id != null ? p.dwaprices_id : p.id != null ? p.id : p.product_name);
  // المواد الفعّالة للمنتج (لفحص التفاعلات): من product_ingredients لو موجودة، وإلا من scientific_name مفصولة بـ +
  const ingsOf = (p) => {
    const a = (p.product_ingredients || []).map((pi) => pi && pi.active_ingredients && pi.active_ingredients.inn).filter(Boolean);
    const b = a.length ? a : String(p.scientific_name || "").split("+");
    return [...new Set(b.map((x) => String(x).trim().slice(0, 100)).filter(Boolean))].slice(0, 8);
  };

  const st = document.createElement("style");
  st.textContent = ".rxc-add{width:100%;min-height:44px;margin-top:10px;border-radius:12px;border:1px solid var(--accent);background:var(--soft);color:var(--soft-ink);font:inherit;font-weight:600;cursor:pointer}"
    + ".rxc-add.rxc-mini{display:flex;align-items:center;justify-content:center;width:auto;min-height:38px;margin-top:6px;padding:0 12px;font-size:13.5px}"
    + ".rxc-add.in{background:var(--ok-bg);color:var(--ok);border-color:var(--ok)}"
    + ".rxc-bar{position:fixed;z-index:40;inset-inline:12px;bottom:calc(var(--bot) + 12px);max-width:736px;margin-inline:auto;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;padding:8px 18px;border:0;border-radius:18px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;box-shadow:0 6px 22px rgba(0,0,0,.25);cursor:pointer}"
    + ".rxc-bar[hidden]{display:none}.rxc-bar b{font-size:18px}"
    + "body.rxc-on main{padding-bottom:calc(100px + var(--bot))}"
    + ".rxc-ov{position:fixed;inset:0;z-index:70;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.5)}"
    + ".rxc-sheet{width:100%;max-width:760px;max-height:88dvh;display:flex;flex-direction:column;background:var(--surface);color:var(--ink);border-radius:22px 22px 0 0;padding:16px 16px calc(16px + var(--bot))}"
    + ".rxc-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.rxc-head h3{margin:0;font-size:18px}"
    + ".rxc-x{min-width:44px;min-height:44px;border:0;border-radius:12px;background:var(--bg);color:var(--ink);font:inherit;font-size:20px;cursor:pointer}"
    + ".rxc-list{overflow:auto;flex:1;min-height:60px;margin:0 -4px;padding:0 4px}"
    + ".rxc-row{border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin-bottom:10px;background:var(--bg)}"
    + ".rxc-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.rxc-name{font-weight:600;line-height:1.4}"
    + ".rxc-del{flex:none;min-width:40px;min-height:40px;border:0;border-radius:10px;background:var(--bad-bg);color:var(--bad);font:inherit;cursor:pointer}"
    + ".rxc-sub{color:var(--muted);font-size:13px;margin:2px 0 8px}"
    + ".rxc-ctl{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}"
    + ".rxc-seg{display:inline-flex;border:1px solid var(--line);border-radius:12px;overflow:hidden}"
    + ".rxc-seg button{min-height:40px;padding:0 14px;border:0;background:var(--surface);color:var(--ink);font:inherit;cursor:pointer}"
    + ".rxc-seg button.on{background:var(--accent);color:var(--accent-ink);font-weight:600}"
    + ".rxc-step{display:inline-flex;align-items:center;gap:4px}.rxc-step button{min-width:40px;min-height:40px;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:inherit;font-size:20px;cursor:pointer}"
    + ".rxc-step span{min-width:34px;text-align:center;font-weight:600}"
    + ".rxc-lt{font-weight:700;color:var(--soft-ink)}"
    + ".rxc-disc{display:flex;align-items:center;gap:10px;margin:6px 0}.rxc-disc input{width:84px;min-height:40px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit;padding:0 10px;text-align:center}"
    + ".rxc-tot{margin:6px 0 10px;padding:12px 14px;border-radius:14px;background:var(--soft);display:flex;flex-direction:column;gap:4px}"
    + ".rxc-tot div{display:flex;justify-content:space-between;color:var(--muted);font-size:14px}.rxc-tot div.g{color:var(--soft-ink);font-size:20px;font-weight:700}"
    + ".rxc-note{color:var(--muted);font-size:12.5px;margin:0 0 10px}"
    + ".rxc-ddi{width:100%;min-height:46px;margin:0 0 10px;border-radius:12px;border:1px solid var(--warn);background:var(--warn-bg);color:var(--warn);font:inherit;font-weight:600;cursor:pointer}"
    + ".rxc-acts{display:flex;gap:10px}.rxc-acts button{flex:1;min-height:46px;border-radius:12px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink)}"
    + ".rxc-acts button.sec{background:transparent;color:var(--accent)}.rxc-empty{text-align:center;color:var(--muted);padding:26px 0}";
  document.head.append(st);

  const lbl = (l, mini) => (mini ? (l ? "✓ في الفاتورة ×" + cnt(l.qty) : "＋ للفاتورة") : (l ? "✓ في الفاتورة (×" + cnt(l.qty) + ") — اضغط للزيادة" : "＋ أضف للفاتورة"));
  const btns = new Map(); // id -> أزرار «أضف للفاتورة» الظاهرة في الصفحة
  let bar = null, ov = null, listBox = null, totBox = null, discIn = null, clearBtn = null, clearT = 0;

  function syncBtns() {
    btns.forEach((set, id) => {
      const l = lines.find((x) => x.id === id);
      set.forEach((b) => {
        if (!b.isConnected) { set.delete(b); return; }
        b.classList.toggle("in", !!l);
        b.textContent = lbl(l, b.dataset.mini === "1");
      });
    });
  }
  function paintBar() {
    if (!bar) { bar = el("button", "rxc-bar"); bar.type = "button"; bar.hidden = true; bar.addEventListener("click", openSheet); document.body.append(bar); }
    const n = lines.length;
    bar.hidden = n === 0 || !!ov;
    document.body.classList.toggle("rxc-on", n > 0);
    bar.replaceChildren(el("span", null, "الفاتورة · " + cnt(n) + " صنف"), el("b", null, "الإجمالي " + money(totals().total)));
  }
  function paintTotals() {
    if (!totBox) return;
    const t = totals();
    const rows = [["المجموع", money(t.sub)]];
    if (discount > 0) rows.push(["الخصم (" + cnt(discount) + "%)", "− " + money(t.d)]);
    totBox.replaceChildren(...rows.map(([a, b]) => { const d = el("div"); d.append(el("span", null, a), el("span", null, b)); return d; }));
    const g = el("div", "g"); g.append(el("span", null, "الإجمالي"), el("span", null, money(t.total))); totBox.append(g);
  }
  function paintList() {
    if (!listBox) return;
    if (!lines.length) { listBox.replaceChildren(el("div", "rxc-empty", "الفاتورة فاضية. اختار منتجات من نتايج الروشتة.")); paintTotals(); return; }
    listBox.replaceChildren(...lines.map((l) => {
      const row = el("div", "rxc-row");
      const top = el("div", "rxc-top"), nm = el("div", "rxc-name", l.name); nm.dir = "auto";
      const del = el("button", "rxc-del", "حذف"); del.type = "button"; del.setAttribute("aria-label", "حذف " + l.name);
      del.addEventListener("click", () => { lines = lines.filter((x) => x !== l); changed(); });
      top.append(nm, del);
      row.append(top, el("div", "rxc-sub", money(unitPrice(l)) + " لل" + unitName(l) + (l.major > 1 ? " · العلبة " + money(l.price) + " فيها " + cnt(l.major) + " " + l.sub : "")));
      const ctl = el("div", "rxc-ctl");
      if (l.major > 1) {
        const seg = el("div", "rxc-seg");
        [["box", "علبة"], ["sub", l.sub]].forEach(([u, t]) => {
          const b = el("button", l.unit === u ? "on" : "", t); b.type = "button"; b.setAttribute("aria-pressed", String(l.unit === u));
          b.addEventListener("click", () => { l.unit = u; changed(); });
          seg.append(b);
        });
        ctl.append(seg);
      }
      const step = el("div", "rxc-step");
      const minus = el("button", null, "−"), plus = el("button", null, "+");
      minus.type = plus.type = "button"; minus.setAttribute("aria-label", "نقّص"); plus.setAttribute("aria-label", "زوّد");
      minus.addEventListener("click", () => { if (l.qty > 1) l.qty--; else lines = lines.filter((x) => x !== l); changed(); });
      plus.addEventListener("click", () => { if (l.qty < 999) l.qty++; changed(); });
      step.append(minus, el("span", null, cnt(l.qty)), plus);
      ctl.append(step, el("span", "rxc-lt", money(lineTotal(l))));
      row.append(ctl);
      return row;
    }));
    paintTotals();
  }
  function changed() { save(); paintBar(); paintList(); syncBtns(); }

  function invoiceText() {
    const t = totals();
    const out = ["فاتورة تقديرية"];
    lines.forEach((l, i) => out.push(cnt(i + 1) + ") " + l.name + " — " + cnt(l.qty) + " " + unitName(l) + " × " + money(unitPrice(l)) + " = " + money(lineTotal(l))));
    out.push("المجموع: " + money(t.sub));
    if (discount > 0) out.push("الخصم (" + cnt(discount) + "%): − " + money(t.d));
    out.push("الإجمالي: " + money(t.total), "الأسعار من دليل الأسعار وممكن تختلف عن سعر الصيدلية.");
    return out.join("\n");
  }
  async function copyInvoice() {
    const txt = invoiceText();
    try { await navigator.clipboard.writeText(txt); toast("success", "اتنسخت الفاتورة."); return; } catch { /* نجرّب الطريقة القديمة */ }
    try {
      const ta = document.createElement("textarea"); ta.value = txt; ta.style.cssText = "position:fixed;opacity:0"; document.body.append(ta); ta.select();
      const ok = document.execCommand("copy"); ta.remove();
      toast(ok ? "success" : "error", ok ? "اتنسخت الفاتورة." : "تعذّر النسخ.");
    } catch { toast("error", "تعذّر النسخ."); }
  }

  function closeSheet() { if (!ov) return; ov.remove(); ov = listBox = totBox = discIn = clearBtn = null; document.removeEventListener("keydown", onKey); paintBar(); }
  function onKey(e) { if (e.key === "Escape") closeSheet(); }
  function openSheet() {
    if (ov) return;
    ov = el("div", "rxc-ov"); ov.addEventListener("click", (e) => { if (e.target === ov) closeSheet(); });
    const sh = el("div", "rxc-sheet"); sh.setAttribute("role", "dialog"); sh.setAttribute("aria-modal", "true"); sh.setAttribute("aria-label", "الفاتورة");
    const head = el("div", "rxc-head"), x = el("button", "rxc-x", "✕"); x.type = "button"; x.setAttribute("aria-label", "إغلاق"); x.addEventListener("click", closeSheet);
    head.append(el("h3", null, "فاتورة الروشتة"), x);
    listBox = el("div", "rxc-list"); totBox = el("div", "rxc-tot");
    const dr = el("label", "rxc-disc"); discIn = el("input"); discIn.type = "number"; discIn.min = "0"; discIn.max = "100"; discIn.step = "any"; discIn.inputMode = "decimal"; discIn.value = discount ? String(discount) : "";
    discIn.placeholder = "٠";
    discIn.addEventListener("input", () => { const n = num(discIn.value); discount = n === null ? 0 : Math.min(100, Math.max(0, n)); save(); paintTotals(); paintBar(); });
    dr.append(el("span", null, "خصم %"), discIn);
    const acts = el("div", "rxc-acts");
    const cp = el("button", null, "نسخ الفاتورة"); cp.type = "button"; cp.addEventListener("click", copyInvoice);
    clearBtn = el("button", "sec", "مسح الكل"); clearBtn.type = "button";
    clearBtn.addEventListener("click", () => {
      if (!lines.length) return;
      if (clearBtn.dataset.sure !== "1") { clearBtn.dataset.sure = "1"; clearBtn.textContent = "اضغط تاني للتأكيد"; clearTimeout(clearT); clearT = setTimeout(() => { if (clearBtn) { clearBtn.dataset.sure = ""; clearBtn.textContent = "مسح الكل"; } }, 3000); return; }
      lines = []; discount = 0; if (discIn) discIn.value = ""; clearBtn.dataset.sure = ""; clearBtn.textContent = "مسح الكل"; changed();
    });
    acts.append(cp, clearBtn);
    const ddi = el("button", "rxc-ddi", "فحص التفاعلات بين الأدوية"); ddi.type = "button";
    ddi.addEventListener("click", () => {
      const ok = lines.filter((l) => Array.isArray(l.ings) && l.ings.length);
      if (ok.length < 2) { toast("warn", lines.length < 2 ? "ضيف دوائين على الأقل للفاتورة الأول." : "المواد الفعّالة غير معروفة لأدوية الفاتورة. أضفها تاني من نتايج الروشتة."); return; }
      if (window.DDI) window.DDI.open(ok.map((l) => ({ label: l.name, ingredients: l.ings, kind: l.kind || null })));
    });
    sh.append(head, listBox, dr, totBox, el("p", "rxc-note", "الأسعار من دليل الأسعار وممكن تختلف عن سعر الصيدلية، والتوفر غير متحقق منه."), ddi, acts);
    ov.append(sh); document.body.append(ov); document.addEventListener("keydown", onKey);
    paintBar(); paintList(); x.focus();
  }

  function add(p) {
    const price = num(p.current_price != null ? p.current_price : p.price);
    if (price === null || price <= 0) return false;
    const id = idOf(p), ex = lines.find((l) => l.id === id);
    if (ex) { if (ex.qty < 999) ex.qty++; if (!ex.ings) ex.ings = ingsOf(p); if (!ex.kind && String(p.product_class || "").toLowerCase() === "supplement") ex.kind = "supplement"; } else {
      let major = num(p.major_unit_qty), minor = num(p.minor_unit_qty);
      major = major && major > 1 && (minor === null || major <= minor) ? Math.round(major) : 1; // عدد الشرايط في العلبة (1 = مفيش تقسيم)
      lines.push({ id, name: String(p.product_name || "").slice(0, 120), price, major, sub: subLabel((p.dosage_form || "") + " " + (p.product_name || "")), unit: "box", qty: 1, ings: ingsOf(p), kind: String(p.product_class || "").toLowerCase() === "supplement" ? "supplement" : null });
    }
    changed();
    return true;
  }
  // mini = جوه بلاطة منتج الروشتة (هي نفسها زرار بيفتح صفحة المنتج، فالإضافة span بدور زرار ومش بتفتح الصفحة)
  function addBtn(p, mini) {
    const price = num(p.current_price != null ? p.current_price : p.price);
    if (price === null || price <= 0) return null; // مفيش سعر: مفيش إضافة للفاتورة
    const id = idOf(p), b = el(mini ? "span" : "button", "rxc-add" + (mini ? " rxc-mini" : ""), lbl(null, !!mini));
    if (mini) { b.dataset.mini = "1"; b.setAttribute("role", "button"); b.tabIndex = 0; } else b.type = "button";
    const go = (e) => { e.stopPropagation(); add(p); };
    b.addEventListener("click", go);
    if (mini) b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } });
    if (!btns.has(id)) btns.set(id, new Set());
    btns.get(id).add(b);
    queueMicrotask(syncBtns);
    return b;
  }
  window.rxCart = { addBtn, add, open: openSheet, count: () => lines.length };
  paintBar();
})();
