// زر الحساب: بيقرا بيانات الجلسة اللي صفحة الدخول حفظتها (اسم جوجل والإيميل) ويقول مرحبا.
// لو مفيش جلسة (زي المواقع التانية اللي مفيهاش دخول) الزر مبيظهرش.
(function () {
  function readUser() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/^sb-.+-auth-token$/.test(k)) continue;
        var o = JSON.parse(localStorage.getItem(k) || "null");
        var u = o && (o.user || (o.currentSession && o.currentSession.user));
        if (u) return u;
      }
    } catch (e) {}
    return null;
  }
  var u = readUser();
  var bar = document.querySelector(".appbar");
  if (!u || !bar) return;
  var m = u.user_metadata || {};
  var email = u.email || m.email || "";
  var name = String(m.full_name || m.name || (email ? email.split("@")[0] : "") || "").trim();
  if (!name) return;
  var photo = String(m.avatar_url || m.picture || "");
  if (photo.indexOf("https://") !== 0) photo = "";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function avatar(cls) {
    var a = el("span", cls);
    var ini = el("span", "acct-ini", Array.from(name)[0].toUpperCase());
    a.appendChild(ini);
    if (photo) {
      var img = new Image();
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.onload = function () { a.textContent = ""; a.appendChild(img); };
      img.src = photo;
    }
    return a;
  }

  var btn = el("button", "acct-btn");
  btn.type = "button";
  btn.setAttribute("aria-label", "الحساب: " + name);
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  btn.appendChild(avatar("acct-av"));
  bar.appendChild(btn);
  document.body.classList.add("acct-on");

  var pop = el("div", "acct-pop");
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.appendChild(avatar("acct-av acct-av-lg"));
  var tx = el("div", "acct-tx");
  tx.appendChild(el("div", "acct-hi", "مرحبا"));
  tx.appendChild(el("div", "acct-nm", name));
  if (email) { var em = el("div", "acct-em", email); em.dir = "ltr"; tx.appendChild(em); }
  pop.appendChild(tx);
  var out = el("a", "acct-out", "تسجيل الخروج");
  out.href = "/login?logout=1";
  pop.appendChild(out);
  document.body.appendChild(pop);

  function close() { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); }
  function open() {
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    var r = btn.getBoundingClientRect(), w = pop.offsetWidth, vw = document.documentElement.clientWidth;
    pop.style.top = Math.round(r.bottom + 8) + "px";
    pop.style.left = Math.max(12, Math.min(Math.round(r.left), vw - w - 12)) + "px";
  }
  btn.addEventListener("click", function (e) { e.stopPropagation(); pop.hidden ? open() : close(); });
  document.addEventListener("click", function (e) { if (!pop.hidden && !pop.contains(e.target)) close(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !pop.hidden) { close(); btn.focus(); } });
  window.addEventListener("resize", close);
})();
