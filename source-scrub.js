/* source-scrub.js — شبكة أمان: اسم مصدر البيانات الرئيسي ورابطه مبيظهروش في الصفحة نهائيًا، حتى لو جم في نص من السيرفر.
   - بيمسح الاسم من أي نص أو alt أو title، وبيشيل أي رابط (a) بيودّي لموقع المصدر.
   - اللي بيعرضه الكود نفسه اتصلّح في أماكنه؛ ده لأي نص جاي من السيرفر (تنبيهات، ملاحظات، أسماء مصادر).
   ⚠ بيتحمّل آخر ملف. صور المنتجات نفسها (img src) مبتتعرضش كنص ولا رابط. */
(() => {
"use strict";
const NAME = /(?:(?:المصدر(?:\s+الرسمي)?\s*[:：]\s*)|(?:\s+من\s+))?[(\[«]?\s*(?:دليل\s+دواء\s+مصر|دليل\s+الدواء(?:\s+المصري)?|dwaprices(?:\.com)?)\s*[)\]»]?/gi;
const HOST = /dwaprices/i;
const clean = (s) => {
  if (!s) return s;
  NAME.lastIndex = 0;
  if (!NAME.test(s)) { NAME.lastIndex = 0; return s; }
  NAME.lastIndex = 0;
  const lead = (s.match(/^\s*/) || [""])[0], trail = (s.match(/\s*$/) || [""])[0];
  let t = s.replace(NAME, " ").replace(/\(\s*\)|«\s*»/g, "");
  t = t.replace(/\s*(?:المصدر(?:\s+الرسمي)?)\s*[:：]\s*(?=[.،]|$)/g, "");  // "المصدر:" اتبقّت من غير اسم
  t = t.replace(/\s{2,}/g, " ").replace(/([.،])\s*(?:[.،]\s*)+/g, "$1 ").trim();
  return /^(?:المصدر(?:\s+الرسمي)?|من)?\s*[:：.،]*$/.test(t) ? "" : lead + t + trail;
};
const ATTRS = ["alt", "title", "aria-label", "placeholder"];
function scrub(root) {
  if (!root) return;
  if (root.nodeType === 3) { const v = clean(root.nodeValue); if (v !== root.nodeValue) root.nodeValue = v; return; }
  if (root.nodeType !== 1) return;
  const tag = root.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") return;
  const anchors = root.matches && root.matches("a[href]") ? [root] : [];
  anchors.push(...root.querySelectorAll("a[href]"));
  anchors.forEach((a) => { let h = ""; try { h = new URL(a.getAttribute("href"), location.href).hostname; } catch { h = a.getAttribute("href") || ""; } if (HOST.test(h)) a.remove(); });
  const els = [root, ...root.querySelectorAll("*")];
  els.forEach((e) => ATTRS.forEach((n) => { const v = e.getAttribute && e.getAttribute(n); if (v) { const c = clean(v); if (c !== v) e.setAttribute(n, c); } }));
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => { const p = n.parentNode && n.parentNode.nodeName; return p === "SCRIPT" || p === "STYLE" || p === "TEXTAREA" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
  const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
  nodes.forEach((n) => { const v = clean(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; });
}
let queued = false; const pending = new Set();
const flush = () => { queued = false; const items = [...pending]; pending.clear(); items.forEach((n) => { if (n.isConnected || n.nodeType === 3) scrub(n); }); };
new MutationObserver((muts) => {
  muts.forEach((m) => {
    if (m.type === "characterData") pending.add(m.target);
    else if (m.type === "attributes") pending.add(m.target);
    else m.addedNodes.forEach((n) => pending.add(n));
  });
  if (!queued) { queued = true; queueMicrotask(flush); }
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat("href") });
scrub(document.body);
})();
