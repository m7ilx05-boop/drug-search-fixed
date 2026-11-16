import { createClient } from "npm:@supabase/supabase-js@2";

// drug-barcode-live v11: DWAPRICES ONLY. A scanned barcode that drug-barcode did not find in dwaprices_products is searched on
// dwaprices.com through the site's OWN search endpoint (POST https://dwaprices.com/routing-new.php, the same call its search box makes).
// That endpoint matches the barcode directly, so no Tavily, no Firecrawl, no AI and no credits are used.
//   0. defensive DB re-check (same RPC as drug-barcode): a hit is returned as db_hit
//   1. site search for the barcode (and its GTIN-14 / EAN-13 / UPC-A / EAN-8 variants); a row is accepted ONLY if its own
//      barcode field equals the scanned code (compared as GTIN-14), never on a fuzzy name match
//   2. the accepted row is stored through the existing import_dwaprices_product function (same table, same rules as drug-refresh)
//      and the answer is a db_hit, exactly like any other dwaprices product
//   3. nothing accepted -> status no_candidate (reason not_found_on_dwaprices); the miss is remembered 5 minutes
// Nothing is written to drug_products / drug_pre*. The old open-web / Tavily / Firecrawl / AI route is no longer used.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MISS_TTL = 5 * 60 * 1000;
const OFFICIAL_LABEL = "المصدر الرسمي: دليل دواء مصر (dwaprices.com)";
const LABEL_AR = "غير موجود على دليل دواء مصر (dwaprices.com)";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";

function checkOk(code: string): boolean {
  const d = code.split("").map(Number);
  const check = d.pop() as number;
  let sum = 0;
  d.reverse().forEach((x, i) => { sum += x * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}
function candidatesOf(code: string): string[] {
  const g14 = code.padStart(14, "0");
  const out = new Set<string>([g14, code]);
  for (const len of [8, 12, 13]) if (/^0*$/.test(g14.slice(0, 14 - len))) out.add(g14.slice(14 - len));
  return [...out];
}
const g14of = (s: string) => s.replace(/\D/g, "").padStart(14, "0");

type Row = Record<string, unknown>;

// one POST to the site's own search; null = the site did not answer properly (never cached as a miss)
async function siteSearch(q: string): Promise<Row[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://dwaprices.com/routing-new.php", {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", Referer: "https://dwaprices.com/" },
        body: new URLSearchParams({ search: "1", searchq: q }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { await res.body?.cancel(); continue; }
      const b = await res.json().catch(() => null);
      if (b && Array.isArray(b.data)) return b.data as Row[];
    } catch { /* retry once */ }
  }
  return null;
}

const str = (v: unknown, max = 300): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s.length ? s : null;
};
const cap = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : null);
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
function isoFromUnix(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1e9 || n > 4e9) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

// the site's JSON row -> the payload import_dwaprices_product already takes (same fields drug-refresh sends)
function payloadOf(r: Row, gtin: string) {
  const id = Number(r.id);
  const bc = typeof r.barcode === "string" && g14of(r.barcode) === g14of(gtin) ? r.barcode : (typeof r.barcode2 === "string" ? r.barcode2 : null);
  const img = typeof r.img === "string" && /^upload\/[\w.\-]+$/.test(r.img) ? `https://dwaprices.com/${r.img}` : null;
  return {
    dwaprices_id: id,
    source_url: `https://dwaprices.com/med.php?id=${id}`,
    trade_name: cap(str(r.name, 200)),
    scientific_name: cap(str(r.active, 500)),
    classification: cap(str(r.description, 200)),
    manufacturer: cap(str(r.company, 120)),
    dosage_form: cap(str(r.dosage_form, 60)),
    current_price: numOrNull(r.price),
    old_price: numOrNull(r.oldprice),
    price_updated_on: isoFromUnix(r.Date_updated),
    major_unit_qty: numOrNull(r.units),
    minor_unit_qty: numOrNull(r.small_unit),
    barcode: bc ? bc.replace(/\D/g, "") : null,
    image_url: img,
    import_notes: ["source:dwaprices_site_search", "imported_by:drug-barcode-live_v11"],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { gtin?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const gtin = typeof body.gtin === "string" ? body.gtin.trim() : "";
  if (!/^(\d{8}|\d{12,14})$/.test(gtin) || !checkOk(gtin)) return json({ error: "invalid_gtin" }, 400);
  const g14 = g14of(gtin);
  const cands = candidatesOf(gtin);

  const baseUrl = Deno.env.get("SUPABASE_URL")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(baseUrl, svc, { auth: { persistSession: false } });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { data: allowed, error: rlErr } = await db.rpc("check_rate_limit", { p_key: `scanlive:${ip}`, p_limit: 10, p_window_seconds: 60 });
  if (rlErr) { console.error("rate_limit_error", rlErr.message); return json({ error: "internal_error" }, 500); }
  if (allowed === false) return json({ error: "rate_limited" }, 429);

  // 0) a barcode that IS in dwaprices_products never goes to the site
  {
    const { data, error } = await db.rpc("lookup_dwaprices_by_barcode", { p_candidates: cands });
    if (error) { console.error("barcode_lookup_error", error.message); return json({ error: "internal_error" }, 500); }
    const rows = (data ?? []) as { dwaprices_id: number }[];
    if (rows.length) return json({ ok: true, gtin, source: "database", status: "db_hit", found: rows.length, ids: rows.map((r) => r.dwaprices_id).slice(0, 10) });
  }

  // 1) the site's own search (the scan itself is the only thing sent; the miss cache is not consulted first because this call is free)
  const t0 = Date.now();
  const found = new Map<number, Row>();
  let answered = 0;
  const queries = [...new Set([gtin, ...cands.filter((c) => c !== g14)])].slice(0, 3);
  for (const q of queries) {
    const rows = await siteSearch(q);
    if (rows === null) continue;
    answered++;
    for (const r of rows) {
      const id = Number(r.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const hit = [r.barcode, r.barcode2].some((b) => typeof b === "string" && /\d/.test(b) && g14of(b) === g14);
      if (hit && !found.has(id)) found.set(id, r);
    }
    if (found.size) break;
  }
  const stats = { queries: queries.length, answered, accepted_ids: [...found.keys()], elapsed_ms: Date.now() - t0 };
  console.log("live_result", JSON.stringify({ gtin, v: 11, via: "dwaprices_site_search", status: found.size ? "found" : answered ? "no_candidate" : "site_unavailable", stats }));

  if (!answered) return json({ ok: false, error: "providers_unavailable", detail: "dwaprices search did not answer", retry_after: 30 }, 503);

  // 2) store what the site printed, then answer as a normal database hit
  if (found.size) {
    const done: number[] = [];
    const failed: string[] = [];
    for (const [id, r] of [...found.entries()].slice(0, 3)) {
      const imp = await db.rpc("import_dwaprices_product", { p: payloadOf(r, gtin) });
      if (imp.error) failed.push(`${id}:${imp.error.message.slice(0, 120)}`); else done.push(id);
    }
    console.log("barcode_import", JSON.stringify({ gtin, imported: done, failed }));
    if (done.length) {
      const { data, error } = await db.rpc("lookup_dwaprices_by_barcode", { p_candidates: cands });
      const rows = (data ?? []) as { dwaprices_id: number }[];
      if (!error && rows.length) {
        const del = await db.from("barcode_live_miss").delete().in("gtin", [g14, gtin]);
        if (del.error) console.error("miss_clear_error", del.error.message);
        return json({
          ok: true, gtin, source: "database", status: "db_hit", imported_now: true, label_ar: OFFICIAL_LABEL,
          found: rows.length, ids: rows.map((x) => x.dwaprices_id).slice(0, 10), imported_ids: done,
        });
      }
      failed.push(`imported_but_not_found_by_lookup:${error?.message ?? "no_rows"}`);
    }
    return json({ ok: false, error: "import_failed", detail: failed.join(" | ").slice(0, 300) }, 500);
  }

  // 3) the site answered and has no product with this barcode
  const w = await db.from("barcode_live_miss").upsert({ gtin: g14, checked_at: new Date().toISOString() });
  if (w.error) console.error("miss_write_error", w.error.message);
  return json({
    ok: true, gtin, source: "dwaprices", cached: false, status: "no_candidate", reason: "not_found_on_dwaprices",
    label_ar: LABEL_AR, needs_review: false, candidate: null, matches: [], hidden_count: 0, stats,
  });
});
