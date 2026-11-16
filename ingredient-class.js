/* ingredient-class.js — التصنيف المختصر جنب كل مادة فعّالة، ولما تدوس على المادة بتظهر تفاصيل الكلاس.
   البيانات من دالة ingredient-class (action "get") على Supabase، وهي اللي بتقرا من openFDA بمفتاح FDA_key_1 على السيرفر
   (المفتاح عمره ما بيوصل للمتصفح). هنا بنعرض اللي متخزّن بس، ومبنخترعش أي معلومة.
   بيدوّر على أي <li data-ing="اسم المادة"> بيتحط في الصفحة (render.js بيعلّمها).
   ⚠ لازم يتحمّل بعد core.js وقبل barcode-live.js. */
(() => {
"use strict";
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const cache = new Map();      // اسم مُطبَّع -> العنصر الراجع من السيرفر، أو null لو مفيش بيانات
const inflight = new Map();   // اسم مُطبَّع -> Promise
const clean = (s) => String(s || "").replace(/\s*\[(EPC|MoA|PE|CS)\]\s*$/i, "").trim();

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
      } catch { /* من غير تصنيف: الصفحة بتشتغل عادي */ part.forEach((n) => cache.set(n, null)); }
    }
  })();
  need.forEach((n) => inflight.set(n, p));
  try { await Promise.all([p, ...waits]); } finally { need.forEach((n) => inflight.delete(n)); }
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
  const epc = lines(it.epc && it.epc.length ? it.epc : [it.fda_class]);
  row("تصنيف FDA الدوائي", epc, true);
  row("آلية العمل (MoA)", lines(it.moa), true);
  row("الغرض حسب ملصق FDA", (Array.isArray(it.fda_purpose) ? it.fda_purpose : []).map((x) => String(x).slice(0, 160)), true);
  box.append(el("p", "meta ing-src", "المصدر: openFDA (ملصقات الأدوية الأمريكية). ده تصنيف عام للمادة الفعّالة مش لمنتج معيّن في السوق المصري، ومش بديل لرأي الصيدلي أو الطبيب."));
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
  load([li.dataset.ing]).then(fillTag);
  let panel = null;
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
