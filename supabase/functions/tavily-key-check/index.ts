// Checks every TAVILY* secret against Tavily's /usage endpoint and stores the result
// (slot name + numbers only; a key is never returned, logged or stored).
// Auth: header x-check-token must equal app_secrets.cron_secret.
//
// v30: keys are checked in small batches (Tavily blocks bursts with 429), a 429 is retried once,
// and a transient failure (429 / timeout / 5xx) no longer wipes the last good numbers:
// only http_status, error and checked_at are updated for that slot.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

const BATCH = 3;
const BATCH_DELAY_MS = 1200;
const RETRY_DELAY_MS = 2500;

const num = (v: unknown) => (typeof v === "number" ? v : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function authorized(req: Request) {
  const t = req.headers.get("x-check-token");
  if (!t) return false;
  const r = await fetch(`${SB_URL}/rest/v1/app_secrets?name=eq.cron_secret&select=value`, { headers: sbHeaders });
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows[0]?.value === t;
}

type Result = {
  slot: string; http_status: number; state: string; key_usage: number | null; key_limit: number | null;
  plan: string | null; plan_usage: number | null; plan_limit: number | null; error: string | null;
};

async function checkOnce(slot: string): Promise<Result> {
  const base: Result = { slot, http_status: 0, state: "unknown", key_usage: null, key_limit: null,
    plan: null, plan_usage: null, plan_limit: null, error: null };
  try {
    const r = await fetch("https://api.tavily.com/usage", {
      headers: { Authorization: `Bearer ${Deno.env.get(slot)}` },
      signal: AbortSignal.timeout(15000),
    });
    const b = await r.json().catch(() => null);
    base.http_status = r.status;
    const k = b?.key ?? {}, a = b?.account ?? {};
    base.key_usage = num(k.usage); base.key_limit = num(k.limit);
    base.plan = typeof a.current_plan === "string" ? a.current_plan.slice(0, 40) : null;
    base.plan_usage = num(a.plan_usage); base.plan_limit = num(a.plan_limit);
    if (r.ok) {
      const keyOut = base.key_limit !== null && base.key_usage !== null && base.key_usage >= base.key_limit;
      const planOut = base.plan_limit !== null && base.plan_usage !== null && base.plan_usage >= base.plan_limit
        && !(num(a.paygo_limit) && (num(a.paygo_usage) ?? 0) < (num(a.paygo_limit) as number));
      base.state = keyOut || planOut ? "exhausted" : "active";
    } else {
      base.error = String(b?.detail?.error ?? b?.error ?? "").slice(0, 120) || null;
      base.state = r.status === 401 || r.status === 403 ? "invalid"
        : r.status === 432 || r.status === 433 ? "exhausted"
        : r.status === 429 ? "rate_limited" : "error";
    }
  } catch (e) {
    base.state = "error";
    base.error = e instanceof Error ? e.name : "error";
  }
  return base;
}

async function checkSlot(slot: string): Promise<Result> {
  let r = await checkOnce(slot);
  if (r.state === "rate_limited") {
    await sleep(RETRY_DELAY_MS);
    r = await checkOnce(slot);
  }
  return r;
}

// definitive answers describe the key itself; everything else is a transient check failure
const isDefinitive = (s: string) => s === "active" || s === "exhausted" || s === "invalid";

async function store(results: Result[]) {
  const now = new Date().toISOString();
  const good = results.filter((r) => isDefinitive(r.state));
  const bad = results.filter((r) => !isDefinitive(r.state));

  if (good.length) {
    await fetch(`${SB_URL}/rest/v1/tavily_key_checks?on_conflict=slot`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(good.map((r) => ({ ...r, checked_at: now }))),
    });
  }
  if (bad.length) {
    // create the row only if it never existed, then touch just the diagnostic columns
    await fetch(`${SB_URL}/rest/v1/tavily_key_checks?on_conflict=slot`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(bad.map((r) => ({ ...r, checked_at: now }))),
    });
    await Promise.all(bad.map((r) =>
      fetch(`${SB_URL}/rest/v1/tavily_key_checks?slot=eq.${encodeURIComponent(r.slot)}`, {
        method: "PATCH",
        headers: { ...sbHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ http_status: r.http_status, error: r.error, checked_at: now }),
      })));
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST" || !(await authorized(req))) return json({ error: "forbidden" }, 403);

  const slots = Object.keys(Deno.env.toObject())
    .filter((k) => /^tavily/i.test(k) && Deno.env.get(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const results: Result[] = [];
  for (let i = 0; i < slots.length; i += BATCH) {
    if (i > 0) await sleep(BATCH_DELAY_MS);
    results.push(...await Promise.all(slots.slice(i, i + BATCH).map(checkSlot)));
  }

  if (results.length) await store(results);

  const summary: Record<string, number> = {};
  for (const r of results) summary[r.state] = (summary[r.state] ?? 0) + 1;
  return json({ count: results.length, summary, results });
});
