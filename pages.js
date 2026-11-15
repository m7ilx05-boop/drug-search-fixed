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
      c.setAttribute("role", "button");
      c.setAttribute("aria-expanded", "false");
      // زرار صفحة المنتج: بيظهر في الكارت المفتوح بس
      const g = el("button", "goto", "صفحة المنتج ←"); g.type = "button";
      c.prepend(g);
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

  // دوس على صورة الكارت أو اسمه = يتفتح في مكانه (الاسم بيطلع فوق وتحت التفاصيل). زرار «صفحة المنتج» بيفتح صفحته.
  const open = (c) => { listY = window.scrollY; navd = true; location.hash = "#/p/" + c.dataset.i; };
  const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)");
  function setOpen(c, on, animate) {
    const h = c.querySelector("h2");
    const firstH = animate && h ? h.getBoundingClientRect() : null;
    const pic = c.querySelector(".pic");
    const firstP = animate && pic ? pic.getBoundingClientRect() : null;
    const hFrom = c.offsetHeight;
    c.classList.toggle("open", on);
    c.setAttribute("aria-expanded", on ? "true" : "false");
    if (!animate || REDUCE.matches || !c.animate) return Promise.resolve();
    const hTo = c.offsetHeight;
    // 1) الاسم بيتحرك من مكانه القديم للجديد
    if (firstH && h.animate) {
      const last = h.getBoundingClientRect(), dx = firstH.left - last.left, dy = firstH.top - last.top;
      if (dx || dy) {
        // الاسم بيتحرك ومعاه خلفية الكارت (لوحة) فوق الصورة، والصورة بتتحرك عكسه، بدل ما الاسم يعدّي على الصورة لوحده
        c.classList.add("swap");
        const ha = h.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.4,0,.2,1)" });
        const un = () => c.classList.remove("swap");
        ha.addEventListener("finish", un); ha.addEventListener("cancel", un);
      }
    }
    if (firstP && pic.animate) {
      const lp = pic.getBoundingClientRect(), pdy = firstP.top - lp.top;
      if (pdy) pic.animate([{ transform: "translateY(" + pdy + "px)" }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.4,0,.2,1)" });
    }
    // 2) ارتفاع الكارت بيتغيّر تدريجي بدل ما يقفز
    if (hFrom === hTo) return Promise.resolve();
    c.classList.add("anim");
    const a = c.animate([{ height: hFrom + "px" }, { height: hTo + "px" }], { duration: 300, easing: "cubic-bezier(.4,0,.2,1)" });
    const done = () => c.classList.remove("anim");
    a.addEventListener("finish", done); a.addEventListener("cancel", done);
    return a.finished.catch(() => {});
  }
  function toggle(c) {
    const on = !c.classList.contains("open");
    if (on) $("out").querySelectorAll(".card.open").forEach((o) => { if (o !== c) setOpen(o, false, true); }); // كارت واحد مفتوح
    const p = setOpen(c, on, true);
    // السكرول بيستنى الحركة تخلص عشان ما يتعارضش معاها
    if (on) p.then(() => {
      const r = c.getBoundingClientRect(), top = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
      if (r.top < top || r.bottom > window.innerHeight) c.scrollIntoView({ block: "start", behavior: REDUCE.matches ? "auto" : "smooth" });
    });
  }
  $("out").addEventListener("click", (e) => {
    const c = e.target.closest(".card[data-i]");
    if (!c) return;
    if (e.target.closest("button.goto")) { open(c); return; }
    if (e.target.closest("a, button")) return;
    if (e.target === c || e.target.closest(".pic, h2")) toggle(c);
  });
  $("out").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".card[data-i]")) { e.preventDefault(); toggle(e.target); }
  });

  // أي بحث (من الفورم أو الباركود أو الصورة) بيودّي لصفحة النتايج
  $("f").addEventListener("submit", () => {
    searched = true;
    lastQ = $("q").value.trim();
    if (document.body.dataset.view !== "results") {
      if (!document.getElementById("skel")) $("out").replaceChildren();
      navd = true;
      location.hash = "#/r";
    } else $("ab-s").textContent = "«" + lastQ + "»";
  });

  $("back").addEventListener("click", goBack);
  window.addEventListener("hashchange", route);
  route();
})();
