/* image-search.js — البحث بصورة المنتج: كاميرا أو معرض. النتيجة = نفس المنتج في الصورة بنفس التركيز والشكل
   (الفلترة في الباك اند: match.exact_ids).
   بيعتمد على: core.js, render.js (card), search.js (polling, clearMore), وكلاس .scan-btn من scanner.js. */
(() => {
"use strict";
const MAX_SIDE = 1280;
ERR.vision_unavailable = "قراءة الصورة مش متاحة دلوقتي. جرّب تاني بعد شوية.";
ERR.vision_bad_output = "ما قدرناش نقرا الصورة. جرّب صورة أوضح.";
ERR.invalid_image = "الصورة مش صالحة أو كبيرة قوي. جرّب صورة تانية.";
ERR.invalid_gtin = "الباركود المقروء من الصورة مش صالح.";

const box = $("imgbox");
const fam = el("div"); fam.id = "fam"; fam.setAttribute("aria-live", "polite");
$("out").after(fam); // بعد النتايج مباشرة، وفوق زر البحث في الصيدليات

const mkInput = (capture) => { const i = el("input"); i.type = "file"; i.accept = "image/*"; if (capture) i.setAttribute("capture", "environment"); i.hidden = true; return i; };
const camIn = mkInput(true), galIn = mkInput(false);
const imgBtn = el("button", "scan-btn img-pick", "بحث بصورة"); imgBtn.type = "button";
// ===== صفحة البحث بالصورة (#/img): كاميرا حية جوه الصفحة، أو كاميرا التليفون العادية، أو المعرض. الروشتة قريباً. =====
let built = false, stream = null, camGen = 0;
const ipMsg = el("div", "ip-msg"); ipMsg.hidden = true;
const say = (txt, bad) => { ipMsg.hidden = !txt; ipMsg.textContent = txt || ""; ipMsg.className = "ip-msg" + (bad ? " bad" : ""); };
const video = Object.assign(el("video"), { muted: true, autoplay: true }); video.setAttribute("playsinline", "");
const camBox = el("div", "ip-cam"); camBox.hidden = true; camBox.append(video, el("div", "ip-frame"));
const shotBtn = el("button", "ip-shot", "صوّر وابحث"); shotBtn.type = "button";
const closeBtn = el("button", "ip-close", "إغلاق الكاميرا"); closeBtn.type = "button";
const actions = el("div", "ip-actions"); actions.hidden = true; actions.append(shotBtn, closeBtn);
const row = (cls, text, fn) => { const o = el("button", "img-opt " + cls, text); o.type = "button"; o.addEventListener("click", fn); return o; };
const liveRow = row("cam", "فتح الكاميرا هنا", () => startCam());
const nativeRow = row("cam", "تصوير بكاميرا التليفون", () => camIn.click());
const galRow = row("gal", "استيراد صورة من المعرض", () => galIn.click());
const soon = (cls, text) => { // الروشتة لسه مش شغّالة: الزر مقفول ومكتوب عليه "قريباً" بخط صغير
  const o = el("button", "img-opt " + cls); o.type = "button"; o.disabled = true;
  o.append(el("span", null, text), el("small", "img-soon", "قريباً"));
  return o;
};

function stopCam() {
  camGen++;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; video.srcObject = null;
  camBox.hidden = true; actions.hidden = true; liveRow.hidden = false;
}
async function startCam() {
  say("");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    say("الكاميرا جوه الصفحة مش متاحة في المتصفح ده (محتاجة HTTPS ومتصفح حديث). افتحنا لك كاميرا التليفون العادية.", true);
    camIn.click(); return;
  }
  const gen = ++camGen;
  let s;
  try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
  catch (e) {
    say(e && e.name === "NotAllowedError" ? "مفيش إذن للكاميرا. فعّله من إعدادات المتصفح وجرّب تاني، أو استخدم «تصوير بكاميرا التليفون»." : "تعذّر فتح الكاميرا (" + ((e && e.name) || "unknown") + "). جرّب «تصوير بكاميرا التليفون».", true);
    return;
  }
  if (gen !== camGen) { s.getTracks().forEach((t) => t.stop()); return; }
  stream = s; video.srcObject = s;
  try { await video.play(); } catch { /* هيشتغل أول ما الفريم يجهز */ }
  camBox.hidden = false; actions.hidden = false; liveRow.hidden = true;
}
async function shoot() {
  if (!stream || !video.videoWidth) { say("الكاميرا لسه بتجهز. استنى ثانية وجرّب تاني.", true); return; }
  const cv = document.createElement("canvas"); cv.width = video.videoWidth; cv.height = video.videoHeight;
  const ctx = cv.getContext("2d"); if (!ctx) { say("تعذّر التقاط الصورة.", true); return; }
  ctx.drawImage(video, 0, 0, cv.width, cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.9));
  stopCam();
  if (!blob) { say("تعذّر التقاط الصورة.", true); return; }
  handle(new File([blob], "photo.jpg", { type: "image/jpeg" }));
}
shotBtn.addEventListener("click", shoot);
closeBtn.addEventListener("click", stopCam);
document.addEventListener("visibilitychange", () => { if (document.hidden) stopCam(); });

window.imageLeave = stopCam;
window.imagePage = () => {
  const pg = $("imgpage");
  if (!built) {
    built = true;
    const c1 = el("div", "ip-card"), c2 = el("div", "ip-card");
    c1.append(el("h2", "ip-h", "صورة المنتج"), camBox, actions, ipMsg, liveRow, nativeRow, galRow,
      el("p", "ip-tip", "صوّر العلبة من قدّام وبإضاءة كويسة، وخلّي الاسم والتركيز باينين."));
    c2.append(el("h2", "ip-h", "الروشتة"), soon("cam", "تصوير الروشتة بالكاميرا"), soon("gal", "استيراد صورة الروشتة من المعرض"));
    pg.append(c1, c2);
  }
  say("");
};
imgBtn.addEventListener("click", () => { if (window.openImagePage) window.openImagePage(); else location.hash = "#/img"; });
$("f").append(imgBtn, camIn, galIn);
const busy = (v) => { imgBtn.disabled = v; };

// أي بحث مش جاي من الصورة بيمسح صندوق العائلة
$("f").addEventListener("submit", () => { if (!window.__keepImg) fam.replaceChildren(); }, true);

async function toJpegBase64(f) {
  let src, w0, h0;
  try { src = await createImageBitmap(f, { imageOrientation: "from-image" }); w0 = src.width; h0 = src.height; }
  catch {
    src = await new Promise((res, rej) => { const u = URL.createObjectURL(f), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error("image_decode_failed")); }; im.src = u; });
    w0 = src.naturalWidth; h0 = src.naturalHeight;
  }
  if (!w0 || !h0) throw new Error("image_decode_failed");
  const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const cv = document.createElement("canvas"); cv.width = Math.round(w0 * k); cv.height = Math.round(h0 * k);
  cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.85));
  if (!blob) throw new Error("image_encode_failed");
  const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("image_read_failed")); fr.readAsDataURL(blob); });
  return String(url).split(",")[1];
}

function readCard(r) {
  const x = r.extracted || {};
  const c = el("div", "read-box");
  c.append(el("h3", null, "اللي اتقرا من الصورة"));
  const dl = el("dl");
  const row = (k, v) => { if (!v) return; dl.append(el("dt", null, k), el("dd", null, v)); };
  row("الاسم", x.brand_name);
  row("الاسم بالعربي", x.arabic_name);
  row("المادة الفعّالة", (x.active_ingredients || []).join("، "));
  row("التركيز", x.strength);
  row("الشكل الدوائي", x.dosage_form);
  row("الشركة", x.manufacturer);
  if (r.barcode_read) row("باركود", (r.gtins || []).length ? r.gtins[0] + " (رقم المراجعة صحيح)" : "اتقرا بس رقم المراجعة مش مطابق، فمش هيتستخدم");
  c.append(dl);
  c.append(el("div", "dose-note", "ده قراءة آلية للصورة وممكن تغلط في حرف أو رقم. قارن الاسم والتركيز بالعلبة نفسها قبل ما تعتمد على أي نتيجة."));
  return c;
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

async function handle(f) {
  if (!f) return;
  if (!/^image\//.test(f.type)) { setStatus("الملف ده مش صورة.", { error: true }); return; }
  const token = ++polling;
  clearMore(); box.replaceChildren(); fam.replaceChildren(); $("out").replaceChildren();
  busy(true); setStatus("جاري قراءة الصورة…"); showSkeleton();
  if (window.showResultsPage) window.showResultsPage("بحث بالصورة"); // من غيرها النتيجة بتتملي في صفحة مخفية
  const ffPrev = window.__ff; window.__ff = ""; // فلتر الشكل الدوائي مش بيأثر على البحث بالصورة
  try {
    const b64 = await toJpegBase64(f);
    const r = await call("drug-image-search", { image: b64, mime: "image/jpeg" });
    if (token !== polling) return;
    box.replaceChildren(readCard(r));
    const x = r.extracted || {};
    if (!x.is_medicine_pack) { setStatus("مش باين في الصورة علبة دواء. صوّر العلبة من قدّام وبإضاءة كويسة.", { error: true }); return; }
    if (!(r.gtins || []).length && !r.search) { setStatus("ما قدرناش نقرا اسم ولا باركود واضح من الصورة. جرّب صورة أقرب وأوضح.", { error: true }); return; }
    if (r.family) famBox(r.family);
    else if (r.search && r.search.type !== "ingredient") famBox({ text: r.search.text });

    // 1) باركود صحيح = نفس المنتج بالظبط
    if ((r.gtins || []).length) {
      try {
        const d = await call("drug-barcode", { gtins: r.gtins });
        if (token !== polling) return;
        if (d.found > 0) {
          const out = $("out");
          out.replaceChildren(el("h3", "sec", "نفس المنتج اللي في الصورة (" + d.found + ")"));
          if (d.ambiguous) out.append(el("div", "scan-msg warn", "الباركود ده مسجّل لأكتر من منتج في المصدر. راجع الاسم والحجم على العبوة."));
          (d.results || []).forEach((p) => out.append(card(p, 1)));
          setStatus("اتعرف على المنتج من الباركود المطبوع في الصورة.");
          toast("success", "اتعرف على المنتج من الباركود.");
          return;
        }
      } catch { /* نكمّل بالاسم */ }
    }

    // 2) الاسم + التركيز + الشكل: الباك اند حدّد مين هو نفس المنتج، ومخفي أي تركيز أو شكل مختلف
    if (!r.search) { setStatus("الباركود المقروء مش موجود في قاعدة البيانات، ومفيش اسم واضح في الصورة نبحث بيه.", { error: true }); return; }
    const d = await call("drug-search", { query: r.search.text, search_type: r.search.type === "ingredient" ? "ingredient" : "brand" });
    if (token !== polling) return;
    const list = (d.tiers && d.tiers.official) || d.results || [];
    const m = r.match || {};
    const out = $("out"); out.replaceChildren();

    if (!Array.isArray(m.exact_ids)) {
      out.append(el("div", "scan-msg warn", "ما قدرناش نتحقق من التركيز والشكل، فالنتايج دي ممكن تكون لمنتجات مشابهة. قارنها بالعلبة."));
      list.forEach((p) => out.append(card(p, 1)));
      setStatus("");
      return;
    }
    const ex = new Set(m.exact_ids), un = new Set(m.unverified_ids || []);
    const exact = list.filter((p) => ex.has(p.dwaprices_id));
    const unv = list.filter((p) => un.has(p.dwaprices_id));
    if (exact.length) {
      out.append(el("h3", "sec", "نفس المنتج اللي في الصورة (" + exact.length + ")"));
      out.append(el("p", "sec-note", "نفس الاسم" + (m.strength_checked ? " والتركيز (" + (m.required_strength || []).join(" + ") + ")" : "") + " والشكل الدوائي."));
      exact.forEach((p) => out.append(card(p, 1)));
      toast("success", "لقينا نفس المنتج اللي في الصورة.");
    } else {
      toast("warn", "ما لقيناش نفس المنتج بنفس التركيز والشكل.");
      out.append(el("div", "scan-msg warn", "ما لقيناش في السجل نفس المنتج بنفس التركيز والشكل."));
    }
    if (unv.length) {
      out.append(el("h3", "sec", "نفس الاسم لكن التركيز مش مكتوب في السجل (" + unv.length + ")"));
      out.append(el("p", "sec-note", "مش قادرين نأكد إنه نفس التركيز. قارنه بالعلبة."));
      unv.forEach((p) => out.append(card(p, 3)));
    }
    if (m.hidden_count > 0) out.append(el("p", "sec-note", "اتخفّى " + m.hidden_count + " منتج بنفس العائلة بتركيز أو شكل أو نوع مختلف. تقدر تشوفهم من البحث بالعائلة تحت."));
    setStatus("");
  } catch (err) {
    const gw = err && err.data && err.data.gateway_error;
    const known = ERR[err && err.code];
    setStatus(known || "حصلت مشكلة في قراءة الصورة (" + ((err && (err.code || err.message)) || "unknown") + (gw ? " / " + gw : "") + ").", { error: true });
  } finally { window.__ff = ffPrev; busy(false); }
}

[camIn, galIn].forEach((inp) => inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.value = ""; handle(f); }));
})();
