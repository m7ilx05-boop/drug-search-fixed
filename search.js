/* search.js — منطق البحث الرئيسي: الفورم، متابعة المهام (poll)، مرحلة الصيدليات، آخر عمليات البحث.
   بيعرّف: clearMore, showMore, recGet/recSet/recAdd/recRender, polling, poll + submit handler للفورم
   بيعتمد على: core.js, render.js. الملفات اللي بعده (scanner, image-search) بتستخدم polling و clearMore. */

// ===== المرحلة التانية: الصيدليات والمصادر الأخرى (زر تحت النتيجة) =====
// البحث الأول بيقرأ المصادر الأساسية بس. الزر ده بينادي drug-search بـ phase:"secondary"، وبعدين بيتابع المهمة
// وبيعيد تحميل الإجابة المحفوظة. الزر في #more (برّه #out) فمش بيتمسح لما النتايج تتعرض تاني.
let secToken = 0;
function clearMore() { secToken++; $("more").replaceChildren(); }
function showMore(query, search_type, sec) {
  const box = $("more");
  box.replaceChildren();
  if (!sec || !sec.available) return;
  const my = ++secToken;
  const wrap = el("div", "more-box");
  wrap.append(el("p", null, "دي نتايج المصادر الأساسية. تقدر تبحث كمان في الصيدليات والمصادر التانية، ونتايجها بتظهر معلّمة «من الصيدليات» أو «قيد المراجعة»."));
  const b = el("button", null, "ابحث في الصيدليات والمصادر الأخرى");
  b.type = "button";
  const msg = el("div", "meta");
  wrap.append(b, msg);
  box.append(wrap);

  const idle = (label, text) => { b.disabled = false; b.textContent = label; if (text != null) msg.textContent = text; };
  const finish = async () => {
    try {
      const d2 = await call("drug-search", { query, search_type, phase: "secondary" });
      if (my !== secToken) return;
      const n = renderAll(d2, "مفيش منتجات محفوظة لهذا البحث لسه.");
      idle("أعد البحث في الصيدليات", n ? "اكتمل البحث في الصيدليات. النتايج الجديدة معلّمة بمصدرها." : "اكتمل البحث في الصيدليات، لكن ما لقيناش نتايج جديدة.");
    } catch {
      if (my === secToken) idle("أعد البحث في الصيدليات", "اكتمل البحث، لكن تعذّر تحميل النتايج. جرّب تاني.");
    }
  };
  const wait = async (jobId) => {
    for (let i = 0; i < 45 && my === secToken; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (my !== secToken) return;
      let j;
      try { j = await call("drug-job-status", { job_id: jobId }); } catch { continue; }
      if (j.status === "completed") { await finish(); return; }
      if (j.status === "failed") { idle("أعد المحاولة", j.message_ar || ERR[j.error_message] || "فشل البحث في الصيدليات."); return; }
      msg.textContent = "جاري البحث في الصيدليات…" + (j.progress ? " " + j.progress + "%" : "");
    }
    if (my === secToken) idle("أعد المحاولة", "البحث بياخد وقت أطول من المعتاد. جرّب تاني بعد شوية.");
  };
  b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "جاري البحث…"; msg.textContent = "جاري البحث في الصيدليات…";
    try {
      const d = await call("drug-search", { query, search_type, phase: "secondary" });
      if (my !== secToken) return;
      const s = d.secondary || {};
      if (s.status === "completed") await finish();
      else if (s.job_id) await wait(s.job_id);
      else idle("ابحث في الصيدليات والمصادر الأخرى", "تعذّر بدء البحث. جرّب تاني.");
    } catch (err) {
      if (my === secToken) idle("ابحث في الصيدليات والمصادر الأخرى", ERR[err.code] || "حصلت مشكلة في الاتصال. جرّب تاني.");
    }
  });

  if (sec.status === "queued" || sec.status === "running") {
    b.disabled = true; b.textContent = "جاري البحث…"; msg.textContent = "جاري البحث في الصيدليات…";
    if (sec.job_id) wait(sec.job_id);
  } else if (sec.status === "completed") {
    idle("أعد البحث في الصيدليات", "اتبحث في الصيدليات قبل كده لهذا الاسم.");
  }
}

// ===== آخر عمليات البحث (بتتحفظ في المتصفح بس، آخر 5) =====
const REC_KEY = "drugsearch.recent.v1", REC_MAX = 5, REC_TYPES = ["auto", "brand_family", "brand", "ingredient"];
function recGet() {
  try {
    const a = JSON.parse(localStorage.getItem(REC_KEY) || "[]");
    return Array.isArray(a) ? a.filter((x) => x && typeof x.q === "string" && x.q.trim()).slice(0, REC_MAX) : [];
  } catch { return []; }
}
function recSet(a) { try { localStorage.setItem(REC_KEY, JSON.stringify(a)); } catch {} }
function recAdd(q, t) {
  const k = normKey(q);
  if (!k) return;
  const a = recGet().filter((x) => normKey(x.q) !== k);
  a.unshift({ q: String(q).trim().slice(0, 100), t: REC_TYPES.includes(t) ? t : "auto" });
  recSet(a.slice(0, REC_MAX));
  recRender();
}
function recRender() {
  const box = $("recent");
  box.replaceChildren();
  const a = recGet();
  if (!a.length) return;
  const head = el("div", "recent-h");
  head.append(el("span", null, "آخر عمليات البحث"));
  const clr = el("button", "rc-clear", "مسح"); clr.type = "button";
  clr.addEventListener("click", () => { recSet([]); recRender(); });
  head.append(clr);
  const row = el("div", "chips");
  a.forEach((x) => {
    const b = el("button", "rc", x.q); b.type = "button"; b.dir = "auto";
    b.addEventListener("click", () => {
      $("q").value = x.q;
      const radio = document.querySelector('input[name=t][value="' + (REC_TYPES.includes(x.t) ? x.t : "auto") + '"]');
      if (radio) radio.checked = true;
      $("f").requestSubmit();
    });
    row.append(b);
  });
  box.append(head, row);
}

// ===== متابعة مهمة البحث على الإنترنت =====
let polling = 0;
async function poll(jobId, token, query, search_type) {
  for (let i = 0; i < 30 && token === polling; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (token !== polling) return;
    let j;
    try { j = await call("drug-job-status", { job_id: jobId }); } catch { continue; }
    if (j.status === "completed") {
      const st = j.stats || {};
      const code = j.outcome_code || j.outcome || st.outcome_code;

      // The job finished: ALWAYS reload the stored answer (approved + under review) so the screen shows the real data.
      // (A job that only reports "pending_review" can still have added rows to the main source.)
      // drug-search reuses this finished job, so it does not start another one.
      let shown = 0;
      try {
        const d2 = await call("drug-search", { query, search_type });
        if (token !== polling) return;
        shown = renderAll(d2);
      } catch { /* fall back below */ }
      if (!shown && j.results?.length) { render(j.results); shown = j.results.length; }
      // other spellings / names to try: the server returns these at the top level of the response (not inside stats)
      const spelling = (Array.isArray(j.did_you_mean) ? j.did_you_mean : [])
        .filter((n) => typeof n === "string" && n.trim() && norm(n) !== norm(query))
        .map((n) => ({ text: n.trim(), type: "auto" }));
      const alts = (Array.isArray(j.suggestions) ? j.suggestions : [])
        .filter((s) => s && typeof s.text === "string" && norm(s.text) !== norm(query) && !spelling.some((x) => norm(x.text) === norm(s.text)))
        .map((s) => ({ text: s.text, type: s.search_type }));
      const items = [...spelling, ...alts];
      const auto = j.auto_search && typeof j.auto_search.text === "string" ? j.auto_search : null;
      if (auto && norm(auto.text) !== norm(query) && !items.some((x) => norm(x.text) === norm(auto.text))) items.unshift({ text: auto.text.trim(), type: auto.search_type || "auto" });

      // nothing to show: explain why, or offer other spellings
      const pending = (Array.isArray(j.pending_products) ? j.pending_products : []).filter((p) => p && typeof p.name === "string");
      // names the job found online become "search with this name" buttons (typo -> correct name)
      pending.forEach((p) => { const nm = p.name.trim(); if (nm && norm(nm) !== norm(query) && !items.some((x) => norm(x.text) === norm(nm))) items.push({ text: nm, type: "auto" }); });

      if (shown) {
        appendSuggestions(items);
        recAdd(query, search_type);
        setStatus("اكتمل البحث على الإنترنت.", { progress: 100 });
        toast("success", "اكتمل التحديث. " + foundMsg(shown));
        return;
      }

      if (pending.length) {
        toast("info", "لقينا المنتج وهو في انتظار المراجعة.");
        showPending(j.message_ar || "لقينا المنتج ده، وهو في انتظار المراجعة قبل ما يتضاف لقاعدة البيانات.", pending);
        appendSuggestions(items);
        setStatus("اكتمل البحث على الإنترنت.", { progress: 100 });
      }
      else if (items.length) { toast("warn", "مفيش نتايج بالاسم ده. جرّب الأسماء المقترحة."); showSuggestions(query, items); setStatus("اكتمل البحث على الإنترنت.", { progress: 100 }); }
      else if (j.message_ar) { toast("warn", "اكتمل البحث ومفيش نتايج مؤكدة."); render([], j.message_ar); setStatus("اكتمل البحث على الإنترنت.", { progress: 100 }); }
      else if (code === "pending_review") { toast("info", "لقينا منتجات جديدة في انتظار المراجعة."); render([], "لقينا منتجات جديدة، وهي في انتظار المراجعة قبل ما تتضاف لقاعدة البيانات."); setStatus("اكتمل البحث على الإنترنت.", { progress: 100 }); }
      else { toast("warn", "اكتمل البحث ومفيش نتايج لهذا الاسم."); render([], "اكتمل البحث على الإنترنت، لكن مفيش نتايج محفوظة لهذا الاسم."); setStatus("اكتمل البحث على الإنترنت.", { progress: 100 }); }
      return;
    }
    if (j.status === "failed") { setStatus(j.message_ar || ERR[j.error_message] || "فشل تحديث البيانات من الإنترنت.", { error: true }); return; }
    setStatus("جاري البحث في المصادر…", { progress: j.progress || 5 });
  }
  if (token === polling) setStatus("التحديث بياخد وقت أطول من المعتاد. جرّب تاني بعد شوية.", { error: true });
}

// ===== إرسال الفورم =====
$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  // نتيجة قراءة الصورة بتفضل ظاهرة بس لما البحث ده جه منها؛ أي بحث تاني بيمسحها
  if (!window.__keepImg) $("imgbox").replaceChildren();
  window.__keepImg = false;
  const query = $("q").value.trim();
  const search_type = document.querySelector('input[name=t]:checked').value;
  const token = ++polling;
  clearMore();
  $("go").disabled = true;
  setStatus("جاري البحث…");
  showSkeleton();
  try {
    const d = await call("drug-search", { query, search_type });
    const shown = renderAll(d, "مفيش منتجات محفوظة لهذا البحث لسه.");
    if (shown) recAdd(query, search_type);
    let hadSug = false;
    if (!shown) {
      // typo of a name we already know (Cnor -> Concor): the server answers this before the web search finishes
      const sug = (Array.isArray(d.suggestions) ? d.suggestions : [])
        .filter((s) => s && typeof s.text === "string" && norm(s.text) !== norm(query))
        .map((s) => ({ text: s.text, type: s.search_type }));
      if (sug.length) { showSuggestions(query, sug); hadSug = true; }
    }
    showMore(query, search_type, d.secondary);
    if (window.famBox) window.famBox({ text: search_type === "ingredient" ? "" : query });
    const underReview = Array.isArray(d.pending_review) ? d.pending_review.length : 0;
    if (d.job_id && d.refresh_status !== "not_needed") {
      if (d.refresh_status === "completed" && shown) {
        // an earlier search for this name already finished: what is stored is the answer, nothing more to wait for
        setStatus(underReview ? "ده اللي لقيناه. المنتجات «قيد المراجعة» لسه مش مؤكدة." : "");
        toast("success", foundMsg(shown));
      } else {
        if (shown) toast("info", "ده اللي محفوظ عندنا، وجاري تحديثه من المصادر.");
        setStatus(shown ? "ده اللي محفوظ عندنا. جاري تحديثه من المصادر…" : "جاري البحث في المصادر…", { progress: 5 });
        if (!shown && !$("out").querySelector(".suggest")) showSkeleton();
        poll(d.job_id, token, query, search_type);
      }
    } else {
      setStatus(d.cache_status === "fresh" ? "بيانات محدّثة." : "");
      if (shown) toast("success", foundMsg(shown));
      else toast("warn", hadSug ? "مفيش نتايج بالاسم ده. جرّب الأسماء المقترحة." : "مفيش نتايج لهذا البحث.");
    }
  } catch (err) {
    setStatus(ERR[err.code] || "حصلت مشكلة في الاتصال. جرّب تاني.", { error: true });
  } finally { $("go").disabled = false; }
});
recRender();
