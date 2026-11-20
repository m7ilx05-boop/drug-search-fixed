/* home-cards.js — كروت أدوية (منتجات حقيقية بصورها) بتلف 3D في الرئيسية، بنفس شكل كارت المنتج.
   الدوس على كارت = يتفتح قدّام بحركة (واللف شغال)، وفيه زرار "افتح المنتج" بيعمل بحث باسمه.
   المنتجات جاية من drug-home-cards. لو فشل الطلب بنرجع لقايمة ثابتة عشان الشريط ميبوظش.
   بيعتمد على: core.js (call, el). */
(function () {
  var host = document.getElementById("d3inner");
  if (!host) return;

  var FALLBACK = ["Panadol", "Brufen", "Cataflam", "Voltaren", "Augmentin", "Zithromax", "Flagyl", "Antinal", "Zyrtec", "Claritine"];
  var CARD_W = 112;

  function brand(n) { return String(n || "").replace(/\s+\d.*$/, "").trim() || String(n || ""); }
  function safeUrl(u) { try { var x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch (e) { return null; } }
  function price(v) { return v == null || v === "" || isNaN(Number(v)) ? null : Number(v).toLocaleString("ar-EG") + " ج.م"; }

  function picBox(p, cls) {
    var box = el("div", cls), u = safeUrl(p.image && p.image.url);
    if (u) {
      var im = el("img"); im.src = u; im.alt = p.product_name || ""; im.loading = "lazy"; im.referrerPolicy = "no-referrer";
      im.onerror = function () { box.replaceChildren("💊"); };
      box.append(im);
    } else box.append("💊");
    return box;
  }

  function search(name) {
    var q = document.getElementById("q"), f = document.getElementById("f");
    var auto = document.querySelector('input[name="t"][value="auto"]');
    if (auto) auto.checked = true;
    q.value = name;
    if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  }

  /* ===== الكارت المفتوح ===== */
  var openOv = null;
  function closeOpen(fromRect) {
    var ov = openOv; if (!ov) return;
    openOv = null;
    var card = ov.querySelector(".hc-card");
    var done = function () { ov.remove(); };
    var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion:reduce)").matches;
    if (reduce || !card.animate || !fromRect) { done(); return; }
    ov.classList.add("out");
    var r = card.getBoundingClientRect();
    var a = card.animate([
      { transform: "none", opacity: 1 },
      { transform: "translate(" + (fromRect.left + fromRect.width / 2 - r.left - r.width / 2) + "px," + (fromRect.top + fromRect.height / 2 - r.top - r.height / 2) + "px) scale(" + Math.min(.4, fromRect.width / r.width) + ")", opacity: 0 }
    ], { duration: 260, easing: "cubic-bezier(.4,0,.6,1)" });
    a.onfinish = done; setTimeout(done, 400);
  }

  function openCard(p, btn) {
    if (openOv) closeOpen(null);
    var from = btn.getBoundingClientRect();
    var ov = el("div", "hc-ov"), card = el("article", "hc-card");
    ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-label", p.product_name || "منتج");
    var x = el("button", "hc-x", "✕"); x.type = "button"; x.setAttribute("aria-label", "إغلاق");
    card.append(x, picBox(p, "hc-pic"));
    var h = el("h2", null, p.product_name || ""); h.dir = "auto";
    if (p.arabic_name) { h.append(" "); h.append(el("span", "ar", p.arabic_name)); }
    card.append(h);
    if (p.scientific_name) { var s = el("div", "hc-meta", p.scientific_name); s.dir = "auto"; card.append(s); }
    if (p.manufacturer) card.append(el("div", "hc-meta", "الشركة: " + p.manufacturer));
    var chips = el("div", "hc-chips");
    if (p.dosage_form) chips.append(el("span", "hc-chip", p.dosage_form));
    if (p.strength) chips.append(el("span", "hc-chip", p.strength));
    var pr = price(p.current_price); if (pr) chips.append(el("span", "hc-chip", pr));
    if (chips.childNodes.length) card.append(chips);
    if (p.barcode) { var bc = el("div", "hc-bc"); bc.append(el("span", "hc-bc-l", "الباركود"), el("b", null, p.barcode)); card.append(bc); }
    var go = el("button", "hc-go", "افتح المنتج"); go.type = "button";
    card.append(go);
    ov.append(card); document.body.append(ov); openOv = ov;

    var close = function () { closeOpen(from); };
    x.addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    go.addEventListener("click", function () { var n = brand(p.product_name); closeOpen(null); search(n); });
    document.addEventListener("keydown", function esc(e) {
      if (!openOv) { document.removeEventListener("keydown", esc); return; }
      if (e.key === "Escape") { document.removeEventListener("keydown", esc); close(); }
    });

    var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion:reduce)").matches;
    if (!reduce && card.animate) {
      var r = card.getBoundingClientRect();
      var dx = from.left + from.width / 2 - r.left - r.width / 2, dy = from.top + from.height / 2 - r.top - r.height / 2;
      card.animate([
        { transform: "translate(" + dx + "px," + dy + "px) scale(" + Math.min(.4, from.width / r.width) + ")", opacity: .2 },
        { transform: "none", opacity: 1 }
      ], { duration: 380, easing: "cubic-bezier(.2,.9,.25,1.1)" });
      ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
    }
    go.focus({ preventScroll: true });
  }

  /* ===== الشريط اللي بيلف ===== */
  function build(items) {
    var n = items.length;
    host.replaceChildren();
    host.style.setProperty("--w", CARD_W + "px");
    host.style.setProperty("--z", Math.round(CARD_W / (2 * Math.tan(Math.PI / n))) + 14 + "px");
    items.forEach(function (p, i) {
      var b = el("button", "dcard");
      b.type = "button";
      b.style.setProperty("--i", i); b.style.setProperty("--q", n);
      b.setAttribute("aria-label", "افتح " + (p.product_name || ""));
      b.append(picBox(p, "dpic"));
      var nm = el("span", "dname", brand(p.product_name)); nm.dir = "auto";
      b.append(nm);
      b.addEventListener("click", function () { openCard(p, b); });
      host.append(b);
    });
  }

  function fallbackItems() {
    return FALLBACK.map(function (n) { return { product_name: n, image: null }; });
  }

  var done = false;
  var timer = setTimeout(function () { if (!done) { done = true; build(fallbackItems()); } }, 4500);
  call("drug-home-cards", { n: 10 }).then(function (d) {
    var items = (d && d.items || []).filter(function (p) { return p && p.product_name; });
    clearTimeout(timer);
    if (done) { if (items.length >= 6) build(items); return; }
    done = true;
    build(items.length >= 6 ? items : fallbackItems());
  }).catch(function (e) {
    clearTimeout(timer);
    console.warn("home_cards_failed", e && e.code);
    if (!done) { done = true; build(fallbackItems()); }
  });
})();
