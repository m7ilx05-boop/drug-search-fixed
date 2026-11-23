/* suggest.js — اقتراحات البحث وإنت بتكتب (من جدول الأدوية المصرية ~25 ألف دواء عن طريق drug-autocomplete).
   بيعتمد على: core.js ($, el, call, normKey) وsearch.js (recShow). لازم يتحمّل بعد search.js.
   الاقتراحات: عائلات تجارية (إنجليزي أو عربي) + مواد فعّالة. لما الخانة تكون أقل من حرفين بيظهر سجل البحث زي الأول. */
(() => {
  const q = $("q"), form = $("f"), row = q && q.closest(".row");
  if (!q || !form || !row) return;

  const box = el("div", "sugg");
  box.id = "sugg";
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "اقتراحات الأدوية");
  row.append(box);
  q.setAttribute("aria-controls", "sugg");
  q.setAttribute("aria-autocomplete", "list");

  const cache = new Map();   // مفتاح الكتابة -> قايمة الاقتراحات (بتقلّل الطلبات)
  let timer = 0, seq = 0, items = [], active = -1;
  const isOpen = () => box.classList.contains("open");

  // السجل (#recent) مايظهرش وإحنا بنعرض اقتراحات
  const _recShow = window.recShow;
  if (typeof _recShow === "function") window.recShow = (on) => _recShow(on && !isOpen());

  function close() {
    seq++; clearTimeout(timer);
    box.classList.remove("open"); box.replaceChildren(); items = []; active = -1;
    q.setAttribute("aria-expanded", "false"); q.removeAttribute("aria-activedescendant");
  }

  function setActive(i) {
    items.forEach((b, k) => { b.classList.toggle("on", k === i); b.setAttribute("aria-selected", k === i ? "true" : "false"); });
    active = i;
    if (i >= 0) { items[i].scrollIntoView({ block: "nearest" }); q.setAttribute("aria-activedescendant", items[i].id); }
    else q.removeAttribute("aria-activedescendant");
  }

  function pick(s) {
    q.value = s.label;
    const radio = (v) => { const r = document.querySelector('input[name=t][value="' + v + '"]'); if (r) r.checked = true; };
    radio(s.kind === "ingredient" ? "ingredient" : "auto");
    close();
    if (typeof window.recShow === "function") window.recShow(false);
    form.requestSubmit();
  }

  function render(list) {
    box.replaceChildren(); items = []; active = -1;
    if (!list.length) { close(); return; }
    list.forEach((s, i) => {
      const b = el("button", "sg " + (s.kind === "ingredient" ? "sg-ing" : "sg-brand"));
      b.type = "button"; b.id = "sg" + i; b.setAttribute("role", "option"); b.setAttribute("aria-selected", "false");
      const name = el("span", "sg-name", s.label); name.dir = "auto";
      const bits = [];
      if (s.kind === "ingredient") bits.push("مادة فعّالة");
      else if (s.sub) bits.push(s.sub);
      if (s.n > 1) bits.push(s.n + " منتج");
      const meta = el("span", "sg-meta", bits.join(" · ")); meta.dir = "auto";
      b.append(name, meta);
      // pointerdown بدل click عشان الخانة ماتفقدش الـ focus قبل الاختيار
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(s); });
      box.append(b); items.push(b);
    });
    const r = document.getElementById("recent"); if (r) r.classList.remove("open");
    box.classList.add("open"); q.setAttribute("aria-expanded", "true");
  }

  async function fetchSug(raw) {
    const key = raw.replace(/\s+/g, " ");
    const mine = ++seq;
    let list = cache.get(key);
    if (!list) {
      try { list = (await call("drug-autocomplete", { q: raw, limit: 8 })).suggestions || []; }
      catch { list = null; }
      if (list) { if (cache.size > 200) cache.clear(); cache.set(key, list); }
    }
    if (mine !== seq) return;           // وصل رد قديم: اتجاهله
    if (!list) { close(); return; }
    // لو المكتوب بالظبط هو الاقتراح الوحيد مفيش داعي نعرضه
    if (list.length === 1 && normKey(list[0].label) === normKey(raw)) { close(); return; }
    render(list);
  }

  function onInput() {
    clearTimeout(timer);
    const raw = q.value;
    if (raw.trim().length < 2) { close(); return; }
    timer = setTimeout(() => fetchSug(raw), 180);
  }

  q.addEventListener("input", onInput);
  q.addEventListener("focus", () => { if (q.value.trim().length >= 2 && !isOpen()) onInput(); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); return; }
    if (!isOpen() || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((active - 1 + items.length) % items.length); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); items[active].dispatchEvent(new Event("pointerdown", { cancelable: true })); }
  });
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".row")) close(); });
  form.addEventListener("submit", close);
})();
