// Read-only status of Tavily/Firecrawl/Gemini/Grok keys (slot names + numbers only; never a key).
// Refreshes Tavily/Firecrawl through the existing *-key-check functions when data is stale
// (5 min, or 60 s when ?refresh=1 is passed).
// v3: also returns `renews` (when the quota resets): Firecrawl = its billing period_end,
// Tavily = first day of next month (UTC), which is when Tavily's monthly credits reset.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const slotNo = (s: string) => Number(s.match(/(\d+)$/)?.[1] ?? 0);
const iso = (s: unknown) => {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return isNaN(+d) ? null : d.toISOString();
};
const nextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};

async function rows(table: string, cols: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?select=${cols}`, { headers: H });
  const b = await r.json().catch(() => []);
  return Array.isArray(b) ? b.sort((a, c) => slotNo(a.slot) - slotNo(c.slot)) : [];
}
const load = async () => {
  const [t, f, l] = await Promise.all([
    rows("tavily_key_checks", "slot,state,key_usage,plan_usage,plan_limit,checked_at"),
    rows("firecrawl_key_checks", "slot,state,remaining_credits,plan_credits,period_end,checked_at"),
    rows("llm_key_quota", "provider,slot,usage_day,used_today,total_used,block_reason,blocked_until,last_status,last_used_at"),
  ]);
  return { t, f, l };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const staleMs = force ? 60 * 1000 : 5 * 60 * 1000;
  let { t, f, l } = await load();
  const times = [...t, ...f].map((r) => Date.parse(r.checked_at)).filter(Boolean);
  const newest = times.length ? Math.max(...times) : 0;
  let refreshed = false;
  if (Date.now() - newest > staleMs) {
    const s = await fetch(`${SB_URL}/rest/v1/app_secrets?name=eq.cron_secret&select=value`, { headers: H }).then((r) => r.json()).catch(() => []);
    const token = Array.isArray(s) ? s[0]?.value : null;
    if (token) {
      await Promise.all(["tavily-key-check", "firecrawl-key-check"].map((fn) =>
        fetch(`${SB_URL}/functions/v1/${fn}`, { method: "POST", headers: { ...H, "x-check-token": token }, body: "{}", signal: AbortSignal.timeout(40000) }).catch(() => null)));
      ({ t, f, l } = await load());
      refreshed = true;
    }
  }
  const all = [...t, ...f].map((r) => Date.parse(r.checked_at)).filter(Boolean);
  const tavilyRenews = nextMonth();
  return new Response(JSON.stringify({
    refreshed,
    checked_at: all.length ? new Date(Math.min(...all)).toISOString() : null,
    tavily: t.map((r) => ({ slot: r.slot, state: r.state, used: n(r.plan_usage ?? r.key_usage), limit: n(r.plan_limit), renews: tavilyRenews })),
    firecrawl: f.map((r) => ({ slot: r.slot, state: r.state, remaining: n(r.remaining_credits), plan: n(r.plan_credits), renews: iso(r.period_end) })),
    llm: l.filter((r) => r.provider === "gemini" || r.provider === "grok"),
  }), { headers: CORS });
});
