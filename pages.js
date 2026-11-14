/* pages.js — صفحات الموقع: الرئيسية (#/) ← نتايج البحث (#/r) ← تفاصيل المنتج (#/p/رقم).
   بيعتمد على: core.js, render.js. مش بيغيّر أي ملف تاني: بيلفّ دالتي card و pendingCard بس
   عشان كل كارت في النتايج يبقى ينفع تدوس عليه وتفتح صفحته. */
(function () {
  const ITEMS = [];
  const orig = { card: window.card, pendingCard: window.pendingCard };
  const HOME_SUB = $("ab-s").textContent;
  let searched = false, navd = false, listY = 0, lastQ = "";

  // كل كارت بيترسم بيتسجّل هنا، وبيتفتح في صفحته من نفس البيانات
  ["card", "pendingCard"].forEach((kind) => {
    window[kind] = function (p, t) {
      const c = orig[kind](p, t);
      if (kind === "pendingCard") c.prepend(picBlock(p));
      c.dataset.i = ITEMS.push({ kind, p, t }) - 1;
      c.tabIndex = 0;
      c.setAttribute("role", "link");
      return c;
    };
  });

  const fmt = (v) => Number(v).toLocaleString("ar-EG") + " ج.م";

  function goBack() {
    if (navd) history.back();
    else location.hash = document.body.dataset.view === "product" ? "#/r" : "#/";
  }

  // صفحة المنتج: صورة كبيرة على خلفية سماوي، بعدها الاسم والسعر، وتحتهم بيانات المنتج كاملة
  function detail(i) {
    const it = ITEMS[i], p = it.p, root = $("pd");
    root.replaceChildren();
    const hero = el("div", "hero");
    const bk = el("button", "back hero-back", "→");
    bk.type = "button"; bk.setAttribute("aria-label", "رجوع");
    bk.addEventListener("click", goBack);
    const pic = picBlock(p); pic.classList.add("big");
    hero.append(bk, pic);

    const sheet = el("div", "sheet");
    const h = el("h2", "pd-name", p.product_name || p.arabic_name || "منتج بدون اسم");
    h.dir = "auto";
    sheet.append(h);
    if (p.product_name && p.arabic_name) sheet.append(el("div", "pd-ar", p.arabic_name));
    const cur = p.current_price != null ? p.current_price : p.price;
    if (cur != null) {
      const row = el("div", "pd-price");
      row.append(el("b", null, fmt(cur)));
      const d = p.price_updated_on || p.price_date || p.price_updated_at;
      row.append(el("span", null, d ? "آخر تحديث للسعر: " + new Date(d).toLocaleDateString("ar-EG") : "تاريخ تحديث السعر غير معروف"));
      sheet.append(row);
    }
    sheet.append(el("h3", "pd-h", "عن المنتج"));
    sheet.append(orig[it.kind](p, it.t));
    root.append(hero, sheet);
  }

  function route() {
    const h = location.hash, m = h.match(/^#\/p\/(\d+)$/);
    let v = m ? "product" : h === "#/r" ? "results" : "home";
    const implied = v;
    if (v === "product" && !ITEMS[+m[1]]) v = searched ? "results" : "home";
    if (v === "results" && !searched) v = "home";
    if (v !== implied) history.replaceState(null, "", v === "results" ? "#/r" : "#/");
    const prev = document.body.dataset.view;
    document.body.dataset.view = v;
    $("ab-t").textContent = v === "results" ? "نتائج البحث" : "دليل الدواء";
    $("ab-s").textContent = v === "results" ? "«" + lastQ + "»" : HOME_SUB;
    if (v === "product") detail(+m[1]);
    window.scrollTo(0, v === "results" && prev === "product" ? listY : 0);
  }

  // دوس على كارت في النتايج = افتح صفحته
  const open = (c) => { listY = window.scrollY; navd = true; location.hash = "#/p/" + c.dataset.i; };
  $("out").addEventListener("click", (e) => {
    if (e.target.closest("a, button")) return;
    const c = e.target.closest(".card[data-i]");
    if (c) open(c);
  });
  $("out").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".card[data-i]")) { e.preventDefault(); open(e.target); }
  });

  // أي بحث (من الفورم أو الباركود أو الصورة) بيودّي لصفحة النتايج
  $("f").addEventListener("submit", () => {
    searched = true;
    lastQ = $("q").value.trim();
    if (document.body.dataset.view !== "results") {
      $("out").replaceChildren();
      navd = true;
      location.hash = "#/r";
    } else $("ab-s").textContent = "«" + lastQ + "»";
  });

  $("back").addEventListener("click", goBack);
  window.addEventListener("hashchange", route);
  route();
})();
