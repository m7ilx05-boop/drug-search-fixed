import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export class ProviderExhausted extends Error {}

function tavilySlots(): string[] {
  return Object.keys(Deno.env.toObject())
    .filter((k) => /^tavily/i.test(k) && Deno.env.get(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function firstOfNextMonthUTC(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

async function mark(db: SupabaseClient, slot: string, status: number, until: string | null, err: string | null) {
  const { data } = await db.from("provider_key_state").select("fail_count").eq("provider", "tavily").eq("slot", slot).maybeSingle();
  const { error } = await db.from("provider_key_state").upsert({
    provider: "tavily", slot, exhausted_until: until, last_status: status, last_error: err,
    fail_count: (data?.fail_count ?? 0) + 1, updated_at: new Date().toISOString(),
  });
  if (error) console.error("key_state_error", error.message);
}

export async function tavilySearch(db: SupabaseClient, query: string, opts?: { includeDomains?: string[] }) {
  const all = tavilySlots();
  if (!all.length) throw new ProviderExhausted("no Tavily secret found");
  const { data: states } = await db.from("provider_key_state").select("slot, exhausted_until").eq("provider", "tavily");
  const blocked = new Set((states ?? [])
    .filter((s) => s.exhausted_until && new Date(s.exhausted_until).getTime() > Date.now())
    .map((s) => s.slot));

  const candidates = all.filter((s) => !blocked.has(s));
  if (!candidates.length) throw new ProviderExhausted("all Tavily keys are cooling down");

  const payload: Record<string, unknown> = { query, search_depth: "basic", max_results: 20 };
  if (opts?.includeDomains?.length) payload.include_domains = opts.includeDomains;

  for (const slot of candidates) {
    let res: Response;
    try {
      res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get(slot)}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      console.error("tavily_network", slot, e instanceof Error ? e.name : "error");
      continue;
    }

    if (res.ok) {
      const body = await res.json();
      const results = (body.results ?? []).map((r: { url: string; title: string; score: number }) => ({
        url: r.url, title: r.title, score: r.score,
      }));
      return { slot, results };
    }
    await res.body?.cancel();
    console.error("tavily_http", slot, res.status);

    if (res.status === 432 || res.status === 433) {
      await mark(db, slot, res.status, firstOfNextMonthUTC(), "credits_exhausted");
    } else if (res.status === 429) {
      await mark(db, slot, 429, new Date(Date.now() + 60_000).toISOString(), "rate_limited");
    } else if (res.status === 401 || res.status === 403) {
      await mark(db, slot, res.status, new Date(Date.now() + 30 * 864e5).toISOString(), "invalid_key");
    }
  }
  throw new ProviderExhausted("all Tavily keys failed");
}
