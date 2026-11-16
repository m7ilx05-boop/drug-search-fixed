import { secs } from "./helper.ts";
// Read-only operations feed for the dashboard (page 2).
// Returns recent search operations (jobs + user searches), per-operation key usage (key_usage_log) and key-usage totals.
// Never returns keys, user ids or secrets: slot names, counts, credits, tokens and query text only.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const warnings: string[] = [];
// deno-lint-ignore no-explicit-any
async function q(path: string): Promise<any[]> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
    const b = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(b)) {
      warnings.push(`${path.split("?")[0]}: ${r.status} ${typeof b === "object" && b ? (b.message || "") : ""}`.trim());
      return [];
    }
    return b;
  } catch (e) {
    warnings.push(`${path.split("?")[0]}: ${String(e).slice(0, 80)}`);
    return [];
  }
}
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v) || 0);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);
const r4 = (n: number) => Math.round(n * 10000) / 10000;

// Grok list prices (USD per million tokens) used only to ESTIMATE the cost of a call from its token counts.
const GROK_IN_PER_M = 0.30, GROK_OUT_PER_M = 0.50;
const PROVIDER_ORDER: Record<string, number> = { tavily: 0, firecrawl: 1, gemini: 2, grok: 3 };

type KeyUse = {
  provider: string; slot: string; calls: number; ok: number; failed: number;
  credits: number; credits_estimated: boolean; tokens_in: number; tokens_out: number; tokens_total: number;
  usd_estimated: number | null; models: string[]; kinds: string[];
};
// deno-lint-ignore no-explicit-any
function toKeyUse(r: any): KeyUse {
  const tin = num(r.tokens_in), tout = num(r.tokens_out);
  return {
    provider: String(r.provider), slot: String(r.slot), calls: num(r.calls), ok: num(r.ok_calls), failed: num(r.failed_calls),
    credits: r4(num(r.credits)), credits_estimated: !!r.credits_estimated, tokens_in: tin, tokens_out: tout,
    tokens_total: num(r.tokens_total) || tin + tout,
    usd_estimated: r.provider === "grok" ? r4((tin * GROK_IN_PER_M + tout * GROK_OUT_PER_M) / 1e6) : null,
    models: arr(r.models), kinds: arr(r.kinds),
  };
}
function usageOf(keys: KeyUse[]) {
  const sorted = [...keys].sort((a, b) => (PROVIDER_ORDER[a.provider] ?? 9) - (PROVIDER_ORDER[b.provider] ?? 9) || a.slot.localeCompare(b.slot, undefined, { numeric: true }));
  const by = (p: string) => sorted.filter((k) => k.provider === p);
  return {
    keys: sorted,
    totals: {
      calls: sum(sorted, (k) => k.calls), failed: sum(sorted, (k) => k.failed),
      tavily_credits: r4(sum(by("tavily"), (k) => k.credits)), firecrawl_credits: r4(sum(by("firecrawl"), (k) => k.credits)),
      gemini_tokens: sum(by("gemini"), (k) => k.tokens_total), grok_tokens: sum(by("grok"), (k) => k.tokens_total),
      grok_usd_estimated: r4(sum(by("grok"), (k) => k.usd_estimated ?? 0)),
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  warnings.length = 0;
  const u = new URL(req.url);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") || 60), 10), 100);
  const since = encodeURIComponent(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const today = new Date().toISOString().slice(0, 10);

  const jobSel = "id,query,job_kind,status,error_message,created_at,started_at,completed_at,pages:stats->pages_scraped,tav:stats->key_slots_used,fc:stats->firecrawl_slots_used,oc:stats->>outcome_code";
  const [jobs, hist, jobs24, hist24, llm, grok, tav, fc, loose] = await Promise.all([
    q(`search_jobs?select=${jobSel}&order=created_at.desc&limit=${limit}`),
    q(`search_history?select=query,search_type,outcome,results_count,cache_status,created_at,job_id&order=created_at.desc&limit=${limit}`),
    q(`search_jobs?select=job_kind,status,pages:stats->pages_scraped&created_at=gte.${since}&limit=3000`),
    q(`search_history?select=outcome&created_at=gte.${since}&limit=3000`),
    q("llm_key_quota?select=provider,slot,usage_day,used_today,total_used"),
    q("grok_key_state?select=slot,day,spent_today_usd,calls_today,balance_usd"),
    q("tavily_key_checks?select=slot,state,plan_usage,plan_limit,key_usage"),
    q("firecrawl_key_checks?select=slot,state,remaining_credits,plan_credits"),
    // provider calls that belong to no search job (background work such as official-site lookups, photo checks)
    q("key_usage_log?select=created_at,provider,slot,kind,status,credits,credits_estimated,tokens_in,tokens_out,tokens_total,model,meta&job_id=is.null&order=created_at.desc&limit=600"),
  ]);

  // per-job key usage (one aggregated row per job + provider + key slot, from the view key_usage_job_summary)
  const jobIdList = jobs.map((j) => j.id).filter(Boolean);
  const usageRows = jobIdList.length ? await q(`key_usage_job_summary?select=*&job_id=in.(${jobIdList.join(",")})`) : [];
  const usageByJob = new Map<string, KeyUse[]>();
  for (const r of usageRows) {
    const a = usageByJob.get(r.job_id) ?? [];
    a.push(toKeyUse(r));
    usageByJob.set(r.job_id, a);
  }

  // background (job-less) calls: grouped by what they were for (meta.purpose, else the call kind), a new group after a 3 minute gap
  type G = { label: string; first: number; last: number; rows: Record<string, unknown>[] };
  const groups: G[] = [];
  for (const r of loose) {
    const label = String((r.meta && (r.meta as Record<string, unknown>).purpose) || r.kind || "other").slice(0, 60);
    const t = Date.parse(r.created_at);
    const g = groups.find((x) => x.label === label && x.first - t <= 180_000 && t <= x.last);
    if (g) { g.rows.push(r); g.first = Math.min(g.first, t); } else groups.push({ label, first: t, last: t, rows: [r] });
  }
  const bgItems = groups.map((g) => {
    const m = new Map<string, Record<string, unknown>>();
    for (const r of g.rows as Record<string, unknown>[]) {
      const k = `${r.provider}|${r.slot}`;
      const ok = num(r.status) >= 200 && num(r.status) < 300;
      const c = m.get(k) ?? { provider: r.provider, slot: r.slot, calls: 0, ok_calls: 0, failed_calls: 0, credits: 0, credits_estimated: false, tokens_in: 0, tokens_out: 0, tokens_total: 0, models: [] as string[], kinds: [] as string[] };
      c.calls = num(c.calls) + 1; if (ok) c.ok_calls = num(c.ok_calls) + 1; else c.failed_calls = num(c.failed_calls) + 1;
      c.credits = num(c.credits) + num(r.credits); c.credits_estimated = !!c.credits_estimated || !!r.credits_estimated;
      c.tokens_in = num(c.tokens_in) + num(r.tokens_in); c.tokens_out = num(c.tokens_out) + num(r.tokens_out); c.tokens_total = num(c.tokens_total) + num(r.tokens_total);
      if (r.model && !(c.models as string[]).includes(String(r.model))) (c.models as string[]).push(String(r.model));
      if (r.kind && !(c.kinds as string[]).includes(String(r.kind))) (c.kinds as string[]).push(String(r.kind));
      m.set(k, c);
    }
    return { t: new Date(g.last).toISOString(), type: "background", label: g.label, usage: usageOf([...m.values()].map(toKeyUse)) };
  });

  const hByJob = new Map(hist.filter((h) => h.job_id).map((h) => [h.job_id, h]));
  const jobIds = new Set(jobs.map((j) => j.id));
  const items = [
    ...jobs.map((j) => {
      const h = hByJob.get(j.id);
      const keys = usageByJob.get(j.id);
      return {
        t: j.created_at, type: "job", kind: j.job_kind, status: j.status, query: j.query,
        outcome: h ? h.outcome : null, results: h ? h.results_count : null,
        secs: secs(j.started_at, j.completed_at), pages: num(j.pages),
        tavily: arr(j.tav), firecrawl: arr(j.fc),
        usage: keys ? usageOf(keys) : null,
        error: j.error_message ? String(j.error_message).slice(0, 200) : null, code: j.oc || null,
      };
    }),
    ...hist.filter((h) => !h.job_id || !jobIds.has(h.job_id)).map((h) => ({
      t: h.created_at, type: "search", query: h.query, outcome: h.outcome, results: h.results_count, cache: h.cache_status,
    })),
    ...bgItems,
  ].sort((a, b) => Date.parse(b.t) - Date.parse(a.t)).slice(0, limit);

  const kinds: Record<string, number> = {};
  for (const j of jobs24) kinds[j.job_kind] = (kinds[j.job_kind] || 0) + 1;
  const outcomes: Record<string, number> = {};
  for (const h of hist24) outcomes[h.outcome || "unknown"] = (outcomes[h.outcome || "unknown"] || 0) + 1;

  const summary = {
    searches_24h: hist24.length,
    outcomes_24h: outcomes,
    jobs_24h: jobs24.length,
    jobs_failed_24h: jobs24.filter((j) => j.status === "failed").length,
    jobs_by_kind_24h: kinds,
    firecrawl_pages_24h: sum(jobs24, (j) => num(j.pages)),
    gemini_calls_today: sum(llm.filter((r) => r.provider === "gemini" && r.usage_day === today), (r) => num(r.used_today)),
    gemini_calls_total: sum(llm.filter((r) => r.provider === "gemini"), (r) => num(r.total_used)),
    grok_calls_today: sum(grok.filter((r) => r.day === today), (r) => num(r.calls_today)),
    grok_spent_today_usd: Math.round(sum(grok.filter((r) => r.day === today), (r) => num(r.spent_today_usd)) * 10000) / 10000,
    grok_calls_total: sum(llm.filter((r) => r.provider === "grok"), (r) => num(r.total_used)),
    tavily_used: sum(tav, (r) => num(r.plan_usage ?? r.key_usage)),
    tavily_limit: sum(tav, (r) => num(r.plan_limit) || 1000),
    tavily_keys: tav.length,
    firecrawl_used: sum(fc, (r) => Math.max(num(r.plan_credits) - num(r.remaining_credits), 0)),
    firecrawl_limit: sum(fc, (r) => num(r.plan_credits)),
    firecrawl_remaining: sum(fc.filter((r) => r.state === "active"), (r) => num(r.remaining_credits)),
    firecrawl_keys: fc.length,
  };

  return new Response(JSON.stringify({ generated_at: new Date().toISOString(), summary, items, warnings }), { headers: CORS });
});
