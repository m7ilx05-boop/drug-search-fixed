/* interactions.js — فحص التفاعلات الدوائية بين أدوية الفاتورة.
   بيعتمد على: core.js (el, call, ERR, toast). بيتفتح من زر «فحص التفاعلات» جوه شيت فاتورة الروشتة (image-search.js).
   القرار (فيه تفاعل ولا لأ، ودرجته) جاي من دالة drug-interactions بس. الفرونت بيعرض اللي رجع ومبيحكمش على حاجة بنفسه.
   مفيش تفاعل مسجّل ≠ آمن: الجملة دي بتظهر دايمًا. */
(function () {
  const ST = {
    interaction: ["تفاعل مسجّل", "bad"],
    label_only: ["مذكور في نشرة المنتج", "warn"],
    incomplete: ["الفحص ناقص", "warn"],
    no_record: ["مفيش تفاعل مسجّل", "ok"],
  };
  const LV = { Major: ["شديد", "bad"], Moderate: ["متوسط", "warn"], Minor: ["بسيط", "ok"], Unknown: ["الدرجة غير محددة", "warn"] };
  const MAX_RETRIES = 3;
  const cnt = (v) => Number(v).toLocaleString("ar-EG");
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);

  const css = document.createElement("style");
  css.textContent = ".ddi-sum{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}"
    + ".ddi-alert{display:flex;gap:12px;align-items:flex-start;margin:0 0 12px;padding:14px;border-radius:16px;background:#C62828;color:#fff;line-height:1.6;box-shadow:0 2px 10px rgba(0,0,0,.25)}"
    + ".ddi-alert-ic{flex:none;font-size:28px;line-height:1}.ddi-alert-t{font-weight:700;font-size:16.5px;margin:0 0 2px}.ddi-alert-s{font-size:14px;margin:0}"
    + ".ddi-pair.sev{border-width:2px;border-color:#C62828;box-shadow:0 0 0 3px rgba(198,40,40,.22)}"
    + ".ddi-alert.warn{background:#B45309}.ddi-alert.okb{background:#1B7F4D}"
    + ".ddi-pair.okc{border-width:2px;border-color:#1B7F4D}.ddi-pair.inc{border-width:2px;border-color:#B45309}"
    + ".ddi-tag{display:inline-flex;align-items:center;gap:6px;margin:0 0 8px;padding:4px 12px;border-radius:999px;color:#fff;font-size:13.5px;font-weight:700}.ddi-tag.warn{background:#B45309}.ddi-tag.okb{background:#1B7F4D}"
    + ".ddi-sevtag{display:inline-flex;align-items:center;gap:6px;margin:0 0 8px;padding:4px 12px;border-radius:999px;background:#C62828;color:#fff;font-size:13.5px;font-weight:700}"
    + ".ddi-pair{border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin-bottom:10px;background:var(--bg)}"
    + ".ddi-pair.bad{border-color:var(--bad)}.ddi-pair.warn{border-color:var(--warn)}"
    + ".ddi-names{font-weight:600;line-height:1.5;margin-bottom:6px}.ddi-n{overflow-wrap:anywhere}.ddi-with{color:var(--muted);font-size:12.5px;font-weight:400}"
    + ".ddi-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}"
    + ".ddi-ai{margin:6px 0;padding:9px 12px;border-radius:12px;background:var(--soft);color:var(--soft-ink);font-size:14px;line-height:1.6}"
    + ".ddi-q{margin:6px 0;padding:8px 12px;border-inline-start:3px solid var(--line);color:var(--ink);font-size:13.5px;line-height:1.55;text-align:left}"
    + ".ddi-src{display:block;color:var(--muted);font-size:12.5px;margin:2px 0 6px}.ddi-src a{color:var(--accent)}"
    + ".ddi-note{color:var(--muted);font-size:13px;line-height:1.55;margin:4px 0}"
    + ".ddi-dup{margin:0 0 10px;padding:10px 12px;border-radius:14px;background:var(--warn-bg);color:var(--warn);font-size:14px;line-height:1.55}"
    + ".ddi-disc{margin:8px 0 0;padding:10px 12px;border-radius:14px;background:var(--soft);color:var(--soft-ink);font-size:13.5px;line-height:1.55}"
    + ".ddi-load,.ddi-err{text-align:center;color:var(--muted);padding:26px 0}.ddi-err{color:var(--bad)}"
    + ".ddi-retry{display:block;margin:10px auto 0;min-height:44px;padding:0 18px;border-radius:12px;border:1px solid var(--accent);background:transparent;color:var(--accent);font:inherit;font-weight:600;cursor:pointer}"
    + ".ddi-uk{margin:6px 0 0;font-size:13px}.ddi-uk summary{cursor:pointer;color:var(--soft-ink)}.ddi-uk .ddi-q{white-space:pre-wrap;max-height:260px;overflow:auto}"
    + ".ddi-pap{margin:6px 0 0;font-size:13px}.ddi-pap summary{cursor:pointer;color:var(--soft-ink)}.ddi-pap ul{margin:6px 0 0;padding-inline-start:18px}.ddi-pap li{margin-bottom:4px;text-align:left}.ddi-pap a{color:var(--accent)}";
  document.head.append(css);

  const chip = (text, kind) => el("span", "chip " + (kind || ""), text);
  const names = (a, b) => {
    const d = el("div", "ddi-names"), x = el("div", "ddi-n", a), y = el("div", "ddi-n", b);
    x.dir = y.dir = "auto";
    d.append(x, el("div", "ddi-with", "مع"), y);
    return d;
  };

  const isSevere = (p) => !!p && (p.severe === true || (p.status === "interaction" && p.level === "Major"));

  function pairCard(p, items) {
    const st = ST[p.status] || ["غير معروف", "warn"];
    const sev = isSevere(p);
    const c = el("section", "ddi-pair " + (sev ? "sev " : "") + (p.status === "interaction" ? "bad" : p.status === "label_only" || p.status === "incomplete" ? "warn" : ""));
    if (sev) c.append(el("div", "ddi-sevtag", "⚠️ تفاعل خطير"));
    else if (p.status === "incomplete") { c.classList.add("inc"); c.append(el("div", "ddi-tag warn", "⚠️ بيانات ناقصة")); }
    else if (p.status === "no_record") { c.classList.add("okc"); c.append(el("div", "ddi-tag okb", "✅ مفيش تفاعل مسجّل")); }
    c.append(names(p.a.label, p.b.label));
    const chips = el("div", "ddi-chips");
    chips.append(chip(st[0], st[1]));
    if (p.status === "interaction" && p.level) { const lv = LV[p.level] || LV.Unknown; chips.append(chip("الدرجة: " + lv[0], lv[1])); }
    c.append(chips);

    if (p.ai_summary_ar) c.append(el("p", "ddi-ai", p.ai_summary_ar));
    if (p.status === "interaction") {
      (p.findings || []).slice(0, 4).forEach((f) => {
        const n = el("div", "ddi-note"); const x = el("bdi", null, f.ddinter_a || f.ingredient_a), y = el("bdi", null, f.ddinter_b || f.ingredient_b); x.dir = y.dir = "ltr";
        n.append("المادتين: ", x, " + ", y, " (قاعدة DDInter)"); c.append(n);
      });
    }

    (p.evidence || []).forEach((e) => {
      if (!e || !e.snippet) return;
      const q = el("blockquote", "ddi-q"); q.lang = "en"; q.dir = "ltr"; q.textContent = e.snippet; c.append(q);
      const s = el("span", "ddi-src"); s.append("النص كما هو من: " + (e.source || "مصدر رسمي") + (e.product ? " — " + e.product : "") + " ");
      const u = safeUrl(e.url); if (u) { const a = el("a", null, "فتح المصدر"); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; s.append(a); }
      c.append(s);
    });

    const isSupp = (p.a && p.a.kind === "supplement") || (p.b && p.b.kind === "supplement");
    if (p.status === "incomplete") {
      const un = (p.unresolved || []).filter(Boolean);
      if (isSupp) {
        const sn = (p.a && p.a.kind === "supplement" ? p.a.label : "") + (p.a && p.a.kind === "supplement" && p.b && p.b.kind === "supplement" ? " و " : "") + (p.b && p.b.kind === "supplement" ? p.b.label : "");
        const w = el("p", "ddi-note"); const b = el("bdi", null, sn); b.dir = "auto";
        w.append("مكمّل غذائي (", b, "): مفيش قاعدة تفاعلات رسمية ليه، فمكوناته مش بتتفحص في DDInter ولا في النشرات. ده مش معناه إنه آمن مع الدوا التاني. راجع الصيدلي.");
        c.append(w);
      } else c.append(el("p", "ddi-note", un.length
        ? "النتيجة غير معروفة: المواد دي مش موجودة في قاعدة التفاعلات (" + un.join("، ") + ")، ومفيش معلومة عن الزوج ده في نشرات FDA أو EMA أو المملكة المتحدة اللي فحصناها. ده مش معناه إنهم آمنين. راجع الصيدلي."
        : "النتيجة غير معروفة: مفيش مواد فعّالة مسجّلة لواحد من الدوائين. راجع الصيدلي."));
    }
    if (p.ema && p.ema.state === "pending") c.append(el("p", "ddi-note", "بنقرا نشرة الدواء الأوروبية (EMA) للزوج ده دلوقتي. النتيجة ممكن تتحدّث بعد دقيقتين."));
    if (p.ema && p.ema.state === "unavailable") c.append(el("p", "ddi-note", "نشرة EMA مش متاحة دلوقتي للزوج ده."));
    if (p.uk && p.uk.state === "pending") c.append(el("p", "ddi-note", "بنقرا نشرة المنتج البريطانية (emc) للزوج ده دلوقتي. النتيجة هتتحدّث تلقائي."));
    if (p.uk && p.uk.state === "unavailable") c.append(el("p", "ddi-note", "نشرة emc البريطانية مش متاحة دلوقتي للزوج ده."));
    if (Array.isArray(p.uk_sections) && p.uk_sections.length) {
      p.uk_sections.forEach((u) => {
        if (!u || !u.text) return;
        const d = el("details", "ddi-uk"), sm = el("summary");
        const ib = el("bdi", null, u.ingredient || ""); ib.dir = "ltr";
        sm.append("نص قسم 4.5 (التفاعلات) من نشرة ", ib, " البريطانية");
        d.append(sm);
        const q = el("blockquote", "ddi-q"); q.lang = "en"; q.dir = "ltr"; q.textContent = u.text; d.append(q);
        const sr = el("span", "ddi-src"); sr.append("النص كما هو من: UK SmPC (emc)" + (u.product ? " — " + u.product : "") + ". مصدر بريطاني مش مصري، واسم الدوا التاني مش مذكور بالاسم فيه، اقراه كله. ");
        const uu = safeUrl(u.url); if (uu) { const a = el("a", null, "فتح المصدر"); a.href = uu; a.target = "_blank"; a.rel = "noopener noreferrer"; sr.append(a); }
        d.append(sr); c.append(d);
      });
    }
    if (p.status === "no_record") {
      c.append(el("p", "ddi-note", "مفيش تفاعل مسجّل في المصادر اللي بنفحصها. ده مش معناه إنهم آمنين مع بعض."));
      const ing = (i) => ((items && items[i] && items[i].ingredients) || []).map((x) => (x.matched && x.matched[0]) || x.raw).filter(Boolean);
      const nm = ing(p.a.index).concat(ing(p.b.index));
      if (nm.length) { const n = el("p", "ddi-note"); const b = el("bdi", null, [...new Set(nm)].join("، ")); b.dir = "ltr"; n.append("المواد اللي اتفحصت (كلها معروفة في قاعدة DDInter): ", b); c.append(n); }
    }

    const pp = p.papers;
    if (pp && pp.found > 0 && Array.isArray(pp.items) && pp.items.length) {
      const d = el("details", "ddi-pap"); d.append(el("summary", null, "أبحاث مرتبطة (للاطلاع فقط، مش حكم بدرجة الخطورة)"));
      const ul = el("ul");
      pp.items.forEach((it) => {
        const li = el("li"); li.lang = "en"; li.dir = "ltr";
        const u = safeUrl(it.url), t = (it.title || "PubMed " + it.pmid) + (it.year ? " (" + it.year + ")" : "");
        if (u) { const a = el("a", null, t); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; li.append(a); } else li.textContent = t;
        ul.append(li);
      });
      d.append(ul); c.append(d);
    }
    return c;
  }

  function render(box, d) {
    const nodes = [];
    const cv = d.coverage || {};
    const nSev = Number.isFinite(Number(cv.major)) && cv.major !== undefined ? Number(cv.major) : (d.pairs || []).filter(isSevere).length;
    if (nSev > 0) {
      const a = el("div", "ddi-alert"); a.setAttribute("role", "alert");
      const tx = el("div");
      tx.append(el("p", "ddi-alert-t", "تحذير: " + (nSev === 1 ? "فيه تفاعل خطير" : cnt(nSev) + " تفاعلات خطيرة") + " في الروشتة"),
        el("p", "ddi-alert-s", "الدرجة «شديد» حسب قاعدة DDInter. راجع الطبيب أو الصيدلي قبل صرف الأدوية دي مع بعض."));
      a.append(el("div", "ddi-alert-ic", "⚠️"), tx);
      nodes.push(a);
    }
    const incPairs = (d.pairs || []).filter((p) => p.status === "incomplete");
    if (incPairs.length) {
      const unk = [...new Set(incPairs.flatMap((p) => (p.unresolved || []).filter(Boolean)))];
      const a = el("div", "ddi-alert warn"); a.setAttribute("role", "alert");
      const tx = el("div");
      const sub = el("p", "ddi-alert-s"); sub.append(unk.length ? "مش عارفين عن المواد دي أي حاجة: " : "مفيش مواد فعّالة مسجّلة لبعض الأدوية. ");
      if (unk.length) { const b = el("bdi", null, unk.join("، ")); b.dir = "ltr"; sub.append(b, ". "); }
      sub.append("ده مش معناه إنها آمنة. راجع الصيدلي أو مرجع تاني.");
      tx.append(el("p", "ddi-alert-t", "بيانات ناقصة: الفحص مش مكتمل لـ " + cnt(incPairs.length) + (incPairs.length === 1 ? " زوج" : " أزواج")), sub);
      a.append(el("div", "ddi-alert-ic", "⚠️"), tx);
      nodes.push(a);
    }
    if (!nSev && !incPairs.length && !cv.interaction && !cv.label_only && cv.no_record) {
      const a = el("div", "ddi-alert okb");
      const tx = el("div");
      tx.append(el("p", "ddi-alert-t", "مفيش تفاعل مسجّل بين الأدوية دي"),
        el("p", "ddi-alert-s", "في المصادر اللي فحصناها (DDInter وFDA وEMA وUK). ده مش ضمان إنها آمنة، راجع الصيدلي لو الحالة حساسة."));
      a.append(el("div", "ddi-alert-ic", "✅"), tx);
      nodes.push(a);
    }
    const sum = el("div", "ddi-sum");
    if (nSev > 0) sum.append(chip("⚠️ " + cnt(nSev) + " خطير", "bad"));
    if (cv.interaction) sum.append(chip(cnt(cv.interaction) + " تفاعل مسجّل", "bad"));
    else if (!cv.incomplete && !cv.label_only) sum.append(chip("مفيش تفاعل مسجّل", "ok"));
    if (cv.label_only) sum.append(chip(cnt(cv.label_only) + " في نشرة المنتج", "warn"));
    if (cv.incomplete) sum.append(chip(cnt(cv.incomplete) + " فحص ناقص", "warn"));
    if (cv.no_record) sum.append(chip(cnt(cv.no_record) + " مفيش تسجيل", "ok"));
    nodes.push(sum);
    (d.duplicates || []).forEach((x) => {
      const w = el("div", "ddi-dup"); const n = el("bdi", null, x.ingredient || ""); n.dir = "auto";
      w.append("نفس المادة الفعّالة (", n, ") موجودة في: " + x.a.label + " و " + x.b.label + ". ممكن يكون تكرار في العلاج، راجع الصيدلي.");
      nodes.push(w);
    });
    (d.pairs || []).forEach((p) => nodes.push(pairCard(p, d.items)));
    nodes.push(el("p", "ddi-disc", d.disclaimer_ar || "النتيجة استرشادية، ومش بديل عن مراجعة الطبيب أو الصيدلي. غياب تفاعل مسجّل مش معناه إن الأدوية آمنة مع بعض."));
    box.replaceChildren(...nodes);
  }

  // items: [{ label, ingredients: [..] }]، لازم دوائين على الأقل بمواد فعّالة
  function open(items) {
    const list = (items || []).filter((x) => x && Array.isArray(x.ingredients) && x.ingredients.length);
    if (list.length < 2) { toast("warn", "محتاجين دوائين على الأقل بمواد فعّالة معروفة."); return; }
    let closed = false, timer = 0;
    const ov = el("div", "rxc-ov"), sh = el("div", "rxc-sheet");
    sh.setAttribute("role", "dialog"); sh.setAttribute("aria-modal", "true"); sh.setAttribute("aria-label", "فحص التفاعلات الدوائية");
    const head = el("div", "rxc-head"), x = el("button", "rxc-x", "✕"); x.type = "button"; x.setAttribute("aria-label", "إغلاق");
    head.append(el("h3", null, "التفاعلات الدوائية"), x);
    const body = el("div", "rxc-list");
    sh.append(head, body); ov.append(sh); document.body.append(ov);
    const close = () => { if (closed) return; closed = true; clearTimeout(timer); ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    x.addEventListener("click", close); ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    document.addEventListener("keydown", onKey); x.focus();

    async function load(attempt) {
      if (closed) return;
      if (attempt === 0) body.replaceChildren(el("div", "ddi-load", "جاري فحص التفاعلات…"));
      try {
        const d = await call("drug-interactions", { items: list.map((i) => ({ label: i.label, ingredients: i.ingredients, kind: i.kind === "supplement" ? "supplement" : undefined })) });
        if (closed) return;
        render(body, d);
        if (d.retry_after_sec && attempt < MAX_RETRIES) {
          const n = el("p", "ddi-note", "فيه نشرات بتتقرا دلوقتي. هنحدّث النتيجة تلقائي بعد " + cnt(d.retry_after_sec) + " ثانية.");
          body.prepend(n);
          timer = setTimeout(() => load(attempt + 1), d.retry_after_sec * 1000);
        }
      } catch (err) {
        if (closed) return;
        const code = (err && (err.code || err.message)) || "unknown";
        const box = el("div", "ddi-err", ERR[code] || "ما قدرناش نفحص التفاعلات دلوقتي (" + code + ").");
        const rb = el("button", "ddi-retry", "حاول تاني"); rb.type = "button"; rb.addEventListener("click", () => load(0));
        body.replaceChildren(box, rb);
      }
    }
    load(0);
  }

  window.DDI = { open };
})();
