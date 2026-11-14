/* barcode-live.js — مسح ضوئي: لو الباركود مش في الداتا بيز، يبحث في dwaprices.com (drug-barcode-live).
   لو لقاه، المنتج بيتسجل ويتعرض كنتيجة عادية.
   ⚠ لازم يتحمّل آخر ملف: بيستبدل window.call و window.card بنسخ بتلفّ الأصلية (من core.js و render.js).
   بيعتمد على: scanner.js (#scanPanel), core.js, render.js. */
(() => {
"use strict";
const baseCall = window.call, baseCard = window.card;
const AR_MISS = { strength: "التركيز", dosage_form: "الشكل الدوائي", pack: "العبوة", name: "الاسم" };
const inScan = () => { const p = document.getElementById("scanPanel"); return !!p && !p.hidden; };
const https = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch { return null; } };
const LIVE_ERR = {
  providers_unavailable: "موقع dwaprices مش بيرد دلوقتي. جرّب بعد شوية.",
  rate_limited: "عدد محاولات البحث على الإنترنت كبير. انتظر دقيقة وجرّب تاني.",
};
const warn = (m) => setTimeout(() => { const pn = document.getElementById("scanPanel"), ob = pn && pn.children[1]; if (ob) ob.append(el("div", "scan-msg bad", m)); }, 0);

window.call = async function (name, body) {
  const d = await baseCall(name, body);
  if (name !== "drug-barcode" || !d || d.found !== 0 || !inScan() || !body || !Array.isArray(body.gtins) || !body.gtins.length) return d;
  let r;
  try { r = await baseCall("drug-barcode-live", { gtin: body.gtins[0] }); }
  catch (err) { console.warn("barcode_live_failed", err && err.code, err && err.data); warn("تعذّر البحث في dwaprices. " + (LIVE_ERR[err && err.code] || "حصلت مشكلة في الاتصال، جرّب تاني.")); return d; }
  // المنتج اتلقى على dwaprices واتسجل في القاعدة: نعيد قراءته من القاعدة ونعرضه كنتيجة عادية
  if (r && r.status === "db_hit") {
    try { const d2 = await baseCall("drug-barcode", body); if (d2 && d2.found > 0) return d2; } catch (err) { console.warn("barcode_reload_failed", err && err.code); }
  }
  if (!r || r.status === "db_hit" || !Array.isArray(r.matches) || !r.matches.length) {
    if (r && r.status === "conflicting") warn("نتايج الويب لهذا الباركود متعارضة، فمعرضناش اسم.");
    else if (r && r.status !== "db_hit") warn("الباركود ده مش موجود على دليل دواء مصر (dwaprices.com).");
    return d;
  }
  const cand = r.candidate || null;
  const results = r.matches.map((m) => ({
    product_name: m.trade_name, arabic_name: m.arabic_name, manufacturer: m.manufacturer, dosage_form: m.dosage_form,
    scientific_name: m.scientific_name, pack_size: m.pack, current_price: m.current_price, old_price: m.old_price,
    price_updated_on: m.price_updated_on, barcode: m.barcode_on_page, source_url: m.source_url,
    _web: true, _label: r.label_ar, _verdict: m.verdict, _missing: m.missing || [], _cand: cand,
    _multi: r.matches.length > 1, _hidden: r.hidden_count || 0, _cached: !!r.cached,
  }));
  return { ...d, found: results.length, ambiguous: false, results, _web: true };
};

window.card = function (p, tier) {
  if (!p || !p._web) return baseCard(p, tier);
  const c = baseCard(p, 3);
  const w = el("div", "scan-msg warn", p._label || "من الويب — غير مؤكد، يحتاج مراجعة");
  const add = (t) => w.append(el("div", "meta", t));
  if (p._verdict === "complete") add("التركيز والشكل والعبوة متطابقين مع نتيجة الويب.");
  else add("نتيجة ناقصة. غير متحقق منه: " + (p._missing.map((k) => AR_MISS[k] || k).join("، ") || "بعض البيانات"));
  if (p._cand && p._cand.name) {
    const m = el("div", "meta", "الاسم المقترح من الويب: " + p._cand.name + " — ");
    const u = https(p._cand.source_url);
    if (u) { const a = el("a", null, "المصدر"); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; m.append(a); }
    w.append(m);
  }
  if (p._multi) add("فيه أكتر من منتج متطابق. مختارناش واحد منهم، قارن بالعبوة.");
  if (p._hidden) add("اتخفّى " + p._hidden + " منتج بتركيز أو شكل أو عبوة مختلفة.");
  c.prepend(w);
  return c;
};
})();
