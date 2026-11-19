/* home-cards.js — كروت أدوية شائعة بتلف 3D في الرئيسية. الدوس على كارت = بحث باسمه (نفس زرار "بحث"). */
(function () {
  var host = document.getElementById("d3inner");
  if (!host) return;
  var POOL = [
    ["Panadol", "باراسيتامول"], ["Brufen", "إيبوبروفين"], ["Cataflam", "ديكلوفيناك بوتاسيوم"],
    ["Voltaren", "ديكلوفيناك"], ["Augmentin", "أموكسيسيلين + كلافيولانيك"], ["Zithromax", "أزيثروميسين"],
    ["Flagyl", "ميترونيدازول"], ["Antinal", "نيفوروكسازيد"], ["Zyrtec", "سيتيريزين"],
    ["Claritine", "لوراتادين"], ["Allegra", "فيكسوفينادين"], ["Nexium", "إيسوميبرازول"],
    ["Controloc", "بانتوبرازول"], ["Motilium", "دومبيريدون"], ["Buscopan", "هيوسين بوتيل بروميد"],
    ["Ventolin", "سالبوتامول"], ["Mucosolvan", "أمبروكسول"], ["Glucophage", "ميتفورمين"],
    ["Amaryl", "جليمبيريد"], ["Concor", "بيسوبرولول"], ["Lipitor", "أتورفاستاتين"],
    ["Plavix", "كلوبيدوجريل"], ["Xarelto", "ريفاروكسابان"], ["Lasix", "فيوروسيميد"],
    ["Cipro", "سيبروفلوكساسين"], ["Gaviscon", "ألجينات + مضاد حموضة"]
  ];
  var COLORS = ["142,249,252", "142,252,204", "142,252,157", "215,252,142", "252,252,142",
                "252,208,142", "252,142,142", "252,142,239", "204,142,252", "142,202,252"];
  for (var i = POOL.length - 1; i > 0; i--) { // خلط عشوائي في كل فتحة
    var j = Math.floor(Math.random() * (i + 1)), t = POOL[i]; POOL[i] = POOL[j]; POOL[j] = t;
  }
  var pick = POOL.slice(0, COLORS.length);
  var PILL = '<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="rotate(-42 32 32)"><rect x="4" y="19" width="56" height="26" rx="13" fill="#F5B301"/><path d="M32 19H17a13 13 0 0 0 0 26h15z" fill="#1E7BE0"/><rect x="10" y="23" width="38" height="5" rx="2.5" fill="#fff" opacity=".4"/></g></svg>';
  pick.forEach(function (d, i) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "dcard";
    b.style.setProperty("--i", i); b.style.setProperty("--q", pick.length); b.style.setProperty("--c", COLORS[i]);
    b.setAttribute("aria-label", "ابحث عن " + d[0]);
    b.innerHTML = '<span class="dtxt">' + PILL + "<b></b><small></small></span>";
    b.querySelector("b").textContent = d[0];
    b.querySelector("small").textContent = d[1];
    b.addEventListener("click", function () {
      var q = document.getElementById("q"), f = document.getElementById("f");
      var auto = document.querySelector('input[name="t"][value="auto"]');
      if (auto) auto.checked = true;
      q.value = d[0];
      if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    });
    host.appendChild(b);
  });
})();
