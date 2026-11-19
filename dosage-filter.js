/* dosage-filter.js — فلتر الشكل الدوائي (أقراص / شراب / مرهم ...) جنب خانة البحث.
   بيفلتر النتايج الراجعة من drug-search (وجوب drug-job-status بتاعها) على الشكل الدوائي المسجّل للمنتج.
   المنتج اللي شكله الدوائي مش مسجّل بيتخفّى لما الفلتر شغال، وبنقول كام منتج اتخفّى.
   ⚠ لازم يتحمّل بعد core.js وقبل barcode-live.js (barcode-live لازم يفضل آخر ملف). */
(() => {
"use strict";
const FORMS = [
  { id: "", label: "تلقائي" },
  { id: "solid", label: "أقراص / كبسولات", re: /tablet|caplet|capsule|قرص|أقراص|اقراص|كبسول/i },
  { id: "syrup", label: "شراب / معلّق", re: /syrup|suspension|elixir|شراب|معلق/i },
  { id: "topical", label: "مرهم / كريم / جل", re: /ointment|مرهم|cream|كريم|\bgel\b|emulgel|(^|\s)جل(\s|$)/i },
  { id: "injection", label: "حقن", re: /inject|vial|ampou?le|syringe|حقن|أمبول|امبول|فيال/i },
  { id: "drops", label: "قطرة", re: /drops?|قطرة|نقط/i },
  { id: "suppository", label: "تحاميل", re: /suppositor|تحاميل|لبوس/i },
  { id: "sachet", label: "أكياس", re: /sachet|powder|أكياس|ساشيه|بودرة/i },
  { id: "spray", label: "سبراي", re: /spray|سبراي|بخاخ/i },
];
window.__ff = ""; // الفلتر الشغال دلوقتي: id أو أكتر من id للأشكال الدوائية مفصولين بفاصلة (مثلاً "solid,injection")، فاضي = تلقائي
const selIds = () => String(window.__ff || "").split(",").filter(Boolean);
const selForms = () => selIds().map((id) => FORMS.find((x) => x.id === id)).filter((f) => f && f.re);

// ===== الواجهة =====
const btn = $("ffBtn"), strip = $("forms"), note = $("ffnote");
// القائمة: فوق "نوع البحث" (الراديوهات اتنقلت هنا من الفورم)، وتحتها "الشكل الدوائي"، وزرار "تم" في الآخر
const formsH = el("div", "set-h", "الشكل الدوائي");
formsH.append(el("span", "set-sub", " · اختار واحد أو أكتر"));
strip.append(formsH);
const formsBox = el("div", "set-forms"); formsBox.setAttribute("role", "group"); formsBox.setAttribute("aria-label", "الشكل الدوائي");
// صف واحد بيتحرّك يمين وشمال. تحته شريط صغير بيبيّن مكانك من باقي الاختيارات، وبيبهت الطرف اللي فيه اختيارات مخبية
const formsWrap = el("div", "set-formswrap");
const track = el("div", "set-track"); track.setAttribute("aria-hidden", "true");
const thumb = el("div", "set-thumb"); track.append(thumb);
formsWrap.append(formsBox, track);
strip.append(formsWrap);
function syncScroll() {
  const max = formsBox.scrollWidth - formsBox.clientWidth;
  if (formsBox.clientWidth === 0) return; // القايمة مقفولة
  const more = max > 2;
  track.hidden = !more;
  if (!more) { formsBox.style.setProperty("--fl", "0px"); formsBox.style.setProperty("--fr", "0px"); return; }
  const rtl = getComputedStyle(formsBox).direction === "rtl";
  const pos = Math.min(Math.max(Math.abs(formsBox.scrollLeft), 0), max); // المسافة من أول القايمة (يمين في العربي)
  const w = Math.max(track.clientWidth * (formsBox.clientWidth / formsBox.scrollWidth), 28);
  thumb.style.width = w + "px";
  thumb.style.insetInlineStart = (pos / max) * (track.clientWidth - w) + "px";
  const startMore = pos > 2, endMore = pos < max - 2;       // start = أول القايمة، end = آخرها
  formsBox.style.setProperty(rtl ? "--fr" : "--fl", startMore ? "26px" : "0px");
  formsBox.style.setProperty(rtl ? "--fl" : "--fr", endMore ? "26px" : "0px");
}
formsBox.addEventListener("scroll", syncScroll, { passive: true });
if (window.ResizeObserver) new ResizeObserver(syncScroll).observe(formsBox); else window.addEventListener("resize", syncScroll);
FORMS.forEach((f, i) => {
  const b = el("button", null, f.label); b.type = "button"; b.dataset.id = f.id;
  b.setAttribute("role", "checkbox"); b.setAttribute("aria-checked", i === 0 ? "true" : "false");
  formsBox.append(b);
});
function paintForms() {
  const cur = selIds();
  formsBox.querySelectorAll("button").forEach((x) => {
    const on = x.dataset.id === "" ? cur.length === 0 : cur.includes(x.dataset.id);
    x.setAttribute("aria-checked", on ? "true" : "false");
  });
}
const done = el("button", "set-done", "تم"); done.type = "button";
strip.append(done);
const typeChecked = () => { const r = document.querySelector("input[name=t]:checked"); return r ? r.value : "auto"; };
// النقطة الصفرا على زرار الإعدادات: بتظهر لو في فلتر شكل دوائي أو نوع بحث غير "تلقائي"
function syncDot() {
  const t = typeChecked(), fs = selForms();
  btn.classList.toggle("on", fs.length > 0 || t !== "auto");
  const parts = [];
  if (t !== "auto") { const r = document.querySelector("input[name=t]:checked"); const s = r && r.parentElement && r.parentElement.querySelector("span"); if (s) parts.push("نوع البحث: " + s.textContent); }
  if (fs.length) parts.push("الشكل الدوائي: " + fs.map((f) => f.label).join(" + "));
  btn.title = parts.join(" · ");
}
function setOpen(open) {
  strip.hidden = !open; btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) requestAnimationFrame(() => { const on = formsBox.querySelector("[aria-checked=true]"); if (on) on.scrollIntoView({ inline: "nearest", block: "nearest" }); syncScroll(); });
}
btn.addEventListener("click", () => setOpen(strip.hidden));
done.addEventListener("click", () => setOpen(false));
strip.addEventListener("change", syncDot); // تغيير نوع البحث
strip.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]"); if (!b) return;
  // «تلقائي» بيمسح كل الاختيارات. أي شكل تاني بيتضاف/بيتشال، ولو مفضلش ولا واحد نرجع «تلقائي»
  const id = b.dataset.id, cur = selIds();
  const next = id === "" ? [] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  window.__ff = next.join(",");
  paintForms();
  b.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  syncDot();
  clearNote();
});
// النوع ممكن يتغيّر من الكود (آخر عمليات البحث، الماسح، الرجوع للرئيسية): نحدّث النقطة عند الفتح وبعد كل بحث
btn.addEventListener("click", syncDot);
const form = $("f"); if (form) form.addEventListener("submit", () => setTimeout(syncDot, 0));
window.addEventListener("hashchange", () => setTimeout(syncDot, 0));
syncDot();

function clearNote() { note.hidden = true; note.textContent = ""; }
function setNote(label, n) {
  if (!n) { clearNote(); return; }
  note.textContent = "فلتر الشكل الدوائي: " + label + ". اتخفّى " + n + " منتج شكله الدوائي مختلف أو مش مسجّل. اختار «تلقائي» لو عايز تشوف الكل.";
  note.hidden = false;
}

// ===== الفلترة =====
const isProd = (o) => o && typeof o === "object" && !Array.isArray(o) && "product_name" in o;
const keyOf = (p) => String(p.id || p.dwaprices_id || p.product_name);
function filterDeep(node, f, hidden) { // f.re.test(...) = أي واحد من الأشكال المختارة
  if (Array.isArray(node)) {
    if (node.some(isProd)) return node.filter((p) => {
      if (!isProd(p)) return true;
      if (f.re.test(String(p.dosage_form || ""))) return true;
      hidden.add(keyOf(p)); return false;
    });
    return node.map((x) => filterDeep(x, f, hidden));
  }
  if (node && typeof node === "object") { for (const k of Object.keys(node)) node[k] = filterDeep(node[k], f, hidden); }
  return node;
}

const baseCall = window.call, jobs = new Set();
window.call = async function (name, body) {
  const d = await baseCall(name, body);
  const fs = selForms();
  if (!fs.length || !d) return d;
  const f = { label: fs.map((x) => x.label).join(" + "), re: { test: (v) => fs.some((x) => x.re.test(v)) } };
  if (name === "drug-search") {
    if (d.job_id) jobs.add(d.job_id);
    if (d.secondary && d.secondary.job_id) jobs.add(d.secondary.job_id);
  } else if (!(name === "drug-job-status" && body && jobs.has(body.job_id))) return d;
  const hidden = new Set();
  const out = filterDeep(d, f, hidden);
  if (name === "drug-search") setNote(f.label, hidden.size); else if (hidden.size) setNote(f.label, hidden.size);
  return out;
};
})();
