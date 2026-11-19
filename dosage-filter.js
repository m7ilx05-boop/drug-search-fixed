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
function setOpen(open) {
  strip.hidden = !open; btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) requestAnimationFrame(() => { const on = formsBox.querySelector("[aria-checked=true]"); if (on) on.scrollIntoView({ inline: "nearest", block: "nearest" }); syncScroll(); });
}
btn.addEventListener("click", () => setOpen(strip.hidden));
done.addEventListener("click", () => setOpen(false));
strip.addEventListener("change", syncDot); // تغيير نوع البحث
strip.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]"); if (!b) return;
  window.__ff = b.dataset.id;
  formsBox.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", x === b ? "true" : "false"));
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
