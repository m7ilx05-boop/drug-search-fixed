/* pages.js — صفحات الموقع: الرئيسية (#/) ← نتايج البحث (#/r) ← تفاصيل المنتج (#/p/رقم).
   بيعتمد على: core.js, render.js. مش بيغيّر أي ملف تاني: بيلفّ دالتي card و pendingCard بس
   عشان كل كارت في النتايج يبقى ينفع تدوس عليه وتفتح صفحته. */
(function () {
  const ITEMS = [];
  const orig = { card: window.card, pendingCard: window.pendingCard, altBlock: window.altBlock, altItem: window.altItem };
  const HOME_SUB = $("ab-s").textContent;
  let searched = false, navd = false, listY = 0, lastQ = "", curIdx = -1;

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

  // البدائل: كل بديل بيحمل بياناته، وبيعرف المنتج الأصلي اللي طلع منه
  window.altBlock = function (p) {
    const w = orig.altBlock(p);
    if (w) { w.classList.add("alt-wrap"); w._parent = p; }
    return w;
  };
  window.altItem = function (a) {
    const row = orig.altItem(a);
    row._alt = a;
    row.tabIndex = 0;
    row.setAttribute("role", "link");
    return row;
  };

  const fmt = (v) => Number(v).toLocaleString("ar-EG") + " ج.م";

  function goBack() {
    if (navd) history.back();
    else location.hash = document.body.dataset.view === "product" ? "#/r" : "#/";
  }

  function heroOf(pic) {
    const hero = el("div", "hero");
    const bk = el("button", "back hero-back", "→");
    bk.type = "button"; bk.setAttribute("aria-label", "رجوع");
    bk.addEventListener("click", goBack);
    pic.classList.add("big");
    hero.append(bk, pic);
    return hero;
  }

  // صفحة المنتج: صورة كبيرة على خلفية سماوي، بعدها الاسم والسعر، وتحتهم بيانات المنتج كاملة
  function productPage(it) {
    const p = it.p;
    const hero = heroOf(picBlock(p));
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
    return [hero, sheet];
  }

  // صفحة البديل: من بيانات البديل نفسها (اسم، سعر، شركة، تركيز، شكل)، وزر يجيب بياناته الكاملة بالبحث
  function altPage(it) {
    const a = it.p, par = it.parent;
    const hero = heroOf(picBlock({ product_name: a.trade_name, image: { has_image: !!a.image_url, url: a.image_url } }));
    const sheet = el("div", "sheet");
    const h = el("h2", "pd-name", a.trade_name || "منتج بدون اسم");
    h.dir = "auto";
    sheet.append(h);
    if (par && (par.product_name || par.arabic_name)) sheet.append(el("div", "pd-ar", "بديل لـ " + (par.product_name || par.arabic_name)));
    if (a.current_price != null) {
      const row = el("div", "pd-price");
      row.append(el("b", null, fmt(a.current_price)));
      const diff = Number(a.price_diff);
      if (a.price_diff != null && Number.isFinite(diff)) {
        row.append(el("span", "alt-diff " + (diff < 0 ? "cheap" : diff > 0 ? "dear" : ""),
          diff === 0 ? "نفس سعر المنتج الأصلي" : (diff < 0 ? "أرخص بـ " : "أغلى بـ ") + fmt(Math.abs(diff)) + " من المنتج الأصلي"));
      }
      if (a.price_updated_on) row.append(el("span", null, "آخر تحديث للسعر: " + new Date(a.price_updated_on).toLocaleDateString("ar-EG")));
      sheet.append(row);
    }
    sheet.append(el("h3", "pd-h", "عن المنتج"));
    const ul = el("ul", "ing");
    [["الشركة", a.manufacturer], ["التركيز", a.strength], ["الشكل الدوائي", a.dosage_form], ["سعر الوحدة", a.price_per_unit != null ? fmt(a.price_per_unit) : null]]
      .filter((r) => r[1]).forEach((r) => { const li = el("li"); li.append(el("span", null, r[0]), el("span", null, r[1])); ul.append(li); });
    if (ul.childElementCount) sheet.append(ul);
    const chips = el("div", "chips");
    chips.append(el("span", "chip " + (a.pack_matched ? "ok" : "warn"), a.pack_matched ? "نفس حجم العبوة" : "حجم العبوة مختلف"));
    if (a.match_level && a.match_level !== "strict") chips.append(el("span", "chip warn", "نفس المادة بس"));
    sheet.append(chips);
    const full = el("button", "alt-btn", "ابحث عن بياناته الكاملة");
    full.type = "button";
    full.addEventListener("click", () => {
      $("q").value = a.trade_name;
      const r = document.querySelector('input[name=t][value="auto"]');
      if (r) r.checked = true;
      $("f").requestSubmit();
    });
    sheet.append(full, el("div", "meta", "اسأل الصيدلي أو الدكتور قبل ما تستبدل الدواء."));
    return [hero, sheet];
  }

  // الصفحة بتتبني مرة واحدة وتتحفظ، فلما ترجع من بديل لمنتجه الأصلي تلاقي كل حاجة زي ما سبتها
  function detail(i) {
    const it = ITEMS[i], root = $("pd");
    if (!it.dom) it.dom = it.kind === "alt" ? altPage(it) : productPage(it);
    root.replaceChildren(...it.dom);
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
    $("ab-t").textContent = v === "results" ? "نتائج البحث" : "The Pharmacist";
    $("ab-s").textContent = v === "results" ? "«" + lastQ + "»" : HOME_SUB;
    let y = 0;
    if (v === "product") {
      curIdx = +m[1];
      detail(curIdx);
      y = ITEMS[curIdx].y || 0; ITEMS[curIdx].y = 0;
    } else {
      curIdx = -1;
      if (v === "results" && prev === "product") y = listY;
    }
    window.scrollTo(0, y);
  }

  // دوس على صورة الكارت أو اسمه = يتفتح في مكانه (الاسم بيطلع فوق وتحت التفاصيل). زرار «صفحة المنتج» بيفتح صفحته.
  const open = (c) => { listY = window.scrollY; navd = true; location.hash = "#/p/" + c.dataset.i; };
  const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)");
  function setOpen(c, on, animate) {
    const OPT = { duration: 1250, easing: "cubic-bezier(.4,0,.2,1)" };
    const h = c.querySelector("h2"), pic = c.querySelector(".pic");
    const kids = () => Array.from(c.children).filter((n) => !n.matches(".pic,h2,.goto"));
    const can = animate && !REDUCE.matches && !!c.animate;
    const firstH = can && h ? h.getBoundingClientRect() : null;
    const firstP = can && pic ? pic.getBoundingClientRect() : null;
    const firstK = can ? kids().map((n) => n.getBoundingClientRect().top) : [];
    const hFrom = c.offsetHeight;
    c.classList.toggle("open", on);
    c.setAttribute("aria-expanded", on ? "true" : "false");
    if (!can) return Promise.resolve();
    const hTo = c.offsetHeight;
    if (hFrom === hTo) return Promise.resolve();
    // وقت القفل: التفاصيل بتفضل ظاهرة لحد ما الحركة تخلص عشان تطلع مع الخلفية الرمادي وهي بتصغر
    if (!on) c.classList.add("closing");
    c.classList.add("anim", "swap");
    const lastH = h ? h.getBoundingClientRect() : null, lastP = pic ? pic.getBoundingClientRect() : null;
    // 1) الاسم (ومعاه لوحة بلون الكارت) والصورة بيتبادلوا أماكنهم
    if (firstH && lastH) {
      const dx = firstH.left - lastH.left, dy = firstH.top - lastH.top;
      if (dx || dy) h.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], OPT);
    }
    if (firstP && lastP) {
      const pdy = firstP.top - lastP.top;
      if (pdy) pic.animate([{ transform: "translateY(" + pdy + "px)" }, { transform: "none" }], OPT);
    }
    // عرض الصورة وحوافها بيتغيّروا بالتدريج (مش بيتبدّلوا فجأة): مفتوح = هامش 20px من الجنبين
    if (pic) {
      const A = { marginInlineStart: "0px", marginInlineEnd: "0px", width: "100%", borderRadius: "50px" };
      const Z = { marginInlineStart: "20px", marginInlineEnd: "20px", width: "calc(100% - 40px)", borderRadius: "30px" };
      pic.animate(on ? [A, Z] : [Z, A], OPT);
    }
    // 2) الكلام اللي تحت بيتحرك مع حافة الخلفية الرمادي وهي بتنزل (فتح) أو بتطلع (قفل)
    const dH = hTo - hFrom;
    kids().forEach((n, i) => {
      if (on) n.animate([{ transform: "translateY(" + (-dH) + "px)" }, { transform: "none" }], OPT);
      else if (firstK[i] != null) {
        const o = firstK[i] - n.getBoundingClientRect().top;
        n.animate([
          { transform: "translateY(" + o + "px)", opacity: 1 },
          { transform: "translateY(" + (o + dH) + "px)", opacity: 1, offset: 0.8 },
          { transform: "translateY(" + (o + dH) + "px)", opacity: 0 }
        ], OPT);
      }
    });
    // 3) ارتفاع الكارت (الخلفية الرمادي) بيتغيّر تدريجي
    const a = c.animate([{ height: hFrom + "px" }, { height: hTo + "px" }], { duration: OPT.duration, easing: OPT.easing, fill: "forwards" });
    const done = () => c.classList.remove("anim", "swap", "closing");
    a.addEventListener("finish", () => { done(); a.cancel(); });
    a.addEventListener("cancel", done);
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

  // دوس على بديل = افتح صفحة البديل
  const openAlt = (row) => {
    if (row._i == null) {
      const w = row.closest(".alt-wrap");
      row._i = ITEMS.push({ kind: "alt", p: row._alt, parent: w && w._parent }) - 1;
    }
    if (curIdx >= 0) ITEMS[curIdx].y = window.scrollY;
    else listY = window.scrollY;
    navd = true;
    location.hash = "#/p/" + row._i;
  };
  document.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) return;
    const row = e.target.closest(".alt-item");
    if (row && row._alt) openAlt(row);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.matches && e.target.matches(".alt-item") && e.target._alt) { e.preventDefault(); openAlt(e.target); }
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
