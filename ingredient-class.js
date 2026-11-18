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

// ---- RxClass: الاستخدامات والوقاية والموانع (MED-RT) ----
// الأسماء إنجليزي (MeSH). لو name_ar متخزّن بيظهر، وغير كده زرار ترجمة بيترجم الأسماء كلها في طلب واحد (دالة translate-label).
const RX_GROUPS = [["indications", "الاستخدامات"], ["prevention", "الوقاية"], ["contraindications", "موانع الاستعمال"]];
function rxFlat(rx) {
  const groups = RX_GROUPS.map(([k, t]) => [k, t, (Array.isArray(rx[k]) ? rx[k] : []).filter((x) => x && x.name)]).filter((g) => g[2].length);
  if (!groups.length) return null;
  const body = el("div", "ing-rx-body");
  const btn = el("button", "ing-tr-btn", "🌐 ترجمة الأسماء للعربي"); btn.type = "button";
  const lis = [];
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
    lis.forEach(({ li, x }, i) => { const a = x.name_ar || (ar && ar[i]); li.textContent = isAr && a ? a : x.name; li.dir = isAr && a ? "rtl" : "ltr"; });
    btn.textContent = isAr ? "↩ الأسماء بالإنجليزي" : "🌐 ترجمة الأسماء للعربي";
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
  return body;
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

// ---- ترتيب نص ملصق FDA: فواصل أسطر وعناوين ونقط. الكلمات نفسها مبتتغيّرش (بس بنكسر الأسطر ونعمل عناوين) ----
const BULLET = "\u25AA";
const HEADS = "Do not use|Ask a doctor or pharmacist before use if you are|Ask a doctor before use if you have|Ask a doctor before use if|Ask a doctor or pharmacist before use if|When using this product|Stop use and ask a doctor if|If pregnant or breast-feeding|If pregnant or breast feeding|Do not exceed recommended dosage|Other information";
const BREAKS = "Do not use|Ask a doctor|Stop use|When using|If pregnant|Keep out of reach|In case of overdose|Liver warning|Allergy alert|Sore throat warning|Reye's syndrome|Stomach bleeding warning|Directions|Warnings|Other information|Inactive ingredients|Questions";
const LEAD = /^(Uses|Directions|Warnings|Purpose|Indications and usage|Indications & usage|Dosage and administration|Contraindications|Adverse reactions|Drug interactions|Warnings and precautions|Warnings and cautions)\s*:?\s+(?=\S)/i;
function fdaLines(text, isEn) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  if (isEn) {
    t = t.replace(LEAD, "");
    t = t.replace(new RegExp("(" + HEADS + ")\\s*:?\\s*(?=" + BULLET + ")", "g"), "\n\u00A7$1\n");
    t = t.replace(new RegExp("([.!?])\\s+(?=(?:" + BREAKS + ")\\b)", "g"), "$1\n");
  }
  t = t.split(BULLET).join("\n" + BULLET + " ");
  return t.split("\n").map((x) => x.trim()).filter(Boolean);
}
function fdaBody(text, isEn) {
  const root = el("div", "ing-text" + (isEn ? " ltr" : ""));
  let ul = null;
  fdaLines(text, isEn).forEach((ln) => {
    if (ln.charAt(0) === "\u00A7") { ul = null; root.append(el("h4", "ing-h", ln.slice(1))); return; }
    if (ln.charAt(0) === BULLET) {
      if (!ul) { ul = el("ul", "ing-bl"); root.append(ul); }
      ul.append(el("li", null, ln.slice(1).trim()));
      return;
    }
    ul = null; root.append(el("p", null, ln));
  });
  return root;
}

const TR_ERR = {
  rate_limited: "الطلبات كتير، استنى دقيقة وجرّب تاني.",
  translation_unavailable: "الترجمة مش متاحة دلوقتي أو ماعدّتش فحص الدقة. اقرا النص الأصلي، وجرّب تاني بعد شوية.",
  section_not_found: "القسم ده مش موجود."
};

// ---- صفحة المادة الفعّالة (#/i/الاسم): كل حاجة مترتبة، والمصادر والتنبيهات مرة واحدة في الآخر ----
const SEC_ORDER = [["indications", "دواعي الاستعمال"], ["dosage", "الجرعة وطريقة الاستخدام"], ["contraindications", "موانع الاستعمال"],
  ["warnings", "التحذيرات"], ["adverse", "الأعراض الجانبية"], ["interactions", "التداخلات الدوائية"]];
const niceDate = (t) => { t = String(t || ""); return /^\d{8}$/.test(t) ? t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6) : t; };
const SRC_NAMES = {
  rxclass: "RxClass (المكتبة الطبية الأمريكية NLM)",
  openfda: "openFDA (ملصقات الأدوية الأمريكية)",
  chembl: "ChEMBL (قاعدة EMBL-EBI المفتوحة): كود ATC وآلية العمل",
  nutrient_rule: "قاعدة ثابتة في النظام (الفيتامينات والمعادن والأحماض الأمينية بتتصنف كمكمل غذائي، مش من مرجع طبي خارجي)",
};
const uniq = (a) => a.filter((x, i) => x && a.indexOf(x) === i);
function addRow(box, k, v, ltr) {
  if (!v || (Array.isArray(v) && !v.length)) return;
  const d = el("div", "ing-row"); d.append(el("b", null, k));
  (Array.isArray(v) ? v : [v]).forEach((x) => d.append(el("span", ltr ? "ltr" : null, x)));
  box.append(d);
}

// قسم واحد من النشرة: نص مترتب + زرار ترجمة/النص الأصلي. من غير تحذير ولا مصدر هنا، دول في آخر الصفحة مرة واحدة.
function sectionFlat(s, key) {
  const wrap = el("div", "ing-secflat");
  const holder = el("div", "ing-view");
  const tools = el("div", "ing-tools");
  const tbtn = el("button", "ing-tr-btn", ""); tbtn.type = "button";
  const msg = el("p", "meta ing-trmsg"); msg.hidden = true;
  let mode = "en";
  const paint = () => {
    holder.replaceChildren();
    if (mode === "ar" && s.text_ar) {
      holder.append(fdaBody(s.text_ar, false));
      tbtn.textContent = "عرض النص الأصلي (English)";
    } else {
      if (s.text_en) holder.append(fdaBody(s.text_en, true));
      tbtn.textContent = s.text_ar ? "عرض الترجمة العربية" : "ترجمة للعربي";
    }
    tbtn.hidden = !(s.text_en || s.text_ar) || (!s.text_en && mode === "ar");
  };
  tbtn.addEventListener("click", async () => {
    msg.hidden = true;
    if (s.text_ar) { mode = mode === "ar" ? "en" : "ar"; paint(); return; }
    if (!s.section_key) return;
    const old = tbtn.textContent; tbtn.disabled = true; tbtn.textContent = "جاري الترجمة… (ممكن تاخد نص دقيقة)";
    try {
      const r = await call("ingredient-translate", { component: key, section_key: s.section_key });
      if (r && r.text_ar) { s.text_ar = r.text_ar; mode = "ar"; paint(); }
      else throw new Error("empty");
    } catch (e) {
      tbtn.textContent = old;
      msg.textContent = TR_ERR[e && e.code] || "الترجمة مش متاحة دلوقتي. جرّب تاني بعد شوية.";
      msg.hidden = false;
    } finally { tbtn.disabled = false; }
  });
  tools.append(tbtn); wrap.append(tools, msg, holder);
  paint();
  return wrap;
}

function ingredientBody(it, key) {
  const frag = document.createDocumentFragment();
  const secs = (it && Array.isArray(it.sections) ? it.sections : []).filter((s) => s && s.section_key && (s.text_en || s.text_ar));
  const rx = it && it.rxclass ? it.rxclass : null;
  const ref = it && it.reference && it.reference.review_status === "reviewed" ? it.reference : null;
  const doses = ((it && it.reference && it.reference.doses) || []).filter((d) => d && d.review_status === "reviewed" && Number(d.max_daily_dose) > 0 && d.source_title);
  const hasClass = !!(it && it.status === "found" && (tagOf(it) || it.fda_class || (it.fda_purpose && it.fda_purpose.length) || (it.atc && it.atc.length) || (it.moa && it.moa.length)));
  if (!hasClass && !secs.length && !rx) { frag.append(el("p", "meta", "لسه مفيش بيانات تصنيف مؤكدة لهذه المادة.")); return frag; }

  // 1) التصنيف
  if (hasClass) {
    frag.append(el("h3", "pd-h", "التصنيف"));
    const box = el("div", "ing-box");
    addRow(box, "التصنيف المختصر", uniq([it.purpose_ar, it.purpose_en]));
    if (ref) addRow(box, "السب كلاس", uniq([ref.subclass_ar, ref.subclass_en]));
    addRow(box, "كود ATC (WHO)", it.atc, true);
    addRow(box, "تصنيف FDA الدوائي", lines(it.epc && it.epc.length ? it.epc : [it.fda_class]), true);
    addRow(box, "آلية العمل (MoA)", lines(it.moa), true);
    addRow(box, "الغرض حسب ملصق FDA", (Array.isArray(it.fda_purpose) ? it.fda_purpose : []).map((x) => String(x).slice(0, 160)), true);
    frag.append(box);
  }
  // 2) أقسام النشرة بالترتيب
  SEC_ORDER.forEach(([k, title]) => {
    const s = secs.find((x) => x.section_key === k);
    if (!s) return;
    frag.append(el("h3", "pd-h", title));
    if (s.source === "chembl") {
      const ul = el("ul", "ing-ul");
      String(s.text_en || "").split(";").map((x) => x.trim()).filter(Boolean).forEach((x) => { const li = el("li", null, x); li.dir = "ltr"; ul.append(li); });
      frag.append(ul);
    } else frag.append(sectionFlat(s, key));
  });
  // 3) الحد الأقصى اليومي (المتراجع فقط)
  if (doses.length) {
    frag.append(el("h3", "pd-h", "الحد الأقصى اليومي (راجعه صيدلي)"));
    const AG = { adult: "بالغ", child: "أطفال", elderly: "كبار السن" };
    const ul = el("ul", "ing-ul");
    doses.forEach((d) => {
      const age = d.age_min_years != null || d.age_max_years != null ? " (" + (d.age_min_years ?? "") + "–" + (d.age_max_years ?? "") + " سنة)" : "";
      ul.append(el("li", null, (AG[d.age_group] || d.age_group) + age + ": " + d.max_daily_dose + " " + (d.unit || "mg") + " / يوم"));
    });
    frag.append(ul);
  }
  // 4) RxClass
  const rxEl = rx ? rxFlat(rx) : null;
  if (rxEl) { frag.append(el("h3", "pd-h", "الاستخدامات والموانع (RxClass)")); frag.append(rxEl); }

  // 5) المصادر والتنبيهات: مرة واحدة في الآخر
  const foot = el("div", "ing-foot");
  foot.append(el("b", null, "المصادر"));
  const sl = el("ul", "ing-ul");
  const addSrc = (text, ltrPart) => { const li = el("li", null, text); if (ltrPart) { li.append(" "); li.append(el("span", "ltr", ltrPart)); } sl.append(li); };
  uniq(String(it && it.source ? it.source : "").split("+").map((x) => SRC_NAMES[x] || "")).forEach((t) => addSrc("التصنيف: " + t));
  const fdaSec = secs.find((s) => (s.source || "openfda") === "openfda");
  if (fdaSec) addSrc("نصوص النشرة: openFDA label" + (fdaSec.effective_time ? "، بتاريخ " + niceDate(fdaSec.effective_time) : ""), fdaSec.set_id || "");
  const chSec = secs.find((s) => s.source === "chembl");
  if (chSec) addSrc("دواعي الاستعمال: ChEMBL،", chSec.source_ref || "");
  if (rxEl) addSrc("الاستخدامات والموانع: RxClass (MED-RT)");
  uniq([ref && ref.source_title, ...doses.map((d) => d.source_title)]).forEach((t) => addSrc("مرجع مراجَع: " + t));
  foot.append(sl);
  const notes = ["ده تصنيف ومعلومات عامة على مستوى المادة الفعّالة، مش لمنتج معيّن في السوق المصري، ومش بديل لرأي الصيدلي أو الطبيب. راجع نشرة المنتج قبل الاعتماد عليه."];
  if (rx && Array.isArray(rx.contraindications) && rx.contraindications.length) notes.push("موانع RxClass على مستوى المادة وما اتراجعتش بواسطة صيدلي، وبعضها ممكن يخص منتجات مركّبة.");
  if (chSec) notes.push("دواعي الاستعمال من ChEMBL محتفظ فيها بالمرحلة 3 فأعلى، وهي مش نص نشرة دواء ولا نص أصلي من FDA.");
  if (secs.some((s) => (s.source || "openfda") === "openfda") || rxEl) notes.push("الترجمة العربية (لو اتعملت) اتعملت آليًا بالذكاء الاصطناعي واتراجعت آليًا بموديل تاني، ومفيش مراجعة بشرية، فممكن فيها أخطاء. المرجع هو النص الأصلي بالإنجليزي.");
  foot.append(el("b", null, "تنبيهات"));
  const nl = el("ul", "ing-ul");
  notes.forEach((t) => nl.append(el("li", null, t)));
  foot.append(nl);
  frag.append(foot);
  return frag;
}

// بتتنادى من pages.js لما الراوت يبقى #/i/الاسم. بترجّع [هيدر, ورقة] بتتحط في صفحة المنتج.
window.ingredientPage = function (name, goBackFn) {
  const hero = el("div", "hero ing-hero");
  const bk = el("button", "back hero-back", "→"); bk.type = "button"; bk.setAttribute("aria-label", "رجوع");
  if (goBackFn) bk.addEventListener("click", goBackFn);
  const t = el("div", "ing-hero-t");
  const h = el("h1", null, name); h.dir = "auto";
  const tag = el("span", "ing-hero-tag", ""); tag.hidden = true;
  t.append(h, tag); hero.append(bk, t);
  const sheet = el("div", "sheet ing-page");
  sheet.append(el("p", "meta", "...جاري التحميل"));
  const key = norm(name);
  const paint = () => {
    if (!sheet.isConnected) { const a = refreshers.get(key) || []; const i = a.indexOf(paint); if (i >= 0) a.splice(i, 1); return; }
    const it = cache.get(key);
    tag.textContent = tagOf(it); tag.hidden = !tag.textContent;
    sheet.replaceChildren(ingredientBody(it, key));
  };
  (refreshers.get(key) || refreshers.set(key, []).get(key)).push(paint);
  load([name]).then(paint);
  return [hero, sheet];
};

// القائمة: الشارة بتظهر في كل مكان، بس الاسم بيبقى رابط لصفحة المادة جوّه صفحة المنتج بس (مش في كروت النتايج)
function decorate(li) {
  const nameEl = li.firstElementChild; if (!nameEl) return;
  const main = el("span", "ing-main");
  nameEl.classList.add("ing-name");
  const valEl = nameEl.nextElementSibling; if (valEl) valEl.classList.add("ing-val"); // التركيز بيفضل جنب الصف
  li.prepend(main); main.append(nameEl);
  const key = norm(li.dataset.ing);
  if (li.closest("#pd")) {
    main.classList.add("ing-link"); main.tabIndex = 0; main.setAttribute("role", "link");
    const go = () => { if (typeof window.openIngredient === "function") window.openIngredient(li.dataset.ing); };
    main.addEventListener("click", go);
    main.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }
  const fillTag = () => {
    const t = tagOf(cache.get(key));
    if (t && !main.querySelector(".ing-tag")) main.append(el("span", "ing-tag", t));
  };
  (refreshers.get(key) || refreshers.set(key, []).get(key)).push(fillTag);
  load([li.dataset.ing]).then(fillTag);
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
