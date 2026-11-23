import { kenv } from "./vault-env.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// drug-doses-pharmacy: looks for the doses that an official (tier 1) product page did not publish, in the enabled
// pharmacy / drug-database sources. The result is NEVER written to drug_products / product_ingredients / data_evidence.
// When doses are found they are recorded as ONE row in drug_pre_review (reason = 'pharmacy_doses', status = 'pending')
// for a human to review, and returned to the page so it can be shown temporarily, labelled "من الصيدليات".
// A dose is kept only if the model quotes it AND that quote is found in the page text AND it contains the number.
// A search that finds nothing writes nothing.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_MS = 24 * 3600_000;
const MAX_PAGES = 5;
const PAGE_CHARS = 4500;
const UNITS = ["mg", "mcg", "g", "iu", "ml"];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF.]+/g, "");
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www[.]/, ""); } catch { return ""; } };

const tavilySlots = () =>
  Object.keys(kenv.toObject()).filter((k) => /^tavily/i.test(k) && kenv.get(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

async function tavily(db: SupabaseClient, query: string, domains: string[]) {
  const st = await db.from("provider_key_state").select("slot,exhausted_until").ilike("provider", "tavily");
  const blocked = new Set((st.data ?? []).filter((r) => r.exhausted_until && new Date(r.exhausted_until).getTime() > Date.now()).map((r) => r.slot));
  const slots = tavilySlots().filter((s) => !blocked.has(s));
  let last = 0;
  for (const slot of slots) {
    let res: Response;
    try {
      res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kenv.get(slot)}` },
        body: JSON.stringify({ query, include_domains: domains, search_depth: "advanced", max_results: 8, include_raw_content: true }),
        signal: AbortSignal.timeout(40_000),
      });
    } catch { last = 0; continue; }
    last = res.status;
    if (res.ok) {
      const b = await res.json().catch(() => null);
      return { ok: true as const, results: (Array.isArray(b?.results) ? b.results : []) as { url: string; content?: string; raw_content?: string }[] };
    }
    await res.body?.cancel();
  }
  return { ok: false as const, status: last, tried: slots.length };
}

async function llm(prompt: string, system: string) {
  const url = `${kenv.get("SUPABASE_URL")}/functions/v1/llm-gateway`;
  const key = kenv.get("SUPABASE_SERVICE_ROLE_KEY")!;
  let lastErr = "";
  for (const provider of ["gemini", "grok"]) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ provider, prompt, system, json: true }), signal: AbortSignal.timeout(60_000),
      });
      const b = await r.json().catch(() => ({}));
      if (r.ok && b?.ok && typeof b.text === "string") return { ok: true as const, text: b.text as string };
      lastErr = `${provider}:${b?.error ?? r.status}`;
    } catch { lastErr = `${provider}:network`; }
  }
  return { ok: false as const, error: lastErr };
}

function pageText(r: { content?: string; raw_content?: string }) {
  const t = (r.raw_content && r.raw_content.length > (r.content?.length ?? 0) ? r.raw_content : r.content) ?? "";
  if (t.length <= PAGE_CHARS) return t;
  const m = t.search(/\b\d+(?:[.,]\d+)?\s?(mg|mcg|µg|ug|iu)\b/i);
  const from = Math.max(0, (m < 0 ? 0 : m) - 600);
  return t.slice(from, from + PAGE_CHARS);
}

type Dose = { ingredient: string; value: number; unit: string; per: string; url: string; quote: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: { product_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const productId = typeof body.product_id === "string" ? body.product_id : "";
  if (!UUID.test(productId)) return json({ error: "invalid_product_id" }, 400);

  const db = createClient(kenv.get("SUPABASE_URL")!, kenv.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await db.rpc("check_rate_limit", { p_key: `doses:${ip}`, p_limit: 5, p_window_seconds: 60 });
  if (rl.error) { console.error("rate_limit_error", rl.error.message); return json({ error: "internal_error" }, 500); }
  if (rl.data === false) return json({ error: "rate_limited" }, 429);

  // only tier 1 products with missing doses are eligible
  const tier = await db.from("product_display_tier").select("display_tier,doses_missing").eq("product_id", productId).maybeSingle();
  if (tier.error) { console.error("tier_error", tier.error.message); return json({ error: "internal_error" }, 500); }
  if (!tier.data) return json({ error: "product_not_found" }, 404);
  if (tier.data.display_tier !== 1 || tier.data.doses_missing !== true) return json({ error: "not_eligible", detail: "only official products with missing doses" }, 400);

  const pq = await db.from("drug_products").select("product_name,dosage_form,pack_size").eq("id", productId).single();
  if (pq.error || !pq.data) return json({ error: "product_not_found" }, 404);
  const prod = pq.data;
  const iq = await db.from("product_ingredients").select("strength_unknown, active_ingredients(inn)").eq("product_id", productId);
  if (iq.error) { console.error("ingredients_error", iq.error.message); return json({ error: "internal_error" }, 500); }
  const missing = [...new Set((iq.data ?? []).filter((r) => r.strength_unknown === true)
    // deno-lint-ignore no-explicit-any
    .map((r: any) => String(r.active_ingredients?.inn ?? "").trim()).filter(Boolean))];
  if (!missing.length) return json({ error: "not_eligible", detail: "no ingredient with unknown dose" }, 400);

  const reviewKey = `pharmacy_doses:${productId}`;
  const prev = await db.from("drug_pre_review").select("id,created_at,context").eq("raw_strength", reviewKey).eq("status", "pending").maybeSingle();
  const prevCtx = (prev.data?.context ?? {}) as Record<string, unknown>;
  const prevAt = typeof prevCtx.searched_at === "string" ? new Date(prevCtx.searched_at).getTime() : 0;
  if (prev.data && Date.now() - prevAt < CACHE_MS) {
    return json({ product_id: productId, status: Array.isArray(prevCtx.doses) && prevCtx.doses.length ? "found" : "none", cached: true, review_id: prev.data.id,
      doses: prevCtx.doses ?? [], still_missing: prevCtx.still_missing ?? missing, searched_at: prevCtx.searched_at, label: "من الصيدليات", official_record_changed: false });
  }

  const srcs = await db.from("search_sources").select("domain,source_category")
    .in("source_category", ["ONLINE_PHARMACY", "PHARMACEUTICAL_DATABASE"]).eq("enabled", true).eq("access_policy", "permitted");
  if (srcs.error) { console.error("sources_error", srcs.error.message); return json({ error: "internal_error" }, 500); }
  const domains = [...new Set((srcs.data ?? []).map((s) => String(s.domain || "").toLowerCase()).filter(Boolean))];
  if (!domains.length) return json({ error: "no_sources" }, 503);

  const sr = await tavily(db, `${prod.product_name} ${prod.dosage_form ?? ""} ingredients per tablet mg mcg`.replace(/\s+/g, " ").trim(), domains);
  if (!sr.ok) { console.error("tavily_failed", sr.status, sr.tried); return json({ error: "provider_exhausted", detail: `tavily status ${sr.status}` }, 503); }
  const pages = sr.results.filter((r) => domains.some((d) => host(r.url) === d || host(r.url).endsWith("." + d))).slice(0, MAX_PAGES)
    .map((r) => ({ url: r.url, text: pageText(r) })).filter((p) => p.text.length > 200);

  let doses: (Dose & { sources: { host: string; url: string }[]; agreement: number; conflict: boolean })[] = [];
  let llmError: string | null = null;
  if (pages.length) {
    const system = "You extract ingredient doses from pharmacy web pages. Reply with JSON only.";
    const prompt =
      `Product: "${prod.product_name}" (${prod.dosage_form ?? ""} ${prod.pack_size ?? ""}).\n` +
      `Ingredients whose dose is needed (use EXACTLY these names in "ingredient"): ${JSON.stringify(missing)}.\n` +
      `Rules: use only text of a page that is about THIS exact product (same brand AND same variant, e.g. Men vs Women vs Silver); ` +
      `ignore other products. Only doses per ONE tablet/capsule (not per day, not per 100g). Never guess or convert; skip anything unclear. ` +
      `Each item needs a short verbatim "quote" (max 160 chars) copied from the page that contains the number.\n` +
      `Reply: {"items":[{"ingredient":"","value":0,"unit":"mg|mcg|g|IU","per":"tablet","url":"","quote":""}]}\n\n` +
      pages.map((p, i) => `--- PAGE ${i + 1} url=${p.url}\n${p.text}`).join("\n\n");
    const out = await llm(prompt, system);
    if (!out.ok) llmError = out.error;
    else {
      let items: unknown[] = [];
      try { const j = JSON.parse(out.text.replace(/^```(?:json)?|```$/gim, "").trim()); items = Array.isArray(j?.items) ? j.items : []; } catch { llmError = "bad_json"; }
      const byName = new Map(missing.map((m) => [m.toLowerCase(), m]));
      const good: Dose[] = [];
      for (const it of items as Record<string, unknown>[]) {
        const ing = byName.get(String(it?.ingredient ?? "").trim().toLowerCase());
        const value = typeof it?.value === "number" ? it.value : NaN;
        const unit = String(it?.unit ?? "").trim();
        const unitL = unit.toLowerCase();
        const quote = String(it?.quote ?? "").slice(0, 200);
        const page = pages.find((p) => p.url === it?.url);
        if (!ing || !(value > 0) || !UNITS.includes(unitL) || !page || !quote) continue;
        if (!squash(page.text).includes(squash(quote))) continue;            // quote must really be on the page
        if (!squash(quote).includes(String(value).replace(",", "."))) continue; // and must contain the number
        good.push({ ingredient: ing, value, unit: unitL === "iu" ? "IU" : unitL, per: "tablet", url: page.url, quote });
      }
      const groups = new Map<string, Dose[]>();
      for (const g of good) { const k = `${g.ingredient}|${g.value}|${g.unit}`; groups.set(k, [...(groups.get(k) ?? []), g]); }
      for (const [, arr] of groups) {
        const hosts = new Map<string, string>();
        arr.forEach((a) => { if (!hosts.has(host(a.url))) hosts.set(host(a.url), a.url); });
        const rival = [...groups.values()].some((o) => o[0].ingredient === arr[0].ingredient && (o[0].value !== arr[0].value || o[0].unit !== arr[0].unit));
        doses.push({ ...arr[0], sources: [...hosts].map(([h, url]) => ({ host: h, url })), agreement: hosts.size, conflict: rival });
      }
      doses.sort((a, b) => a.ingredient.localeCompare(b.ingredient) || b.agreement - a.agreement);
    }
  }

  const found = new Set(doses.map((d) => d.ingredient));
  const stillMissing = missing.filter((m) => !found.has(m));
  const searchedAt = new Date().toISOString();
  const pagesRead = pages.map((p) => p.url);

  // nothing verifiable found: report it, write nothing
  if (!doses.length) {
    return json({
      product_id: productId, status: "none", cached: false, review_id: null, recorded_in_review: false,
      doses: [], still_missing: stillMissing, searched_at: searchedAt, pages_read: pagesRead, llm_error: llmError,
      label: "من الصيدليات", official_record_changed: false,
    });
  }

  const context = {
    kind: "pharmacy_doses", product_id: productId, doses, still_missing: stillMissing, searched_at: searchedAt,
    pages_read: pagesRead, domains_searched: domains.length, llm_error: llmError,
    note: "doses found in pharmacies; NOT written to the official product record",
  };
  const row = { raw_name: prod.product_name, raw_strength: reviewKey, raw_form: prod.dosage_form ?? "", reason: "pharmacy_doses", context };

  let reviewId: string | null = prev.data?.id ?? null;
  if (reviewId) {
    const u = await db.from("drug_pre_review").update({ context }).eq("id", reviewId);
    if (u.error) { console.error("review_update_error", u.error.message); reviewId = null; }
  } else {
    const ins = await db.from("drug_pre_review").insert(row).select("id").single();
    if (ins.error) {
      console.error("review_insert_error", ins.error.code, ins.error.message);
      if (ins.error.code === "23505") {
        const ex = await db.from("drug_pre_review").select("id").eq("raw_strength", reviewKey).eq("status", "pending").maybeSingle();
        reviewId = ex.data?.id ?? null;
        if (reviewId) await db.from("drug_pre_review").update({ context }).eq("id", reviewId);
      }
    } else reviewId = ins.data.id;
  }

  return json({
    product_id: productId, status: "found", cached: false, review_id: reviewId, recorded_in_review: !!reviewId,
    doses, still_missing: stillMissing, searched_at: searchedAt, pages_read: pagesRead, llm_error: llmError,
    label: "من الصيدليات", official_record_changed: false,
  });
});
