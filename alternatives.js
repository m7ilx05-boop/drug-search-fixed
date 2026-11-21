/* alternatives.js — بدائل الدواء (نفس المادة الفعّالة).
   بيعرّف: fmtEGP, altItem, ALT_PAGE, sleep, altBlock (بتتنادي من card في render.js)
   بيعتمد على: core.js (el, call, ERR) */

ERR.invalid_id = "رقم المنتج مش صالح.";
const fmtEGP = (v) => Number(v).toLocaleString("ar-EG") + " ج.م";

function altItem(a) {
  const row = el("div", "alt-item");
  const u = (() => { try { const x = new URL(a.image_url); return x.protocol === "https:" ? x.href : null; } catch { return null; } })();
  let pic;
  if (u) {
    pic = el("img"); pic.src = u; pic.alt = ""; pic.loading = "lazy"; pic.referrerPolicy = "no-referrer";
    pic.onerror = () => pic.replaceWith(el("div", "alt-ph", "💊"));
  } else pic = el("div", "alt-ph", "💊");

  const info = el("div", "alt-info");
  info.append(el("b", null, a.trade_name));
  const meta = [a.manufacturer, a.strength, a.dosage_form].filter(Boolean).join(" — ");
  if (meta) info.append(el("div", "meta", meta));
  const chips = el("div", "chips");
  chips.append(el("span", "chip " + (a.pack_matched ? "ok" : "warn"), a.pack_matched ? "نفس حجم العبوة" : "حجم العبوة مختلف"));
  if (a.match_level && a.match_level !== "strict") chips.append(el("span", "chip warn", "نفس المادة بس"));
  if (a.price_per_unit != null) chips.append(el("span", "chip", "سعر الوحدة: " + fmtEGP(a.price_per_unit)));
  info.append(chips);

  const price = el("div", "alt-price");
  if (a.current_price != null) price.append(el("b", null, fmtEGP(a.current_price)));
  const diff = Number(a.price_diff);
  if (a.price_diff != null && Number.isFinite(diff)) {
    price.append(el("div", "alt-diff " + (diff < 0 ? "cheap" : diff > 0 ? "dear" : ""),
      diff === 0 ? "نفس السعر" : (diff < 0 ? "أرخص بـ " : "أغلى بـ ") + fmtEGP(Math.abs(diff))));
  }
  if (a.price_updated_on) price.append(el("div", "meta", new Date(a.price_updated_on).toLocaleDateString("ar-EG")));

  row.append(pic, info, price);
  return row;
}

const ALT_PAGE = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// زر البدائل: الصفحة الأولى، "عرض المزيد" (offset)، و"البحث عن البدائل" لما مفيش بدائل مسجّلة.
// عقد الباك اند المتوقع (لسه هيتعمل):
//  - drug-alternatives { dwaprices_id, limit, offset } -> { alternatives: [...], has_more?: boolean, total?: number }
//  - drug-alternatives-search { dwaprices_id } -> { status?, job_id? } وبعدها الواجهة بتعيد قراءة drug-alternatives
function altBlock(p) {
  if (!p.dwaprices_id) return null;
  const id = p.dwaprices_id;
  const wrap = el("div");
  const toggle = el("button", "alt-btn", "عرض البدائل");
  toggle.type = "button";
  const box = el("div", "alt-box");
  box.hidden = true;
  const note = el("div"), list = el("div"), msg = el("div", "meta");
  const moreBtn = el("button", "alt-btn", "عرض المزيد من البدائل");
  const searchBtn = el("button", "alt-btn", "البحث عن البدائل");
  moreBtn.type = searchBtn.type = "button";
  const foot = el("div", "scan-msg warn", "راجع الجرعة والشكل الدوائي قبل البديل.");
  moreBtn.hidden = searchBtn.hidden = foot.hidden = true;
  box.append(note, list, msg, moreBtn, searchBtn, foot);
  let loaded = false, offset = 0, busy = false;
  const fail = (err) => (err && err.ar) || ERR[err && err.code] || "حصلت مشكلة في الاتصال. جرّب تاني.";

  const reset = () => { note.replaceChildren(); list.replaceChildren(); msg.textContent = ""; moreBtn.hidden = searchBtn.hidden = foot.hidden = true; offset = 0; };

  async function loadPage(first) {
    const r = await call("drug-alternatives", { dwaprices_id: id, limit: ALT_PAGE, offset });
    const items = Array.isArray(r.alternatives) ? r.alternatives : [];
    if (first && !items.length) {
      msg.textContent = "مفيش بدائل مسجّلة لهذا المنتج في النظام. ممكن تدوّر عليها.";
      searchBtn.hidden = false;
      return;
    }
    if (first) {
      if (items[0].match_level === "strict") note.append(el("p", "sec-note", "بدائل بنفس المادة الفعّالة والتركيز والشكل الدوائي."));
      else note.append(el("div", "dose-note", "نفس المادة الفعّالة بس. التركيز والشكل الدوائي ممكن يختلفوا، راجع كل منتج."));
    }
    items.forEach((a) => list.append(altItem(a)));
    offset += items.length;
    const more = typeof r.has_more === "boolean" ? r.has_more : typeof r.total === "number" ? offset < r.total : items.length >= ALT_PAGE;
    moreBtn.hidden = !more || !items.length;
    foot.hidden = false;
  }

  toggle.addEventListener("click", async () => {
    if (loaded) { box.hidden = !box.hidden; toggle.textContent = box.hidden ? "عرض البدائل" : "إخفاء البدائل"; return; }
    if (busy) return;
    busy = true; toggle.disabled = true; toggle.textContent = "جاري تحميل البدائل…";
    try {
      reset();
      await loadPage(true);
      loaded = true; box.hidden = false; toggle.textContent = "إخفاء البدائل";
    } catch (err) {
      box.hidden = false; msg.textContent = fail(err); toggle.textContent = "عرض البدائل";
    } finally { toggle.disabled = false; busy = false; }
  });

  moreBtn.addEventListener("click", async () => {
    if (busy) return;
    busy = true; moreBtn.disabled = true; moreBtn.textContent = "جاري التحميل…"; msg.textContent = "";
    try { await loadPage(false); }
    catch (err) { msg.textContent = fail(err); }
    finally { moreBtn.disabled = false; moreBtn.textContent = "عرض المزيد من البدائل"; busy = false; }
  });

  searchBtn.addEventListener("click", async () => {
    if (busy) return;
    busy = true; searchBtn.disabled = true; searchBtn.textContent = "جاري البحث عن البدائل…"; msg.textContent = "";
    try {
      const r = await call("drug-alternatives-search", { dwaprices_id: id });
      if (r.job_id && r.status !== "completed") {
        let done = false;
        for (let i = 0; i < 45 && !done; i++) {
          await sleep(3000);
          let j;
          try { j = await call("drug-job-status", { job_id: r.job_id }); } catch { continue; }
          if (j.status === "completed") done = true;
          else if (j.status === "failed") throw { ar: j.message_ar, code: j.error_message };
          else msg.textContent = "جاري البحث عن البدائل…" + (j.progress ? " " + j.progress + "%" : "");
        }
        if (!done) throw { ar: "البحث بياخد وقت أطول من المعتاد. جرّب تاني بعد شوية." };
      }
      reset();
      await loadPage(true);
      if (!list.childElementCount) msg.textContent = "اكتمل البحث، لكن ما لقيناش بدائل لهذا المنتج.";
    } catch (err) { msg.textContent = fail(err); }
    finally { searchBtn.disabled = false; searchBtn.textContent = "البحث عن البدائل"; busy = false; }
  });

  wrap.append(toggle, box);
  return wrap;
}
