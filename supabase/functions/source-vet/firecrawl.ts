import { kenv } from "./vault-env.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export class FirecrawlUnavailable extends Error {}

function slots(): string[] {
  return Object.keys(kenv.toObject())
    .filter((k) => /^firecrawl/i.test(k) && !/url|endpoint|host/i.test(k) && kenv.get(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function firstOfNextMonthUTC(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

async function mark(db: SupabaseClient, slot: string, status: number, until: string | null, err: string) {
  const { data } = await db.from("provider_key_state").select("fail_count").eq("provider", "firecrawl").eq("slot", slot).maybeSingle();
  const { error } = await db.from("provider_key_state").upsert({
    provider: "firecrawl", slot, exhausted_until: until, last_status: status, last_error: err,
    fail_count: (data?.fail_count ?? 0) + 1, updated_at: new Date().toISOString(),
  });
  if (error) console.error("fc_key_state_error", error.message);
}

export type ScrapeResult =
  | { ok: true; slot: string; json: unknown }
  | { ok: false; slot: string | null; reason: string };

export async function firecrawlScrapeJson(
  db: SupabaseClient, url: string, schema: unknown, prompt: string,
): Promise<ScrapeResult> {
  const all = slots();
  if (!all.length) return { ok: false, slot: null, reason: "no_firecrawl_key" };

  const { data: states } = await db.from("provider_key_state").select("slot, exhausted_until").eq("provider", "firecrawl");
  const blocked = new Set((states ?? [])
    .filter((s) => s.exhausted_until && new Date(s.exhausted_until).getTime() > Date.now())
    .map((s) => s.slot));
  const candidates = all.filter((s) => !blocked.has(s));
  if (!candidates.length) return { ok: false, slot: null, reason: "firecrawl_keys_cooling_down" };

  for (const slot of candidates) {
    let res: Response;
    try {
      res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kenv.get(slot)}` },
        body: JSON.stringify({ url, formats: [{ type: "json", schema, prompt }], timeout: 60000 }),
        signal: AbortSignal.timeout(75000),
      });
    } catch (e) {
      return { ok: false, slot, reason: "network" };
    }

    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.success && body?.data?.json != null) return { ok: true, slot, json: body.data.json };
      return { ok: false, slot, reason: "no_json_in_response" };
    }
    await res.body?.cancel();

    if (res.status === 402) { await mark(db, slot, 402, firstOfNextMonthUTC(), "credits_exhausted"); continue; }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(wait) && wait > 0 ? Math.min(wait, 600) * 1000 : 60_000;
      await mark(db, slot, 429, new Date(Date.now() + ms).toISOString(), "rate_limited");
      continue;
    }
    if (res.status === 401) { await mark(db, slot, 401, new Date(Date.now() + 30 * 864e5).toISOString(), "invalid_key"); continue; }
    return { ok: false, slot, reason: `http_${res.status}` };
  }
  return { ok: false, slot: null, reason: "all_firecrawl_keys_failed" };
}
