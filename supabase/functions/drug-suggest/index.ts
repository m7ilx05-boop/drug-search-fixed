import { kenv } from "./vault-env.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { nameMentioned, rankCandidates, type Item } from "./naming.ts";

// Internal helper for drug-job-status: ranks "did you mean" spellings for an English drug name that matched nothing.
// 1) rank names found in the titles the failed job already stored (free);
// 2) only when that finds nothing, ONE extra Tavily search on the enabled Egyptian sources, ranked on title + snippet.
// Suggestions only: nothing here writes to the product tables.

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function tavilySlots(): string[] {
  return Object.keys(kenv.toObject())
    .filter((k) => /^tavily/i.test(k) && kenv.get(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
const firstOfNextMonthUTC = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};
async function mark(db: SupabaseClient, slot: string, status: number, until: string | null, err: string) {
  const { data } = await db.from("provider_key_state").select("fail_count").eq("provider", "tavily").eq("slot", slot).maybeSingle();
  const { error } = await db.from("provider_key_state").upsert({
    provider: "tavily", slot, exhausted_until: until, last_status: status, last_error: err,
    fail_count: (data?.fail_count ?? 0) + 1, updated_at: new Date().toISOString(),
  });
  if (error) console.error("key_state_error", error.message);
}

async function eligibleDomains(db: SupabaseClient): Promise<string[]> {
  const out = new Set<string>();
  for (const intent of ["BRAND", "INGREDIENT"]) {
    const { data, error } = await db.rpc("get_sources_for_intent", { p_intent: intent });
    if (error) throw new Error("routes_error: " + error.message);
    for (const s of data ?? []) if (s.access_policy === "permitted" && s.extraction_method === "firecrawl" && s.domain) out.add(s.domain);
  }
  return [...out];
}

const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

async function searchItems(db: SupabaseClient, query: string, domains: string[]): Promise<Item[]> {
  const all = tavilySlots();
  if (!all.length) return [];
  const { data: states } = await db.from("provider_key_state").select("slot, exhausted_until").eq("provider", "tavily");
  const blocked = new Set((states ?? [])
    .filter((s) => s.exhausted_until && new Date(s.exhausted_until).getTime() > Date.now())
    .map((s) => s.slot));
  const candidates = all.filter((s) => !blocked.has(s));
  for (const slot of candidates) {
    let res: Response;
    try {
      res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kenv.get(slot)}` },
        body: JSON.stringify({ query, search_depth: "basic", max_results: 20, include_domains: domains }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      console.error("tavily_network", slot, e instanceof Error ? e.name : "error");
      continue;
    }
    if (res.ok) {
      const body = await res.json();
      return (body.results ?? []).map((r: { url?: string; title?: string; content?: string }) => ({
        text: `${String(r.title ?? "").slice(0, 200)} ${String(r.content ?? "").slice(0, 600)}`,
        domain: hostOf(String(r.url ?? "")) || undefined,
        egypt: true, // every domain searched is an enabled Egyptian source
      }));
    }
    await res.body?.cancel();
    console.error("tavily_http", slot, res.status);
    if (res.status === 432 || res.status === 433) await mark(db, slot, res.status, firstOfNextMonthUTC(), "credits_exhausted");
    else if (res.status === 429) await mark(db, slot, 429, new Date(Date.now() + 60_000).toISOString(), "rate_limited");
    else if (res.status === 401 || res.status === 403) await mark(db, slot, res.status, new Date(Date.now() + 30 * 864e5).toISOString(), "invalid_key");
  }
  return [];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = kenv.get("SUPABASE_URL")!;
  const svc = kenv.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // internal-only: callers must present the service role key
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token !== svc) return json({ error: "forbidden" }, 403);

  let body: { query?: unknown; items?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (query.length < 2 || query.length > 100) return json({ error: "invalid_query" }, 400);

  const stored: Item[] = (Array.isArray(body.items) ? body.items : []).slice(0, 80).flatMap((x) => {
    const it = x as { text?: unknown; domain?: unknown };
    if (typeof it?.text !== "string") return [];
    return [{ text: it.text.slice(0, 300), domain: typeof it.domain === "string" ? it.domain.slice(0, 80) : undefined, egypt: true }];
  });

  try {
    if (nameMentioned(query, stored)) return json({ ranked: [], used_search: false, name_found: true });
    let ranked = rankCandidates(query, stored);
    let usedSearch = false;
    if (!ranked.length) {
      const db = createClient(url, svc, { auth: { persistSession: false } });
      const domains = await eligibleDomains(db);
      if (domains.length) {
        const found = await searchItems(db, query, domains);
        usedSearch = true;
        if (nameMentioned(query, found)) return json({ ranked: [], used_search: true, name_found: true });
        ranked = rankCandidates(query, [...stored, ...found]);
      }
    }
    return json({ ranked, used_search: usedSearch, name_found: false });
  } catch (e) {
    console.error("suggest_error", e instanceof Error ? e.message : String(e));
    return json({ ranked: [], used_search: false, error: "internal_error" }, 500);
  }
});
