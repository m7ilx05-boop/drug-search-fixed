// بوابة تسجيل الدخول لموقع the-pharmacist فقط. باقي المواقع اللي بتتبني من نفس المستودع مش بتتأثر.
const SB_URL = "https://clhtimetvykbjdhfdmig.supabase.co";
const SB_KEY = "sb_publishable_iaieY2I6Kiy9RLo9JiY1BQ_khK91Dim";
const GATED_HOST = "the-pharmacist.pages.dev";
const PUBLIC_PATHS = ["/login", "/login.html", "/manifest.webmanifest", "/robots.txt", "/icon-180.png", "/icon-192.png", "/icon-512.png"];
const seen = new Map();
function getCookie(req, name) {
  const parts = (req.headers.get("Cookie") || "").split(";");
  for (const p of parts) { const s = p.trim(); if (s.indexOf(name + "=") === 0) return s.slice(name.length + 1); }
  return "";
}
function jwtExp(t) {
  try {
    let b = t.split(".")[1].split("-").join("+").split("_").join("/");
    while (b.length % 4) b += "=";
    return JSON.parse(atob(b)).exp || 0;
  } catch (e) { return 0; }
}
// بترجّع: ok / expired / bad
async function check(token) {
  const exp = jwtExp(token), now = Math.floor(Date.now() / 1000);
  if (!exp || exp <= now) return "expired";
  const hit = seen.get(token);
  if (hit && hit > Date.now()) return "ok";
  let r;
  try { r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, Authorization: "Bearer " + token } }); }
  catch (e) { return "bad"; }
  if (!r.ok) return "bad";
  if (seen.size > 500) seen.clear();
  seen.set(token, Date.now() + Math.min(120000, (exp - now) * 1000));
  return "ok";
}
export async function onRequest(ctx) {
  const req = ctx.request, url = new URL(req.url), host = url.hostname;
  if (!(host === GATED_HOST || host.endsWith("." + GATED_HOST))) return ctx.next();
  if (PUBLIC_PATHS.indexOf(url.pathname) > -1) return ctx.next();
  const token = getCookie(req, "ph_at");
  const state = token ? await check(token) : "none";
  if (state === "ok") {
    const res = await ctx.next();
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-cache");
    out.headers.set("Vary", "Cookie");
    return out;
  }
  const nav = req.method === "GET" && (req.headers.get("Accept") || "").indexOf("text/html") > -1;
  if (!nav) return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  const dest = "/login?next=" + encodeURIComponent(url.pathname + url.search) + (state === "bad" ? "&e=1" : "");
  return new Response(null, { status: 302, headers: { Location: dest, "Cache-Control": "no-store" } });
}
