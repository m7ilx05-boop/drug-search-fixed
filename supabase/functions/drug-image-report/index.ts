import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// drug-image-report v3: the "this is not the product's photo" button.
// Input: { dwaprices_id }. The function takes the photo URL from dwaprices_products itself (never from the caller),
// reads the pack with Gemini (through llm-gateway) and compares the printed brand with the product's name.
// Cooldown: ONE finished check per product every 6 months. Pressing again earlier returns the stored result
// and calls nothing (no fetch, no Gemini, no rate-limit use). A failed check (status error) does not start the 6 months.
// A photo shared by several products is read by Gemini once; the stored reading is reused for the other products.
// v2: the brand comparison uses EVERY word of the brand part of the name (the text before the first number), not just the first word.
//     v1 accepted "Zinc-sedico" for a pack of "NOW Zinc" because both start with the generic word "zinc".
// v3: after the brand matches, the STRENGTH printed on the pack is compared with the strength in the product's name.
//     Different strength = status "mismatch", reason "strength_differs" (the photo is then hidden like any mismatch).
//     Conservative: the strength check is skipped (the brand verdict stands) when either side has no readable strength,
//     when a side is a percentage or a per-volume concentration (mg/5ml), or when the two sides have no unit type in common.

const UPLOAD_RE = /^https:\/\/dwaprices\.com\/upload\/[A-Za-z0-9._-]+$/;
const MAX_IMAGE_BYTES = 4_000_000;
const DONE = ["match", "mismatch", "unreadable"];

const PROMPT = `You are reading ONE photo of a medicine package (front, back or blister). Extract ONLY text that is actually printed and legible in the photo. Never guess, never complete a name from memory, never translate.
Return a single JSON object with exactly these keys:
{
  "is_medicine_pack": boolean,   // true only if the photo shows a medicine/supplement package or blister
  "legible": boolean,            // false if the text is too blurry, cut off or too small to read
  "brand_name": string|null,     // the full trade/brand name exactly as printed, including variant words (e.g. "Panadol Extra"), without strength and dosage form
  "brand_family": string|null,   // ONLY the family root of the brand name: "Panadol" for "Panadol Extra". Same letters as printed. null if unsure
  "arabic_name": string|null,    // the Arabic printed name, if present
  "strength": string|null        // strength exactly as printed, e.g. "500 mg"
}
If a field is not visible use null. Output JSON only.`;

const clean = (v: unknown, max = 100): string | null => {
  if (typeof v !== "string") return null;
  // deno-lint-ignore no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s.length ? s : null;
};

// ---------- name helpers (same rules as drug-image-search) ----------
const DROP_WORDS = new Set([
  "tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules", "syrup", "susp", "suspension", "drops", "drop",
  "cream", "gel", "oint", "ointment", "amp", "amps", "ampoule", "ampoules", "vial", "vials", "inj", "injection", "fc", "film", "coated",
  "sachet", "sachets", "supp", "suppositories", "spray", "lotion", "solution", "mg", "ml", "mcg", "g", "gm", "iu", "for", "the",
  "قرص", "اقراص", "أقراص", "كبسول", "شراب", "كريم", "جل", "مرهم", "حقن", "امبول", "لبوس", "قطرة", "مل", "مجم", "جم",
]);
function nameTokens(s: string | null | undefined): string[] {
  if (!s) return [];
  const t = s.toLowerCase().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/f\.\s*c\.?/g, " fc ")
    .replace(/[^a-z0-9\u0621-\u064A. ]+/g, " ").replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
  return t.split(/\s+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter((w) => w && !/^\d+(\.\d+)?(mg|mcg|ug|g|gm|ml|iu|%)?$/.test(w) && !DROP_WORDS.has(w));
}

// the brand part of a product name = the text before its first number or bracket ("Zinc-sedico 10mg/5ml pd." -> "Zinc-sedico").
// Words of 1-2 letters and linking words carry no identity and are ignored.
const LINK_WORDS = new Set(["from", "with", "and", "the", "for"]);
const coreTokens = (s: string | null | undefined): string[] =>
  nameTokens((s ?? "").split(/\s\d|\(/)[0]).filter((t) => t.length >= 3 && !LINK_WORDS.has(t));

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
// one wrong letter is tolerated only for words of 5+ letters (reading errors); short words must be identical
const near = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);
const allNear = (core: string[], read: string[]) => core.length > 0 && core.every((t) => read.some((r) => near(r, t)));

// ---------- strength comparison (v3) ----------
// Strength values of a text, normalised: mg (mcg/ug divided by 1000, g/gm times 1000) or iu.
// null = no usable strength (none found, a percentage, or a per-volume concentration such as 10mg/5ml): the check is then skipped.
type StrengthVal = { u: "mg" | "iu"; v: number };
const STRENGTH_RE = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)*)\s*(mg|mcg|ug|gm|g|iu)\b/g;
const PER_ML_RE = /\d\s*(?:mg|mcg|ug|gm|g|iu)\s*\/\s*\d*\.?\d*\s*(?:ml|l)\b/;
function parseStrengths(s: string | null | undefined): StrengthVal[] | null {
  if (!s) return null;
  const t = s.toLowerCase().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2").replace(/(\d),(\d)/g, "$1.$2");
  if (t.includes("%") || PER_ML_RE.test(t)) return null;
  const out: StrengthVal[] = [];
  for (const m of t.matchAll(STRENGTH_RE)) {
    const unit = m[2];
    for (const n of m[1].split("/")) {
      const v = Number(n);
      if (!Number.isFinite(v)) continue;
      if (unit === "iu") out.push({ u: "iu", v });
      else out.push({ u: "mg", v: unit === "mcg" || unit === "ug" ? v / 1000 : unit === "g" || unit === "gm" ? v * 1000 : v });
    }
  }
  return out.length ? out : null;
}
// null = not checked. ok = every strength of the product (of a unit type the pack also shows) is printed on the pack.
function compareStrength(productName: string, readStrength: string | null): { ok: boolean; product: StrengthVal[]; read: StrengthVal[] } | null {
  const p = parseStrengths(productName), r = parseStrengths(readStrength);
  if (!p || !r) return null;
  const rel = p.filter((x) => r.some((y) => y.u === x.u));
  if (!rel.length) return null;
  const ok = rel.every((x) => r.some((y) => y.u === x.u && Math.abs(x.v - y.v) <= 1e-6 * Math.max(1, x.v)));
  return { ok, product: p, read: r };
}

const addMonths = (iso: string, m: number) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString(); };

type Row = {
  dwaprices_id: number; image_url: string; status: string; read_brand: string | null; read_arabic: string | null;
  reason: string | null; details: Record<string, unknown> | null; model: string | null; checked_at: string; attempts: number;
};
const isDone = (r: Row, url: string) => r.image_url === url && DONE.includes(r.status) && Date.parse(addMonths(r.checked_at, 6)) > Date.now();
const view = (r: Row, cached: boolean) => ({
  ok: true, dwaprices_id: r.dwaprices_id, status: r.status, cached,
  hide_image: r.status === "mismatch",
  read_brand: r.read_brand, read_arabic: r.read_arabic, reason: r.reason,
  variant_match: (r.details as { variant_match?: boolean } | null)?.variant_match ?? null,
  strength_check: (r.details as { strength_check?: unknown } | null)?.strength_check ?? null,
  checked_at: r.checked_at, next_allowed_at: addMonths(r.checked_at, 6),
});

type Reading = { is_medicine_pack: boolean; legible: boolean; brand_name: string | null; brand_family: string | null; arabic_name: string | null; strength: string | null };

async function callVision(url: string, svc: string, mime: string, data: string): Promise<{ ok: true; text: string; model: string | null } | { ok: false; code: string; status: number }> {
  const attempt = async (timeoutMs: number) => {
    try {
      const gw = await fetch(`${url}/functions/v1/llm-gateway`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${svc}` },
        body: JSON.stringify({ provider: "gemini", prompt: PROMPT, json: true, image: { mime, data } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const b = await gw.json().catch(() => ({} as Record<string, unknown>));
      if (gw.ok && b.ok) return { ok: true as const, text: String(b.text ?? ""), model: typeof b.model === "string" ? b.model : null, retry: false, code: "", status: 200 };
      const code = String(b.error ?? `status_${gw.status}`);
      console.error("gateway_error", gw.status, JSON.stringify(b).slice(0, 300));
      return { ok: false as const, text: "", model: null, retry: [429, 502, 503, 504].includes(gw.status) || code === "provider_overloaded", code, status: gw.status };
    } catch (e) {
      console.error("gateway_unreachable", String(e));
      return { ok: false as const, text: "", model: null, retry: true, code: "gateway_unreachable", status: 0 };
    }
  };
  let r = await attempt(40_000);
  if (!r.ok && r.retry && r.code !== "quota_exhausted") { await new Promise((res) => setTimeout(res, 2000)); r = await attempt(30_000); }
  return r.ok ? { ok: true, text: r.text, model: r.model } : { ok: false, code: r.code, status: r.status };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { dwaprices_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const id = typeof body.dwaprices_id === "number" ? body.dwaprices_id : NaN;
  if (!Number.isInteger(id) || id < 1 || id > 2_000_000_000) return json({ error: "invalid_id" }, 400);

  const supaUrl = Deno.env.get("SUPABASE_URL")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supaUrl, svc, { auth: { persistSession: false } });

  // 1) the photo URL always comes from our own table
  const pr = await db.from("dwaprices_products").select("dwaprices_id,trade_name,arabic_name,image_url").eq("dwaprices_id", id).maybeSingle();
  if (pr.error) { console.error("product_error", pr.error.message); return json({ error: "internal_error" }, 500); }
  const prod = pr.data;
  if (!prod) return json({ error: "not_found" }, 404);
  if (!prod.image_url) return json({ error: "no_image" }, 404);
  const imageUrl = prod.image_url as string;
  if (!UPLOAD_RE.test(imageUrl)) return json({ error: "bad_image_url" }, 400);

  // 2) cooldown: a finished check of this photo in the last 6 months is returned as is. Nothing else runs.
  const peek = await db.from("image_checks").select("*").eq("dwaprices_id", id).maybeSingle();
  if (peek.error) { console.error("peek_error", peek.error.message); return json({ error: "internal_error" }, 500); }
  if (peek.data && isDone(peek.data as Row, imageUrl)) return json(view(peek.data as Row, true));

  // 3) limits that protect the vision quota: per IP, and one global daily cap
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl1 = await db.rpc("check_rate_limit", { p_key: `imgrep:${ip}`, p_limit: 5, p_window_seconds: 60 });
  if (rl1.error) { console.error("rate_limit_error", rl1.error.message); return json({ error: "internal_error" }, 500); }
  if (rl1.data === false) return json({ error: "rate_limited", retry_after: 60 }, 429);
  const rl2 = await db.rpc("check_rate_limit", { p_key: "imgrep:global", p_limit: 300, p_window_seconds: 86400 });
  if (rl2.error) { console.error("rate_limit_error", rl2.error.message); return json({ error: "internal_error" }, 500); }
  if (rl2.data === false) return json({ error: "daily_limit", retry_after: 3600 }, 429);

  // 4) claim the right to run (atomic: a double click or a second user cannot start a second call)
  const claim = await db.rpc("claim_image_check", { p_id: id, p_url: imageUrl });
  if (claim.error) { console.error("claim_error", claim.error.message); return json({ error: "internal_error" }, 500); }
  if (claim.data === "cached") {
    const again = await db.from("image_checks").select("*").eq("dwaprices_id", id).maybeSingle();
    if (again.data) return json(view(again.data as Row, true));
    return json({ error: "internal_error" }, 500);
  }
  if (claim.data === "busy") return json({ error: "busy", retry_after: 10 }, 409);
  if (claim.data === "cooldown") return json({ error: "retry_later", retry_after: 600 }, 429);
  if (claim.data !== "run") return json({ error: "internal_error" }, 500);

  const fail = async (code: string, status: number, extra: Record<string, unknown> = {}) => {
    const u = await db.from("image_checks").update({ status: "error", reason: code, checked_at: new Date().toISOString() }).eq("dwaprices_id", id);
    if (u.error) console.error("fail_update_error", u.error.message);
    return json({ error: code, ...extra }, status);
  };

  // 5) the reading of the photo: reuse a stored one (same photo, another product, last 6 months) or read it now
  let reading: Reading | null = null;
  let model: string | null = null;
  let reused = false;
  const cutoff = new Date(Date.now() - 183 * 86400_000).toISOString();
  const sib = await db.from("image_checks").select("details,model").eq("image_url", imageUrl).neq("dwaprices_id", id)
    .in("status", DONE).gte("checked_at", cutoff).order("checked_at", { ascending: false }).limit(1).maybeSingle();
  const sr = (sib.data?.details as { reading?: Reading } | null)?.reading;
  if (sr && typeof sr === "object") { reading = sr; model = (sib.data?.model as string | null) ?? null; reused = true; }

  if (!reading) {
    let bytes: Uint8Array;
    let mime: string;
    try {
      const res = await fetch(imageUrl, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Accept: "image/jpeg,image/png,image/webp" } });
      if (!res.ok) { await res.body?.cancel(); return await fail("fetch_failed", 502, { http_status: res.status }); }
      mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (mime === "image/jpg") mime = "image/jpeg";
      if (!/^image\/(jpeg|png|webp)$/.test(mime)) { await res.body?.cancel(); return await fail("bad_content_type", 502); }
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_IMAGE_BYTES) { await res.body?.cancel(); return await fail("image_too_large", 502); }
      bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 100) return await fail("bad_image_size", 502);
    } catch (e) {
      console.error("image_fetch_error", String(e));
      return await fail("fetch_failed", 502);
    }

    const vis = await callVision(supaUrl, svc, mime, encodeBase64(bytes));
    if (!vis.ok) {
      if (vis.code === "quota_exhausted" || vis.code === "provider_overloaded" || vis.status === 429) return await fail("provider_exhausted", 503, { retry_after: 60 });
      return await fail("vision_unavailable", 502, { retry_after: 30 });
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(vis.text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    } catch { return await fail("vision_bad_output", 502); }
    reading = {
      is_medicine_pack: raw.is_medicine_pack === true,
      legible: raw.legible !== false,
      brand_name: clean(raw.brand_name), brand_family: clean(raw.brand_family, 60),
      arabic_name: clean(raw.arabic_name), strength: clean(raw.strength, 60),
    };
    model = vis.model;
  }

  // 6) compare. Every word of the brand part of the product name (text before the first number) must be printed on the pack
  //    (one wrong letter tolerated in words of 5+ letters). A name that starts with a number falls back to its first word.
  //    v3: when the brand matches, the strength printed on the pack must also match the strength of the product (see compareStrength).
  const readEn = [...nameTokens(reading.brand_name), ...nameTokens(reading.brand_family)];
  const readAr = nameTokens(reading.arabic_name);
  const prodEn = nameTokens(prod.trade_name as string);
  const coreEn = coreTokens(prod.trade_name as string);
  const coreAr = coreTokens(prod.arabic_name as string | null);
  const compared = [prod.trade_name as string, ...(prod.arabic_name ? [prod.arabic_name as string] : [])];

  let status: "match" | "mismatch" | "unreadable";
  let reason: string | null = null;
  let variantMatch: boolean | null = null;
  let strengthCheck: { checked: boolean; ok: boolean | null; product: StrengthVal[] | null; read: StrengthVal[] | null } | null = null;
  if (!reading.is_medicine_pack) { status = "unreadable"; reason = "not_a_pack"; }
  else if (!reading.legible) { status = "unreadable"; reason = "illegible"; }
  else if (!readEn.length && !readAr.length) { status = "unreadable"; reason = "no_brand_read"; }
  else {
    let ok = coreEn.length ? allNear(coreEn, readEn) : (prodEn.length > 0 && readEn.some((t) => near(t, prodEn[0])));
    if (!ok && coreAr.length && readAr.length) ok = allNear(coreAr, readAr);
    status = ok ? "match" : "mismatch";
    if (ok && prodEn.length) variantMatch = prodEn.every((t) => readEn.some((r) => near(r, t)));
    if (!ok) reason = "brand_differs";
    if (ok) {
      const sc = compareStrength(prod.trade_name as string, reading.strength);
      strengthCheck = sc ? { checked: true, ok: sc.ok, product: sc.product, read: sc.read } : { checked: false, ok: null, product: null, read: null };
      if (sc && !sc.ok) { status = "mismatch"; reason = "strength_differs"; }
    }
  }

  const done = await db.from("image_checks").update({
    status, reason, read_brand: reading.brand_name, read_arabic: reading.arabic_name, compared_with: compared,
    details: { reading, variant_match: variantMatch, strength_check: strengthCheck, reused_reading: reused, rule: "core_all_words_v2+strength_v3" },
    model, checked_at: new Date().toISOString(),
  }).eq("dwaprices_id", id).select("*").single();
  if (done.error) { console.error("final_update_error", done.error.message); return json({ error: "internal_error" }, 500); }
  return json(view(done.data as Row, false));
});
