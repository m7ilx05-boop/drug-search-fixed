/* otc-triage.js — صفحة تقييم الأعراض (#/t). نسخة تجريبية.
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

  const S = { built: false, step: "form", symptoms: null, sel: new Set(), q: "", age: "", sex: "", preg: null, lact: null, answers: {}, stack: [], res: null, err: "", loading: false };

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

  // ===== الخطوة 1: البيانات والأعراض =====
  function formView() {
    const w = el("div", "otc-wrap");
    w.append(banner());
    const e = errBox(); if (e) w.append(e);

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

    const pg = el("div", "otc-preg"); pg.id = "otcPreg";
    w.append(pg);
    function syncPreg() {
      pg.replaceChildren();
      if (!needsPreg()) { S.preg = null; S.lact = null; return; }
      [["preg", "حامل؟"], ["lact", "بترضّعي؟"]].forEach(([k, t]) => {
        const f = el("div", "otc-f"); f.append(el("span", null, t));
        const g = el("div", "otc-seg");
        [[true, "أيوه"], [false, "لأ"]].forEach(([v, tt]) => {
          const b = btn(tt, "otc-opt" + (S[k] === v ? " on" : ""), () => { S[k] = v; syncPreg(); });
          b.setAttribute("aria-pressed", S[k] === v);
          g.append(b);
        });
        f.append(g); pg.append(f);
      });
    }
    syncPreg();

    w.append(el("h3", "otc-h", "إيه الأعراض اللي عندك؟"));
    const find = el("input", "otc-find"); find.type = "search"; find.placeholder = "دوّر على عرض"; find.value = S.q; find.setAttribute("aria-label", "بحث في الأعراض");
    w.append(find);
    const chips = el("div", "otc-chips"); chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "الأعراض");
    w.append(chips);
    const cnt = el("div", "otc-cnt"); w.append(cnt);
    function drawChips() {
      chips.replaceChildren();
      const q = find.value.trim();
      (S.symptoms || []).filter((s) => !q || s.name.includes(q)).forEach((s) => {
        const on = S.sel.has(s.id);
        const c = btn(s.name, "otc-chip" + (on ? " on" : "") + (s.has_flow ? "" : " nof"), () => {
          if (S.sel.has(s.id)) S.sel.delete(s.id); else if (S.sel.size < 20) S.sel.add(s.id);
          drawChips();
        });
        c.setAttribute("aria-pressed", on);
        chips.append(c);
      });
      cnt.textContent = S.sel.size ? "اخترت " + S.sel.size.toLocaleString("ar-EG") + " من الأعراض" : "اختار عرض واحد على الأقل";
      go.disabled = !S.sel.size || S.loading;
    }
    find.addEventListener("input", () => { S.q = find.value; drawChips(); });

    const go = btn(S.loading ? "ثانية..." : "ابدأ الأسئلة", "otc-btn otc-go", start);
    w.append(go);
    drawChips();
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
    if (!S.stack.length && !k) { S.step = "form"; render(); return; }
    assess();
  }
  function navRow(canUndo) {
    const r = el("div", "otc-nav");
    if (canUndo) r.append(btn(S.stack.length ? "← السؤال اللي فات" : "← رجوع للأعراض", "otc-link", () => { if (S.stack.length) undo(); else { S.step = "form"; render(); } }));
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

    if (r.status === "missing_input") { w.append(el("div", "otc-err", "في بيانات ناقصة. ارجع واكمّلها.")); w.append(btn("رجوع", "otc-btn", () => { S.step = "form"; render(); })); return w; }

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
    nav.append(btn("تقييم جديد", "otc-btn", () => { S.step = "form"; S.answers = {}; S.stack = []; S.res = null; S.sel = new Set(); render(); }));
    w.append(nav);
    return w;
  }

  function render() {
    const pg = root(); if (!pg) return;
    const y = window.scrollY;
    let v;
    if (S.step === "ask" && S.res && nextQuestion(S.res)) v = askView();
    else if (S.step === "result" && S.res) v = resultView();
    else v = formView();
    pg.replaceChildren(v);
    if (S.step !== "form" || !S.loading) window.scrollTo(0, S.step === "form" ? y : 0);
  }

  async function loadSymptoms() {
    if (S.symptoms) return;
    try { const d = await api({ action: "symptoms" }); S.symptoms = (d.symptoms || []).sort((a, b) => (b.has_flow - a.has_flow) || a.name.localeCompare(b.name, "ar")); S.err = ""; }
    catch (e) { S.symptoms = null; fail(e); return; }
    render();
  }

  // بيتنادى من pages.js أول ما #/t تفتح
  window.otcPage = function () {
    if (!S.built) { S.built = true; render(); }
    if (!S.symptoms) { S.symptoms = null; loadSymptoms(); }
  };
})();
