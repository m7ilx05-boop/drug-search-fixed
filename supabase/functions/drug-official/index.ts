import { kenv } from "./vault-env.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { PRODUCT_SCHEMA, validateProducts, norm, splitName } from "./extract.ts";
import { groundProducts } from "./ground.ts";

// drug-official: finds the OFFICIAL (manufacturer) site of a brand for EGYPT or the MIDDLE EAST, reads the whole product
// family from it (e.g. Centrum Women / Men / Adults ...) and stages every variant as a payload of the registered
// MANUFACTURER source.
// It runs automatically when a new product is first registered from pharmacies (trigger on drug_pre), so the brand is
// already confirmed to be a real product. It also runs again (trigger on search_history) when a search finds registered
// products that no official site has confirmed yet. It never creates rows in drug_products and is separate from drug-refresh on purpose.
// A product that is already registered and that the official page confirms (same identity key) is not staged again: the
// official source is recorded on it instead (attach_official_to_product).
// Rules:
//  - Egyptian (EG) and Middle East (MENA) sites/pages are accepted, EG first. ONLY when the brand has no EG/MENA official site,
//    the brand's OWN global official site is used as a fallback (domain really named like the brand, e.g. centrum.com,
//    limitlessnaturals.com; never look-alike domains). If there is no official site at all the brand ends as
//    'no_regional_site' and the normal multi-source flow runs with the product labelled 'no_official_source'
//  - the domain's main label must be the brand name (optionally + a region word like arabia/egypt) or the manufacturer;
//    stores, marketplaces and social pages are never accepted
//  - the domain is registered in search_sources and checked by source-vet. 'blocked' (robots/terms forbid it) is never
//    scraped. 'needs_review' (no terms page found) is accepted ONLY when the domain is named like the brand.
//  - ONLY product detail pages are read (EG/MENA pages only when the domain is regional), and from each page ONLY the main product
//    (never 'related/recommended' ones), so every payload's source_url is the real page of that product
//  - every staged payload keeps the product exactly as the page wrote it (as_written), the market of ITS page and the
//    class the page gives it (drug / supplement / cosmetic / medical_device / other)
//  - GROUNDING (ground.ts): the AI extraction is checked against the page's own text; anything the page does not literally
//    print (ingredient, strength, pack size, form, manufacturer) is dropped, never kept as a guess
//  - AI SELECTION (llm-gateway): when the name heuristics find no strong Egyptian/Middle East candidate, Gemini (Google grounding),
//    then Grok if Gemini fails, is asked to pick the official host ONLY from the Tavily results. The AI never supplies data and never
//    invents a host: a host that is not in the search results is rejected, the market is computed by this code from the URL, and the
//    picked domain still has to pass source-vet. Product data always comes from the page text via Firecrawl + grounding.
//  - every staged payload also keeps official_snippet: the line of the page text where the product name was found (evidence)

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const MAX_PAGES = 14;
const CONCURRENCY = 4;
const MAX_STAGED = 40;
const MAX_VET_CANDIDATES = 3;
const VET_WAIT_MS = 45_000;
const SCRAPE_DEADLINE_MS = 125_000;
const DAY = 864e5;
const CLASSES = ["drug", "supplement", "cosmetic", "medical_device", "other"];
const AI_MIN_CONFIDENCE = 0.7;

const TLD_WORDS = new Set(["com", "net", "org", "eg", "co", "gov", "edu", "info", "biz", "io", "app", "store", "shop", "health", "uk", "us", "ae", "sa"]);
const NOT_OFFICIAL = /(^|\.)(amazon|ebay|noon|jumia|facebook|instagram|twitter|x|youtube|tiktok|linkedin|wikipedia|pinterest|reddit|walmart|target|iherb|vitacost|drugs|webmd|healthline|goodrx|boots|cvs|walgreens|google|bing|yahoo|alibaba|aliexpress|temu|shein|olx|dubizzle|souq)\./i;
// pages that are never a single product: company, help, legal, search, store-locator, blog/news pages
const SKIP_PATH = /\/(blog|blogs|news|article|articles|tag|careers|privacy|terms|contact|cookie|cookies|legal|login|cart|checkout|about|faq|faqs|our-story|story|where-to-buy|store-locator|stores|search|sitemap|press|media)(\/|$)/;
const PRODUCT_LIKE = /\/(product|products|item|p|vitamins|supplements|range|our-products)\//;
const REGION_WORDS = /^(arabia|egypt|eg|mena|gulf|me|middleeast)$/;
// words a brand adds to its own domain (limitlessnaturals.com, centrumhealth.com); look-alikes such as centrum-air.com do not qualify
const BRAND_SUFFIX = /^(naturals?|official|health|healthcare|pharma|vitamins?|supplements?|global|usa|us|uk|group|labs?|nutrition|wellness)$/;

class Unavailable extends Error {}

const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const pathOf = (u: string) => { try { return decodeURIComponent(new URL(u).pathname.toLowerCase()); } catch { return ""; } };
const depthOf = (u: string) => pathOf(u).split("/").filter(Boolean).length;
const hostMatches = (host: string, domain: string) => { const d = domain.toLowerCase().replace(/^www\./, ""); return host === d || host.endsWith("." + d); };
const coreLabel = (host: string) => {
  const l = host.replace(/^www\./, "").split(".");
  while (l.length > 1 && TLD_WORDS.has(l[l.length - 1])) l.pop();
  return l[l.length - 1] ?? "";
};
// domain is named like the brand: centrum.com, centrum.com.eg, centrumarabia.com, centrum-egypt.com
const namedLikeBrand = (host: string, brandKey: string) => {
  const core = coreLabel(host).replace(/[^a-z0-9]/g, "");
  return core === brandKey || (core.startsWith(brandKey) && REGION_WORDS.test(core.slice(brandKey.length)));
};
// the brand's own domain: named like the brand, or the brand + a company word (limitlessnaturals.com)
const ownBrand = (host: string, brandKey: string) => {
  const core = coreLabel(host).replace(/[^a-z0-9]/g, "");
  return namedLikeBrand(host, brandKey) || (core.startsWith(brandKey) && BRAND_SUFFIX.test(core.slice(brandKey.length)));
};
// EG = Egyptian site or Egyptian page of a global site (.eg domain, eg.brand.com, /eg/ /en-eg/ /ar-eg/ /egypt/ folder, 'egypt' in the host)
// MENA = Middle East site or page (arabia/mena/gulf in the host, Gulf country domains, /mena/ /me/ /ae/ /sa/ folder).
// An Arabic language folder alone (/ar/) does NOT make a page regional. Anything else is GLOBAL.
const marketOf = (u: string): "EG" | "MENA" | "GLOBAL" => {
  const h = hostOf(u), p = pathOf(u);
  if (/\.eg$/.test(h) || /^eg\./.test(h) || /\/(eg|en-eg|ar-eg|eg-ar|eg-en|egypt)(\/|$)/.test(p) || /egypt/.test(h)) return "EG";
  if (/(arabia|mena|gulf|middleeast|\.ae$|\.sa$|\.kw$|\.qa$)/.test(h) || /\/(mena|me|ae|sa)(\/|$)/.test(p)) return "MENA";
  return "GLOBAL";
};
const marketRank = (m: string) => (m === "EG" ? 2 : m === "MENA" ? 1 : 0);

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const nextMonth = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(); };

// evidence: the line of the page text where the product name is printed
const snippetOf = (md: string, name: string): string | null => {
  const k = norm(name);
  if (!k) return null;
  for (const l of md.split("\n")) {
    const t = l.replace(/\s+/g, " ").trim();
    if (t.length >= 3 && norm(t).includes(k)) return t.slice(0, 240);
  }
  return null;
};

async function markKey(db: SupabaseClient, provider: string, slot: string, status: number, until: string, err: string) {
  const { data } = await db.from("provider_key_state").select("fail_count").eq("provider", provider).eq("slot", slot).maybeSingle();
  const { error } = await db.from("provider_key_state").upsert({
    provider, slot, exhausted_until: until, last_status: status, last_error: err,
    fail_count: (data?.fail_count ?? 0) + 1, updated_at: new Date().toISOString(),
  });
  if (error) console.error("key_state_error", error.message);
}

async function usableSlots(db: SupabaseClient, provider: "tavily" | "firecrawl"): Promise<string[]> {
  const re = provider === "tavily" ? /^tavily/i : /^firecrawl/i;
  const all = Object.keys(kenv.toObject())
    .filter((k) => re.test(k) && !/url|endpoint|host/i.test(k) && kenv.get(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!all.length) throw new Unavailable(`no ${provider} key`);
  const { data } = await db.from("provider_key_state").select("slot, exhausted_until").eq("provider", provider);
  const blocked = new Set((data ?? []).filter((s) => s.exhausted_until && new Date(s.exhausted_until).getTime() > Date.now()).map((s) => s.slot));
  const ok = all.filter((s) => !blocked.has(s));
  if (!ok.length) throw new Unavailable(`all ${provider} keys cooling down`);
  return ok;
}

type Hit = { url: string; title: string; score: number };

async function tavily(db: SupabaseClient, query: string, includeDomains?: string[]): Promise<Hit[]> {
  const payload: Record<string, unknown> = { query, search_depth: "basic", max_results: 15 };
  if (includeDomains?.length) payload.include_domains = includeDomains;
  for (const slot of await usableSlots(db, "tavily")) {
    let res: Response;
    try {
      res = await fetch("https://api.tavily.com/search", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${kenv.get(slot)}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
      });
    } catch { continue; }
    if (res.ok) {
      const b = await res.json();
      return (b.results ?? []).map((r: Hit) => ({ url: r.url, title: r.title, score: r.score }));
    }
    await res.body?.cancel();
    if (res.status === 432 || res.status === 433) await markKey(db, "tavily", slot, res.status, nextMonth(), "credits_exhausted");
    else if (res.status === 429) await markKey(db, "tavily", slot, 429, new Date(Date.now() + 60_000).toISOString(), "rate_limited");
    else if (res.status === 401 || res.status === 403) await markKey(db, "tavily", slot, res.status, new Date(Date.now() + 30 * DAY).toISOString(), "invalid_key");
  }
  throw new Unavailable("tavily failed");
}

async function scrape(db: SupabaseClient, url: string, prompt: string): Promise<{ ok: true; json: unknown; md: string } | { ok: false; reason: string }> {
  let slots: string[];
  try { slots = await usableSlots(db, "firecrawl"); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : "unavailable" }; }
  for (const slot of slots) {
    let res: Response;
    try {
      res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${kenv.get(slot)}` },
        body: JSON.stringify({ url, formats: [{ type: "json", schema: PRODUCT_SCHEMA, prompt }, "markdown"], timeout: 60000 }),
        signal: AbortSignal.timeout(75000),
      });
    } catch { return { ok: false, reason: "network" }; }
    if (res.ok) {
      const b = await res.json().catch(() => null);
      return b?.success && b?.data?.json != null ? { ok: true, json: b.data.json, md: typeof b.data.markdown === "string" ? b.data.markdown : "" } : { ok: false, reason: "no_json_in_response" };
    }
    await res.body?.cancel();
    if (res.status === 402) { await markKey(db, "firecrawl", slot, 402, nextMonth(), "credits_exhausted"); continue; }
    if (res.status === 429) { await markKey(db, "firecrawl", slot, 429, new Date(Date.now() + 60_000).toISOString(), "rate_limited"); continue; }
    if (res.status === 401) { await markKey(db, "firecrawl", slot, 401, new Date(Date.now() + 30 * DAY).toISOString(), "invalid_key"); continue; }
    return { ok: false, reason: `http_${res.status}` };
  }
  return { ok: false, reason: "all_keys_failed" };
}

// Asks the llm-gateway (which owns the Gemini / Grok keys and their daily quotas) to pick the official host from a fixed list.
// Gemini first (Google grounding on); if it fails for any reason (quota, 503, bad answer) Grok is tried. Returns null when both fail.
async function llmPick(
  baseUrl: string, svc: string, system: string, prompt: string, stats: Record<string, unknown>,
): Promise<{ host: string | null; confidence: number; reason: string } | null> {
  const attempts: { provider: string; ok: boolean; error?: string }[] = [];
  for (const provider of ["gemini", "grok"] as const) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/functions/v1/llm-gateway`, {
        method: "POST", headers: { Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
        body: JSON.stringify({ provider, prompt, system, json: true, grounded: provider === "gemini" }),
        signal: AbortSignal.timeout(55_000),
      });
    } catch { attempts.push({ provider, ok: false, error: "network" }); continue; }
    const raw = await res.text();
    let b: { ok?: boolean; error?: string; text?: string; provider?: string; model?: string; slot?: string } | null = null;
    try { b = JSON.parse(raw); } catch { /* not json */ }
    if (!res.ok || !b?.ok) { attempts.push({ provider, ok: false, error: String(b?.error ?? `http_${res.status}`) }); continue; }
    const m = /\{[\s\S]*\}/.exec(String(b.text ?? ""));
    let j: Record<string, unknown> | null = null;
    try { j = m ? JSON.parse(m[0]) : null; } catch { /* unparseable */ }
    if (!j || typeof j !== "object") { attempts.push({ provider, ok: false, error: "unparseable_answer" }); continue; }
    attempts.push({ provider, ok: true });
    stats.ai_attempts = attempts;
    stats.ai_used = { provider: b.provider, model: b.model, slot: b.slot };
    return {
      host: typeof j.host === "string" && j.host.trim() ? j.host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] : null,
      confidence: Number(j.confidence) || 0,
      reason: String(j.reason ?? "").slice(0, 200),
    };
  }
  stats.ai_attempts = attempts;
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = kenv.get("SUPABASE_URL")!;
  const svc = kenv.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, svc, { auth: { persistSession: false } });

  // internal only: service-role bearer or the same shared secret the verify trigger uses
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  let authed = !!bearer && same(bearer, svc);
  if (!authed) {
    const { data: secret } = await db.rpc("get_drug_pre_verify_secret");
    const given = req.headers.get("x-verify-secret") ?? "";
    authed = typeof secret === "string" && !!secret && same(given, secret);
  }
  if (!authed) return json({ error: "forbidden" }, 403);

  let body: { brand?: unknown; force?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const brandRaw = typeof body.brand === "string" ? body.brand.replace(/[\u0000-\u001F\u007F"]+/g, " ").trim().slice(0, 60) : "";
  const brandName = splitName(brandRaw).name;
  const brandKey = norm(brandName).split(" ")[0] ?? "";
  if (brandKey.length < 3 || !/^[a-z0-9]+$/.test(brandKey)) return json({ error: "invalid_brand", detail: "brand must be a Latin trade name of 3+ letters" }, 400);
  const force = body.force === true;

  const prev = await db.from("official_lookups").select("status,checked_at").eq("brand_key", brandKey).maybeSingle();
  if (prev.data && !force) {
    const age = Date.now() - new Date(prev.data.checked_at).getTime();
    const retrySoon = ["no_official_site", "failed", "vet_failed"].includes(prev.data.status);
    if (prev.data.status === "running" && age < 10 * 60_000) return json({ status: "already_running", brand_key: brandKey }, 202);
    if (prev.data.status !== "running" && age < (retrySoon ? 1 : 7) * DAY) return json({ status: "skipped_recent", last: prev.data.status, brand_key: brandKey });
  }
  const now = new Date().toISOString();
  const up = await db.from("official_lookups").upsert({ brand_key: brandKey, brand: brandName, status: "running", started_at: now, checked_at: now, stats: {} });
  if (up.error) { console.error("lookup_upsert", up.error.message); return json({ error: "internal_error" }, 500); }

  const stats: Record<string, unknown> = {};
  const finish = async (status: string, extra: Record<string, unknown> = {}) => {
    const { error } = await db.from("official_lookups").update({ status, checked_at: new Date().toISOString(), stats: { ...stats }, ...extra }).eq("brand_key", brandKey);
    if (error) console.error("lookup_finish", error.message);
  };

  const work = async () => {
    const t0 = Date.now();
    try {
      // 1) manufacturer hint from what the normal search already stored (majority of stated values)
      let manu: string | null = null;
      const pl = await db.from("drug_pre_payloads").select("payload").ilike("payload->>product_name", `${brandKey}%`).limit(60);
      const tally = new Map<string, { n: number; shown: string }>();
      for (const r of pl.data ?? []) {
        const m = (r.payload as { manufacturer?: unknown })?.manufacturer;
        if (typeof m === "string" && norm(m).length >= 3) { const k = norm(m); const c = tally.get(k) ?? { n: 0, shown: m }; c.n++; tally.set(k, c); }
      }
      manu = [...tally.values()].sort((a, b) => b.n - a.n)[0]?.shown ?? null;
      const manuTokens = manu ? norm(manu).split(" ").filter((t) => t.length >= 4) : [];
      stats.manufacturer_hint = manu;

      // 2) find official domain candidates; stores/marketplaces are excluded
      const stores = await db.from("search_sources").select("domain").in("source_category", ["ONLINE_PHARMACY", "PHARMACEUTICAL_DATABASE", "REGULATORY"]);
      const storeDomains = (stores.data ?? []).map((s) => s.domain as string);
      const cand = new Map<string, { host: string; score: number; url: string; title: string; market: "EG" | "MENA" | "GLOBAL" }>();
      // every non-store host Tavily returned (best page per host): the only list the AI is allowed to choose from
      const pool = new Map<string, { host: string; url: string; title: string; market: "EG" | "MENA" | "GLOBAL" }>();
      const queries = [`${brandName} الموقع الرسمي مصر`, `${brandName} Egypt official website`, `${brandName} Middle East Arabia official website`, `${brandName} official website`, ...(manu ? [`${brandName} ${manu} official site Egypt`] : [])];
      for (const q of queries) {
        let hits: Hit[] = [];
        try { hits = await tavily(db, q); } catch (e) { if (e instanceof Unavailable) break; throw e; }
        for (const x of hits) {
          const host = hostOf(x.url);
          if (!host || NOT_OFFICIAL.test(host) || storeDomains.some((d) => hostMatches(host, d))) continue;
          const pm = marketOf(x.url);
          const pc = pool.get(host);
          if (!pc || marketRank(pm) > marketRank(pc.market)) pool.set(host, { host, url: x.url, title: x.title, market: pm });
          const core = coreLabel(host);
          let s = 0;
          if (ownBrand(host, brandKey)) s = core === brandKey ? 100 : 90;
          else if (brandKey.length >= 4 && core.includes(brandKey)) s = 70;
          else if (manuTokens.includes(core)) s = 60;
          if (!s) continue;
          const m = marketOf(x.url);
          const cur = cand.get(host);
          if (!cur || marketRank(m) > marketRank(cur.market) || (m === cur.market && s > cur.score)) cand.set(host, { host, score: s, url: x.url, title: x.title, market: m });
        }
      }

      // 2b) AI selection (llm-gateway: Gemini first, Grok as fallback). Skipped when the name heuristics already found a strong
      // Egyptian / Middle East candidate, to save daily quota. The AI can only choose a host that is in the Tavily results.
      const strongRegional = [...cand.values()].some((c) => c.market !== "GLOBAL" && c.score >= 90);
      if (!strongRegional && pool.size) {
        const list = [...pool.values()].sort((a, b) => marketRank(b.market) - marketRank(a.market)).slice(0, 12);
        const system = "You identify the OFFICIAL website of a medicine or supplement brand. Answer with one JSON object only, no other text.";
        const prompt =
          `Brand: ${brandName}\nKnown manufacturer (may be empty): ${manu ?? ""}\n\n` +
          `From the candidate list below choose the ONE site that is the OFFICIAL website of this brand's owner or manufacturer for EGYPT or the MIDDLE EAST.\n` +
          `Rules: choose only a host that appears in the list; never a pharmacy, online store, marketplace, price or drug database, blog, forum or social page; ` +
          `prefer an Egyptian site or Egyptian page, then a Middle East one; if the only official site is the global one, return it; ` +
          `if no candidate is the official site, return host null. Never invent a host.\n\nCandidates:\n` +
          list.map((c, i) => `${i + 1}. host=${c.host} | market=${c.market} | title=${(c.title ?? "").slice(0, 100)} | url=${c.url}`).join("\n") +
          `\n\nReply exactly: {"host": string or null, "confidence": number between 0 and 1, "reason": "one short sentence"}`;
        const pick = await llmPick(url, svc, system, prompt, stats);
        if (!pick) stats.ai_result = "all_models_failed";
        else if (!pick.host) stats.ai_result = { host: null, reason: pick.reason };
        else {
          const entry = pool.get(pick.host) ?? [...pool.values()].find((p) => hostMatches(p.host, pick.host!) || hostMatches(pick.host!, p.host));
          if (!entry) stats.ai_result = { host: pick.host, rejected: "host_not_in_search_results" };
          else if (pick.confidence < AI_MIN_CONFIDENCE) stats.ai_result = { host: entry.host, rejected: "low_confidence", confidence: pick.confidence };
          else {
            stats.ai_result = { host: entry.host, confidence: pick.confidence, reason: pick.reason };
            if (!cand.has(entry.host)) cand.set(entry.host, { host: entry.host, score: 80, url: entry.url, title: entry.title, market: entry.market });
          }
        }
      }

      const allCand = [...cand.values()].sort((a, b) => marketRank(b.market) - marketRank(a.market) || b.score - a.score);
      stats.candidates = allCand.map((c) => ({ host: c.host, score: c.score, market: c.market }));
      if (!allCand.length) { await finish("no_official_site", { manufacturer_hint: manu }); return; }
      // Egyptian or Middle East official site first (EG before MENA). Only when there is none, fall back to the brand's OWN global
      // official site (domain really named like the brand, score >= 90); look-alike domains are never used
      const ordered = [...allCand.filter((c) => c.market !== "GLOBAL"), ...allCand.filter((c) => c.market === "GLOBAL" && c.score >= 90)];
      if (!ordered.length) { await finish("no_regional_site", { manufacturer_hint: manu }); return; }

      // 3+4) register and vet candidates in order; the first one that is allowed is used
      let best = ordered[0];
      let sourceId = "";
      let accepted = false;
      let lastFail = "vet_failed";
      const vetLog: { host: string; verdict: string | null }[] = [];
      for (const c of ordered.slice(0, MAX_VET_CANDIDATES)) {
        best = c;
        let src = (await db.from("search_sources").select("id,access_policy,enabled,extraction_method,notes").eq("domain", c.host).maybeSingle()).data;
        if (!src) {
          const ins = await db.from("search_sources").insert({
            source_name: `${brandName} Official (${c.host})`, domain: c.host, website_url: `https://${c.host}/`,
            source_category: "MANUFACTURER", supported_data: ["composition", "product_identity"], enabled: false,
            access_policy: "unverified", extraction_method: "unverified", reliability_score: 0.9,
            notes: `Auto-discovered by drug-official for brand ${brandName} on ${now.slice(0, 10)} (market ${c.market})`,
          }).select("id,access_policy,enabled,extraction_method,notes").single();
          if (ins.error) throw new Error("source_insert: " + ins.error.message);
          src = ins.data;
        }
        sourceId = src!.id as string;
        if (["restricted", "prohibited", "manual_only"].includes(src!.access_policy)) { lastFail = "blocked"; vetLog.push({ host: c.host, verdict: "already_" + src!.access_policy }); continue; }
        if (src!.access_policy === "permitted" && src!.enabled && src!.extraction_method === "firecrawl") { accepted = true; break; }

        const sec = await db.from("app_secrets").select("value").eq("name", "cron_secret").maybeSingle();
        if (!sec.data?.value) throw new Error("cron_secret missing");
        const started = new Date(Date.now() - 2000).toISOString();
        const r = await fetch(`${url}/functions/v1/source-vet`, {
          method: "POST", headers: { "x-cron-secret": sec.data.value, "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "vet", source_id: sourceId }), signal: AbortSignal.timeout(20_000),
        });
        await r.text();
        let verdict: string | null = null;
        for (let waited = 0; waited < VET_WAIT_MS && !verdict; waited += 5000) {
          await new Promise((res) => setTimeout(res, 5000));
          const v = await db.from("source_vetting").select("verdict").eq("source_id", sourceId).gte("checked_at", started).order("checked_at", { ascending: false }).limit(1);
          verdict = v.data?.[0]?.verdict ?? null;
        }
        vetLog.push({ host: c.host, verdict });
        const clean = verdict === "no_prohibition_found";
        // owner decision: a domain named like the brand is accepted even when no terms page could be found; a real prohibition never is
        const byName = verdict === "needs_review" && ownBrand(c.host, brandKey);
        if (!clean && !byName) { lastFail = verdict === "blocked" ? "blocked" : "vet_failed"; continue; }
        const why = clean ? "source-vet found no prohibition (robots.txt and terms checked)" : "domain is named like the brand and source-vet found no prohibition (no terms page could be read)";
        const u = await db.from("search_sources").update({
          access_policy: "permitted", extraction_method: "firecrawl", enabled: true, last_verified_at: new Date().toISOString(),
          notes: `${src!.notes ?? ""} | Auto-permitted ${now.slice(0, 10)}: ${why}. See source_vetting.`.trim(),
        }).eq("id", sourceId);
        if (u.error) throw new Error("source_update: " + u.error.message);
        accepted = true;
        break;
      }
      stats.vet = vetLog;
      const market = best.market;
      stats.market = market;
      if (!accepted) { await finish(lastFail, { domain: best.host, source_id: sourceId, market, manufacturer_hint: manu }); return; }

      // 5) discover the family's product pages on that domain only (EG/MENA pages only when the domain is regional)
      const found = new Map<string, Hit>();
      found.set(best.url, { url: best.url, title: best.title, score: 1 });
      for (const q of [brandName, `${brandName} products`, `${brandName} supplement facts ingredients`, `${brandName} multivitamin`]) {
        try { for (const x of await tavily(db, q, [best.host])) if (!found.has(x.url)) found.set(x.url, x); } catch (e) { if (e instanceof Unavailable) break; throw e; }
      }
      // a product detail page: not a company/help page, lives under a products-like folder and is at least 2 levels deep
      const isDetail = (u: string) => !SKIP_PATH.test(pathOf(u)) && PRODUCT_LIKE.test(pathOf(u)) && depthOf(u) >= 3;
      const picks = [...found.values()]
        .filter((p) => hostMatches(hostOf(p.url), best.host) && (best.market === "GLOBAL" || marketOf(p.url) !== "GLOBAL") && isDetail(p.url))
        .filter((p) => norm(`${p.title ?? ""} ${pathOf(p.url)}`).includes(brandKey) || (p.score ?? 0) >= 0.5)
        .sort((a, b) => marketRank(marketOf(b.url)) - marketRank(marketOf(a.url)) || (b.score ?? 0) - (a.score ?? 0))
        .slice(0, MAX_PAGES);
      stats.pages_found = found.size; stats.pages_picked = picks.length; stats.picked_urls = picks.map((p) => p.url);

      // 6) read each product page and stage its MAIN product as a MANUFACTURER payload (page URL kept in source_url)
      const prompt = `This should be a single product page of "${brandName}". Extract ONLY the main product this page is about. ` +
        `Completely ignore related, recommended, 'you may also like' or other-variant products shown elsewhere on the page. ` +
        `If the page offers several pack sizes of that same main product, return one item per pack size. ` +
        `If the page is not a single product page (company info, FAQ, category or listing page), return an empty products array. ` +
        `Use only what the page explicitly states; omit anything it does not state; never guess. ` +
        `product_class: say what the page presents the product as: drug (a registered medicine), supplement (vitamin, mineral or dietary supplement), cosmetic, medical_device or other. Omit it if the page does not make this clear. ` +
        `product_name is the trade name only: never put numbers, sizes, counts, strengths or the dosage form in it. Put the size or count (for example 30 tablets) in pack_size. ` +
        `For vitamins and supplements every vitamin or mineral in the supplement facts / composition table is an ingredient with its amount and unit per serving (strength_value, strength_unit, strength_per); list ALL of them, there is no limit on how many. ` +
        `Take ingredients ONLY from a supplement facts / composition table that prints an amount for each ingredient. Marketing highlights, benefit lists, headings and sentences such as 'contains X, Y and Z' or 'rich in B vitamins' are NOT a composition: if the page has no such table, return ingredients as an empty array. ` +
        `Never write an amount the page does not print, never use a placeholder such as 1, and never list a group name (B vitamins, vitamins and minerals, antioxidants) as an ingredient. ` +
        `If an amount is not stated omit it; never write 0. manufacturer is the company that makes or markets the product, only if the page states it.`;
      let scraped = 0, failed = 0, extracted = 0, staged = 0, alreadyApproved = 0, attached = 0;
      const failures: string[] = [], family: { name: string; pack: string | null; page: string }[] = [];
      const dropTotals: Record<string, number> = {};
      const queue = [...picks];
      const worker = async () => {
        for (;;) {
          const p = queue.shift();
          if (!p) return;
          if (Date.now() - t0 > SCRAPE_DEADLINE_MS || staged >= MAX_STAGED) { failures.push("skipped_budget"); continue; }
          const r = await scrape(db, p.url, prompt);
          if (!r.ok) { failed++; failures.push(r.reason); continue; }
          if (!r.md) { failed++; failures.push("no_markdown"); continue; }
          scraped++;
          const g = groundProducts(r.json, r.md);
          for (const [k, n] of Object.entries(g.dropped)) dropTotals[k] = (dropTotals[k] ?? 0) + n;
          const rawList = g.json.products;
          const products = validateProducts(g.json, brandKey, [], { trustSingle: true });
          extracted += products.length;
          const known = new Set<string>();
          if (products.length) {
            const kr = await db.from("drug_products").select("identity_key").in("identity_key", products.map((x) => x.identity_key));
            for (const row of kr.data ?? []) known.add(row.identity_key as string);
          }
          for (const np of products) {
            const asWritten = rawList.find((it) => typeof it?.product_name === "string" && norm(splitName(it.product_name as string).name) === np.normalized_name) ?? null;
            const cls = typeof asWritten?.product_class === "string" ? asWritten.product_class.toLowerCase().trim() : "";
            const productClass = CLASSES.includes(cls) ? cls : null;
            if (known.has(np.identity_key)) {
              // already registered (for example from pharmacies) and this official page confirms the very same product:
              // record the official source on it instead of staging a duplicate
              alreadyApproved++;
              const at = await db.rpc("attach_official_to_product", {
                p_identity_key: np.identity_key, p_source_id: sourceId, p_source_url: p.url, p_market: marketOf(p.url), p_class: productClass,
              });
              if (at.error) failures.push("attach_error: " + at.error.message.slice(0, 100)); else if (at.data) attached++;
              continue;
            }
            if (staged >= MAX_STAGED) break;
            const st = await db.rpc("stage_new_product", {
              p_source_id: sourceId, p_source_url: p.url, p_job_id: null, p_page_products: products.length,
              p_product: { ...np, product_class: productClass, official_market: marketOf(p.url), official_domain: best.host, official_page: p.url, official_snippet: snippetOf(r.md, np.product_name), as_written: asWritten },
            });
            if (st.error) { failures.push("stage_error: " + st.error.message.slice(0, 100)); continue; }
            staged++; family.push({ name: np.product_name, pack: np.pack_size, page: p.url });
          }
        }
      };
      await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      Object.assign(stats, { pages_scraped: scraped, pages_failed: failed, products_extracted: extracted, products_staged: staged, already_approved: alreadyApproved, official_attached: attached, grounding_dropped: dropTotals, family, failures: failures.slice(0, 10) });
      await finish(staged > 0 || attached > 0 ? "found" : "no_products", { domain: best.host, source_id: sourceId, market, manufacturer_hint: manu });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.error("official_error", brandKey, m);
      stats.error = m.slice(0, 200);
      await finish("failed");
    }
  };

  EdgeRuntime.waitUntil(work());
  return json({ status: "accepted", brand_key: brandKey }, 202);
});
