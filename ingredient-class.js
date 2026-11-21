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
// زرار الترجمة (تصميم Uiverse): النص جوه span.text_button، فبنغيّره بـ setLbl بدل textContent عشان الأيقونة والإطار يفضلوا
const SPARK = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="sparkle" aria-hidden="true"><path class="path" stroke-linejoin="round" stroke-linecap="round" stroke="black" fill="black" d="M14.187 8.096L15 5.25L15.813 8.096C16.0231 8.83114 16.4171 9.50062 16.9577 10.0413C17.4984 10.5819 18.1679 10.9759 18.903 11.186L21.75 12L18.904 12.813C18.1689 13.0231 17.4994 13.4171 16.9587 13.9577C16.4181 14.4984 16.0241 15.1679 15.814 15.903L15 18.75L14.187 15.904C13.9769 15.1689 13.5829 14.4994 13.0423 13.9587C12.5016 13.4181 11.8321 13.0241 11.097 12.814L8.25 12L11.096 11.187C11.8311 10.9769 12.5006 10.5829 13.0413 10.0423C13.5819 9.50162 13.9759 8.83214 14.186 8.097L14.187 8.096Z"></path><path class="path" stroke-linejoin="round" stroke-linecap="round" stroke="black" fill="black" d="M6 14.25L5.741 15.285C5.59267 15.8785 5.28579 16.4206 4.85319 16.8532C4.42059 17.2858 3.87853 17.5927 3.285 17.741L2.25 18L3.285 18.259C3.87853 18.4073 4.42059 18.7142 4.85319 19.1468C5.28579 19.5794 5.59267 20.1215 5.741 20.715L6 21.75L6.259 20.715C6.40725 20.1216 6.71398 19.5796 7.14639 19.147C7.5788 18.7144 8.12065 18.4075 8.714 18.259L9.75 18L8.714 17.741C8.12065 17.5925 7.5788 17.2856 7.14639 16.853C6.71398 16.4204 6.40725 15.8784 6.259 15.285L6 14.25Z"></path><path class="path" stroke-linejoin="round" stroke-linecap="round" stroke="black" fill="black" d="M6.5 4L6.303 4.5915C6.24777 4.75718 6.15472 4.90774 6.03123 5.03123C5.90774 5.15472 5.75718 5.24777 5.5915 5.303L5 5.5L5.5915 5.697C5.75718 5.75223 5.90774 5.84528 6.03123 5.96877C6.15472 6.09226 6.24777 6.24282 6.303 6.4085L6.5 7L6.697 6.4085C6.75223 6.24282 6.84528 6.09226 6.96877 5.96877C7.09226 5.84528 7.24282 5.75223 7.4085 5.697L8 5.5L7.4085 5.303C7.24282 5.24777 7.09226 5.15472 6.96877 5.03123C6.84528 4.90774 6.75223 4.75718 6.697 4.5915L6.5 4Z"></path></svg>';
function uvBtn(text) {
  const b = el("button", "uv-btn"); b.type = "button";
  b.append(el("div", "dots_border"));
  b.insertAdjacentHTML("beforeend", SPARK);
  b._lbl = el("span", "text_button", text); b.append(b._lbl);
  return b;
}
const setLbl = (b, t) => { b._lbl.textContent = t; };

function rxFlat(rx) {
  const groups = RX_GROUPS.map(([k, t]) => [k, t, (Array.isArray(rx[k]) ? rx[k] : []).filter((x) => x && x.name)]).filter((g) => g[2].length);
  if (!groups.length) return null;
  const body = el("div", "ing-rx-body");
  const btn = uvBtn("ترجمة الأسماء للعربي");
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
    setLbl(btn, isAr ? "↩ الأسماء بالإنجليزي" : "ترجمة الأسماء للعربي");
  };
  if (!allAr) {
    btn.addEventListener("click", async () => {
      if (showAr) return apply(false);
      if (ar) return apply(true);
      btn.disabled = true; setLbl(btn, "...جاري الترجمة");
      try {
        const r = await call("translate-label", { text: lis.map(({ x }) => "▪ " + x.name).join("\n"), target: "ar" });
        const out = String(r.text || "").split("\n").map((l) => l.replace(/^\s*[▪■•]\s*/, "").trim()).filter(Boolean);
        if (out.length !== lis.length) throw Object.assign(new Error("lines"), { code: "not_translated" });
        ar = out; apply(true);
      } catch (e) {
        setLbl(btn, e && e.code === "rate_limited" ? "حاول بعد دقيقة" : "تعذّرت الترجمة، حاول تاني");
        setTimeout(() => { if (!showAr) setLbl(btn, "ترجمة الأسماء للعربي"); }, 3500);
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
  const tbtn = uvBtn("");
  const msg = el("p", "meta ing-trmsg"); msg.hidden = true;
  let mode = "en";
  const paint = () => {
    holder.replaceChildren();
    if (mode === "ar" && s.text_ar) {
      holder.append(fdaBody(s.text_ar, false));
      setLbl(tbtn, "عرض النص الأصلي (English)");
    } else {
      if (s.text_en) holder.append(fdaBody(s.text_en, true));
      setLbl(tbtn, s.text_ar ? "عرض الترجمة العربية" : "ترجمة للعربي");
    }
    tbtn.hidden = !(s.text_en || s.text_ar) || (!s.text_en && mode === "ar");
  };
  tbtn.addEventListener("click", async () => {
    msg.hidden = true;
    if (s.text_ar) { mode = mode === "ar" ? "en" : "ar"; paint(); return; }
    if (!s.section_key) return;
    const old = tbtn._lbl.textContent; tbtn.disabled = true; setLbl(tbtn, "جاري الترجمة… (ممكن تاخد نص دقيقة)");
    try {
      const r = await call("ingredient-translate", { component: key, section_key: s.section_key });
      if (r && r.text_ar) { s.text_ar = r.text_ar; mode = "ar"; paint(); }
      else throw new Error("empty");
    } catch (e) {
      setLbl(tbtn, old);
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
    frag.append(el("h3", "pd-h", "الحد الأقصى اليومي (راجعه قبل الصرف)"));
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
  const notes = ["ده تصنيف ومعلومات عامة على مستوى المادة الفعّالة، مش لمنتج معيّن في السوق المصري، ومش بديل لنشرة المنتج. راجع النشرة قبل الاعتماد عليه."];
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
window.ingredientPage = function (name, goBackFn, siblings) {
  const hero = el("div", "hero ing-hero");
  // شريط ثابت فوق: زرار الرجوع + اسم المادة (ولو الدواء فيه أكتر من مادة: تابات للتنقل بينهم)
  const bar = el("div", "ing-bar");
  const bk = el("button", "back", "→"); bk.type = "button"; bk.setAttribute("aria-label", "رجوع");
  if (goBackFn) bk.addEventListener("click", goBackFn);
  const tabs = el("div", "ing-tabs");
  const names = Array.isArray(siblings) && siblings.length > 1 && siblings.includes(name) ? siblings : [name];
  names.forEach((n) => {
    const b = el("button", "ing-tab" + (n === name ? " on" : ""), n); b.type = "button"; b.dir = "auto";
    if (n === name) b.setAttribute("aria-current", "true");
    else b.addEventListener("click", () => {
      history.replaceState(null, "", "#/i/" + encodeURIComponent(n));
      document.getElementById("pd").replaceChildren(...window.ingredientPage(n, goBackFn, names));
      window.scrollTo(0, 0);
    });
    tabs.append(b);
  });
  bar.append(bk, tabs);
  requestAnimationFrame(() => { const on = tabs.querySelector(".on"); if (on && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft += (on.getBoundingClientRect().left + on.offsetWidth / 2) - (tabs.getBoundingClientRect().left + tabs.clientWidth / 2); });
  const t = el("div", "ing-hero-t");
  const h = el("h1", null, name); h.dir = "auto";
  const tag = el("span", "ing-hero-tag", ""); tag.hidden = true;
  t.append(h, tag); hero.append(t);
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
  return [bar, hero, sheet];
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
    const go = () => {
      const sib = [...li.closest("ul.ing").querySelectorAll("li[data-ing]")].map((x) => x.dataset.ing);
      if (typeof window.openIngredient === "function") window.openIngredient(li.dataset.ing, sib);
    };
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
