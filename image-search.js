/* image-search.js — البحث بصورة المنتج: كاميرا أو معرض. النتيجة = نفس المنتج في الصورة بنفس التركيز والشكل
   (الفلترة في الباك اند: match.exact_ids).
   بيعتمد على: core.js, render.js (card), search.js (polling, clearMore), وكلاس .scan-btn من scanner.js. */
(() => {
"use strict";
const MAX_SIDE = 1280;
let lastShot = { w: 0, h: 0 };
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
// ===== صفحة البحث بالصورة (#/img): من غير كاميرا جوه الصفحة. كاميرا الجوال الأصلية بتفتح (input capture) أو المعرض. =====
let built = false;
const ipMsg = el("div", "ip-msg"); ipMsg.hidden = true;
const say = (txt, bad) => { ipMsg.hidden = !txt; ipMsg.textContent = txt || ""; ipMsg.className = "ip-msg" + (bad ? " bad" : ""); };
const camRow = el("button", "img-opt cam", "صوّر بكاميرا الجوال"); camRow.type = "button";
camRow.addEventListener("click", () => camIn.click());
const galRow = el("button", "img-opt gal", "اختيار صورة من المعرض"); galRow.type = "button";
galRow.addEventListener("click", () => galIn.click());

window.imageLeave = () => {};
window.imagePage = () => {
  const pg = $("imgpage");
  if (!built) {
    built = true;
    const c = el("div", "ip-card");
    c.append(camRow, galRow, el("p", "ip-tip", "صوّر العلبة من قدّام وبإضاءة كويسة، وخلّي الاسم والتركيز باينين."));
    pg.append(ipMsg, c);
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
  lastShot = { w: cv.width, h: cv.height };
  cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.85));
  if (!blob) throw new Error("image_encode_failed");
  const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("image_read_failed")); fr.readAsDataURL(blob); });
  return String(url).split(",")[1];
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

[camIn, galIn].forEach((inp) => inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.value = ""; handle(f); }));
})();
