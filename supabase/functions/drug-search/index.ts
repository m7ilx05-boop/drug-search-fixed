import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const TYPES = ["auto", "brand_family", "brand", "ingredient"];

// A job that is still queued/running after this long was cut off (the runner gives up at 120s).
const STALE_JOB_MS = 4 * 60_000;
// A query whose pages were read this recently is answered from the stored rows (price / availability refresh window).
const COOLDOWN_AFTER_COMPLETED_MS = 12 * 3600_000;
// A job that finished without reaching the pages (provider down, no source enabled...) is retried sooner.
const COOLDOWN_AFTER_NOT_REACHED_MS = 10 * 60_000;
const COOLDOWN_AFTER_FAILED_MS = 2 * 60_000;
const NOT_REACHED_CODES = ["", "extraction_failed", "firecrawl_unavailable", "no_enabled_sources"];
// While a background job is still reading the source for a query that has no stored rows yet, the front end retries after this long.
const RETRY_AFTER_SECONDS = 5;

// dwaprices.com is the app's official source (decision 2026-11-12). The first search returns ONLY its data.
// Information from pharmacies and every other source is returned only when the person presses the
// "search pharmacies" button (request with phase "secondary"), and always in its own `pharmacies` group.
const SOURCE_NAME = "دليل دواء مصر";
const SOURCE_SITE = "dwaprices.com";
const SOURCE_URL = "https://dwaprices.com";
const OFFICIAL_LABEL = "المصدر الرسمي: دليل دواء مصر (dwaprices.com)";
const CONSENSUS_LABEL = "معلومات مجمّعة من الصيدليات";
const MANUFACTURER_LABEL = "من الموقع الرسمي للمصنّع";
const PHARMACIES_LABEL = "معلومات الصيدليات والمصادر الأخرى";
const DISCLAIMER = "المعلومات من موقع دليل دواء مصر وللتوعية فقط، وليست بديلاً عن استشارة الطبيب أو الصيدلي. تاريخ آخر تحديث للسعر ظاهر بجانب كل سعر.";

type Row = Record<string, unknown>;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
const nameKey = (s: unknown) => (typeof s === "string" ? s.toLowerCase().replace(/\s+/g, " ").trim() : "");
const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// Barcode (the product's serial / GTIN number): format by length, and the check digit is verified.
// A barcode whose check digit is wrong is a typo somewhere upstream: it is not shown at all.
function gtinInfo(code: string | null): { value: string | null; format: string | null; display: string | null } {
  if (!code || !/^(\d{8}|\d{12,14})$/.test(code)) return { value: null, format: null, display: null };
  const d = code.split("").map(Number);
  const check = d.pop() as number;
  let sum = 0;
  d.reverse().forEach((x, i) => { sum += x * (i % 2 === 0 ? 3 : 1); });
  if ((10 - (sum % 10)) % 10 !== check) return { value: null, format: null, display: null };
  const format = ({ 8: "EAN-8", 12: "UPC-A", 13: "EAN-13", 14: "GTIN-14" } as Record<number, string>)[code.length] ?? null;
  const display = code.length === 13 ? `${code[0]} ${code.slice(1, 7)} ${code.slice(7)}` : code;
  return { value: code, format, display };
}

type DwaRow = {
  dwaprices_id: number; source_url: string; trade_name: string; arabic_name: string | null; scientific_name: string | null;
  classification: string | null; manufacturer: string | null; dosage_form: string | null;
  current_price: number | string | null; old_price: number | string | null; price_updated_on: string | null;
  major_unit_qty: number | string | null; minor_unit_qty: number | string | null; barcode: string | null;
  image_url: string | null; extracted_at: string | null;
  // how the name matched the query: "exact" (word starts), "compact" (same name without spaces), "similar" (spelling within 1-2 letters)
  match_kind?: string | null;
};

// Photo check (button "this is not the product's photo", function drug-image-report). One finished check per product every 6 months.
const CHECK_DONE = ["match", "mismatch", "unreadable"];
const addMonthsMs = (iso: string, m: number) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + m); return d.getTime(); };
type ImageCheck = { dwaprices_id: number; image_url: string; status: string; checked_at: string };

// Imported photo (button "search for the photo", function drug-image-import): only for a product that has NO photo on dwaprices.
// Same windows as the function's claim: running 3 min, not_found 7 days, error 10 min.
type ImageImport = { dwaprices_id: number; status: string; storage_path: string | null; source_domain: string | null; started_at: string | null; finished_at: string | null };
const IMPORT_RUNNING_MS = 3 * 60_000;
const IMPORT_NOT_FOUND_MS = 7 * 86400_000;
const IMPORT_ERROR_MS = 10 * 60_000;
const ageMs = (iso: string | null) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { query?: unknown; search_type?: unknown; phase?: unknown; retry?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const searchType = typeof body.search_type === "string" ? body.search_type : "auto";
  if (query.length < 2 || query.length > 100) return json({ error: "invalid_query", detail: "query must be 2-100 characters" }, 400);
  if (!TYPES.includes(searchType)) return json({ error: "invalid_search_type", allowed: TYPES }, 400);
  // No `phase` (or "primary") = the first search (dwaprices.com only); "secondary" = the button that searches pharmacies and the other sources.
  if (body.phase !== undefined && body.phase !== "primary" && body.phase !== "secondary") {
    return json({ error: "invalid_phase", allowed: ["primary", "secondary"] }, 400);
  }
  const wantSecondary = body.phase === "secondary";
  const jobKind = wantSecondary ? "secondary" : "full";
  // `retry: true` = the front end re-asking for the same search while its background job runs: it is not logged as a new search.
  const isRetry = body.retry === true;

  const supaUrl = Deno.env.get("SUPABASE_URL")!;
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supaUrl, svcKey, { auth: { persistSession: false } });

  let userId: string | null = null;
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token) {
    const { data } = await db.auth.getUser(token);
    userId = data?.user?.id ?? null;
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { data: allowed, error: rlErr } = await db.rpc("check_rate_limit", {
    p_key: `search:${userId ?? ip}`, p_limit: 30, p_window_seconds: 60,
  });
  if (rlErr) { console.error("rate_limit_error", rlErr.message); return json({ error: "internal_error" }, 500); }
  if (allowed === false) return json({ error: "rate_limited" }, 429);

  const { data: norm, error: nErr } = await db.rpc("normalize_text", { t: query });
  if (nErr || !norm) { console.error("normalize_error", nErr?.message); return json({ error: "internal_error" }, 500); }
  const normalized = norm as string;
  const safeText = /^[a-z0-9؀-ۿ ]+$/.test(normalized);

  // Arabic names of pages read since the last search are copied into dwaprices_products first, so Arabic queries match.
  const fill = await db.rpc("dwaprices_fill_arabic");
  if (fill.error) console.error("dwaprices_fill_arabic_error", fill.error.message);

  // ---- The answer: rows of dwaprices_products only (the same barcode on two products is already hidden by the function)
  const sr = await db.rpc("search_dwaprices", { p_query: query, p_type: searchType, p_limit: 50 });
  if (sr.error) { console.error("dwaprices_search_error", sr.error.message); return json({ error: "internal_error" }, 500); }
  let rows = (sr.data ?? []) as DwaRow[];

  // A brand name searched as an ingredient (or an ingredient as a brand) finds nothing in the typed search:
  // retry once over every field (type "auto") so a wrong search type does not hide products that exist.
  let fallbackFrom: string | null = null;
  if (!rows.length && (searchType === "ingredient" || searchType === "brand")) {
    const sr2 = await db.rpc("search_dwaprices", { p_query: query, p_type: "auto", p_limit: 50 });
    if (sr2.error) console.error("dwaprices_search_fallback_error", sr2.error.message);
    else if ((sr2.data ?? []).length) { rows = sr2.data as DwaRow[]; fallbackFrom = searchType; }
  }

  // ---- Photo checks of these products (read-only). A failed lookup changes nothing: every photo is then shown as before.
  // The verdict belongs to one photo URL: if dwaprices changed the URL, the old verdict is ignored.
  const imageChecks = new Map<number, ImageCheck>();
  let enforceVision = false;
  const dwaIds = rows.map((r) => r.dwaprices_id).filter((x) => Number.isInteger(x));
  if (dwaIds.length) {
    const [ck, pol] = await Promise.all([
      db.from("image_checks").select("dwaprices_id,image_url,status,checked_at").in("dwaprices_id", dwaIds),
      db.from("image_policy").select("enforce_vision").eq("id", 1).maybeSingle(),
    ]);
    if (ck.error) console.error("image_checks_error", ck.error.message);
    else for (const c of (ck.data ?? []) as ImageCheck[]) imageChecks.set(c.dwaprices_id, c);
    if (pol.error) console.error("image_policy_error", pol.error.message);
    else enforceVision = pol.data?.enforce_vision === true;
  }

  // ---- Imported photos (read-only), looked up only for products that have no photo on dwaprices. A failed lookup changes nothing.
  const imageImports = new Map<number, ImageImport>();
  const noPhotoIds = rows.filter((r) => !r.image_url && Number.isInteger(r.dwaprices_id)).map((r) => r.dwaprices_id);
  if (noPhotoIds.length) {
    const im = await db.from("image_imports").select("dwaprices_id,status,storage_path,source_domain,started_at,finished_at").in("dwaprices_id", noPhotoIds);
    if (im.error) console.error("image_imports_error", im.error.message);
    else for (const i of (im.data ?? []) as ImageImport[]) imageImports.set(i.dwaprices_id, i);
  }

  const products = rows.map((r) => {
    const bc = gtinInfo(r.barcode);
    const official = {
      is_official: true, label: OFFICIAL_LABEL, source_name: SOURCE_NAME, site: SOURCE_SITE,
      page_url: r.source_url, product_url: r.source_url,
    };

    // photo check state for this product
    const ic = imageChecks.get(r.dwaprices_id);
    const sameImage = !!ic && !!r.image_url && ic.image_url === r.image_url;
    const checkStatus = sameImage ? ic!.status : "none";
    const doneRecently = sameImage && CHECK_DONE.includes(ic!.status) && addMonthsMs(ic!.checked_at, 6) > Date.now();
    const imageReliable = checkStatus !== "mismatch";
    // the photo is hidden only when the policy is on AND the stored verdict is mismatch
    const hideImage = enforceVision && checkStatus === "mismatch";

    // imported photo: only for a product with NO photo on dwaprices (a product that has one never uses an imported one)
    const imp = imageImports.get(r.dwaprices_id);
    const importedUrl = !r.image_url && imp?.status === "accepted" && imp.storage_path
      ? `${supaUrl}/storage/v1/object/public/product-images/${imp.storage_path}` : null;
    const importBlocked = !!imp && (
      imp.status === "accepted" ||
      (imp.status === "running" && ageMs(imp.started_at) < IMPORT_RUNNING_MS) ||
      (imp.status === "not_found" && ageMs(imp.finished_at) < IMPORT_NOT_FOUND_MS) ||
      (imp.status === "error" && ageMs(imp.finished_at) < IMPORT_ERROR_MS)
    );
    const imageImport = {
      status: imp?.status ?? "none", // none | running | accepted | not_found | error
      // the button "search for the photo" (function drug-image-import): only while the product has no photo of its own and no import is running, done or in cooldown
      can_import: !r.image_url && !importBlocked,
      next_import_at: imp?.status === "not_found" && imp.finished_at ? new Date(new Date(imp.finished_at).getTime() + IMPORT_NOT_FOUND_MS).toISOString() : null,
      source_domain: importedUrl ? (imp!.source_domain ?? null) : null,
    };

    const shownImage = hideImage ? null : (r.image_url ?? importedUrl ?? null);
    const imageCheck = {
      status: checkStatus, // none | match | mismatch | unreadable | error
      checked_at: sameImage ? ic!.checked_at : null,
      // the button "this is not the product's photo": available while no finished check exists in the last 6 months
      can_report: !!r.image_url && !doneRecently,
      next_report_at: doneRecently ? new Date(addMonthsMs(ic!.checked_at, 6)).toISOString() : null,
    };

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
      // product image: a link to the picture on dwaprices.com (null when the site has none or the photo was found not to be this product's; the front end shows a placeholder then)
      // imported = the picture was found by the "search for the photo" button and is stored in our own bucket; source is then the site it was found on
      image: { url: shownImage, alt: r.trade_name, source: importedUrl ? (imp!.source_domain ?? "imported") : SOURCE_SITE, has_image: !!shownImage, imported: !!importedUrl, hidden_reason: hideImage ? "mismatch" : null },
      product_image_url: shownImage,
      image_url: shownImage,
      // false when the stored photo check says the photo is not this product's (even if the policy does not hide it yet)
      image_reliable: imageReliable,
      image_check: imageCheck,
      image_import: imageImport,
      // product barcode / serial number: only a barcode with a valid check digit; display = grouped for reading
      barcode: bc.value,
      barcode_format: bc.format,
      barcode_display: bc.display,
      current_price: num(r.current_price),
      old_price: num(r.old_price),
      price_updated_on: r.price_updated_on ?? null,
      price_currency: "EGP",
      major_unit_qty: num(r.major_unit_qty),
      minor_unit_qty: num(r.minor_unit_qty),
      source_url: r.source_url,
      last_read_at: r.extracted_at ?? null,
      // how the name matched what was typed; is_approximate = spelled differently from the query (the front end should say so)
      match_kind: r.match_kind ?? "exact",
      is_approximate: r.match_kind === "similar",
      tier: 1,
      tier_label: "official",
      source_label: OFFICIAL_LABEL,
      official_domain: SOURCE_SITE,
      official,
      pharmacy_count: 0,
      doses_missing: null,
      doses_note: null,
      can_search_pharmacies_for_doses: false,
    };
  });

  // ---- Pharmacies and other sources: ONLY after the person presses the pharmacies button (phase "secondary"). ----
  // Everything below is kept in its own group and never mixed into `results`. A failure only drops that group.
  let pharmacyManufacturer: Row[] = [];
  let pharmacyConsensus: Row[] = [];
  let pharmacyUnverified: Row[] = [];
  let pendingReview: Row[] = [];
  if (wantSecondary) {
    const { data: hits, error: sErr } = await db.rpc("search_local_products", { p_query: query, p_type: searchType, p_limit: 30 });
    if (sErr) console.error("local_search_error", sErr.message);
    const ids = ((hits ?? []) as { product_id: string }[]).map((h) => h.product_id);
    let local: Row[] = [];
    if (ids.length) {
      const { data: prow, error: pErr } = await db
        .from("drug_products")
        .select("*, brand_families(name), product_ingredients(strength_value,strength_unit,strength_per,chemical_form, active_ingredients(inn,arabic_name))")
        .in("id", ids);
      if (pErr) console.error("products_error", pErr.message);
      const order = new Map(ids.map((id, i) => [id, i]));
      local = ((prow ?? []) as Row[]).sort((a, b) => (order.get(a.id as string) ?? 0) - (order.get(b.id as string) ?? 0));

      const off = await db.rpc("product_official_info", { p_ids: ids });
      if (off.error) console.error("official_info_error", off.error.message);
      const info = (off.error ? {} : (off.data ?? {})) as Record<string, unknown>;

      // Display tier, computed by the view product_display_tier (never stored); a failed lookup makes every row tier 3.
      const tq = await db.from("product_display_tier")
        .select("product_id,display_tier,tier_label,official_domain,pharmacy_count")
        .in("product_id", ids);
      if (tq.error) console.error("tier_error", tq.error.message);
      const tmap = new Map<string, { display_tier: number; tier_label: string; official_domain: string | null; pharmacy_count: number }>(
        (tq.data ?? []).map((t) => [t.product_id as string, t as { display_tier: number; tier_label: string; official_domain: string | null; pharmacy_count: number }]),
      );
      const tiered = local.map((p) => {
        const t = tmap.get(p.id as string);
        const tier = t?.display_tier ?? 3;
        return {
          ...p, tier, tier_label: t?.tier_label ?? "unverified",
          official: tier === 1 ? (info[p.id as string] ?? null) : null,
          official_domain: tier === 1 ? (t?.official_domain ?? null) : null,
          pharmacy_count: t?.pharmacy_count ?? 0,
          source_label: tier === 1 ? MANUFACTURER_LABEL : tier === 2 ? CONSENSUS_LABEL : null,
        } as Row;
      });
      pharmacyManufacturer = tiered.filter((p) => p.tier === 1);
      pharmacyConsensus = tiered.filter((p) => p.tier === 2);
      pharmacyUnverified = tiered.filter((p) => p.tier === 3);
    }

    // Layer 2: pharmacy-consensus products (own table, never in drug_products).
    if (safeText) {
      const cq = await db.from("pharmacy_consensus_products")
        .select("id,identity_key,product_name,normalized_name,arabic_name,manufacturer,dosage_form,pack_size,strength_summary,ingredients,pharmacy_count,sources,display_note,last_confirmed_at")
        .ilike("normalized_name", `%${normalized}%`)
        .order("pharmacy_count", { ascending: false }).limit(30);
      if (cq.error) console.error("consensus_error", cq.error.message);
      else {
        const known = new Set(local.map((p) => p.identity_key as string).filter(Boolean));
        pharmacyConsensus = [
          ...pharmacyConsensus,
          ...((cq.data ?? []) as Row[])
            .filter((c) => !known.has(c.identity_key as string))
            .map((c) => ({ ...c, tier: 2, tier_label: "pharmacy_consensus", source_label: CONSENSUS_LABEL, stored_in_main_db: false })),
        ];
      }
    }

    // Products found by the pharmacies / other sources but not approved yet (drug_pre_payloads), shown as "under review".
    // Pages of the primary source (dwaprices.com) are never listed here: they are already in the main results.
    if (safeText) {
      const ss = await db.from("search_sources").select("id").eq("search_phase", "secondary");
      if (ss.error) console.error("secondary_sources_error", ss.error.message);
      const secIds = (ss.data ?? []).map((r) => r.id as string);
      if (secIds.length) {
        const pq = await db.from("drug_pre_payloads")
          .select("id,source_url,source_id,page_products,review_id,created_at,payload")
          .eq("status", "pending").in("source_id", secIds)
          .ilike("payload->>normalized_name", `%${normalized}%`)
          .order("created_at", { ascending: false }).limit(30);
        if (pq.error) console.error("pending_error", pq.error.message);
        else {
          const rowsP = (pq.data ?? []) as Row[];
          const srcIds = [...new Set(rowsP.map((r) => r.source_id as string).filter(Boolean))];
          const srcMap = new Map<string, { source_name: string; domain: string; source_category: string }>();
          if (srcIds.length) {
            const sq = await db.from("search_sources").select("id,source_name,domain,source_category").in("id", srcIds);
            if (sq.error) console.error("pending_sources_error", sq.error.message);
            else for (const s of sq.data ?? []) srcMap.set(s.id as string, s as { source_name: string; domain: string; source_category: string });
          }
          pendingReview = rowsP.map((r) => {
            const p = (r.payload ?? {}) as Record<string, unknown>;
            const s = srcMap.get(r.source_id as string);
            const isOfficial = s?.source_category === "MANUFACTURER";
            return {
              id: r.id, source_url: r.source_url, needs_fix: !!r.review_id, created_at: r.created_at,
              product_name: str(p.product_name, 150), arabic_name: str(p.arabic_name, 150), manufacturer: str(p.manufacturer, 150),
              dosage_form: str(p.dosage_form, 60), pack_size: str(p.pack_size, 60), strength_summary: str(p.strength_summary, 300),
              status: "under_review",
              official: isOfficial
                ? { is_official: true, label: MANUFACTURER_LABEL, source_name: s!.source_name, site: s!.domain, page_url: r.source_url, product_url: r.page_products === 1 ? r.source_url : null }
                : null,
              source_label: isOfficial ? MANUFACTURER_LABEL : null,
            } as Row;
          });
        }
      }
    }
  }

  // Nothing stored under this name: it may be a typo of a name we already know (Cnor -> Concor).
  // Only a spelling hint; no product data comes from it.
  const suggestions: { text: string; kind: string; search_type: string }[] = [];
  if (!products.length && !wantSecondary) {
    const sg = await db.rpc("suggest_drug_names", { p_query: query, p_limit: 5 });
    if (sg.error) console.error("suggest_names_error", sg.error.message);
    else {
      const seen = new Set<string>([normalized]);
      for (const r of (sg.data ?? []) as { suggestion: string; kind: string }[]) {
        const t = typeof r.suggestion === "string" ? r.suggestion.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim() : "";
        if (t.length < 2 || t.length > 60 || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        suggestions.push({ text: t, kind: r.kind, search_type: r.kind === "ingredient" ? "ingredient" : r.kind === "brand_family" ? "brand_family" : "auto" });
      }
    }
  }

  const { data: cache } = await db
    .from("drug_search_cache").select("last_updated_at, expires_at")
    .eq("normalized_query", normalized).eq("search_type", searchType).maybeSingle();
  // The cache belongs to the first stage only: the pharmacies button always goes on to its own job.
  // A cache row only counts as fresh when the search has rows to show: an empty answer must never stop the job that fetches them.
  const fresh = !wantSecondary && !!cache && new Date(cache.expires_at).getTime() > Date.now() && products.length > 0;

  let job: { id: string; status: string } | null = null;
  let startedRunner = false;
  let cooldown = false;
  if (!fresh) {
    // 1) release jobs that were cut off, so they stop blocking new ones
    const reap = await db.from("search_jobs")
      .update({ status: "failed", error_message: "timed_out", completed_at: new Date().toISOString() })
      .in("status", ["queued", "running"]).lt("created_at", new Date(Date.now() - STALE_JOB_MS).toISOString());
    if (reap.error) console.error("reap_error", reap.error.message);

    // 2) reuse a job that is already in flight for this exact query (same stage)
    const active = await db.from("search_jobs").select("id,status")
      .eq("normalized_query", normalized).eq("search_type", searchType).eq("job_kind", jobKind)
      .in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (active.data) {
      job = active.data;
    } else {
      // 3) cooldown: the same query is not read again within the refresh window when its last job reached the pages.
      // A job that did not reach them is retried after 10 minutes, a failed one after 2. A job that finished BEFORE the
      // source registry last changed is not a valid anchor (enabling a source must let the same query run again).
      const regRes = await db.from("search_sources").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle();
      const regChangedMs = regRes.data?.updated_at ? new Date(regRes.data.updated_at).getTime() : 0;
      const sinceMs = Math.max(Date.now() - COOLDOWN_AFTER_COMPLETED_MS, regChangedMs);
      const recent = await db.from("search_jobs").select("id,status,completed_at,stats")
        .eq("normalized_query", normalized).eq("search_type", searchType).eq("job_kind", jobKind)
        .in("status", ["completed", "failed"])
        .gte("completed_at", new Date(sinceMs).toISOString())
        .order("completed_at", { ascending: false }).limit(1).maybeSingle();
      const r = recent.data;
      const age = r?.completed_at ? Date.now() - new Date(r.completed_at).getTime() : Infinity;
      const code = String((r?.stats as { outcome_code?: unknown } | null)?.outcome_code ?? "");
      const reached = r?.status === "completed" && !NOT_REACHED_CODES.includes(code);
      const limit = reached ? COOLDOWN_AFTER_COMPLETED_MS : (r?.status === "completed" ? COOLDOWN_AFTER_NOT_REACHED_MS : COOLDOWN_AFTER_FAILED_MS);
      if (r && age < limit) {
        job = { id: r.id, status: r.status };
        cooldown = true;
      } else {
        const ins = await db.from("search_jobs")
          .insert({ query, normalized_query: normalized, search_type: searchType, job_kind: jobKind, status: "queued", created_by: userId })
          .select("id,status").single();
        if (ins.error) {
          if (ins.error.code === "23505") {
            const ex = await db.from("search_jobs").select("id,status")
              .eq("normalized_query", normalized).eq("search_type", searchType).eq("job_kind", jobKind)
              .in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
            job = ex.data ?? null;
          } else {
            console.error("job_insert_error", ins.error.message);
          }
        } else {
          job = ins.data;
          // run the refresh in the background so the stored answer returns immediately
          const runner = fetch(`${supaUrl}/functions/v1/drug-refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${svcKey}` },
            body: JSON.stringify({ job_id: job.id }),
            signal: AbortSignal.timeout(120000),
          }).then(async (r2) => { if (!r2.ok) console.error("refresh_runner_http", r2.status); await r2.body?.cancel(); })
            .catch((e) => console.error("refresh_runner_error", e instanceof Error ? e.name : "error"));
          // deno-lint-ignore no-explicit-any
          const rt = (globalThis as any).EdgeRuntime;
          if (rt?.waitUntil) { rt.waitUntil(runner); startedRunner = true; }
        }
      }
    }
  }

  // Second stage (pharmacies / databases): the button under the first-stage result. `available` only says that such sources
  // exist; `status` is the state of the latest second-stage job for this exact query. A failed lookup only hides the button.
  let secondaryAvailable = false;
  let secondaryJob: { id: string; status: string } | null = null;
  if (wantSecondary) {
    secondaryJob = job;
    secondaryAvailable = true;
  } else {
    const sc = await db.from("search_sources").select("id", { count: "exact", head: true })
      .eq("enabled", true).eq("access_policy", "permitted").eq("extraction_method", "firecrawl")
      .eq("search_phase", "secondary").neq("health_status", "down");
    if (sc.error) console.error("secondary_count_error", sc.error.message);
    else secondaryAvailable = (sc.count ?? 0) > 0;
    if (secondaryAvailable) {
      const sj = await db.from("search_jobs").select("id,status")
        .eq("normalized_query", normalized).eq("search_type", searchType).eq("job_kind", "secondary")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (sj.error) console.error("secondary_job_error", sj.error.message);
      else secondaryJob = sj.data ?? null;
    }
  }

  // No stored rows yet but the job that fetches them is still running: the front end should wait and retry, not show "not found".
  const searching = !wantSecondary && !products.length && !!job && (job.status === "queued" || job.status === "running");

  // Single search log: one row per search; the pharmacies button and the front end's retries are continuations of a search already logged.
  const cacheStatus = fresh ? "fresh" : (products.length ? "stale" : "miss");
  if (!wantSecondary && !isRetry) {
    const { error: hErr } = await db.from("search_history").insert({
      user_id: userId, query, normalized_query: normalized, search_type: searchType,
      outcome: products.length ? "found" : "not_found",
      results_count: products.length, pending_count: 0, suggestions_count: suggestions.length,
      cache_status: cacheStatus, job_id: job?.id ?? null,
    });
    if (hErr) console.error("history_error", hErr.message);
  }

  // Same response keys as before so the front end keeps working.
  //   results / tiers.official = dwaprices.com products (the only thing shown on the first search)
  //   pharmacies               = filled only on a "secondary" request (after the button is pressed); `shown` says so
  //   tiers.pharmacy_consensus / tiers.unverified / pending_review = the same groups, empty until the button is pressed
  // New keys: searching / retry_after_seconds (wait and send the same request again with retry: true), search_type_fallback,
  // and per product match_kind / is_approximate.
  // Photo check keys (per product): image_reliable (false = a check found the photo is not this product's), image_check
  // { status, checked_at, can_report, next_report_at } for the button "this is not the product's photo" (function drug-image-report,
  // body { dwaprices_id }); image.hidden_reason = "mismatch" when the photo is hidden (only while image_policy.enforce_vision is true).
  // Photo import keys (per product): image_import { status, can_import, next_import_at, source_domain } for the button "search for the photo"
  // (function drug-image-import, body { dwaprices_id }); image.imported = true when the shown photo is an imported one.
  const pharmacies = wantSecondary
    ? {
        shown: true, label: PHARMACIES_LABEL,
        manufacturer: pharmacyManufacturer, consensus: pharmacyConsensus, unverified: pharmacyUnverified, pending_review: pendingReview,
        total: pharmacyManufacturer.length + pharmacyConsensus.length + pharmacyUnverified.length + pendingReview.length,
      }
    : { shown: false, label: PHARMACIES_LABEL, manufacturer: [], consensus: [], unverified: [], pending_review: [], total: 0 };

  return json({
    query, normalized_query: normalized, search_type: searchType,
    search_type_fallback: fallbackFrom ? { from: fallbackFrom, to: "auto" } : null,
    search_phase: wantSecondary ? "secondary" : "primary",
    source: { name: SOURCE_NAME, site: SOURCE_SITE, url: SOURCE_URL, label: OFFICIAL_LABEL },
    disclaimer: DISCLAIMER,
    cache_status: cacheStatus,
    cache_updated_at: cache?.last_updated_at ?? null,
    results: products,
    tiers: { official: products, pharmacy_consensus: pharmacyConsensus, unverified: pharmacyUnverified },
    pharmacies,
    pending_review: pendingReview,
    suggestions,
    job_id: job?.id ?? null,
    refresh_status: fresh ? "not_needed" : (job?.status ?? "unavailable"),
    refresh_started: startedRunner,
    refresh_reused_recent_job: cooldown,
    searching,
    retry_after_seconds: searching ? RETRY_AFTER_SECONDS : null,
    secondary: {
      available: secondaryAvailable,
      status: secondaryJob?.status ?? null,
      job_id: secondaryJob?.id ?? null,
    },
  });
});
