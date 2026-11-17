/* ingredient-class.js — التصنيف المختصر جنب كل مادة فعّالة، ولما تدوس على المادة بتظهر تفاصيل الكلاس.
   البيانات من دالة ingredient-class (action "get") على Supabase، وهي اللي بتقرا من openFDA بمفتاح FDA_key_1 على السيرفر
   (المفتاح عمره ما بيوصل للمتصفح). هنا بنعرض اللي متخزّن بس، ومبنخترعش أي معلومة.
   الملء عند الطلب: المواد اللي ملهاش تصنيف متخزّن بتتبعت لدالة ingredient-class (action "fill_for") في الخلفية بعد ما النتايج تظهر،
   والشارة بتظهر أول ما يوصل التصنيف. الدالة بترفض أي اسم مش موجود في قاعدة البيانات، والمفتاح فضل على السيرفر.
   بيدوّر على أي <li data-ing="اسم المادة"> بيتحط في الصفحة (render.js بيعلّمها).
   ⚠ لازم يتحمّل بعد core.js وقبل barcode-live.js. */
(() => {
"use strict";
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const cache = new Map();      // اسم مُطبَّع -> العنصر الراجع من السيرفر، أو null لو مفيش بيانات
const inflight = new Map();   // اسم مُطبَّع -> Promise
const clean = (s) => String(s || "").replace(/\s*\[(EPC|MoA|PE|CS)\]\s*$/i, "").trim();

// ---- تنظيم نص ملصق FDA (عناوين + نقط + جدول الجرعات) وزرار الترجمة ----
const LBL_HEADS = ["Warnings", "Directions", "Uses", "Purpose", "Active ingredients?", "Inactive ingredients",
  "Do not use", "Ask a doctor or pharmacist before use if you are", "Ask a doctor before use if you have",
  "When using this product", "Stop use and ask a doctor if"];
const LBL_BREAKS = ["If pregnant or breast-feeding", "Keep out of reach of children", "In case of overdose"];
const LBL_ROWS = ["adults and children 12 years and over", "children 6 to under 12 years", "children under 6 years", "children 2 to under 6 years", "adults"];
function labelStructure(raw) {
  let t = String(raw || "").replace(/[\u25A0\u25AA\u25AB\u2022\u25CF]/g, "▪").replace(/\s+/g, " ").trim(); // openFDA بيستخدم ■ (U+25A0) كنقطة
  LBL_HEADS.forEach((h) => { t = t.replace(new RegExp("(^|[\\s.:])(" + h + ")(?=\\s|:|$)", "g"), "$1\n##$2\n"); });
  LBL_BREAKS.forEach((h) => { t = t.replace(new RegExp("(^|[\\s.])(" + h + ")(?=[\\s,.:]|$)", "g"), "$1\n$2"); });
  if (/\bage\s+Dose\b/i.test(t)) {
    t = t.replace(/\bage\s+Dose\b/i, "\n##age Dose\n");
    LBL_ROWS.forEach((r) => { t = t.replace(new RegExp("(^|[\\s\\n])(" + r + ")(?=\\s+(?:\\d|do not))", "gi"), "$1\n▪ $2"); });
  }
  t = t.replace(/\s*▪\s*/g, "\n▪ ");
  return t.split("\n").map((x) => x.trim()).filter(Boolean).join("\n");
}
function labelNodes(struct) {
  const frag = document.createDocumentFragment(); let ul = null;
  String(struct).split("\n").forEach((line) => {
    if (line.startsWith("##")) { ul = null; frag.append(el("h5", "ing-h", line.slice(2).trim())); }
    else if (line.startsWith("▪")) { if (!ul) { ul = el("ul", "ing-ul"); frag.append(ul); } ul.append(el("li", null, line.slice(1).trim())); }
    else { ul = null; frag.append(el("p", "ing-p", line)); }
  });
  return frag;
}
function labelBlock(textEn, textAr) {
  const wrap = el("div", "ing-lblwrap");
  const struct = labelStructure(textEn);
  const box = el("div", "ing-lbl"); box.dir = "ltr"; box.append(labelNodes(struct));
  const btn = el("button", "ing-tr-btn", "🌐 ترجمة للعربي"); btn.type = "button";
  const note = el("p", "meta ing-src", ""); note.hidden = true;
  let ar = textAr ? labelStructure(textAr) : null, showAr = false;
  const show = (isAr) => {
    showAr = isAr; box.replaceChildren(labelNodes(isAr ? ar : struct)); box.dir = isAr ? "rtl" : "ltr";
    btn.textContent = isAr ? "↩ النص الأصلي (English)" : "🌐 ترجمة للعربي";
    note.hidden = !isAr; note.textContent = "ترجمة آلية للنص الأصلي، الأرقام والجرعات متطابقة معاه. الأصل بالإنجليزي هو المرجع.";
  };
  btn.addEventListener("click", async () => {
    if (showAr) return show(false);
    if (ar) return show(true);
    btn.disabled = true; btn.textContent = "...جاري الترجمة";
    try { const r = await call("translate-label", { text: struct, target: "ar" }); ar = String(r.text || ""); show(true); }
    catch (e) {
      btn.textContent = e && e.code === "rate_limited" ? "حاول بعد دقيقة" : e && (e.code === "numbers_mismatch" || e.code === "not_translated") ? "الترجمة مش دقيقة كفاية واترفضت، اقرأ الأصل" : "تعذّرت الترجمة، حاول تاني";
      setTimeout(() => { if (!showAr) btn.textContent = "🌐 ترجمة للعربي"; }, 3500);
    }
    btn.disabled = false;
  });
  wrap.append(btn, box, note);
  return wrap;
}

// ---- كارت RxClass: الاستخدامات والوقاية والموانع (MED-RT) ----
// الأسماء إنجليزي (MeSH). لو name_ar متخزّن بيظهر، وغير كده زرار ترجمة بيترجم الأسماء كلها في طلب واحد (دالة translate-label).
const RX_GROUPS = [["indications", "الاستخدامات"], ["prevention", "الوقاية"], ["contraindications", "موانع الاستعمال"]];
function rxCard(rx) {
  const groups = RX_GROUPS.map(([k, t]) => [k, t, (Array.isArray(rx[k]) ? rx[k] : []).filter((x) => x && x.name)]).filter((g) => g[2].length);
  if (!groups.length) return null;
  const d = el("details", "ing-sec ing-rx"); d.append(el("summary", null, "الاستخدامات والموانع (RxClass)"));
  const body = el("div", "ing-rx-body");
  const btn = el("button", "ing-tr-btn", "🌐 ترجمة الأسماء للعربي"); btn.type = "button";
  const note = el("p", "meta ing-src", ""); note.hidden = true;
  const lis = []; // [{li, item}]
  groups.forEach(([k, title, items]) => {
    body.append(el("h5", "ing-h" + (k === "contraindications" ? " ing-h-warn" : ""), title));
    const ul = el("ul", "ing-ul");
    items.forEach((x) => { const li = el("li", null, x.name_ar || x.name); li.dir = x.name_ar ? "rtl" : "ltr"; ul.append(li); lis.push({ li, x }); });
    body.append(ul);
  });
  const allAr = lis.every(({ x }) => x.name_ar);
  let ar = null, showAr = allAr;
  const apply = (isAr) => {
    showAr = isAr;
    lis.forEach(({ li, x }, i) => { const t = isAr ? (x.name_ar || (ar && ar[i]) || x.name) : x.name; li.textContent = t; li.dir = isAr && (x.name_ar || (ar && ar[i])) ? "rtl" : "ltr"; });
    btn.textContent = isAr ? "↩ الأسماء بالإنجليزي" : "🌐 ترجمة الأسماء للعربي";
    note.hidden = !isAr || allAr; note.textContent = "ترجمة آلية لأسماء الأمراض، والأصل بالإنجليزي هو المرجع.";
  };
  if (!allAr) {
    btn.addEventListener("click", async () => {
      if (showAr) return apply(false);
      if (ar) return apply(true);
      btn.disabled = true; btn.textContent = "...جاري الترجمة";
      try {
        const r = await call("translate-label", { text: lis.map(({ x }) => "▪ " + x.name).join("\n"), target: "ar" });
        const out = String(r.text || "").split("\n").map((l) => l.replace(/^\s*[▪■•]\s*/, "").trim()).filter(Boolean);
        if (out.length !== lis.length) throw Object.assign(new Error("lines"), { code: "not_translated" });
        ar = out; apply(true);
      } catch (e) {
        btn.textContent = e && e.code === "rate_limited" ? "حاول بعد دقيقة" : "تعذّرت الترجمة، حاول تاني";
        setTimeout(() => { if (!showAr) btn.textContent = "🌐 ترجمة الأسماء للعربي"; }, 3500);
      }
      btn.disabled = false;
    });
    body.prepend(btn);
  }
  body.append(note);
  if (groups.some((g) => g[0] === "contraindications")) {
    body.append(el("p", "meta ing-src ing-rx-warn", "⚠ الموانع دي على مستوى المادة الفعّالة من المصدر وما اتراجعتش بواسطة صيدلي. بعضها ممكن يخص منتجات مركّبة (مادة + مادة تانية)، فراجع نشرة المنتج قبل الاعتماد عليها."));
  }
  body.append(el("p", "meta ing-src", "المصدر: " + (rx.source || "RxClass (MED-RT)") + ". " + (rx.note_ar || "")));
  d.append(body);
  return d;
}

async function load(names) {
  const all = [...new Set(names.map(norm))].filter(Boolean);
  const waits = all.map((n) => inflight.get(n)).filter(Boolean);
  const need = all.filter((n) => !cache.has(n) && !inflight.has(n));
  if (!need.length) { await Promise.all(waits); return; }
  const p = (async () => {
    for (let i = 0; i < need.length; i += 40) {
      const part = need.slice(i, i + 40);
      try {
        const r = await call("ingredient-class", { action: "get", names: part });
        const items = (r && r.items) || {};
        part.forEach((n) => cache.set(n, items[n] || null));
        queueFill(part.filter((n) => !items[n])); // مفيش صف أصلًا -> املاه في الخلفية
      } catch { /* من غير تصنيف: الصفحة بتشتغل عادي */ part.forEach((n) => cache.set(n, null)); }
    }
  })();
  need.forEach((n) => inflight.set(n, p));
  try { await Promise.all([p, ...waits]); } finally { need.forEach((n) => inflight.delete(n)); }
}


// ---- الملء في الخلفية بعد ظهور النتايج ----
const tried = new Set();      // أسماء اتحاولت في الجلسة دي (مش هنعيدها)
const refreshers = new Map(); // اسم مُطبَّع -> دوال بتحدّث الشارة/اللوحة لما التصنيف يوصل
let fillQueue = [], filling = false, fillBlockedUntil = 0;
function queueFill(names) {
  names.forEach((n) => { if (n && !tried.has(n) && !fillQueue.includes(n)) fillQueue.push(n); });
  if (!filling && fillQueue.length) setTimeout(runFill, 400);
}
async function runFill() {
  if (filling) return;
  if (Date.now() < fillBlockedUntil) { setTimeout(runFill, fillBlockedUntil - Date.now() + 100); return; }
  filling = true;
  try {
    while (fillQueue.length) {
      const batch = fillQueue.splice(0, 8);   // الدالة بتقبل 8 مواد في الطلب
      batch.forEach((n) => tried.add(n));
      try {
        const r = await call("ingredient-class", { action: "fill_for", names: batch });
        const items = (r && r.items) || {};
        batch.forEach((n) => { if (items[n]) { cache.set(n, items[n]); (refreshers.get(n) || []).forEach((f) => f()); } });
        if (r && (r.stopped === "api_rate_limited" || r.stopped === "openfda_rate_limited")) { fillBlockedUntil = Date.now() + 60000; }
      } catch (e) {
        if (e && e.code === "rate_limited") { batch.forEach((n) => tried.delete(n)); fillQueue.unshift(...batch); fillBlockedUntil = Date.now() + 60000; break; }
        /* أي خطأ تاني: الصفحة بتفضل شغالة من غير تصنيف */
      }
    }
  } finally { filling = false; if (fillQueue.length) setTimeout(runFill, Math.max(500, fillBlockedUntil - Date.now())); }
}

const tagOf = (it) => it && it.status === "found" ? (it.purpose_ar || it.purpose_en || clean(it.fda_class) || "") : "";
const lines = (arr) => (Array.isArray(arr) ? arr : []).map(clean).filter(Boolean);

function detailPanel(it) {
  const box = el("div", "ing-detail");
  if (!it || it.status !== "found" || !(tagOf(it) || it.fda_class || (it.fda_purpose && it.fda_purpose.length))) {
    box.append(el("p", "meta", "لسه مفيش بيانات تصنيف مؤكدة لهذه المادة."));
    return box;
  }
  const row = (k, v, ltr) => {
    if (!v || (Array.isArray(v) && !v.length)) return;
    const d = el("div", "ing-row"); d.append(el("b", null, k));
    (Array.isArray(v) ? v : [v]).forEach((x) => { const s = el("span", ltr ? "ltr" : null, x); d.append(s); });
    box.append(d);
  };
  row("التصنيف المختصر", [it.purpose_ar, it.purpose_en].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i));
  // السب كلاس والجرعة القصوى: بتظهر بس لو الصف متراجع (review_status = reviewed) وليه مصدر. أي حاجة تانية مبتظهرش.
  const ref = it.reference && it.reference.review_status === "reviewed" ? it.reference : null;
  if (ref) row("السب كلاس", [ref.subclass_ar, ref.subclass_en].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i));
  const doses = ((it.reference && it.reference.doses) || []).filter((d) => d && d.review_status === "reviewed" && Number(d.max_daily_dose) > 0 && d.source_title);
  if (doses.length) {
    const AG = { adult: "بالغ", child: "أطفال", elderly: "كبار السن" };
    const wrap = el("div", "ing-row"); wrap.append(el("b", null, "الحد الأقصى اليومي (راجعه صيدلي)"));
    doses.forEach((d) => {
      const age = d.age_min_years != null || d.age_max_years != null ? " (" + (d.age_min_years ?? "") + "–" + (d.age_max_years ?? "") + " سنة)" : "";
      wrap.append(el("span", null, (AG[d.age_group] || d.age_group) + age + ": " + d.max_daily_dose + " " + (d.unit || "mg") + " / يوم"));
      wrap.append(el("span", "meta ing-src", "المصدر: " + d.source_title));
    });
    box.append(wrap);
  }
  const epc = lines(it.epc && it.epc.length ? it.epc : [it.fda_class]);
  row("تصنيف FDA الدوائي", epc, true);
  row("آلية العمل (MoA)", lines(it.moa), true);
  row("الغرض حسب ملصق FDA", (Array.isArray(it.fda_purpose) ? it.fda_purpose : []).map((x) => String(x).slice(0, 160)), true);
  // تفاصيل أكتر: أقسام ملصق FDA (نص أصلي + ترجمة لو موجودة). الزرار مبيظهرش لو مفيش أقسام متخزّنة.
  const secs = (Array.isArray(it.sections) ? it.sections : []).filter((s) => s && s.title_ar && (s.text_en || s.text_ar));
  const rxEl = it.rxclass ? rxCard(it.rxclass) : null;
  if (secs.length || rxEl) {
    const more = el("div", "ing-more"); more.hidden = true;
    secs.forEach((s) => {
      const d = el("details", "ing-sec"); d.append(el("summary", null, s.title_ar));
      if (s.text_ar) { d.append(el("p", null, s.text_ar)); d.append(el("p", "meta ing-src", "ترجمة آلية من نص FDA فقط")); }
      if (s.text_en) { const o = el("details", "ing-orig"); o.append(el("summary", null, "النص الأصلي من FDA")); o.append(labelBlock(s.text_en, null)); d.append(o); }
      const src = el("p", "meta ing-src", "المصدر: openFDA label");
      if (s.effective_time) { const t = String(s.effective_time), nice = /^\d{8}$/.test(t) ? t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6) : t; src.append("، بتاريخ "); src.append(el("span", "ing-id", nice)); }
      d.append(src);
      if (s.set_id) d.append(el("p", "meta ing-src ing-setid", s.set_id)); // معرّف الملصق في سطر لوحده، شمال-لليمين
      more.append(d);
    });
    if (rxEl) more.append(rxEl);
    const btn = el("button", "ing-more-btn", "تفاصيل أكتر"); btn.type = "button";
    btn.addEventListener("click", () => { more.hidden = !more.hidden; btn.textContent = more.hidden ? "تفاصيل أكتر" : "إخفاء التفاصيل"; });
    box.append(btn, more);
  }
  const srcs = String(it.source || "openfda").split("+").map((x) => x === "rxclass" ? "RxClass (المكتبة الطبية الأمريكية NLM)" : x === "openfda" ? "openFDA (ملصقات الأدوية الأمريكية)" : x === "nutrient_rule" ? "قاعدة ثابتة في النظام (الفيتامينات والمعادن والأحماض الأمينية بتتصنف كمكمل غذائي، مش من مرجع طبي خارجي)" : "").filter(Boolean);
  box.append(el("p", "meta ing-src", "المصدر: " + srcs.join(" + ") + ". ده تصنيف عام للمادة الفعّالة مش لمنتج معيّن في السوق المصري، ومش بديل لرأي الصيدلي أو الطبيب."));
  return box;
}

function decorate(li) {
  const nameEl = li.firstElementChild; if (!nameEl) return;
  const main = el("span", "ing-main");
  nameEl.classList.add("ing-name");
  const valEl = nameEl.nextElementSibling; if (valEl) valEl.classList.add("ing-val"); // التركيز بيفضل جنب الصف حتى لو اتفتحت التفاصيل
  li.prepend(main); main.append(nameEl);
  main.tabIndex = 0; main.setAttribute("role", "button"); main.setAttribute("aria-expanded", "false");
  const key = norm(li.dataset.ing);
  const fillTag = () => {
    const t = tagOf(cache.get(key));
    if (t && !main.querySelector(".ing-tag")) main.append(el("span", "ing-tag", t));
  };
  let panel = null;
  const refresh = () => {
    fillTag();
    if (panel && li.classList.contains("ing-open")) { const np = detailPanel(cache.get(key)); panel.replaceWith(np); panel = np; }
  };
  (refreshers.get(key) || refreshers.set(key, []).get(key)).push(refresh);
  load([li.dataset.ing]).then(fillTag);
  const toggle = async () => {
    if (panel) { panel.remove(); panel = null; main.setAttribute("aria-expanded", "false"); li.classList.remove("ing-open"); return; }
    main.setAttribute("aria-expanded", "true"); li.classList.add("ing-open");
    await load([li.dataset.ing]);
    if (!li.classList.contains("ing-open")) return;
    panel = detailPanel(cache.get(key)); li.append(panel); fillTag();
  };
  main.addEventListener("click", toggle);
  main.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
}

let queued = false;
function scan() {
  queued = false;
  const lis = [...document.querySelectorAll("li[data-ing]:not([data-ic])")];
  if (!lis.length) return;
  lis.forEach((li) => li.dataset.ic = "1");
  load(lis.map((li) => li.dataset.ing));      // طلب واحد مجمّع لكل المواد الظاهرة
  lis.forEach(decorate);
}
new MutationObserver(() => { if (!queued) { queued = true; setTimeout(scan, 30); } })
  .observe(document.body, { childList: true, subtree: true });
scan();
})();
