import { createClient } from "npm:@supabase/supabase-js@2";
import { firecrawlScrapeMarkdown, FirecrawlUnavailable } from "./firecrawl.ts";
import { parseDwapricesMarkdown } from "./dwaprices.ts";

// Daily price watcher. Reads the public "latest price updates" table on the dwaprices.com home page,
// opens each listed product page with the same deterministic reader drug-refresh uses, and updates ONLY the price
// fields (current_price, old_price, price_updated_on) of products we already have. New products are reported, not inserted
// (they still go through the normal drug-refresh review path). Internal: needs the project's cron secret.
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const HOME = "https://dwaprices.com/";

// ids of /med.php?id=N links inside the "آخر التعديلات" section (falls back to the whole page, and says so)
function idsFromHome(md: string): { ids: number[]; scoped: boolean } {
  const start = md.search(/آخر التعديلات/);
  let scope = md, scoped = false;
  if (start >= 0) {
    const rest = md.slice(start + 12);
    const end = rest.search(/\n#{1,4}\s/);
    scope = end >= 0 ? rest.slice(0, end) : rest;
    scoped = true;
  }
  const seen = new Set<number>(), ids: number[] = [];
  for (const m of scope.matchAll(/med\.php\?id=(\d{1,9})/g)) {
    const id = Number(m[1]);
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return { ids, scoped };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: s } = await db.from("app_secrets").select("value").eq("name", "cron_secret").maybeSingle();
  if (!secret || !s || secret !== s.value) return json({ error: "forbidden" }, 403);

  let body: { dry_run?: boolean; limit?: number } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const dry = body.dry_run !== false;                       // dry run unless explicitly turned off
  const limit = Math.min(Math.max(Math.floor(Number(body.limit)) || 25, 1), 60);

  try {
    const home = await firecrawlScrapeMarkdown(db, HOME);
    if (!home.ok) return json({ error: "home_fetch_failed", reason: home.reason }, 502);
    const { ids, scoped } = idsFromHome(home.markdown);
    const sample = home.markdown.search(/آخر التعديلات/) >= 0
      ? home.markdown.slice(home.markdown.search(/آخر التعديلات/), home.markdown.search(/آخر التعديلات/) + 700) : home.markdown.slice(0, 400);
    if (dry) return json({ dry_run: true, home_chars: home.markdown.length, section_found: scoped, ids_found: ids.length, ids: ids.slice(0, 60), sample });

    const pick = ids.slice(0, limit);
    const have = await db.from("dwaprices_products").select("dwaprices_id,current_price,old_price,price_updated_on").in("dwaprices_id", pick);
    const known = new Map((have.data ?? []).map((r) => [r.dwaprices_id as number, r]));
    const out = { checked: 0, updated: 0, unchanged: 0, unknown_ids: [] as number[], failed: [] as { id: number; reason: string }[], changes: [] as unknown[] };

    for (const id of pick) {
      const row = known.get(id);
      if (!row) { out.unknown_ids.push(id); continue; }
      const url = `${HOME}med.php?id=${id}`;
      const page = await firecrawlScrapeMarkdown(db, url);
      out.checked++;
      if (!page.ok) { out.failed.push({ id, reason: page.reason }); continue; }
      const p = parseDwapricesMarkdown(page.markdown, url);
      if (!p || p.current_price == null) { out.failed.push({ id, reason: "unparsed" }); continue; }
      const same = Number(row.current_price) === p.current_price && Number(row.old_price ?? 0) === Number(p.old_price ?? 0)
        && (row.price_updated_on ?? null) === (p.price_updated_on ?? null);
      if (same) { out.unchanged++; continue; }
      const up = await db.from("dwaprices_products").update({
        current_price: p.current_price, old_price: p.old_price, price_updated_on: p.price_updated_on,
      }).eq("dwaprices_id", id);
      if (up.error) { out.failed.push({ id, reason: "db_" + up.error.message.slice(0, 60) }); continue; }
      out.updated++;
      out.changes.push({ id, name: p.trade_name, from: row.current_price, to: p.current_price, old: p.old_price, date: p.price_updated_on });
    }
    return json({ dry_run: false, ids_found: ids.length, section_found: scoped, ...out });
  } catch (e) {
    if (e instanceof FirecrawlUnavailable) return json({ error: "firecrawl_unavailable", detail: e.message }, 503);
    console.error("price_watch_error", e instanceof Error ? e.message : "error");
    return json({ error: "internal" }, 500);
  }
});
