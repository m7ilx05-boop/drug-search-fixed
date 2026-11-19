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
window.__ff = ""; // الفلتر الشغال دلوقتي (id الشكل الدوائي)، فاضي = تلقائي

// ===== الواجهة =====
const btn = $("ffBtn"), strip = $("forms"), note = $("ffnote");
// القائمة: فوق "نوع البحث" (الراديوهات اتنقلت هنا من الفورم)، وتحتها "الشكل الدوائي"، وزرار "تم" في الآخر
strip.append(el("div", "set-h", "الشكل الدوائي"));
const formsBox = el("div", "set-forms"); formsBox.setAttribute("role", "radiogroup"); formsBox.setAttribute("aria-label", "الشكل الدوائي");
strip.append(formsBox);
FORMS.forEach((f, i) => {
  const b = el("button", null, f.label); b.type = "button"; b.dataset.id = f.id;
  b.setAttribute("role", "radio"); b.setAttribute("aria-checked", i === 0 ? "true" : "false");
  formsBox.append(b);
});
const done = el("button", "set-done", "تم"); done.type = "button";
strip.append(done);
const typeChecked = () => { const r = document.querySelector("input[name=t]:checked"); return r ? r.value : "auto"; };
// النقطة الصفرا على زرار الإعدادات: بتظهر لو في فلتر شكل دوائي أو نوع بحث غير "تلقائي"
function syncDot() {
  const t = typeChecked(), f = FORMS.find((x) => x.id === window.__ff);
  btn.classList.toggle("on", !!window.__ff || t !== "auto");
  const parts = [];
  if (t !== "auto") { const r = document.querySelector("input[name=t]:checked"); const s = r && r.parentElement && r.parentElement.querySelector("span"); if (s) parts.push("نوع البحث: " + s.textContent); }
  if (window.__ff && f) parts.push("الشكل الدوائي: " + f.label);
  btn.title = parts.join(" · ");
}
function setOpen(open) { strip.hidden = !open; btn.setAttribute("aria-expanded", open ? "true" : "false"); }
btn.addEventListener("click", () => setOpen(strip.hidden));
done.addEventListener("click", () => setOpen(false));
strip.addEventListener("change", syncDot); // تغيير نوع البحث
strip.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]"); if (!b) return;
  window.__ff = b.dataset.id;
  formsBox.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", x === b ? "true" : "false"));
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
function filterDeep(node, f, hidden) {
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
  const id = window.__ff, f = FORMS.find((x) => x.id === id);
  if (!id || !f || !f.re || !d) return d;
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
