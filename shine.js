// أي نص انتظار («جاري البحث…» / «جاري التحميل…» / «بنصوّر بدقة كاملة…» …) بيتلفّ تلقائياً في span.shine-text
// فتشتغل عليه حركة اللمعان (الـCSS في style.css). بيشتغل على أي مكان بيتضاف فيه النص، حتى لو الكود بيستخدم textContent.
(function () {
  "use strict";
  var RE = /(^|[\s.،…])و?جاري\s|^\.{3}جاري|^بن(لتقط|صوّر)\s/;
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, OPTION: 1, NOSCRIPT: 1 };
  function wrap(n) {
    var p = n.parentNode;
    if (!p || p.nodeType !== 1 || SKIP[p.tagName]) return;
    if (p.classList && p.classList.contains("shine-text")) return;
    if (!RE.test(n.nodeValue || "")) return;
    var s = document.createElement("span");
    s.className = "shine-text";
    s.style.animationDelay = "-" + Math.round(performance.now() % 3000) + "ms"; // نفس توقيت اللمعان حتى لو النص اتحدّث كتير
    p.insertBefore(s, n);
    s.appendChild(n);
  }
  function scan(root) {
    if (root.nodeType === 3) { wrap(root); return; }
    if (root.nodeType !== 1 || SKIP[root.tagName]) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), list = [], n;
    while ((n = w.nextNode())) list.push(n);
    list.forEach(wrap);
  }
  function start() {
    scan(document.body);
    new MutationObserver(function (ms) {
      ms.forEach(function (m) {
        if (m.type === "characterData") wrap(m.target);
        else m.addedNodes.forEach(scan);
      });
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
