/* render.js — رسم الكروت والنتايج.
   بيعرّف: showDoses, ean13Svg, picBlock, priceBlock, barcodeBlock, card, تجميع النتايج (mergeGroup, groupPending,
   dedupeApproved, pendingCard), readTiers, renderAll, render, suggestBox, showSuggestions, appendSuggestions, showPending
   بيعتمد على: core.js. card بينادي altBlock (من alternatives.js) وقت التشغيل. */

// نتيجة بحث الجرعات في الصيدليات: بتظهر مؤقتًا تحت المنتج، ومتسجلة في جدول المراجعة، ومش بتتكتب في السجل الرسمي.
function showDoses(box, r) {
  box.replaceChildren();
  const doses = Array.isArray(r.doses) ? r.doses : [];
  if (!doses.length) {
    box.append(el("div", "meta", "ما لقيناش جرعات مؤكدة في الصيدليات. صفحات المنتج هناك ما فيهاش أرقام نقدر نتحقق منها."));
    return;
  }
  const chips = el("div", "chips");
  chips.append(el("span", "chip warn", "من الصيدليات"), el("span", "chip warn", "قيد المراجعة"));
  box.append(chips);
  const ul = el("ul", "ing");
  doses.forEach((d) => {
    const li = el("li");
    const left = el("span", null, d.ingredient + (d.conflict ? " ⚠ أرقام متعارضة" : ""));
    const right = el("span");
    right.append((Number(d.value) + " " + (d.unit || "") + " / " + (d.per || "tablet")) + " · ");
    (d.sources || []).slice(0, 2).forEach((s, i) => {
      if (i) right.append(" · ");
      const u = (() => { try { const x = new URL(s.url); return x.protocol === "https:" ? x.href : null; } catch { return null; } })();
      if (u) { const a = el("a", null, s.host); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; right.append(a); } else right.append(s.host || "");
    });
    li.append(left, right);
    ul.append(li);
  });
  box.append(ul);
  box.append(el("div", "meta", "اتسجّلت في جدول المراجعة ومش اتضافت للسجل الرسمي. راجع المصدر قبل ما تعتمد عليها." + (Array.isArray(r.still_missing) && r.still_missing.length ? " لسه ناقص: " + r.still_missing.join("، ") : "")));
}

// ===== باركود EAN-13 (رسم حقيقي + تحقق من رقم المراجعة) =====
const EL = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const flip = (s) => s.replace(/[01]/g, (c) => (c === "0" ? "1" : "0"));
const ER = EL.map(flip), EG = ER.map((s) => [...s].reverse().join(""));
const EP = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

function ean13Svg(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length !== 13) return null;
  const n = [...d].map(Number);
  const sum = n.slice(0, 12).reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0);
  if ((10 - (sum % 10)) % 10 !== n[12]) return null;
  let bits = "101";
  for (let i = 1; i <= 6; i++) bits += (EP[n[0]][i - 1] === "L" ? EL : EG)[n[i]];
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += ER[n[i]];
  bits += "101";
  const Q = 9, H = 60, NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + (95 + Q * 2) + " " + (H + 14));
  svg.setAttribute("width", "240");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "باركود " + d);
  const guard = (i) => i < 3 || (i >= 45 && i < 50) || i >= 92;
  [...bits].forEach((b, i) => {
    if (b !== "1") return;
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", Q + i); r.setAttribute("y", 0);
    r.setAttribute("width", 1); r.setAttribute("height", guard(i) ? H + 5 : H);
    r.setAttribute("fill", "#000");
    svg.append(r);
  });
  const t = (x, s) => { const e = document.createElementNS(NS, "text"); e.setAttribute("x", x); e.setAttribute("y", H + 12); e.setAttribute("font-size", "10"); e.setAttribute("font-family", "monospace"); e.setAttribute("text-anchor", "middle"); e.setAttribute("fill", "#000"); e.textContent = s; svg.append(e); };
  t(Q - 5, d[0]); t(Q + 3 + 21, d.slice(1, 7)); t(Q + 50 + 21, d.slice(7));
  return svg;
}

function picBlock(p) {
  const box = el("div", "pic");
  const u = (() => { try { const x = new URL(p.image && p.image.url); return x.protocol === "https:" ? x.href : null; } catch { return null; } })();
  if (p.image && p.image.has_image && u) {
    const im = el("img"); im.src = u; im.alt = p.product_name || ""; im.loading = "lazy"; im.referrerPolicy = "no-referrer";
    im.onerror = () => { box.replaceChildren("💊"); };
    box.append(im);
  } else box.append("💊");
  return box;
}

function priceBlock(p) {
  const cur = p.current_price != null ? p.current_price : p.price;
  if (cur == null) return null;
  const d = p.price_updated_on || p.price_date || p.price_updated_at;
  const fmt = (v) => Number(v).toLocaleString("ar-EG") + " ج.م";
  const row = el("div", "price");
  const left = el("div");
  left.append(el("b", null, fmt(cur)));
  if (p.old_price != null && Number(p.old_price) !== Number(cur)) left.append(el("span", null, "  (السعر السابق: " + fmt(p.old_price) + ")"));
  row.append(left, el("span", null, d ? "آخر تحديث للسعر: " + new Date(d).toLocaleDateString("ar-EG") : "تاريخ تحديث السعر غير معروف"));
  return row;
}

function barcodeBlock(p) {
  const b = p.barcode, raw = typeof b === "string" ? b : (b && (b.digits || b.value || b.formatted || b.gtin)) || p.gtin;
  const svg = ean13Svg(raw);
  if (!svg) return null;
  const box = el("div", "bc"); box.append(svg);
  if (p.barcode_format) box.append(el("small", null, p.barcode_format));
  return box;
}

// ===== زرار "مش صورة المنتج" و "دوّر على الصورة" =====
// بيظهروا حسب p.image_check.can_report و p.image_import.can_import، وبيبعتوا { dwaprices_id } للدالتين drug-image-report و drug-image-import.
function waitText(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "";
  return s < 90 ? " (بعد حوالي " + Math.ceil(s) + " ثانية)" : " (بعد حوالي " + Math.ceil(s / 60) + " دقيقة)";
}
function imgErrText(err) {
  const base = ERR[err.code] || "حصلت مشكلة في الاتصال. جرّب تاني.";
  return base + waitText(err.data && err.data.retry_after);
}
function dateAr(iso) { try { return new Date(iso).toLocaleDateString("ar-EG"); } catch { return ""; } }

function imageActions(p) {
  if (!Number.isInteger(p.dwaprices_id)) return null;
  const canReport = !!(p.image_check && p.image_check.can_report);
  const canImport = !!(p.image_import && p.image_import.can_import);
  const imported = !!(p.image && p.image.imported);
  if (!canReport && !canImport && !imported) return null;

  const box = el("div", "img-actions");
  const msg = el("div", "meta img-msg");
  msg.setAttribute("role", "status");
  const say = (t) => { msg.textContent = t; };
  const swapPic = (url) => {
    const old = box.parentElement && box.parentElement.querySelector(".pic");
    if (old) old.replaceWith(picBlock({ ...p, image: { has_image: !!url, url } }));
  };

  if (imported) {
    const src = p.image.source && p.image.source !== "imported" ? " من " + p.image.source : "";
    say("الصورة دي اتجلبت تلقائي" + src + " ومش من المصدر الرسمي.");
  }

  if (canReport) {
    const b = el("button", "img-btn", "مش صورة المنتج؟");
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "جاري فحص الصورة…"; say("");
      try {
        const r = await call("drug-image-report", { dwaprices_id: p.dwaprices_id });
        if (r.status === "mismatch") {
          swapPic(null);
          say(r.reason === "strength_differs"
            ? "الفحص لقى إن التركيز المكتوب على العلبة مختلف، فالصورة مش للمنتج ده."
            : "الفحص لقى إن الصورة مش للمنتج ده، واتشالت.");
        } else if (r.status === "match") {
          say("الفحص أكد إن الصورة بتاعة المنتج" + (r.cached ? " (نتيجة محفوظة)" : "") + ".");
        } else {
          say("الصورة مش واضحة كفاية، فمقدرناش نحكم عليها.");
        }
        b.remove();
      } catch (err) {
        say(imgErrText(err));
        b.disabled = false; b.textContent = "مش صورة المنتج؟";
      }
    });
    box.append(b);
  }

  if (canImport) {
    const b = el("button", "img-btn", "دوّر على الصورة");
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "جاري البحث عن صورة…"; say("ممكن ياخد حوالي دقيقة.");
      try {
        const r = await call("drug-image-import", { dwaprices_id: p.dwaprices_id });
        if (r.status === "accepted" && r.image_url) {
          swapPic(r.image_url);
          say("لقينا صورة مطابقة" + (r.source_domain ? " من " + r.source_domain : "") + ". الصورة اتجلبت تلقائي ومش من المصدر الرسمي.");
          b.remove();
        } else {
          say("ملقيناش صورة مطابقة للمنتج." + (r.next_allowed_at ? " تقدر تجرّب تاني بعد " + dateAr(r.next_allowed_at) + "." : ""));
          b.remove();
        }
      } catch (err) {
        say(imgErrText(err));
        b.disabled = false; b.textContent = "دوّر على الصورة";
      }
    });
    box.append(b);
  }
  box.append(msg);
  return box;
}

// tier: 1 = معتمد من المصنع، 2 = من الصيدليات، 3 = غير مؤكد، undefined = من غير تصنيف
function card(p, tier) {
  const c = el("article", "card" + (tier === 1 ? " official" : tier === 2 ? " pharm" : ""));
  c.append(picBlock(p));
  const h = el("h2", null, p.product_name);
  if (p.arabic_name) { h.append(" "); h.append(el("span", "ar", p.arabic_name)); }
  c.append(h);
  const meta = [p.brand_families?.name, p.manufacturer && "الشركة: " + p.manufacturer].filter(Boolean).join(" — ");
  if (meta) c.append(el("div", "meta", meta));

  const ings = p.product_ingredients || [];
  if (ings.length) {
    const ul = el("ul", "ing");
    ings.forEach((pi) => {
      const li = el("li"); li.dir = "auto";
      if (pi.active_ingredients?.inn) li.dataset.ing = pi.active_ingredients.inn;
      li.append(el("span", null, pi.active_ingredients?.inn || "مادة غير معروفة"), el("span", null, fmtStrength(pi)));
      ul.append(li);
    });
    c.append(ul);
  } else if (p.scientific_name) {
    const ul = el("ul", "ing");
    String(p.scientific_name).split("+").map((s) => s.trim()).filter(Boolean).forEach((n) => {
      const li = el("li"); li.dir = "auto"; li.dataset.ing = n;
      li.append(el("span", null, n));
      ul.append(li);
    });
    c.append(ul);
  } else c.append(el("div", "meta", "المواد الفعّالة غير مسجّلة بعد."));

  const chips = el("div", "chips");
  if (tier === 2) chips.append(el("span", "chip warn", "من الصيدليات"));
  if (tier === 3) chips.append(el("span", "chip warn", "غير مؤكد"));
  if (p.dosage_form) chips.append(el("span", "chip", p.dosage_form));
  if (p.pack_size) chips.append(el("span", "chip", "العبوة: " + p.pack_size));
  if (p.is_combination) chips.append(el("span", "chip", "تركيبة مدمجة"));
  const [regText, regCls] = REG[p.registration_status] || REG.UNKNOWN;
  chips.append(el("span", "chip " + regCls, regText));
  chips.append(el("span", "chip warn", "التوفر غير متحقق منه"));
  c.append(chips);
  const ia = imageActions(p); if (ia) c.append(ia);

  if (p.doses_missing === true) {
    const dn = el("div", "dose-note");
    dn.append(el("div", null, p.doses_note || "بعض الجرعات مش مذكورة في صفحة المصنع."));
    if (p.can_search_pharmacies_for_doses && p.id) {
      const b = el("button", null, "ابحث في الصيدليات عن الجرعات");
      b.type = "button";
      const res = el("div", "dose-res");
      b.addEventListener("click", async () => {
        b.disabled = true; b.textContent = "جاري البحث في الصيدليات…"; res.replaceChildren();
        try {
          const r = await call("drug-doses-pharmacy", { product_id: p.id });
          showDoses(res, r);
          b.textContent = r.status === "found" ? "تم البحث" : "ابحث في الصيدليات عن الجرعات";
          b.disabled = r.status === "found";
        } catch (err) {
          res.append(el("div", "meta", (ERR[err.code] || "حصلت مشكلة في الاتصال. جرّب تاني.") + (err.code && !ERR[err.code] ? " (" + err.code + ")" : "")));
          b.textContent = "ابحث في الصيدليات عن الجرعات"; b.disabled = false;
        }
      });
      dn.append(b, res);
    }
    c.append(dn);
  }

  [priceBlock(p), barcodeBlock(p), altBlock(p)].forEach((n) => n && c.append(n));
  const when = (p.identity_verified_at || p.last_read_at) ? new Date(p.identity_verified_at || p.last_read_at).toLocaleString("ar-EG") : "لم يتم التحقق بعد";
  c.append(el("div", "meta", "آخر تحقق من البيانات: " + when));
  return c;
}

// ===== تجميع النتايج المتكررة =====
function mergeGroup(items) {
  const fields = ["product_name", "arabic_name", "manufacturer", "strength_summary", "dosage_form", "pack_size", "source_url"];
  const score = (p) => fields.filter((f) => p[f]).length;
  const base = items.slice().sort((x, y) => score(y) - score(x))[0];
  const m = { ...base };
  items.forEach((p) => fields.forEach((f) => { if (!m[f] && p[f]) m[f] = p[f]; }));
  items.forEach((p) => { if (String(p.strength_summary || "").length > String(m.strength_summary || "").length) m.strength_summary = p.strength_summary; });
  const packs = new Map();
  items.forEach((p) => { const s = String(p.pack_size || "").trim(), k = normKey(s); if (k && !packs.has(k)) packs.set(k, s); });
  m._packs = [...packs.values()];
  const links = new Map();
  items.forEach((p) => { const s = srcLink(p.source_url); if (s && !links.has(s.host)) links.set(s.host, s); });
  m._sources = [...links.values()];
  m.needs_fix = items.every((p) => p.needs_fix);
  return m;
}
// نفس الاسم + نفس الشكل = منتج واحد. اسم مختلف (Mebo Scar) أو شكل مختلف = منتج منفصل.
function groupPending(list) {
  const byName = new Map();
  list.forEach((p) => { if (!p) return; const k = normKey(p.product_name || p.arabic_name); if (!k) return; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); });
  const groups = [];
  byName.forEach((items) => {
    const forms = new Map(), noForm = [];
    items.forEach((p) => { const fk = normKey(p.dosage_form); if (!fk) { noForm.push(p); return; } if (!forms.has(fk)) forms.set(fk, []); forms.get(fk).push(p); });
    if (!forms.size) { groups.push(noForm); return; }
    // نسخة من غير شكل دوائي بتتدمج في أكبر مجموعة بنفس الاسم
    const biggest = [...forms.values()].sort((x, y) => y.length - x.length)[0];
    biggest.push(...noForm);
    forms.forEach((g) => groups.push(g));
  });
  return groups.map(mergeGroup).sort((x, y) => normKey(x.product_name || x.arabic_name).localeCompare(normKey(y.product_name || y.arabic_name)));
}
function dedupeApproved(list) {
  const seen = new Map();
  list.forEach((p) => { const k = p.id != null ? "id" + p.id : normKey(p.product_name) + "|" + normKey(p.dosage_form) + "|" + normKey(p.pack_size); if (!seen.has(k)) seen.set(k, p); });
  return [...seen.values()];
}
// منتج لقيناه أونلاين ولسه ما اتعتمدش (بعد دمج المتكرر). ظاهر بعلامة واضحة وليس في قاعدة البيانات.
function pendingCard(p) {
  const c = el("article", "card pending");
  const h = el("h2", null, p.product_name || "منتج بدون اسم");
  if (p.arabic_name) { h.append(" "); h.append(el("span", "ar", p.arabic_name)); }
  c.append(h);
  const words = String(p.product_name || "").trim().split(/\s+/);
  const fam = words.length > 1 && words[0].length >= 3 ? "عائلة: " + words[0] : "";
  const meta = [fam, p.manufacturer && "الشركة: " + p.manufacturer].filter(Boolean).join(" — ");
  if (meta) c.append(el("div", "meta", meta));
  if (p.strength_summary) c.append(el("div", "meta", "التركيب: " + String(p.strength_summary).slice(0, 200)));
  const chips = el("div", "chips");
  chips.append(el("span", "chip warn", "قيد المراجعة"));
  if (p.needs_fix) chips.append(el("span", "chip bad", "بيانات ناقصة أو محتاجة تصحيح"));
  if (p.dosage_form) chips.append(el("span", "chip", p.dosage_form));
  (p._packs || []).slice(0, 6).forEach((k) => chips.append(el("span", "chip", "العبوة: " + k)));
  if ((p._sources || []).length > 1) chips.append(el("span", "chip", "لقيناه في " + p._sources.length + " مواقع"));
  c.append(chips);
  if ((p._sources || []).length) {
    const m = el("div", "meta", "المصدر: ");
    p._sources.slice(0, 3).forEach((s, i) => { if (i) m.append(" · "); const a = el("a", null, s.host); a.href = s.href; a.target = "_blank"; a.rel = "noopener noreferrer"; m.append(a); });
    c.append(m);
  }
  return c;
}

// يقرأ d.tiers ويرجّع [طبقة1, طبقة2, طبقة3] أو null لو مفيش tiers.
// أسماء المفاتيح هنا افتراضية: لو الباك اند بيرجعها بأسماء تانية عدّل القوائم دي بس.
function readTiers(d) {
  const t = d && d.tiers;
  if (!t || typeof t !== "object") return null;
  const KEYS = [["official", "tier1", "tier_1", "1"], ["pharmacy_consensus", "pharmacy", "pharmacies", "tier2", "tier_2", "2"], ["unverified", "unconfirmed", "tier3", "tier_3", "3"]];
  const list = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.results) ? v.results : null);
  if (Array.isArray(t)) {
    return [1, 2, 3].map((n) => { const g = t.find((x) => x && Number(x.tier) === n); return list(g && (g.results || g.products)) || []; });
  }
  return KEYS.map((ks) => { for (const k of ks) { const v = list(t[k]); if (v) return v; } return []; });
}

// يعرض المصدر الرسمي الأول، بعده منتجات المصنّع من الصيدليات، بعده الصيدليات، بعده غير المؤكد، بعده قيد المراجعة. بيرجّع عدد الكروت.
function renderAll(d, note) {
  const out = $("out");
  out.replaceChildren();
  const tiers = readTiers(d);
  const t1 = dedupeApproved(tiers ? tiers[0] : (Array.isArray(d.results) ? d.results : []));
  const tm = dedupeApproved(d.pharmacies && Array.isArray(d.pharmacies.manufacturer) ? d.pharmacies.manufacturer : []);
  const t2 = tiers ? dedupeApproved(tiers[1]) : [];
  const t3 = tiers ? dedupeApproved(tiers[2]) : [];
  const approved = [...t1, ...tm, ...t2, ...t3];
  const pending = groupPending(Array.isArray(d.pending_review) ? d.pending_review : []).filter((g) =>
    !approved.some((p) => normKey(p.product_name) === normKey(g.product_name) && (!g.dosage_form || normKey(p.dosage_form) === normKey(g.dosage_form))));
  if (!approved.length && !pending.length) { out.append(el("div", "empty", note || "مفيش منتجات محفوظة لهذا البحث.")); return 0; }
  const section = (list, tier, title, sub) => {
    if (!list.length) return;
    if (tiers) { out.append(el("h3", "sec", title + " (" + list.length + ")")); if (sub) out.append(el("p", "sec-note", sub)); }
    list.forEach((p) => out.append(card(p, tiers ? tier : undefined)));
  };
  const src = d.source && d.source.name;
  section(t1, 1, "تم مراجعته", src ? (d.disclaimer || "") : "بيانات من الموقع الرسمي للشركة المصنّعة.");
  section(tm, 1, "معتمد من المصنع", "بيانات من الموقع الرسمي للشركة المصنّعة.");
  section(t2, 2, "من الصيدليات", "بيانات من صيدليات على الإنترنت مش من المصنع. قارنها بمصدر رسمي.");
  section(t3, 3, "غير مؤكد", "لسه ما اتأكدش من مصدر موثوق.");
  if (pending.length) {
    out.append(el("h3", "sec", "قيد المراجعة (" + pending.length + ")"));
    out.append(el("p", "sec-note", "لقيناها على الإنترنت ولسه ما اتأكدش منها ومش متضافة لقاعدة البيانات. راجع المصدر قبل ما تعتمد عليها."));
    pending.forEach((p) => out.append(pendingCard(p)));
  }
  return approved.length + pending.length;
}

function render(results, note) {
  const out = $("out");
  out.replaceChildren();
  if (!results.length) {
    out.append(el("div", "empty", note || "مفيش منتجات محفوظة لهذا البحث."));
    return;
  }
  results.forEach((p) => out.append(card(p)));
}

// items: [{ text, type? }]  (type = search_type to use when the button is clicked)
// Each suggestion is a button: click = put the name in the search box + start a brand-new search with it.
function suggestBox(heading, items) {
  const box = el("div", "suggest");
  box.append(el("p", null, heading));
  const opts = el("div", "opts");
  items.slice(0, 5).forEach((it) => {
    const b = el("button", null, "ابحث بـ " + it.text);
    b.type = "button";
    b.addEventListener("click", () => {
      const q = $("q");
      q.value = it.text;
      const radio = document.querySelector('input[name=t][value="' + (it.type || "auto") + '"]') || document.querySelector('input[name=t][value="auto"]');
      if (radio) radio.checked = true;
      window.scrollTo({ top: 0, behavior: "smooth" });
      $("f").requestSubmit();
    });
    opts.append(b);
  });
  box.append(opts);
  return box;
}

// nothing found: replace the results with the "did you mean" buttons
function showSuggestions(query, items) {
  const out = $("out");
  out.replaceChildren();
  out.append(suggestBox("ماوجدناش منتج بالاسم «" + query + "». هل تقصد:", items));
}

// something was found but there are also other spellings: add the buttons under the results
function appendSuggestions(items) {
  if (items.length) $("out").append(suggestBox("لو كان الاسم مش اللي تقصده، جرّب:", items));
}

// products found online that wait for review before they join the database (names only: last-resort fallback)
function showPending(message, products) {
  const out = $("out");
  out.replaceChildren();
  const box = el("div", "suggest");
  box.append(el("p", null, message));
  const chips = el("div", "chips");
  products.forEach((p) => chips.append(el("span", "chip", p.dosage_form ? p.name + " — " + p.dosage_form : p.name)));
  box.append(chips);
  out.append(box);
}
