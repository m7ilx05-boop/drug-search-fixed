/* core.js — الأساسيات اللي كل الملفات بتعتمد عليها.
   بيعرّف: BASE, ANON, $, el, REG, ERR, call, setStatus, fmtStrength, norm, normKey, srcLink
   لازم يتحمّل أول ملف. */

const BASE = "https://clhtimetvykbjdhfdmig.supabase.co/functions/v1";
// public anon key: safe to ship in the browser; it grants no more than RLS allows
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNsaHRpbWV0dnlrYmpkaGZkbWlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM4NDM3ODEsImV4cCI6MjEwOTQxOTc4MX0.gfeZ4vLwst6rx0Z1uYLvU_9bzx1yLBR38DDxVD0YSzo";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

const REG = { REGISTERED: ["مسجّل رسميًا", "ok"], NOT_FOUND: ["غير موجود في السجل", "bad"], CANCELLED: ["تسجيل ملغى", "bad"], UNKNOWN: ["التسجيل غير مؤكد", "warn"] };
const ERR = {
  rate_limited: "عدد المحاولات كبير. انتظر دقيقة وجرّب تاني.",
  invalid_query: "اكتب اسم من حرفين لـ 100 حرف.",
  provider_exhausted: "مصادر البحث على الإنترنت مش متاحة دلوقتي. البيانات المحفوظة بس هي اللي بتظهر.",
  not_eligible: "المنتج ده مش محتاج بحث جرعات.",
  no_sources: "مفيش مصادر صيدليات مفعّلة دلوقتي.",
  busy: "فيه عملية شغالة على المنتج ده دلوقتي.",
  retry_later: "اتعمل فحص للمنتج ده قريب. جرّب بعد شوية.",
  daily_limit: "وصلنا للحد اليومي للفحص والبحث عن الصور. جرّب بكرة.",
  has_image: "المنتج ده ليه صورة بالفعل.",
  no_image: "المنتج ده مفيهوش صورة.",
  vision_unavailable: "قراءة الصور مش متاحة دلوقتي. جرّب بعد شوية.",
  search_unavailable: "البحث عن الصور مش متاح دلوقتي. جرّب بعد شوية.",
  search_key_unavailable: "البحث عن الصور مش متاح دلوقتي. جرّب بعد شوية.",
  no_search_key: "البحث عن الصور مش متاح دلوقتي.",
  fetch_failed: "معرفناش نحمّل الصورة. جرّب بعد شوية.",
  upload_failed: "حصلت مشكلة وإحنا بنحفظ الصورة. جرّب تاني.",
};

async function call(name, body) {
  const r = await fetch(BASE + "/" + name, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ANON, apikey: ANON },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "request_failed"), { code: data.error, data });
  return data;
}

// هيكل تحميل مكان النتايج وقت الانتظار (الـ render/showSuggestions/... بتمسح #out فبيختفي لوحده)
function showSkeleton() {
  const out = $("out");
  out.replaceChildren();
  const s = el("div", "skel"); s.id = "skel"; s.setAttribute("aria-hidden", "true");
  const head = el("div");
  head.append(el("div", "sk sk-title"), el("div", "sk sk-sub"));
  s.append(head, el("div", "sk sk-row"), el("div", "sk sk-row"), el("div", "sk sk-row"), el("div", "sk sk-row half"));
  out.append(s);
}
function hideSkeleton() { const s = document.getElementById("skel"); if (s) s.remove(); }

// ===== تنبيه بيطلع من فوق الشاشة: success / info / warn / error (شكل مقتبس من Uiverse / Cybercom682) =====
const TOAST_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M13 16h-1v-4h1m0-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
let toastTimer = 0;
function toast(kind, text) {
  if (!text) return;
  let box = document.getElementById("toasts");
  if (!box) { box = el("div"); box.id = "toasts"; document.body.append(box); }
  clearTimeout(toastTimer);
  const k = ["success", "info", "warn", "error"].includes(kind) ? kind : "info";
  const t = el("div", "toast " + k);
  t.setAttribute("role", k === "error" ? "alert" : "status");
  const ic = el("span", "toast-ic"); ic.innerHTML = TOAST_ICON;
  t.append(ic, el("p", null, text));
  const close = () => { t.classList.add("out"); setTimeout(() => t.remove(), 260); };
  t.addEventListener("click", close);
  box.replaceChildren(t);                       // تنبيه واحد في كل مرة
  toastTimer = setTimeout(close, k === "error" ? 6000 : 4000);
}
function foundMsg(n) { return n === 1 ? "لقينا منتج واحد." : "لقينا " + Number(n).toLocaleString("ar-EG") + " منتج."; }

function setStatus(text, { error = false, progress = null } = {}) {
  if (error && text) toast("error", text);
  if (error || (progress != null && progress >= 100)) hideSkeleton();
  const s = $("status");
  s.className = "show" + (error ? " error" : "");
  $("msg").textContent = text;
  $("pg").parentElement.style.display = (progress == null || progress >= 100) ? "none" : "block";
  if (progress != null) $("pg").style.width = progress + "%";
}

function fmtStrength(pi) {
  if (pi.strength_value == null) return "التركيز غير معروف";
  return (Number(pi.strength_value) + " " + (pi.strength_unit || "") + (pi.strength_per ? " / " + pi.strength_per : "")).trim();
}

const norm = (s) => String(s || "").trim().toLowerCase();

const AR_DIAC = /[\u064B-\u0670\u0640]/g;
const normKey = (s) => String(s || "").toLowerCase().replace(AR_DIAC, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[^a-z0-9\u0621-\u064A]+/g, "");

function srcLink(u) {
  try { const x = new URL(u); if (x.protocol !== "https:" || /dwaprices/i.test(x.hostname)) return null; return { href: x.href, host: x.hostname.replace(/^www[.]/, "") }; } catch { return null; }
}
