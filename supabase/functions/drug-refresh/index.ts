import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { tavilySearch, ProviderExhausted } from "./tavily.ts";
import { firecrawlScrapeJson, firecrawlScrapeMarkdown, FirecrawlUnavailable, type ScrapeResult } from "./firecrawl.ts";
import { PRODUCT_SCHEMA, buildPrompt, validateProducts, norm, splitName } from "./extract.ts";
import { persistProducts, identityTtlMs, type Src } from "./persist.ts";
import { type Code, type Found, dwaProductPages, exactMentioned, fallbackQueries, hostMatches, hostOf, noScrapeCode, pageKind, planPages, relevance, strengthsOf, NON_PRODUCT, pathRaw } from "./select.ts";
import { suggestNames } from "./fuzzy.ts";
import { soundAlikeNames } from "./translit.ts";
import { cleanComboStrengths, dwapricesIdOf, isDwapricesDomain, parseDwapricesMarkdown, type DwaParsed } from "./dwaprices.ts";
import { bindJob } from "./usage.ts";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const MAX_PAGES = 20;         // Firecrawl pages per job (cost cap)
const CONCURRENCY = 5;        // pages scraped at the same time (keeps provider rate limits and the time budget under control)
const BUDGET_MS = 100_000;    // stop starting new scrapes after this; the caller gives up at 120s
const MAX_EDITORIAL = 8;      // article references stored per query
const MAX_REJECTED_SAMPLES = 20; // rejected product names kept in job stats for debugging
const SKIP_RECENT_MS = 30 * 864e5; // a dwaprices.com page read within this window is not read again (saves Firecrawl credits)

// Page ledger: every candidate page of a job ends with exactly one status in stats.ledger, so a product that is missing
// from the site can be traced to a reason. Statuses:
//   saved / pending_review / saved+pending_review / official_locked   the page was read and its product went on
//   rejected          the page was read but no product passed validation (names kept in `names`)
//   skipped_recent    a dwaprices.com page read within the last 30 days (its product is already stored)
//   cut_by_page_cap   related page left out because of MAX_PAGES
//   not_related / article_or_listing / listing_page / off_source   never read, with the reason as the status
//   failed / skipped_deadline / provider_unavailable / not_finished   chosen for reading but NOT completed (counted in ledger_open)
type LedgerEntry = { st: string; names?: string[]; why?: string; saved?: number; staged?: number; locked?: number };
const OPEN_STATES = new Set(["failed", "skipped_deadline", "provider_unavailable", "not_finished"]);
const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 120);

const INTENTS: Record<string, string[]> = {
  ingredient: ["INGREDIENT"], brand: ["BRAND"], brand_family: ["BRAND"], auto: ["BRAND", "INGREDIENT"],
};

type Phase = "primary" | "secondary";

// Only sources that the registry marks enabled AND permitted AND extractable with Firecrawl.
// 'unverified', 'manual_only', 'restricted' and 'prohibited' sources are never scraped.
// Two-stage search: a 'full' job (the first search) reads only sources whose search_phase is 'primary';
// a 'secondary' job (the button) reads only the 'secondary' ones. Any other job kind keeps the old behaviour (no phase filter).
async function eligibleSources(db: SupabaseClient, searchType: string, phase: Phase | null): Promise<Src[]> {
  const out = new Map<string, Src>();
  for (const intent of INTENTS[searchType] ?? INTENTS.auto) {
    const { data, error } = await db.rpc("get_sources_for_intent", { p_intent: intent });
    if (error) throw new Error("routes_error: " + error.message);
    for (const s of data ?? []) {
      if (s.access_policy !== "permitted" || s.extraction_method !== "firecrawl" || out.has(s.source_id)) continue;
      out.set(s.source_id, {
        source_id: s.source_id, source_name: s.source_name, domain: s.domain, source_category: s.source_category,
        extraction_method: s.extraction_method, access_policy: s.access_policy,
        reliability_score: s.reliability_score == null ? null : Number(s.reliability_score),
      });
    }
  }
  let list = [...out.values()];
  if (phase && list.length) {
    const ph = await db.from("search_sources").select("id,search_phase").in("id", list.map((s) => s.source_id));
    if (ph.error) throw new Error("phase_error: " + ph.error.message);
    const phaseOf = new Map((ph.data ?? []).map((r) => [r.id as string, r.search_phase as string]));
    // a source with no phase value is treated as secondary, the same as the column default
    list = list.filter((s) => (phaseOf.get(s.source_id) ?? "secondary") === phase);
  }
  return list;
}

// dwaprices.com writes the pack size inside the trade name with a coating/form word in between ("Exforge 14 f.c. tab",
// "Zarlodip 10 f.c. tabs", "Galvus met 30 f.c.tabs", "Zymonoska 20 enteric coated tablets"). The generic name cleaner only removes a size
// that sits right next to its unit ("14 tab"), so the number stayed in the name and the product was rejected (names never
// contain digits). Dropping the in-between word lets the normal cleaner move the size to pack_size. The space between the
// coating word and the form word is optional ("f.c.tabs" is written without one).
const DWA_COAT = /(\d+(?:[.,]\d+)?)\s+(?:(?:f\.?\s?c\.?|s\.?\s?r\.?|e\.?\s?r\.?|film[- ]?coated|enteric[- ]?coated|coated|chewable|chew|effervescent|eff\.?|dispersible|orodispersible|scored)\s*)+(tabs?|tablets?|caps?|capsules?)(?![a-z])/gi;
// "Epinephrine 5 / amp": a slash between the count and its unit. The slash is dropped so the count is read as a pack size.
const DWA_SLASH = /(\d+(?:[.,]\d+)?)\s*\/\s*(amps?|ampoules?|vials?|tabs?|tablets?|caps?|capsules?|supps?|suppositor(?:y|ies)|sachets?)(?![a-z])/gi;
// "Paralex 125 mg 5 rectal pediatric supp": descriptive words between the count and the form. The words stay in the name
// (they tell products apart) and only move in front of the count, so the count sits next to its unit like "5 supp".
const DWA_DESC = /(\d+(?:[.,]\d+)?)\s+((?:(?:rectal|vaginal|pediatric|paediatric|infant|adults?|children)\s+)+)(supps?|suppositor(?:y|ies))(?![a-z])/gi;
const dwaName = (s: string) =>
  s.replace(DWA_SLASH, "$1 $2").replace(DWA_DESC, (_m, n: string, w: string, u: string) => `${w.trim()} ${n} ${u}`).replace(DWA_COAT, "$1 $2");

// Injectable pens / cartridges / syringes ("Saxenda 1 prefilled pen s.c", "Victoza 2 pre-filled pen s.c"): "pen" is not a unit the
// generic cleaner knows, so the count stayed in the name and the product was rejected. The count moves to pack_size and the
// pen / route words are dropped from the trade name. A name that states a pen / cartridge / syringe is an
// injectable, so the dosage form is filled with "Injection" when the page's own name gave no form.
const DWA_PEN = /(\d+(?:[.,]\d+)?)\s*(?:pre[- ]?filled\s+)?(pens?|cartridges?|syringes?|flexpens?|pfs)(?![a-z])/i;
const DWA_PEN_WORDS = /(?<![a-z])(?:pre[- ]?filled\s+)?(?:pens?|cartridges?|syringes?|flexpens?)(?![a-z])/gi;
const DWA_SOL = /(?<![a-z])sol(?:ution)?\.?\s+for\s+inj(?:ection)?\.?/gi;
const DWA_ROUTE = /(?<![a-z])(?:s\.c|i\.v|i\.m)\.?(?![a-z])/gi;

function dwaCleanInjectable(name: string): { name: string; pack: string | null; injectable: boolean } {
  let pack: string | null = null;
  const pm = DWA_PEN.exec(name);
  if (pm) {
    const n = pm[1].replace(",", ".");
    const unit = pm[2].toLowerCase().replace(/s$/, "");
    pack = unit === "pf" ? `${n} pfs` : `${n} ${unit}${Number(n) === 1 ? "" : "s"}`;
  }
  const injectable = !!pm || new RegExp(DWA_PEN_WORDS.source, "i").test(name) || new RegExp(DWA_SOL.source, "i").test(name);
  const cleaned = name.replace(DWA_PEN, " ").replace(DWA_PEN_WORDS, " ").replace(DWA_SOL, " ").replace(DWA_ROUTE, " ").replace(/\s+/g, " ").trim();
  return { name: cleaned, pack, injectable };
}

// dwaprices.com pages are read by a deterministic reader (dwaprices.ts), not by the generic AI extraction.
// The reader's output is shaped like the generic extraction so the same validation / staging path is used afterwards.
function dwaPipelineJson(d: DwaParsed) {
  const arabic = d.arabic_name ? splitName(cleanComboStrengths(d.arabic_name)).name : "";
  const inj = dwaCleanInjectable(cleanComboStrengths(dwaName(d.trade_name)));
  // The pen / cartridge count tells the pack variants apart (1 pen vs 3 pens share the same "3 mL" size), so it wins.
  const pack = inj.pack ?? d.size;
  const form = d.dosage_form ?? (inj.injectable ? "Injection" : null);
  return {
    products: [{
      product_name: inj.name || cleanComboStrengths(dwaName(d.trade_name)),
      ...(arabic.length >= 2 ? { arabic_name: arabic } : {}),
      ...(d.manufacturer ? { manufacturer: d.manufacturer } : {}),
      ...(form ? { dosage_form: form } : {}),
      ...(pack ? { pack_size: pack } : {}),
      ingredients: d.ingredients.map((i) => ({
        name: i.name, inn_en: i.name,
        ...(i.strength_value != null ? { strength_value: i.strength_value, strength_unit: i.strength_unit, ...(i.strength_per ? { strength_per: i.strength_per } : {}) } : {}),
      })),
    }],
  };
}

// Row for dwaprices_products (price, barcode, units, import notes) through the existing import_dwaprices_product function.
function dwaPayload(d: DwaParsed) {
  const notes = [...d.notes];
  let sci = d.scientific_name;
  if (sci && sci.length > 500) { notes.push("scientific_name_too_long:left null"); sci = null; }
  return {
    dwaprices_id: d.dwaprices_id, source_url: `https://dwaprices.com/med.php?id=${d.dwaprices_id}`,
    trade_name: d.trade_name, scientific_name: sci, classification: d.classification,
    manufacturer: d.manufacturer, dosage_form: d.dosage_form, current_price: d.current_price, old_price: d.old_price,
    price_updated_on: d.price_updated_on, major_unit_qty: d.major_unit_qty, minor_unit_qty: d.minor_unit_qty,
    barcode: d.barcode, image_url: d.image_url, import_notes: notes,
  };
}

// Links of the "alternatives" section of a dwaprices.com product page: every med.php?id=N between that section's
// heading and the next heading. The product's own id is never included.
function altIdsOf(md: string, srcId: number): number[] {
  const start = md.search(/^#{2,4}\s*بدائل ومثائل/m);
  if (start < 0) return [];
  const lines = md.slice(start).split(/\r?\n/);
  const out: number[] = [];
  for (let k = 1; k < lines.length; k++) {
    if (/^#{2,4}\s/.test(lines[k])) break;
    for (const m of lines[k].matchAll(/med\.php\?id=(\d{1,9})/g)) {
      const n = Number(m[1]);
      if (n !== srcId && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

// Extra match terms for a query that is already known locally: when the query is any known name of an
// ingredient (English INN, Arabic name, or a merged alias), every other name of that ingredient is returned,
// so an English-only page can still be matched by text. Nothing is invented: only stored aliases are used.
async function knownTerms(db: SupabaseClient, query: string): Promise<string[]> {
  const qn = norm(query);
  if (!qn) return [];
  const hit = await db.from("ingredient_aliases").select("ingredient_id").eq("normalized_alias", qn).maybeSingle();
  if (hit.error) { console.error("known_terms_error", hit.error.message); return []; }
  if (!hit.data) return [];
  const all = await db.from("ingredient_aliases").select("alias").eq("ingredient_id", hit.data.ingredient_id);
  if (all.error) { console.error("known_terms_error", all.error.message); return []; }
  const terms = new Set<string>();
  for (const r of all.data ?? []) { const t = norm(r.alias); if (t && t !== qn) terms.add(t); }
  return [...terms].slice(0, 10);
}

// Articles about the drug are kept as reading material in their own table. They are never extracted
// as product data and never touch drug_products / data_evidence.
async function saveEditorial(
  db: SupabaseClient, jobId: string, query: string, normalizedQuery: string, pages: Found[], eligible: Src[],
): Promise<number> {
  const rows = pages.slice(0, MAX_EDITORIAL).map((p) => ({
    normalized_query: normalizedQuery, query, url: p.url, title: (p.title ?? "").slice(0, 300) || null,
    page_kind: pageKind(p.url), relevance: p.score ?? null, job_id: jobId,
    source_id: eligible.find((s) => hostMatches(hostOf(p.url), s.domain))?.source_id ?? null,
  }));
  if (!rows.length) return 0;
  const { error } = await db.from("editorial_references").upsert(rows, { onConflict: "normalized_query,url" });
  if (error) { console.error("editorial_error", error.message); return 0; }
  return rows.length;
}

// Names already stored locally (ingredient aliases + products), used only to suggest a corrected spelling.
async function localNames(db: SupabaseClient): Promise<string[]> {
  const out: string[] = [];
  const a = await db.from("ingredient_aliases").select("alias").limit(2000);
  if (a.error) console.error("local_names_ingredients_error", a.error.message);
  for (const r of a.data ?? []) if (typeof r.alias === "string" && r.alias) out.push(r.alias);
  const p = await db.from("drug_products").select("product_name,arabic_name").limit(2000);
  if (p.error) console.error("local_names_products_error", p.error.message);
  for (const r of p.data ?? []) for (const n of [r.product_name, r.arabic_name]) if (typeof n === "string" && n) out.push(n);
  return out;
}

// Official-source lock: a product that already has evidence from a MANUFACTURER (official) source is described by that
// source only. Pharmacy / database pages never add or change its data (they stay the source for price and availability).
// Returns the identity keys of the given products that are locked this way.
async function officialLocked(db: SupabaseClient, keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!keys.length) return out;
  const pr = await db.from("drug_products").select("id,identity_key").in("identity_key", keys);
  if (pr.error) throw new Error("locked_products: " + pr.error.message);
  const byId = new Map((pr.data ?? []).map((r) => [r.id as string, r.identity_key as string]));
  if (!byId.size) return out;
  const ev = await db.from("data_evidence").select("product_id,source_id").in("product_id", [...byId.keys()]);
  if (ev.error) throw new Error("locked_evidence: " + ev.error.message);
  const sids = [...new Set((ev.data ?? []).map((r) => r.source_id as string | null).filter((x): x is string => !!x))];
  if (!sids.length) return out;
  const ss = await db.from("search_sources").select("id").in("id", sids).eq("source_category", "MANUFACTURER");
  if (ss.error) throw new Error("locked_sources: " + ss.error.message);
  const official = new Set((ss.data ?? []).map((r) => r.id as string));
  for (const r of ev.data ?? []) {
    if (r.source_id && official.has(r.source_id as string)) {
      const k = byId.get(r.product_id as string);
      if (k) out.add(k);
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // internal-only: callers must present the service role key
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token !== svc) return json({ error: "forbidden" }, 403);

  let jobId: string | undefined;
  try { jobId = (await req.json()).job_id; } catch { /* handled below */ }
  if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: "invalid_job_id" }, 400);

  const db = createClient(url, svc, { auth: { persistSession: false } });
  bindJob(db, jobId as string); // provider calls made through this client are logged against this job (key_usage_log)

  // atomic claim: only one runner can move queued -> running
  const { data: claimed, error: cErr } = await db.from("search_jobs")
    .update({ status: "running", started_at: new Date().toISOString(), progress: 5 })
    .eq("id", jobId).eq("status", "queued").select("*").maybeSingle();
  if (cErr) { console.error("claim_error", cErr.message); return json({ error: "internal_error" }, 500); }
  if (!claimed) return json({ error: "job_not_queued" }, 409);

  await db.from("search_jobs").update({ attempts: (claimed.attempts ?? 0) + 1 }).eq("id", jobId);

  const finish = async (patch: Record<string, unknown>) => {
    const { error } = await db.from("search_jobs").update({ completed_at: new Date().toISOString(), ...patch }).eq("id", jobId!);
    if (error) console.error("job_finish_error", error.message);
  };

  try {
    const q = claimed.query as string;
    const searchType = claimed.search_type as string;
    const jobKind = String(claimed.job_kind ?? "full");
    const phase: Phase | null = jobKind === "secondary" ? "secondary" : jobKind === "full" ? "primary" : null;
    // "alternatives" job: reads only dwaprices.com (the alternatives list of one product page), no web search
    const isAlt = jobKind === "alternatives";
    const eligibleAll = await eligibleSources(db, searchType, phase);
    const eligible = isAlt ? eligibleAll.filter((s) => isDwapricesDomain(s.domain)) : eligibleAll;
    const domains = eligible.map((s) => s.domain);

    // The NAME part of the query (strength / pack size removed: "Eliquis 5mg" -> "eliquis"). Pages write the strength
    // in many ways ("5 MG", "5mg", "5 مجم"), so matching is done on the name; the strength only orders the pages.
    const baseName = norm(splitName(q).name);
    const matchName = baseName.length >= 2 ? baseName : norm(q);
    const strengths = strengthsOf(q);

    const queries = eligible.length ? [q, `${q} دواء مصر`] : [`${q} دواء سعر مصر`, `${q} Egypt pharmacy price registration`];
    const found = new Map<string, Found>();
    const keySlotsUsed = new Set<string>();

    // Page ledger (see LedgerEntry): one final status per candidate page, written to stats.ledger at the end of the job.
    const ledger = new Map<string, LedgerEntry>();
    const mark = (u: string, e: LedgerEntry) => { ledger.set(u, e); };
    const ledgerStats = () => {
      const counts: Record<string, number> = {};
      let open = 0;
      const obj: Record<string, LedgerEntry> = {};
      for (const [u, v] of ledger) {
        counts[v.st] = (counts[v.st] ?? 0) + 1;
        if (OPEN_STATES.has(v.st)) open++;
        obj[shortUrl(u)] = v;
      }
      return { ledger_total: ledger.size, ledger_open: open, ledger_counts: counts, ledger: obj };
    };

    let altStats: Record<string, unknown> = {};
    if (isAlt) {
      if (eligible.length) {
        const srcId = Number((claimed.stats as { alt_source_id?: unknown } | null)?.alt_source_id);
        if (!Number.isInteger(srcId) || srcId <= 0) throw new Error("alt_source_id_missing");
        const m = await firecrawlScrapeMarkdown(db, `https://dwaprices.com/med.php?id=${srcId}`);
        if (!m.ok) {
          await finish({ status: "failed", error_message: "alt_source_page_failed", stats: { stage: "alt_source_page_failed", reason: m.reason } });
          return json({ job_id: jobId, status: "failed", error: "alt_source_page_failed" }, 502);
        }
        const all = altIdsOf(m.markdown, srcId);
        // products already stored are not read again (saves Firecrawl credits); the ones that do not match the strict rules
        // simply stay in the table without being shown as alternatives
        let haveRows: { dwaprices_id: number }[] = [];
        if (all.length) {
          const have = await db.from("dwaprices_products").select("dwaprices_id").in("dwaprices_id", all);
          if (have.error) throw new Error("alt_known_select: " + have.error.message);
          haveRows = (have.data ?? []) as { dwaprices_id: number }[];
        }
        const haveSet = new Set(haveRows.map((r) => r.dwaprices_id));
        const fresh = all.filter((n) => !haveSet.has(n)).slice(0, MAX_PAGES);
        for (const n of fresh) {
          const u = `https://dwaprices.com/med.php?id=${n}`;
          found.set(u, { url: u, title: "", score: 1 });
        }
        altStats = { alt_candidates: all.length, alt_already_registered: haveSet.size, alt_to_read: fresh.length };
        if (!fresh.length) {
          await finish({
            status: "completed", progress: 100,
            stats: { stage: "extracted_no_match", outcome_code: "no_products_found", eligible_sources: eligible.map((s) => s.source_name), ...altStats },
          });
          return json({ job_id: jobId, status: "completed", stage: "extracted_no_match", ...altStats });
        }
      }
      await db.from("search_jobs").update({ progress: 40 }).eq("id", jobId);
    } else {
      for (let i = 0; i < queries.length; i++) {
        const r = await tavilySearch(db, queries[i], eligible.length ? { includeDomains: domains } : undefined);
        keySlotsUsed.add(r.slot);
        for (const x of r.results) if (!found.has(x.url)) found.set(x.url, x);
        await db.from("search_jobs").update({ progress: 10 + Math.round(((i + 1) / queries.length) * 30) }).eq("id", jobId);
      }
    }

    const mkBase = () => ({
      urls_found: found.size, urls: [...found.values()].slice(0, 20),
      key_slots_used: [...keySlotsUsed], eligible_sources: eligible.map((s) => s.source_name),
      search_phase: phase,
    });

    if (!eligible.length) {
      await finish({ status: "completed", progress: 50, stats: { ...mkBase(), stage: "discovery_only", skipped_reason: "no_enabled_sources", outcome_code: "no_enabled_sources" satisfies Code } });
      return json({ job_id: jobId, status: "completed", stage: "discovery_only", skipped_reason: "no_enabled_sources" });
    }

    const extra = await knownTerms(db, matchName);
    const terms = [...new Set([matchName, norm(q), ...extra])].filter((t) => t.length >= 2);

    // 1) pick only product pages that are related to the query (title/URL text, a close misspelling, or a high search score).
    //    dwaprices.com hits such as aorder.php?id=N / similars.php?id=N are turned into that product's page (med.php?id=N);
    //    those pages are read even when their (Arabic) title cannot be matched by text, because the decision is taken
    //    on the page itself: its own English trade name must contain the searched name (validateProducts).
    let plan = planPages(dwaProductPages(found.values()), domains, terms, MAX_PAGES, strengths);

    // 2) nothing usable: one more discovery round with product-oriented queries (limited to 2 extra searches)
    let fallbackUsed = false;
    if (!plan.picks.length) {
      fallbackUsed = true;
      for (const fq of fallbackQueries(q, extra)) {
        try {
          const r = await tavilySearch(db, fq, { includeDomains: domains });
          keySlotsUsed.add(r.slot);
          for (const x of r.results) if (!found.has(x.url)) found.set(x.url, x);
        } catch (e) {
          if (e instanceof ProviderExhausted) break; // keep what the first round found
          throw e;
        }
      }
      plan = planPages(dwaProductPages(found.values()), domains, terms, MAX_PAGES, strengths);
    }

    // 3) still nothing: the store may spell the name in Arabic (Valtrex -> فالتريكس). One open-web search (never scraped)
    //    is used only to read titles; an Arabic word is accepted as the same name ONLY when it sounds like the query
    //    (consonant skeleton within one edit). Accepted names are used for discovery and matching, nothing else.
    //    Open-web pages outside the enabled sources are only reported in the job stats, never scraped.
    let discoveredNames: string[] = [];
    let offRegistry: Found[] = [];
    if (!plan.picks.length) {
      const open: Found[] = [];
      try {
        const r = await tavilySearch(db, `${q} دواء مصر سعر`);
        keySlotsUsed.add(r.slot);
        open.push(...r.results);
      } catch (e) {
        if (!(e instanceof ProviderExhausted)) throw e;
      }
      offRegistry = open
        .filter((x) => !domains.some((d) => hostMatches(hostOf(x.url), d)) && relevance(x, terms) >= 3)
        .slice(0, 5);
      discoveredNames = soundAlikeNames(matchName, [...found.values(), ...open].map((x) => x.title ?? ""));
      if (discoveredNames.length) {
        for (const nm of discoveredNames) {
          try {
            const r = await tavilySearch(db, `${nm} nowProduct`, { includeDomains: domains });
            keySlotsUsed.add(r.slot);
            for (const x of r.results) if (!found.has(x.url)) found.set(x.url, x);
          } catch (e) {
            if (e instanceof ProviderExhausted) break;
            throw e;
          }
        }
        for (const nm of discoveredNames) {
          extra.push(nm);
          const t = norm(nm);
          if (t.length >= 2 && !terms.includes(t)) terms.push(t);
        }
        plan = planPages(dwaProductPages(found.values()), domains, terms, MAX_PAGES, strengths);
      }
    }

    // Ledger, part 1: candidate pages that were never picked for reading, each with the reason.
    {
      const pickedNow = new Set(plan.picks.map((p) => p.url));
      for (const p of dwaProductPages(found.values())) {
        if (pickedNow.has(p.url)) continue;
        const host = hostOf(p.url);
        if (!domains.some((d) => hostMatches(host, d))) mark(p.url, { st: "off_source" });
        else if (isDwapricesDomain(host) && dwapricesIdOf(p.url) == null) mark(p.url, { st: "listing_page" });
        else if (NON_PRODUCT.test(pathRaw(p.url))) mark(p.url, { st: "article_or_listing" });
        else if (relevance(p, terms) > 0 || p.viaId) mark(p.url, { st: "cut_by_page_cap" });
        else mark(p.url, { st: "not_related" });
      }
    }

    // 5) related articles are stored as reading material only
    const editorialSaved = await saveEditorial(db, jobId, q, claimed.normalized_query as string, plan.relevantArticles, eligible);

    const titles = [...found.values()].map((p) => p.title);
    const nameLooksRight = exactMentioned(found.values(), terms);
    const common = {
      fallback_used: fallbackUsed, non_product_pages_skipped: plan.editorial.length,
      irrelevant_product_pages_skipped: plan.irrelevantProductPages, editorial_saved: editorialSaved,
      discovered_names: discoveredNames,
      match_name: matchName, strengths_in_query: strengths,
      pages_from_dwaprices_ids: plan.picks.filter((p) => p.viaId).length,
      off_registry_hits: offRegistry.map((x) => ({ url: x.url.slice(0, 200), title: (x.title ?? "").slice(0, 120) })),
    };

    if (!plan.picks.length) {
      // 4) suggestions only (never written to the database)
      const didYouMean = nameLooksRight ? [] : suggestNames(matchName, [...titles, ...(await localNames(db))]);
      const code = noScrapeCode(plan, didYouMean);
      const legacy = plan.onSource.length ? "only_non_product_pages" : "no_pages_on_enabled_sources";
      await finish({
        status: "completed", progress: 50,
        stats: { ...mkBase(), ...common, stage: "discovery_only", skipped_reason: legacy, outcome_code: code, did_you_mean: didYouMean, ...ledgerStats() },
      });
      return json({ job_id: jobId, status: "completed", stage: "discovery_only", skipped_reason: legacy, outcome_code: code });
    }

    await db.from("search_jobs").update({ progress: 50 }).eq("id", jobId);

    // dwaprices.com pages that were read within the last SKIP_RECENT_MS are not read again: the name, composition and
    // manufacturer rarely change, and import_dwaprices_product sets extracted_at on every read, so extracted_at is the
    // age of the stored row. The only field that changes is the price, which can be up to 30 days old (the page shows
    // its age). Pages of other sources have no dwaprices id and are never skipped.
    let skippedKnown = 0;
    const pickIds = plan.picks.map((p) => dwapricesIdOf(p.url)).filter((n): n is number => n != null);
    if (pickIds.length) {
      const rec = await db.from("dwaprices_products").select("dwaprices_id")
        .in("dwaprices_id", pickIds).gte("extracted_at", new Date(Date.now() - SKIP_RECENT_MS).toISOString());
      if (rec.error) throw new Error("recent_select: " + rec.error.message);
      const recent = new Set((rec.data ?? []).map((r) => r.dwaprices_id as number));
      const beforePicks = plan.picks;
      const before = beforePicks.length;
      plan = { ...plan, picks: plan.picks.filter((p) => { const n = dwapricesIdOf(p.url); return n == null || !recent.has(n); }) };
      skippedKnown = before - plan.picks.length;
      for (const p of beforePicks) if (!plan.picks.includes(p)) mark(p.url, { st: "skipped_recent", why: "read_within_30d" });
    }

    // Normal search only (job kind "full"): a page that Firecrawl already read successfully in the last 30 days is not read again,
    // whatever came out of it. A page that gave no product (rejected) leaves no row in dwaprices_products, so the check above
    // never saw it and it was read again on every search. Source: key_usage_log, one row per successful Firecrawl call with the
    // page in meta.url. A failed lookup only means that nothing extra is skipped. The 30 day price window above is unchanged.
    if (jobKind === "full" && plan.picks.length) {
      const fcUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 160);
      const seen = await db.from("key_usage_log").select("meta")
        .eq("provider", "firecrawl").eq("status", 200)
        .gte("created_at", new Date(Date.now() - SKIP_RECENT_MS).toISOString())
        .in("meta->>url", plan.picks.map((p) => fcUrl(p.url)));
      if (seen.error) console.error("recent_reads_error", seen.error.message);
      else {
        const readBefore = new Set((seen.data ?? []).map((r) => String((r.meta as { url?: unknown } | null)?.url ?? "")));
        const dropped = plan.picks.filter((p) => readBefore.has(fcUrl(p.url)));
        if (dropped.length) {
          plan = { ...plan, picks: plan.picks.filter((p) => !readBefore.has(fcUrl(p.url))) };
          skippedKnown += dropped.length;
          for (const p of dropped) mark(p.url, { st: "skipped_recent", why: "read_by_firecrawl_within_30d" });
        }
      }
    }

    const deadline = Date.now() + BUDGET_MS;
    const prompt = buildPrompt(q);
    const ids = new Set<string>();
    const fcSlots = new Set<string>();
    let pagesScraped = 0, pagesFailed = 0, productsRaw = 0, productsFound = 0, unavailable = false;
    let staged = 0; // NEW products held in drug_pre for human review (not yet in drug_products)
    let officialSkipped = 0; // approved products locked to their official source: pharmacy data not written
    let remapped = 0; // incoming products whose identity key was replaced by the key of an already-approved product
    let dwaCustom = 0, dwaFallback = 0, dwaImported = 0; // dwaprices.com: pages read by the custom reader / pages that needed the generic fallback / rows written to dwaprices_products
    let cosmeticPages = 0; // dwaprices.com pages classified as cosmetic: the drug-only name / completeness rules are relaxed for them
    const failures: string[] = [];
    const scraped: string[] = [];
    const rawNames: string[] = [];
    // products the page listed but validation dropped: kept (name + page) so a rejection can be explained afterwards
    const rejectedSamples: { url: string; name: string }[] = [];

    const handlePage = async (p: Found) => {
      if (Date.now() > deadline) { failures.push("skipped_deadline"); mark(p.url, { st: "skipped_deadline" }); return; }
      const src = eligible.find((s) => hostMatches(hostOf(p.url), s.domain))!;
      try {
        // dwaprices.com product pages: markdown -> deterministic reader. When the page cannot be parsed the generic
        // extraction is used instead, and that is counted in the job stats (dwaprices_fallbacks).
        let dwa: DwaParsed | null = null;
        let r: ScrapeResult | null = null;
        if (isDwapricesDomain(src.domain) && dwapricesIdOf(p.url) != null) {
          const m = await firecrawlScrapeMarkdown(db, p.url);
          if (m.slot) fcSlots.add(m.slot);
          if (m.ok) {
            dwa = parseDwapricesMarkdown(m.markdown, p.url);
            if (dwa) { r = { ok: true, slot: m.slot, json: dwaPipelineJson(dwa) }; dwaCustom++; }
            else { dwaFallback++; failures.push("dwaprices_parse_failed_generic_used"); }
          } else {
            r = { ok: false, slot: m.slot, reason: m.reason };
          }
        }
        if (!r) r = await firecrawlScrapeJson(db, p.url, PRODUCT_SCHEMA, prompt);
        if (r.slot) fcSlots.add(r.slot);
        if (!r.ok) { pagesFailed++; failures.push(r.reason); mark(p.url, { st: "failed", why: r.reason }); return; }
        pagesScraped++;
        scraped.push(p.url);
        const rawList = (r.json as { products?: unknown })?.products;
        productsRaw += Array.isArray(rawList) ? rawList.length : 0;
        if (Array.isArray(rawList)) {
          for (const it of rawList.slice(0, 30)) {
            const n = (it as { product_name?: unknown })?.product_name;
            if (typeof n === "string") rawNames.push(n.slice(0, 150));
          }
        }

        // Cosmetics are the one class that is exempt from the drug-only rules (no digits in the name, strengths / dosage form
        // mandatory). The class comes from the database classifier, using what the dwaprices page itself states
        // (its classification, name, form and scientific name). Every other page or class stays strict.
        let cosmetic = false;
        if (dwa) {
          const cl = await db.rpc("classify_dwaprices_product", {
            p_classification: dwa.classification, p_dosage_form: dwa.dosage_form,
            p_trade_name: dwa.trade_name, p_scientific_name: dwa.scientific_name,
          });
          if (cl.error) console.error("classify_error", cl.error.message);
          else if (cl.data === "cosmetic") { cosmetic = true; cosmeticPages++; }
        }

        // A page whose own title/URL already contains the searched name (or a close misspelling) and that lists exactly
        // one product is that product, even when the page writes its name in another script (e.g. Arabic).
        // An alternatives job reads pages chosen from the product's own alternatives list: one product per page, trusted.
        const trustSingle = isAlt || relevance(p, terms) >= 2;
        let products = validateProducts(r.json, matchName, extra, { trustSingle, allowDigits: cosmetic });

        // Known-or-new key: the same product written slightly differently by a site ("Centrum Adult" / "Centrum Adults",
        // "... Tablets") gets the identity key of the already-approved row, so it refreshes that row instead of becoming
        // a second "new" product. Matching is done by the database on canonical name + form + pack + strengths.
        if (products.length) {
          const km = await db.rpc("find_known_identity_keys", { p_items: products });
          if (km.error) throw new Error("known_keys: " + km.error.message);
          const remap = new Map<string, string>(
            (km.data ?? []).filter((row: { known_key: string | null }) => row.known_key)
              .map((row: { incoming_key: string; known_key: string }) => [row.incoming_key, row.known_key] as [string, string]),
          );
          if (remap.size) {
            // two products of one page can land on the same known key: keep the first, log the rest
            const seenKeys = new Set<string>();
            const merged: typeof products = [];
            for (const x of products) {
              if (remap.has(x.identity_key)) { x.identity_key = remap.get(x.identity_key)!; remapped++; }
              if (seenKeys.has(x.identity_key)) { console.error("remap_duplicate_dropped", x.identity_key.slice(0, 80)); continue; }
              seenKeys.add(x.identity_key);
              merged.push(x);
            }
            products = merged;
          }
        }
        productsFound += products.length;

        // The Dwaprices row (price, barcode, units, notes) is written only for a page whose product passed validation
        // (so an unrelated page never lands in dwaprices_products). A failure here never blocks the product itself.
        let dwaRowOk = false;
        if (dwa && products.length) {
          const imp = await db.rpc("import_dwaprices_product", { p: dwaPayload(dwa) });
          if (imp.error) {
            failures.push("dwaprices_import_error: " + imp.error.message.slice(0, 100));
            console.error("dwaprices_import_error", imp.error.message);
          } else { dwaImported++; dwaRowOk = true; }
        }

        const rejNames: string[] = []; // every product name of this page that validation dropped (ledger)
        if (Array.isArray(rawList)) {
          const accepted = new Set(products.map((x) => x.normalized_name));
          for (const it of rawList.slice(0, 30)) {
            const n = (it as { product_name?: unknown })?.product_name;
            // compare the cleaned name (sizes / numbers removed), the same way validateProducts stores it
            if (typeof n === "string" && !accepted.has(norm(splitName(n).name))) {
              if (rejNames.length < 8) rejNames.push(n.slice(0, 80));
              if (rejectedSamples.length < MAX_REJECTED_SAMPLES) rejectedSamples.push({ url: p.url.slice(0, 200), name: n.slice(0, 100) });
            }
          }
        }

        // Products already approved (present in drug_products) keep refreshing as before.
        // NEW products are NOT written to drug_products: they wait in drug_pre until a human approves them.
        const keys = products.map((x) => x.identity_key);
        const known = new Set<string>();
        if (keys.length) {
          const kr = await db.from("drug_products").select("identity_key").in("identity_key", keys);
          if (kr.error) throw new Error("known_select: " + kr.error.message);
          for (const row of kr.data ?? []) known.add(row.identity_key as string);
        }
        let knownProducts = products.filter((x) => known.has(x.identity_key));
        const newProducts = products.filter((x) => !known.has(x.identity_key));
        let lockedN = 0;
        let savedN = 0;
        // Official-source lock: a product described by its official (MANUFACTURER) page is never changed from a pharmacy page.
        if (knownProducts.length && src.source_category !== "MANUFACTURER") {
          const locked = await officialLocked(db, knownProducts.map((x) => x.identity_key));
          if (locked.size) {
            officialSkipped += knownProducts.filter((x) => locked.has(x.identity_key)).length;
            lockedN = knownProducts.filter((x) => locked.has(x.identity_key)).length;
            knownProducts = knownProducts.filter((x) => !locked.has(x.identity_key));
          }
        }
        if (knownProducts.length) {
          const written = await persistProducts(db, src, p.url, knownProducts, products.length === 1);
          for (const id of written) ids.add(id);
          savedN = written.length;
          if (dwa && dwaRowOk && products.length === 1 && written.length === 1) {
            const lk = await db.from("dwaprices_products").update({ product_id: written[0] }).eq("dwaprices_id", dwa.dwaprices_id);
            if (lk.error) console.error("dwaprices_link_product_error", lk.error.message);
          }
        }
        for (const np of newProducts) {
          const { data: stData, error: stErr } = await db.rpc("stage_new_product", {
            p_source_id: src.source_id, p_source_url: p.url, p_job_id: jobId,
            p_page_products: products.length, p_product: cosmetic ? { ...np, product_class: "cosmetic" } : np,
          });
          if (stErr) throw new Error("stage_error: " + stErr.message);
          staged++;
          const preId = (stData as { pre_id?: string | null } | null)?.pre_id ?? null;
          if (dwa && dwaRowOk && products.length === 1 && preId) {
            const lk = await db.from("dwaprices_products").update({ drug_pre_id: preId }).eq("dwaprices_id", dwa.dwaprices_id);
            if (lk.error) console.error("dwaprices_link_pre_error", lk.error.message);
          }
        }

        // Ledger, part 2: what happened to this page.
        const stN = newProducts.length;
        mark(p.url, {
          st: stN ? (savedN ? "saved+pending_review" : "pending_review") : savedN ? "saved" : lockedN ? "official_locked" : "rejected",
          ...(rejNames.length ? { names: rejNames } : {}),
          ...(savedN ? { saved: savedN } : {}), ...(stN ? { staged: stN } : {}), ...(lockedN ? { locked: lockedN } : {}),
        });
      } catch (e) {
        if (e instanceof FirecrawlUnavailable) { unavailable = true; mark(p.url, { st: "provider_unavailable" }); return; }
        pagesFailed++;
        const m = e instanceof Error ? e.message : String(e);
        failures.push("persist_or_parse_error: " + m.slice(0, 120));
        mark(p.url, { st: "failed", why: m.slice(0, 120) });
        console.error("page_error", m);
      }
    };

    // small worker pool: up to CONCURRENCY pages at a time; no new page starts after the deadline
    const queue = [...plan.picks];
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await handlePage(next);
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    // a chosen page without a final status was not completed
    for (const p of plan.picks) if (!ledger.has(p.url)) mark(p.url, { st: "not_finished" });

    const stats = {
      ...mkBase(), ...common, firecrawl_slots_used: [...fcSlots], pages_attempted: plan.picks.length, pages_scraped: pagesScraped, pages_scraped_urls: scraped,
      pages_skipped_known: skippedKnown,
      pages_failed: pagesFailed, products_extracted_raw: productsRaw, products_found: productsFound,
      products_rejected: productsRaw - productsFound, products_written: ids.size, products_staged: staged, official_locked_skipped: officialSkipped, products_remapped_to_known: remapped, failures: failures.slice(0, 10),
      rejected_samples: rejectedSamples,
      dwaprices_custom_reads: dwaCustom, dwaprices_fallbacks: dwaFallback, dwaprices_rows_imported: dwaImported, cosmetic_pages: cosmeticPages,
      ...altStats, ...ledgerStats(),
    };

    if (unavailable && pagesScraped === 0) {
      await finish({ status: "completed", progress: 50, stats: { ...stats, stage: "discovery_only", skipped_reason: "firecrawl_unavailable", outcome_code: "firecrawl_unavailable" satisfies Code } });
      return json({ job_id: jobId, status: "completed", stage: "discovery_only", skipped_reason: "firecrawl_unavailable" });
    }

    // The search cache belongs to the first stage: a second-stage (pharmacies) run must not overwrite its result list
    // or make the first stage look freshly refreshed. An alternatives job never writes the search cache.
    if (ids.size && phase !== "secondary" && !isAlt) {
      // only cache when something was actually stored, so an empty run never looks "fresh"
      const ttl = await identityTtlMs(db);
      const { error: cacheErr } = await db.from("drug_search_cache").upsert({
        normalized_query: claimed.normalized_query, search_type: searchType, result_ids: [...ids],
        last_updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttl).toISOString(),
      }, { onConflict: "normalized_query,search_type" });
      if (cacheErr) console.error("cache_error", cacheErr.message);
    }

    // Honest status: a run where every page failed is 'failed', not 'completed'.
    // A run where every page was skipped because it was read recently (nothing failed) is a normal completed run.
    const allFailed = pagesScraped === 0 && (pagesFailed > 0 || skippedKnown === 0);
    const nothingNew = skippedKnown > 0 && !ids.size && !staged;
    const didYouMean = !ids.size && !staged && !skippedKnown && !nameLooksRight ? suggestNames(matchName, [...titles, ...rawNames, ...(await localNames(db))]) : [];
    const code: Code = allFailed ? "extraction_failed" : (ids.size || nothingNew) ? "saved" : staged ? "pending_review" : didYouMean.length ? "name_mismatch" : "no_match_on_pages";
    const stage = allFailed ? "extraction_failed" : ((ids.size || nothingNew) ? "extracted" : (staged ? "extracted_pending_review" : "extracted_no_match"));
    await finish({
      status: allFailed ? "failed" : "completed", progress: allFailed ? 50 : 100, result_ids: [...ids],
      ...(allFailed ? { error_message: "all_pages_failed" } : {}),
      stats: { ...stats, stage, outcome_code: code, did_you_mean: didYouMean },
    });
    return json({ job_id: jobId, status: allFailed ? "failed" : "completed", stage, products_written: ids.size, products_staged: staged, outcome_code: code });
  } catch (e) {
    const exhausted = e instanceof ProviderExhausted;
    const msg = exhausted ? "provider_exhausted" : "discovery_failed";
    console.error(msg, e instanceof Error ? e.message : String(e));
    await finish({ status: "failed", error_message: msg });
    return json({ job_id: jobId, status: "failed", error: msg }, exhausted ? 503 : 502);
  }
});
