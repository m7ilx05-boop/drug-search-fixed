import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// drug-image-import v2: the button "search for the product's photo" (manual only).
// Input: { dwaprices_id }. Works ONLY for a product that has NO photo on dwaprices (image_url empty).
// A product that has a photo (even a hidden / mismatched one) is refused with error "has_image".
// Flow: search the web for pack photos (Tavily) -> read each candidate with Gemini (llm-gateway) -> accept the FIRST one whose
// printed brand (every word of the brand part, no extra variant words) AND strength match the product -> copy it into the
// public bucket product-images -> record it in image_imports. drug-search then shows it for that product.
// Limits: one claim per product (claim_image_import: busy / cooldown 7 days after not_found / 10 min after an error),
// 3 requests per minute per IP, 60 runs per day overall, at most 4 candidates read per run, 90 s budget for trying candidates.
// A rejected candidate is never stored; a run that finds nothing stores nothing but the not_found row.
// v2: source_page_url is no longer taken from the search results (it pointed at an unrelated page); the source is the image's own host.

const BUCKET = "product-images";
const MAX_IMAGE_BYTES = 4_000_000;
const MAX_CANDIDATES_READ = 4;
const TRY_BUDGET_MS = 90_000;
const COOLDOWN_DAYS = 7;

const PROMPT = `You are reading ONE photo of a medicine package (front, back or blister). Extract ONLY text that is actually printed and legible in the photo. Never guess, never complete a name from memory, never translate.
Return a single JSON object with exactly these keys:
{
  "is_medicine_pack": boolean,   // true only if the photo shows a medicine/supplement package or blister
  "legible": boolean,            // false if the text is too blurry, cut off or too small to read
  "brand_name": string|null,     // the full trade/brand name exactly as printed, including variant words (e.g. "Panadol Extra"), without strength and dosage form
  "brand_family": string|null,   // ONLY the family root of the brand name: "Panadol" for "Panadol Extra". Same letters as printed. null if unsure
  "arabic_name": string|null,    // the Arabic printed name, if present
  "strength": string|null        // every strength printed on the front, exactly as printed and in the printed order, e.g. "500 mg" or "5 mg/10 mg"
}
If a field is not visible use null. Output JSON only.`;

const clean = (v: unknown, max = 100): string | null => {
  if (typeof v !== "string") return null;
  // deno-lint-ignore no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s.length ? s : null;
};

// ---------- name helpers (same rules as drug-image-report) ----------
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
const LINK_WORDS = new Set(["from", "with", "and", "the", "for"]);
const coreTokens = (s: string | null | undefined): string[] =>
  nameTokens((s ?? "").split(/\s\d|\(/)[0]).filter((t) => t.length >= 3 && !LINK_WORDS.has(t));

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const near = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);
const allNear = (core: string[], read: string[]) => core.length > 0 && core.every((t) => read.some((r) => near(r, t)));

// ---------- strength helpers ----------
type StrengthVal = { u: "mg" | "iu"; v: number };
const STRENGTH_RE = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)*)\s*(mg|mcg|ug|gm|g|iu)\b/g;
const PER_ML_RE = /\d\s*(?:mg|mcg|ug|gm|g|iu)\s*\/\s*\d*\.?\d*\s*(?:ml|l)\b/;
function normText(s: string): string {
  return s.toLowerCase().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2").replace(/(\d),(\d)/g, "$1.$2");
}
function parseStrengths(s: string | null | undefined): StrengthVal[] | null {
  if (!s) return null;
  const t = normText(s);
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
const sameVal = (a: StrengthVal, b: StrengthVal) => a.u === b.u && Math.abs(a.v - b.v) <= 1e-6 * Math.max(1, a.v);
// numbers that carry a unit in the product name (used for % and per-ml strengths, which parseStrengths skips)
const unitNumbers = (s: string): string[] =>
  [...normText(s).matchAll(/(\d+(?:\.\d+)?)\s*(?=%|mg|mcg|ug|gm|g|iu|ml)/g)].map((m) => String(Number(m[1])));
const allNumbers = (s: string): Set<string> => new Set([...normText(s).matchAll(/\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0]))));

// Strict judgement used for IMPORT (a wrong photo must never be stored): brand, variant and strength must all be confirmed.
type Reading = { is_medicine_pack: boolean; legible: boolean; brand_name: string | null; brand_family: string | null; arabic_name: string | null; strength: string | null };
function judge(prod: { trade_name: string; arabic_name: string | null; manufacturer: string | null }, rd: Reading): { ok: boolean; reason: string | null } {
  if (!rd.is_medicine_pack) return { ok: false, reason: "not_a_pack" };
  if (!rd.legible) return { ok: false, reason: "illegible" };
  const readEn = [...nameTokens(rd.brand_name), ...nameTokens(rd.brand_family)];
  const readAr = nameTokens(rd.arabic_name);
  if (!readEn.length && !readAr.length) return { ok: false, reason: "no_brand_read" };

  const prodEn = nameTokens(prod.trade_name);
  const coreEn = coreTokens(prod.trade_name);
  const coreAr = coreTokens(prod.arabic_name);
  let brandOk = coreEn.length ? allNear(coreEn, readEn) : (prodEn.length > 0 && readEn.some((t) => near(t, prodEn[0])));
  if (!brandOk && coreAr.length && readAr.length) brandOk = allNear(coreAr, readAr);
  if (!brandOk) return { ok: false, reason: "brand_differs" };

  // variant words on the pack that the product name does not have ("Coveram Plus" for "Coveram"): not the same product
  const manu = nameTokens(prod.manufacturer);
  const extra = nameTokens(rd.brand_name).filter((t) => t.length >= 3 && !prodEn.some((p) => near(p, t)) && !manu.some((m) => near(m, t)));
  if (extra.length && readEn.length) return { ok: false, reason: "variant_differs" };

  // strength
  const p = parseStrengths(prod.trade_name);
  if (p) {
    const r = parseStrengths(rd.strength);
    if (!r) return { ok: false, reason: "strength_unreadable" };
    const rel = p.filter((x) => r.some((y) => y.u === x.u));
    if (!rel.length) return { ok: false, reason: "strength_unreadable" };
    // several strengths (5/10): the order must be the same; otherwise every strength must be printed
    const same = p.length > 1 && r.length === p.length ? p.every((x, i) => sameVal(x, r[i])) : p.every((x) => r.some((y) => sameVal(x, y)));
    if (!same) return { ok: false, reason: "strength_differs" };
  } else {
    const need = unitNumbers(prod.trade_name);
    if (need.length) {
      if (!rd.strength) return { ok: false, reason: "strength_unreadable" };
      const have = allNumbers(rd.strength);
      if (!need.every((n) => have.has(n))) return { ok: false, reason: "strength_differs" };
    }
  }
  return { ok: true, reason: null };
}

// ---------- candidate handling ----------
function safeHttps(u: unknown): URL | null {
  if (typeof u !== "string" || u.length > 800) return null;
  try {
    const x = new URL(u);
    if (x.protocol !== "https:") return null;
    if (x.port && x.port !== "443") return null;
    const h = x.hostname.toLowerCase();
    if (h === "localhost" || /^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".internal") || h.endsWith(".local") || !h.includes(".")) return null;
    return x;
  } catch { return null; }
}
const BAD_EXT = /\.(svg|gif|ico|bmp|tiff?)(\?|$)/i;

async function tavilySearch(db: ReturnType<typeof createClient>, query: string): Promise<{ ok: true; images: string[] } | { ok: false; code: string }> {
  const slots = Object.keys(Deno.env.toObject()).filter((k) => /^tavily/i.test(k) && Deno.env.get(k));
  if (!slots.length) return { ok: false, code: "no_search_key" };
  const st = await db.from("tavily_key_checks").select("slot,state");
  const rank = new Map<string, number>();
  for (const r of (st.data ?? []) as { slot: string; state: string }[]) rank.set(r.slot, r.state === "active" ? 0 : r.state === "unknown" ? 1 : 2);
  slots.sort((a, b) => (rank.get(a) ?? 1) - (rank.get(b) ?? 1) || a.localeCompare(b, undefined, { numeric: true }));
  let lastCode = "search_unavailable";
  for (const slot of slots.slice(0, 4)) {
    if ((rank.get(slot) ?? 1) >= 2) continue;
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get(slot)}` },
        body: JSON.stringify({ query, search_depth: "basic", include_images: true, max_results: 6 }),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 401 || r.status === 403 || r.status === 429 || r.status === 432 || r.status === 433) { await r.body?.cancel(); lastCode = "search_key_unavailable"; continue; }
      if (!r.ok) { await r.body?.cancel(); lastCode = "search_unavailable"; continue; }
      const b = await r.json().catch(() => null) as { images?: unknown[] } | null;
      const images = (b?.images ?? []).map((x) => typeof x === "string" ? x : (x as { url?: unknown })?.url).filter((x): x is string => typeof x === "string");
      return { ok: true, images };
    } catch (e) { console.error("tavily_error", e instanceof Error ? e.name : "error"); lastCode = "search_unavailable"; }
  }
  return { ok: false, code: lastCode };
}

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

const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86400_000).toISOString();

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
  const publicUrl = (path: string) => `${supaUrl}/storage/v1/object/public/${BUCKET}/${path}`;

  // 1) the product, from our own table. Only a product WITHOUT a photo is eligible.
  const pr = await db.from("dwaprices_products").select("dwaprices_id,trade_name,arabic_name,manufacturer,image_url").eq("dwaprices_id", id).maybeSingle();
  if (pr.error) { console.error("product_error", pr.error.message); return json({ error: "internal_error" }, 500); }
  const prod = pr.data as { dwaprices_id: number; trade_name: string; arabic_name: string | null; manufacturer: string | null; image_url: string | null } | null;
  if (!prod) return json({ error: "not_found" }, 404);
  if (prod.image_url && String(prod.image_url).trim() !== "") return json({ error: "has_image" }, 409);

  // 2) already imported: return it, nothing else runs
  const peek = await db.from("image_imports").select("*").eq("dwaprices_id", id).maybeSingle();
  if (peek.error) { console.error("peek_error", peek.error.message); return json({ error: "internal_error" }, 500); }
  const pv = peek.data as Record<string, unknown> | null;
  const acceptedView = (r: Record<string, unknown>, cached: boolean) => ({
    ok: true, dwaprices_id: id, status: "accepted", cached,
    image_url: publicUrl(String(r.storage_path)), source_domain: r.source_domain ?? null, source_page_url: r.source_page_url ?? null,
    read_brand: r.read_brand ?? null, read_strength: r.read_strength ?? null, finished_at: r.finished_at ?? null,
  });
  if (pv?.status === "accepted" && pv.storage_path) return json(acceptedView(pv, true));

  // 3) limits
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl1 = await db.rpc("check_rate_limit", { p_key: `imgimp:${ip}`, p_limit: 3, p_window_seconds: 60 });
  if (rl1.error) { console.error("rate_limit_error", rl1.error.message); return json({ error: "internal_error" }, 500); }
  if (rl1.data === false) return json({ error: "rate_limited", retry_after: 60 }, 429);
  const rl2 = await db.rpc("check_rate_limit", { p_key: "imgimp:global", p_limit: 60, p_window_seconds: 86400 });
  if (rl2.error) { console.error("rate_limit_error", rl2.error.message); return json({ error: "internal_error" }, 500); }
  if (rl2.data === false) return json({ error: "daily_limit", retry_after: 3600 }, 429);

  // 4) claim (atomic)
  const claim = await db.rpc("claim_image_import", { p_id: id });
  if (claim.error) { console.error("claim_error", claim.error.message); return json({ error: "internal_error" }, 500); }
  if (claim.data === "cached") {
    const again = await db.from("image_imports").select("*").eq("dwaprices_id", id).maybeSingle();
    if (again.data?.storage_path) return json(acceptedView(again.data as Record<string, unknown>, true));
    return json({ error: "internal_error" }, 500);
  }
  if (claim.data === "busy") return json({ error: "busy", retry_after: 10 }, 409);
  if (claim.data === "cooldown") {
    return json({ ok: true, dwaprices_id: id, status: "not_found", cached: true, next_allowed_at: pv?.finished_at ? addDays(String(pv.finished_at), COOLDOWN_DAYS) : null });
  }
  if (claim.data === "retry_later") return json({ error: "retry_later", retry_after: 600 }, 429);
  if (claim.data !== "run") return json({ error: "internal_error" }, 500);

  const finish = async (fields: Record<string, unknown>) => {
    const u = await db.from("image_imports").update({ finished_at: new Date().toISOString(), ...fields }).eq("dwaprices_id", id);
    if (u.error) console.error("finish_update_error", u.error.message);
  };
  const fail = async (code: string, status: number, extra: Record<string, unknown> = {}) => {
    await finish({ status: "error", reason: code });
    return json({ error: code, ...extra }, status);
  };

  // 5) find candidate photos on the web
  const core = coreTokens(prod.trade_name);
  const baseName = (prod.trade_name ?? "").trim();
  const queries = [
    `${baseName} ${prod.manufacturer ?? ""} medicine package box`.replace(/\s+/g, " ").trim().slice(0, 200),
    `${baseName} pack photo`.slice(0, 200),
  ];
  const seen = new Set<string>();
  const cands: { image: string; score: number }[] = [];
  let searchFailed: string | null = null;
  for (const q of queries) {
    const s = await tavilySearch(db, q);
    if (!s.ok) { searchFailed = s.code; break; }
    for (const img of s.images) {
      const u = safeHttps(img);
      if (!u || BAD_EXT.test(u.pathname) || u.hostname.endsWith("dwaprices.com")) continue;
      const key = u.href;
      if (seen.has(key)) continue;
      seen.add(key);
      let low = u.href.toLowerCase();
      try { low = decodeURIComponent(u.href).toLowerCase(); } catch { /* keep raw */ }
      cands.push({ image: u.href, score: core.filter((t) => low.includes(t)).length });
    }
    if (cands.length >= 8) break;
  }
  if (!cands.length) {
    if (searchFailed) return await fail(searchFailed, 503, { retry_after: 60 });
    await finish({ status: "not_found", reason: "no_candidates", attempts: 0 });
    return json({ ok: true, dwaprices_id: id, status: "not_found", cached: false, tried: 0, next_allowed_at: addDays(new Date().toISOString(), COOLDOWN_DAYS) });
  }
  cands.sort((a, b) => b.score - a.score);

  // 6) read candidates one by one; the first one that passes the strict judgement is kept
  const started = Date.now();
  const log: { host: string; result: string }[] = [];
  let tried = 0;
  let visionFailure: string | null = null;
  for (const c of cands) {
    if (tried >= MAX_CANDIDATES_READ || Date.now() - started > TRY_BUDGET_MS) break;
    const host = new URL(c.image).hostname;

    let bytes: Uint8Array;
    let mime: string;
    try {
      const res = await fetch(c.image, { signal: AbortSignal.timeout(12_000), headers: { Accept: "image/jpeg,image/png,image/webp" } });
      if (!res.ok || !safeHttps(res.url)) { await res.body?.cancel(); log.push({ host, result: "fetch_failed" }); continue; }
      mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (mime === "image/jpg") mime = "image/jpeg";
      if (!/^image\/(jpeg|png|webp)$/.test(mime)) { await res.body?.cancel(); log.push({ host, result: "bad_type" }); continue; }
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_IMAGE_BYTES) { await res.body?.cancel(); log.push({ host, result: "too_large" }); continue; }
      bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 3000) { log.push({ host, result: "bad_size" }); continue; }
    } catch { log.push({ host, result: "fetch_failed" }); continue; }

    tried++;
    const vis = await callVision(supaUrl, svc, mime, encodeBase64(bytes));
    if (!vis.ok) {
      log.push({ host, result: `vision_${vis.code}` });
      visionFailure = vis.code === "quota_exhausted" || vis.code === "provider_overloaded" || vis.status === 429 ? "provider_exhausted" : "vision_unavailable";
      break;
    }
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(vis.text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); }
    catch { log.push({ host, result: "vision_bad_output" }); continue; }
    const reading: Reading = {
      is_medicine_pack: raw.is_medicine_pack === true,
      legible: raw.legible !== false,
      brand_name: clean(raw.brand_name), brand_family: clean(raw.brand_family, 60),
      arabic_name: clean(raw.arabic_name), strength: clean(raw.strength, 60),
    };
    const verdict = judge(prod, reading);
    log.push({ host, result: verdict.ok ? "accepted" : (verdict.reason ?? "rejected") });
    if (!verdict.ok) continue;

    // accepted: copy into our own bucket
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const path = `${id}/${Date.now()}.${ext}`;
    const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
    if (up.error) { console.error("upload_error", up.error.message); return await fail("upload_failed", 502, { retry_after: 30 }); }
    await finish({
      status: "accepted", reason: null, storage_path: path, source_page_url: null, source_image_url: c.image, source_domain: host,
      read_brand: reading.brand_name, read_strength: reading.strength, model: vis.model, attempts: tried,
      details: { reading, tried: log, rule: "import_strict_v1" },
    });
    return json({
      ok: true, dwaprices_id: id, status: "accepted", cached: false, image_url: publicUrl(path),
      source_domain: host, source_page_url: null, read_brand: reading.brand_name, read_strength: reading.strength, tried,
    });
  }

  if (visionFailure) {
    await finish({ status: "error", reason: visionFailure, attempts: tried, details: { tried: log } });
    return json({ error: visionFailure, retry_after: visionFailure === "provider_exhausted" ? 60 : 30 }, visionFailure === "provider_exhausted" ? 503 : 502);
  }
  await finish({ status: "not_found", reason: "no_candidate_matched", attempts: tried, details: { tried: log, rule: "import_strict_v1" } });
  return json({ ok: true, dwaprices_id: id, status: "not_found", cached: false, tried, next_allowed_at: addDays(new Date().toISOString(), COOLDOWN_DAYS) });
});
