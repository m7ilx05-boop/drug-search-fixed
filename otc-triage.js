/* otc-triage.js — صفحة تقييم الأعراض (#/t): مربع لكل حالة (برد، حلق، كحة...) وليه أسئلته. نسخة تجريبية.
   بتكلّم دالة otc-triage (مشروع الـ OTC) بتوكن تسجيل الدخول الموجود في المتصفح.
   الدالة بتسمح لإيميلات محددة بس (جدول otc_test_users) وبتشغّل المسودات من غير ما تسجّل جلسات.
   بيعتمد على: core.js (el, $, toast). بيتحمّل قبل pages.js. */
(function () {
  const OTC_URL = "https://dsphqsdfhhqfqnkdoezh.supabase.co/functions/v1/otc-triage";
  const OUTCOME = {
    emergency: ["حالة طارئة", "bad"],
    refer_urgent: ["محتاج تقييم طبي عاجل", "bad"],
    refer_doctor: ["راجع الصيدلي أو الدكتور", "warn"],
    self_care: ["ممكن العلاج الذاتي بعد مراجعة الصيدلي", "ok"],
  };
  const ROLE = { first_line: "الخيار الأول", second_line: "خيار تاني", adjunct: "مساعد" };
  const ERRS = {
    login_required: "لازم تسجّل دخولك الأول.",
    not_allowed: "الميزة دي تجريبية ومتاحة لحسابات محددة بس دلوقتي.",
    invalid_input: "في بيانات ناقصة أو غلط. راجع السن والنوع.",
  };

  // شكل مربعات الحالات اللي ليها مسار أسئلة جاهز (بالترتيب). الباقي بيتعرض "قريبًا".
  const CARDS = {
    common_cold: { title: "البرد والإنفلونزا", sub: "رشح، عطس، سخونية، تعب، حساسية الأنف", icon: "🤧", order: 1 },
    sore_throat: { title: "التهاب الحلق", sub: "ألم أو التهاب في الحلق", icon: "🗣️", order: 2 },
    acute_cough: { title: "الكحة", sub: "كحة جافة أو ببلغم", icon: "😷", order: 3 },
  };
  const S = { built: false, step: "home", conds: null, card: null, sel: new Set(), age: "", sex: "", preg: null, lact: null, answers: {}, stack: [], res: null, err: "", loading: false };

  function token() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!/^sb-.+-auth-token$/.test(k)) continue;
        const o = JSON.parse(localStorage.getItem(k) || "null");
        const t = o && (o.access_token || (o.currentSession && o.currentSession.access_token));
        if (t) return t;
      }
    } catch (e) { /* مفيش جلسة */ }
    return "";
  }
  function expired(t) {
    try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp * 1000 < Date.now() + 15000; } catch (e) { return true; }
  }

  async function api(body) {
    const t = token();
    if (!t || expired(t)) throw Object.assign(new Error("login_required"), { code: "login_required" });
    let r;
    try {
      r = await fetch(OTC_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify(body) });
    } catch (e) { throw Object.assign(new Error("network"), { code: "network" }); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || "request_failed"), { code: d.error || "request_failed" });
    return d;
  }

  const root = () => $("otcpage");
  const needsPreg = () => S.sex === "female" && Number(S.age) >= 12 && Number(S.age) <= 55;

  function fail(e) {
    S.loading = false;
    S.err = e.code === "network" ? "مفيش اتصال. جرّب تاني." : ERRS[e.code] || "حصلت مشكلة. جرّب تاني.";
    S.errLogin = e.code === "login_required";
    render();
  }

  function banner() {
    const b = el("div", "otc-banner");
    b.append(el("b", null, "نسخة تجريبية"), el("span", null, " المحتوى مسودة ولسه ماتراجعش من صيدلي. الأداة دي للفرز وليست تشخيصًا وما تغنيش عن الصيدلي أو الدكتور."));
    return b;
  }
  function errBox() {
    if (!S.err) return null;
    const b = el("div", "otc-err", S.err);
    if (S.errLogin) { const a = el("a", null, " سجّل دخولك"); a.href = "/login?e=1"; b.append(a); }
    return b;
  }
  function btn(text, cls, fn) {
    const b = el("button", cls || "otc-btn", text); b.type = "button"; b.addEventListener("click", fn); return b;
  }

  // الحالات متجمّعة بمسار الأسئلة: كل مسار = مربع، وأعراضه = اتحاد أعراض الحالات اللي بتشاركه
  function groups() {
    const m = new Map(), soon = [];
    (S.conds || []).forEach((c) => {
      if (!c.flow_code) { soon.push(c.name_ar); return; }
      let g = m.get(c.flow_code);
      if (!g) { g = { code: c.flow_code, names: [], syms: new Map() }; m.set(c.flow_code, g); }
      g.names.push(c.name_ar);
      (c.symptoms || []).forEach((x) => g.syms.set(x.id, x));
    });
    const cards = [...m.values()].sort((x, y) => ((CARDS[x.code] || {}).order || 99) - ((CARDS[y.code] || {}).order || 99));
    return { cards, soon };
  }
  const cardInfo = (g) => CARDS[g.code] || { title: g.names[0] || g.code, sub: g.names.slice(1).join("، "), icon: "💊" };

  // ===== الخطوة 1: مربعات الحالات =====
  function homeView() {
    const w = el("div", "otc-wrap");
    w.append(banner());
    const e = errBox(); if (e) w.append(e);
    w.append(el("h3", "otc-h", "إيه اللي مضايقك؟"));
    if (!S.conds) { if (!S.err) w.append(el("p", "otc-hint", "ثانية...")); return w; }
    const { cards, soon } = groups();
    const grid = el("div", "otc-cards");
    cards.forEach((g) => {
      const ci = cardInfo(g);
      const c = el("button", "otc-card"); c.type = "button";
      c.append(el("span", "otc-ic", ci.icon));
      const t = el("span", "otc-ct"); t.append(el("b", null, ci.title), el("small", null, ci.sub));
      c.append(t, el("span", "otc-go-ic", "‹"));
      c.addEventListener("click", () => {
        S.card = g; S.err = ""; S.errLogin = false;
        S.sel = new Set(g.syms.size === 1 ? [...g.syms.keys()] : []); // مربع بعرض واحد = العرض ده اتحدد بالاختيار نفسه
        S.answers = {}; S.stack = []; S.res = null; S.step = "info"; render();
      });
      grid.append(c);
    });
    w.append(grid);
    if (soon.length) {
      const d = el("div", "otc-soon");
      d.append(el("h4", null, "قريبًا (لسه مفيش أسئلة لها)"));
      const l = el("div", "otc-soonl"); soon.forEach((n) => l.append(el("span", null, n)));
      d.append(l); w.append(d);
    }
    return w;
  }

  // ===== الخطوة 2: بيانات المريض + أعراض الحالة دي بس =====
  function infoView() {
    const g = S.card, ci = cardInfo(g);
    const w = el("div", "otc-wrap");
    w.append(banner());
    const e = errBox(); if (e) w.append(e);
    const hd = el("div", "otc-chead"); hd.append(el("span", "otc-ic", ci.icon), el("b", null, ci.title));
    w.append(hd);

    const row = el("div", "otc-row");
    const ageL = el("label", "otc-f"); ageL.append(el("span", null, "السن (بالسنين)"));
    const age = el("input"); age.type = "number"; age.inputMode = "decimal"; age.min = "0"; age.max = "120"; age.step = "any"; age.value = S.age; age.setAttribute("aria-label", "السن");
    age.addEventListener("input", () => { S.age = age.value; syncPreg(); });
    ageL.append(age);
    const sexL = el("div", "otc-f"); sexL.append(el("span", null, "النوع"));
    const sg = el("div", "otc-seg");
    [["male", "ذكر"], ["female", "أنثى"]].forEach(([v, t]) => {
      const b = btn(t, "otc-opt" + (S.sex === v ? " on" : ""), () => { S.sex = v; if (v === "male") { S.preg = null; S.lact = null; } render(); });
      b.setAttribute("aria-pressed", S.sex === v);
      sg.append(b);
    });
    sexL.append(sg);
    row.append(ageL, sexL);
    w.append(row);

    const pg = el("div", "otc-preg"); w.append(pg);
    function syncPreg() {
      pg.replaceChildren();
      if (!needsPreg()) { S.preg = null; S.lact = null; return; }
      [["preg", "حامل؟"], ["lact", "بترضّعي؟"]].forEach(([k, t]) => {
        const f = el("div", "otc-f"); f.append(el("span", null, t));
        const gg = el("div", "otc-seg");
        [[true, "أيوه"], [false, "لأ"]].forEach(([v, tt]) => {
          const b = btn(tt, "otc-opt" + (S[k] === v ? " on" : ""), () => { S[k] = v; syncPreg(); });
          b.setAttribute("aria-pressed", S[k] === v);
          gg.append(b);
        });
        f.append(gg); pg.append(f);
      });
    }
    syncPreg();

    let go;
    if (g.syms.size > 1) {
      w.append(el("h3", "otc-h", "إيه اللي حاسس بيه؟"));
      const chips = el("div", "otc-chips"); chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "الأعراض");
      const cnt = el("div", "otc-cnt");
      w.append(chips, cnt);
      const list = [...g.syms.values()].sort((x, y) => x.name.localeCompare(y.name, "ar"));
      const draw = () => {
        chips.replaceChildren();
        list.forEach((x) => {
          const on = S.sel.has(x.id);
          const c = btn(x.name, "otc-chip" + (on ? " on" : ""), () => { if (S.sel.has(x.id)) S.sel.delete(x.id); else S.sel.add(x.id); draw(); });
          c.setAttribute("aria-pressed", on);
          chips.append(c);
        });
        cnt.textContent = S.sel.size ? "اخترت " + S.sel.size.toLocaleString("ar-EG") + " من الأعراض" : "اختار عرض واحد على الأقل";
        go.disabled = !S.sel.size || S.loading;
      };
      go = btn(S.loading ? "ثانية..." : "ابدأ الأسئلة", "otc-btn otc-go", start);
      w.append(go);
      draw();
    } else {
      go = btn(S.loading ? "ثانية..." : "ابدأ الأسئلة", "otc-btn otc-go", start);
      go.disabled = S.loading;
      w.append(go);
    }
    w.append(btn("← رجوع للحالات", "otc-link", () => { S.step = "home"; S.err = ""; render(); }));
    return w;
  }

  function validForm() {
    const a = Number(S.age);
    if (S.age === "" || !Number.isFinite(a) || a < 0 || a > 120) return "اكتب سن صحيح من 0 لـ 120.";
    if (!S.sex) return "اختار النوع.";
    if (needsPreg() && (S.preg == null || S.lact == null)) return "جاوب على الحمل والرضاعة.";
    if (!S.sel.size) return "اختار عرض واحد على الأقل.";
    return "";
  }

  async function start() {
    const bad = validForm();
    if (bad) { S.err = bad; S.errLogin = false; render(); return; }
    S.answers = {}; S.stack = []; S.res = null;
    await assess();
  }

  async function assess() {
    S.loading = true; S.err = ""; S.errLogin = false; render();
    try {
      const d = await api({
        action: "assess", age_years: Number(S.age), sex: S.sex,
        is_pregnant: needsPreg() ? S.preg : undefined, is_lactating: needsPreg() ? S.lact : undefined,
        symptom_ids: [...S.sel], answers: S.answers,
      });
      S.loading = false; S.res = d.result || {};
      S.step = nextQuestion(S.res) ? "ask" : "result";
      render();
    } catch (e) { fail(e); }
  }

  // السؤال اللي لازم يتسأل دلوقتي (لو فيه): مسار الأسئلة، بعدين الأسئلة الإلزامية، بعدين أسئلة فحص الدوا
  function nextQuestion(r) {
    if (!r) return null;
    if (r.status === "flow_question" && r.flow && r.flow.question) {
      const q = r.flow.question; return { key: q.key, text: q.question_ar, hint: q.hint_ar };
    }
    const p = (r.pending_questions || []).find((x) => x && x.question_id);
    if (p) return { key: p.question_id, text: p.question_ar };
    for (const rec of r.recommendations || []) {
      const s = (rec.pending_screening_questions || []).find((x) => x && x.question_id);
      if (s) return { key: s.question_id, text: s.question_ar };
    }
    return null;
  }

  // ===== الخطوة 2: سؤال نعم/لأ =====
  function askView() {
    const w = el("div", "otc-wrap");
    w.append(banner());
    const e = errBox(); if (e) w.append(e);
    const flags = flagsBlock(S.res.triggered_red_flags, true); if (flags) w.append(flags);
    const q = nextQuestion(S.res);
    const card = el("div", "otc-q");
    card.append(el("div", "otc-qn", "سؤال " + (S.stack.length + 1).toLocaleString("ar-EG")));
    card.append(el("p", "otc-qt", q.text));
    if (q.hint) card.append(el("p", "otc-hint", q.hint));
    const g = el("div", "otc-yn");
    ["yes", "no"].forEach((v) => {
      const b = btn(v === "yes" ? "أيوه" : "لأ", "otc-btn " + (v === "yes" ? "otc-yes" : "otc-no"), async () => {
        S.answers[q.key] = v; S.stack.push(q.key); await assess();
      });
      b.disabled = S.loading;
      g.append(b);
    });
    card.append(g);
    w.append(card);
    w.append(navRow(true));
    return w;
  }

  function undo() {
    const k = S.stack.pop();
    if (k) delete S.answers[k];
    if (!S.stack.length && !k) { S.step = "info"; render(); return; }
    assess();
  }
  function navRow(canUndo) {
    const r = el("div", "otc-nav");
    if (canUndo) r.append(btn(S.stack.length ? "← السؤال اللي فات" : "← رجوع لبياناتك", "otc-link", () => { if (S.stack.length) undo(); else { S.step = "info"; render(); } }));
    return r;
  }

  // ===== الخطوة 3: النتيجة =====
  function flagsBlock(list, compact) {
    const fl = (list || []).filter((f) => f && f.name_ar);
    if (!fl.length) return null;
    const b = el("div", "otc-flags");
    b.append(el("h4", null, compact ? "علامات خطر ظهرت" : "علامات الخطر"));
    const ul = el("ul");
    fl.forEach((f) => { const li = el("li"); li.append(el("b", null, f.name_ar)); if (f.description_ar && !compact) li.append(el("span", null, " — " + f.description_ar)); ul.append(li); });
    b.append(ul);
    return b;
  }

  function section(title, node) { const s = el("section", "otc-sec"); s.append(el("h3", "otc-h", title), node); return s; }

  function resultView() {
    const r = S.res || {};
    const w = el("div", "otc-wrap");
    w.append(banner());

    if (r.status === "missing_input") { w.append(el("div", "otc-err", "في بيانات ناقصة. ارجع واكمّلها.")); w.append(btn("رجوع", "otc-btn", () => { S.step = "info"; render(); })); return w; }

    const oc = OUTCOME[r.outcome] || ["النتيجة غير مؤكدة", "warn"];
    const head = el("div", "otc-out " + oc[1]);
    head.append(el("b", null, oc[0]));
    if (r.outcome_reason_ar) head.append(el("p", null, r.outcome_reason_ar));
    w.append(head);

    const flags = flagsBlock(r.triggered_red_flags, false); if (flags) w.append(flags);
    (r.age_notices || []).forEach((n) => { if (n && n.message_ar) w.append(el("div", "otc-note", n.message_ar)); });

    const c = (r.conditions || [])[0];
    if (c && r.outcome === "self_care") {
      const ul = el("ul");
      ul.append(el("li", null, "الحالة: " + c.name_ar));
      if (c.max_self_treatment_days) ul.append(el("li", null, "العلاج الذاتي ما يزيدش عن " + Number(c.max_self_treatment_days).toLocaleString("ar-EG") + " أيام."));
      if (c.refer_if_no_improvement_days) ul.append(el("li", null, "لو مفيش تحسن بعد " + Number(c.refer_if_no_improvement_days).toLocaleString("ar-EG") + " أيام، راجع الدكتور."));
      w.append(section("عن الحالة", ul));
    }

    // الأدوية: بس لو النتيجة علاج ذاتي. المستبعد بيتعرض بسببه، مش كاقتراح.
    if (r.outcome === "self_care") {
      const recs = r.recommendations || [];
      const okRecs = recs.filter((x) => x.status === "ok" || x.status === "caution");
      const out = recs.filter((x) => x.status === "excluded");
      if (okRecs.length) {
        const box = el("div");
        okRecs.forEach((x) => {
          const k = el("div", "otc-rec");
          const h = el("div", "otc-rh"); h.append(el("b", null, x.ingredient)); h.dir = "auto";
          if (ROLE[x.line_of_therapy] || ROLE[x.role]) h.append(el("span", "otc-tag", ROLE[x.line_of_therapy] || ROLE[x.role]));
          if (x.status === "caution") h.append(el("span", "otc-tag warn", "بحذر"));
          k.append(h);
          if (x.dose_note_ar) k.append(el("p", null, "الجرعة: " + x.dose_note_ar));
          if (x.duration_note_ar) k.append(el("p", null, "المدة: " + x.duration_note_ar));
          if (x.notes_ar) k.append(el("p", "otc-hint", x.notes_ar));
          (x.reasons || []).forEach((rs) => { if (rs && rs.note_ar) k.append(el("p", "otc-warnline", "• " + rs.note_ar)); });
          box.append(k);
        });
        w.append(section("مواد فعّالة ممكن تسأل عنها الصيدلي", box));
      }
      if (out.length) {
        const ul = el("ul");
        out.forEach((x) => { const why = (x.reasons || []).map((rs) => rs && rs.note_ar).filter(Boolean).join("، "); const li = el("li", null, x.ingredient + (why ? ": " + why : "")); li.dir = "auto"; ul.append(li); });
        w.append(section("مش مناسبة ليك", ul));
      }
      if (!okRecs.length && !out.length && !(r.flow && r.flow.outcome && r.flow.outcome.text_ar)) w.append(el("div", "otc-note", "مفيش مادة فعّالة معتمدة للحالة دي لسه. اسأل الصيدلي."));
      const adv = (r.non_drug_advice || []).filter((a) => a && a.advice_ar);
      if (adv.length) { const ul = el("ul"); adv.forEach((a) => ul.append(el("li", null, a.advice_ar))); w.append(section("نصايح من غير دوا", ul)); }
    }

    const un = (r.unassessed_symptoms || []).concat(r.symptoms_to_clarify || []);
    if (un.length) w.append(el("div", "otc-note", "أعراض لسه ملهاش أسئلة تفصيلية: " + [...new Set(un)].join("، ") + ". اسأل الصيدلي عنها."));

    if (r.disclaimer_ar) w.append(el("p", "otc-disc", r.disclaimer_ar));

    const nav = el("div", "otc-nav");
    if (S.stack.length) nav.append(btn("← السؤال اللي فات", "otc-link", undo));
    nav.append(btn("حالة تانية", "otc-btn", () => { S.step = "home"; S.card = null; S.answers = {}; S.stack = []; S.res = null; S.sel = new Set(); render(); }));
    w.append(nav);
    return w;
  }

  function render() {
    const pg = root(); if (!pg) return;
    let v;
    if (S.step === "ask" && S.res && nextQuestion(S.res)) v = askView();
    else if (S.step === "result" && S.res) v = resultView();
    else if (S.step === "info" && S.card) v = infoView();
    else v = homeView();
    pg.replaceChildren(v);
    window.scrollTo(0, 0);
  }

  async function loadConds() {
    if (S.conds) return;
    try { const d = await api({ action: "conditions" }); S.conds = d.conditions || []; S.err = ""; }
    catch (e) { S.conds = null; fail(e); return; }
    render();
  }

  // بيتنادى من pages.js أول ما #/t تفتح
  window.otcPage = function () {
    if (!S.built) { S.built = true; render(); }
    if (!S.conds) loadConds();
  };
})();
