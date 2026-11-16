import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Barcode lookup against dwaprices_products (the app's primary source).
// v2: when the barcode is NOT stored, this function itself calls drug-barcode-live (web search + the dwaprices page that prints
// the barcode, read by the deterministic reader and imported into dwaprices_products), then answers with the SAME result shape
// as a normal hit. The app therefore gets a full product from its first request and needs no change.
// It never writes search_history. Pass { "live": false } to skip the live step.

const SOURCE_NAME = "دليل دواء مصر";
const SOURCE_SITE = "dwaprices.com";
const OFFICIAL_LABEL = "المصدر الرسمي: دليل دواء مصر (dwaprices.com)";
const LIVE_TIMEOUT_MS = 100_000;

function checkOk(code: string): boolean {
  const d = code.split("").map(Number);
  const check = d.pop() as number;
  let sum = 0;
  d.reverse().forEach((x, i) => { sum += x * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}
const FORMAT: Record<number, string> = { 8: "EAN-8", 12: "UPC-A", 13: "EAN-13", 14: "GTIN-14" };

// Stored barcodes have 12, 13 or 14 digits: compare every equivalent form (leading zeros are padding).
function candidatesOf(code: string): string[] {
  const g14 = code.padStart(14, "0");
  const out = new Set<string>([g14, code]);
  for (const len of [8, 12, 13]) if (/^0*$/.test(g14.slice(0, 14 - len))) out.add(g14.slice(14 - len));
  return [...out];
}

function display(code: string | null) {
  if (!code || !/^(\d{8}|\d{12,14})$/.test(code) || !checkOk(code)) return { value: null, format: null, display: null };
  return { value: code, format: FORMAT[code.length] ?? null, display: code.length === 13 ? `${code[0]} ${code.slice(1, 7)} ${code.slice(7)}` : code };
}
const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const nameKey = (s: unknown) => (typeof s === "string" ? s.toLowerCase().replace(/\s+/g, " ").trim() : "");

type Row = {
  dwaprices_id: number; source_url: string; trade_name: string; arabic_name: string | null; scientific_name: string | null;
  classification: string | null; manufacturer: string | null; dosage_form: string | null;
  current_price: number | string | null; old_price: number | string | null; price_updated_on: string | null;
  major_unit_qty: number | string | null; minor_unit_qty: number | string | null; barcode: string | null;
  image_url: string | null; extracted_at: string | null; shared_count: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { gtins?: unknown; live?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const gtins = (Array.isArray(body.gtins) ? body.gtins : [])
    .filter((g): g is string => typeof g === "string" && /^(\d{8}|\d{12,14})$/.test(g) && checkOk(g))
    .slice(0, 2);
  if (!gtins.length) return json({ error: "invalid_gtin" }, 400);
  const candidates = [...new Set(gtins.flatMap(candidatesOf))];

  const baseUrl = Deno.env.get("SUPABASE_URL")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(baseUrl, svc, { auth: { persistSession: false } });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { data: allowed, error: rlErr } = await db.rpc("check_rate_limit", { p_key: `scan:${ip}`, p_limit: 120, p_window_seconds: 60 });
  if (rlErr) { console.error("rate_limit_error", rlErr.message); return json({ error: "internal_error" }, 500); }
  if (allowed === false) return json({ error: "rate_limited" }, 429);

  const lookup = async () => {
    const { data, error } = await db.rpc("lookup_dwaprices_by_barcode", { p_candidates: candidates });
    if (error) throw new Error(error.message);
    return (data ?? []) as Row[];
  };

  let rows: Row[];
  try { rows = await lookup(); } catch (e) { console.error("barcode_lookup_error", String(e)); return json({ error: "internal_error" }, 500); }

  // v2: not stored -> live search + import, then look again
  let live: Record<string, unknown> | null = null;
  if (!rows.length && body.live !== false) {
    for (const g of gtins) {
      try {
        const r = await fetch(`${baseUrl}/functions/v1/drug-barcode-live`, {
          method: "POST",
          headers: { Authorization: `Bearer ${svc}`, "Content-Type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ gtin: g }),
          signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
        });
        const j = await r.json().catch(() => null) as Record<string, unknown> | null;
        live = j ? { gtin: g, status: j.status ?? null, reason: j.reason ?? null, error: j.error ?? null, imported_now: j.imported_now ?? false } : { gtin: g, error: `http_${r.status}` };
        if (j?.status === "db_hit") break;
      } catch (e) {
        console.error("live_call_error", g, e instanceof Error ? e.message : String(e));
        live = { gtin: g, error: "live_call_failed" };
      }
    }
    try { rows = await lookup(); } catch (e) { console.error("barcode_relookup_error", String(e)); }
  }

  const results = rows.map((r) => {
    const bc = display(r.barcode);
    return {
      id: `dwaprices:${r.dwaprices_id}`,
      dwaprices_id: r.dwaprices_id,
      product_name: r.trade_name,
      normalized_name: nameKey(r.trade_name),
      arabic_name: r.arabic_name ?? null,
      manufacturer: r.manufacturer ?? null,
      dosage_form: r.dosage_form ?? null,
      pack_size: null,
      scientific_name: r.scientific_name ?? null,
      ingredients: r.scientific_name ?? null,
      classification: r.classification ?? null,
      image: { url: r.image_url ?? null, alt: r.trade_name, source: SOURCE_SITE, has_image: !!r.image_url },
      product_image_url: r.image_url ?? null,
      image_url: r.image_url ?? null,
      barcode: bc.value,
      barcode_format: bc.format,
      barcode_display: bc.display,
      barcode_shared: r.shared_count > 1,
      current_price: num(r.current_price),
      old_price: num(r.old_price),
      price_updated_on: r.price_updated_on ?? null,
      price_currency: "EGP",
      major_unit_qty: num(r.major_unit_qty),
      minor_unit_qty: num(r.minor_unit_qty),
      source_url: r.source_url,
      last_read_at: r.extracted_at ?? null,
      tier: 1,
      tier_label: "official",
      source_label: OFFICIAL_LABEL,
      official_domain: SOURCE_SITE,
      official: { is_official: true, label: OFFICIAL_LABEL, source_name: SOURCE_NAME, site: SOURCE_SITE, page_url: r.source_url, product_url: r.source_url },
      doses_missing: null,
      can_search_pharmacies_for_doses: false,
    };
  });

  return json({
    gtins, candidates,
    found: results.length,
    ambiguous: results.length > 1,
    results,
    source: { name: SOURCE_NAME, site: SOURCE_SITE },
    ...(live ? { live } : {}),
  });
});
