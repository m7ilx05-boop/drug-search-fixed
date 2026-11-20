import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { logUsage } from "./usage.ts";

// Thrown when no Firecrawl key can be used right now (missing, cooling down, or all rejected).
export class FirecrawlUnavailable extends Error {}

// Secrets whose NAME starts with FIRECRAWL (any case). Only names are read; values are never logged.
function slots(): string[] {
  return Object.keys(Deno.env.toObject())
    .filter((k) => /^firecrawl/i.test(k) && !/url|endpoint|host/i.test(k) && Deno.env.get(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Round-robin start position. Every call begins at a different key, so the load is spread over all usable keys
// instead of always hitting the first ones (Firecrawl_16, _17, _18 ...). The counter starts at a random value so
// separate function instances do not all begin at the same key. The cursor moves synchronously, so parallel
// page workers inside one job get different start keys.
let rrCursor = Math.floor(Math.random() * 1_000_000);
function rotate<T>(list: T[]): T[] {
  if (list.length < 2) return list;
  const start = rrCursor++ % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
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

export type MarkdownResult =
  | { ok: true; slot: string; markdown: string }
  | { ok: false; slot: string | null; reason: string };

type RawScrape =
  | { ok: true; slot: string; body: { success?: boolean; data?: { json?: unknown; markdown?: unknown } } | null }
  | { ok: false; slot: string | null; reason: string };

// Firecrawl v2 /scrape with key rotation. `formats` decides what comes back (JSON extraction or plain markdown).
async function scrapeRaw(db: SupabaseClient, url: string, formats: unknown[], extra: Record<string, unknown> = {}): Promise<RawScrape> {
  const all = slots();
  if (!all.length) throw new FirecrawlUnavailable("no Firecrawl secret found");

  const { data: states } = await db.from("provider_key_state").select("slot, exhausted_until").eq("provider", "firecrawl");
  const blocked = new Set((states ?? [])
    .filter((s) => s.exhausted_until && new Date(s.exhausted_until).getTime() > Date.now())
    .map((s) => s.slot));
  const candidates = rotate(all.filter((s) => !blocked.has(s)));
  if (!candidates.length) throw new FirecrawlUnavailable("all Firecrawl keys are cooling down");

  // for key_usage_log: JSON extraction costs more credits than a plain markdown scrape
  const kind = formats.some((f) => typeof f === "object") ? "scrape_json" : "scrape_markdown";
  const shortUrl = url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 160);

  for (const slot of candidates) {
    let res: Response;
    try {
      res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get(slot)}` },
        body: JSON.stringify({ url, formats, ...extra, timeout: 60000 }),
        signal: AbortSignal.timeout(75000),
      });
    } catch (e) {
      console.error("fc_network", slot, e instanceof Error ? e.name : "error");
      await logUsage(db, { provider: "firecrawl", slot, kind, status: 0, credits: 0, meta: { url: shortUrl, err: "network" } });
      return { ok: false, slot, reason: "network" };
    }

    if (res.ok) {
      const body = await res.json().catch(() => null);
      // the credits the API reports when it does; otherwise the usual price (1 for markdown, 5 for JSON extraction), marked as an estimate
      const used = Number((body as { data?: { metadata?: { creditsUsed?: unknown } } } | null)?.data?.metadata?.creditsUsed);
      const real = Number.isFinite(used) && used > 0;
      await logUsage(db, { provider: "firecrawl", slot, kind, status: 200, credits: real ? used : (kind === "scrape_json" ? 5 : 1), credits_estimated: !real, meta: { url: shortUrl } });
      return { ok: true, slot, body };
    }
    await res.body?.cancel();
    console.error("fc_http", slot, res.status);
    await logUsage(db, { provider: "firecrawl", slot, kind, status: res.status, credits: 0, meta: { url: shortUrl } });

    // Key-level failures: mark the slot and try the next key.
    if (res.status === 402) {
      await mark(db, slot, 402, firstOfNextMonthUTC(), "credits_exhausted");
      continue;
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(wait) && wait > 0 ? Math.min(wait, 600) * 1000 : 60_000;
      await mark(db, slot, 429, new Date(Date.now() + ms).toISOString(), "rate_limited");
      continue;
    }
    if (res.status === 401) {
      await mark(db, slot, 401, new Date(Date.now() + 30 * 864e5).toISOString(), "invalid_key");
      continue;
    }
    // Anything else (403 blocked site, 408 timeout, 5xx) is a problem with this page, not the key.
    return { ok: false, slot, reason: `http_${res.status}` };
  }
  throw new FirecrawlUnavailable("all Firecrawl keys failed");
}

// JSON extraction: formats: [{ type: "json", schema, prompt }].
export async function firecrawlScrapeJson(
  db: SupabaseClient, url: string, schema: unknown, prompt: string,
): Promise<ScrapeResult> {
  const r = await scrapeRaw(db, url, [{ type: "json", schema, prompt }]);
  if (!r.ok) return r;
  if (r.body?.success && r.body?.data?.json != null) return { ok: true, slot: r.slot, json: r.body.data.json };
  return { ok: false, slot: r.slot, reason: "no_json_in_response" };
}

// Plain markdown of the whole page (no AI extraction). Used by the deterministic dwaprices.com reader.
export async function firecrawlScrapeMarkdown(db: SupabaseClient, url: string): Promise<MarkdownResult> {
  const r = await scrapeRaw(db, url, ["markdown"], { onlyMainContent: false });
  if (!r.ok) return r;
  const md = r.body?.data?.markdown;
  if (r.body?.success && typeof md === "string" && md.length > 0) return { ok: true, slot: r.slot, markdown: md };
  return { ok: false, slot: r.slot, reason: "no_markdown_in_response" };
}
