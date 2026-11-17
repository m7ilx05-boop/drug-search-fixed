import { createClient } from "npm:@supabase/supabase-js@2";

// ema-sync: downloads the official EMA medicines JSON and stores the few fields we need in ema_medicine.
//   action "peek" {} -> downloads, writes nothing, returns the shape of the file (count, top-level keys, first item) so the format can be checked
//   action "sync" {} -> downloads and upserts; skipped when the last sync is under 6 hours old (the EMA file itself changes twice a day)
// ema_medicine is only a FALLBACK source for ingredient-class (used when RxClass and openFDA found nothing).

const EMA_URL = "https://www.ema.europa.eu/en/documents/report/medicines-output-medicines_json-report_en.json";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// a value may be a string, a list of strings or missing
const str = (v: unknown): string | null => {
  if (v == null) return null;
  if (Array.isArray(v)) { const s = v.map((x) => String(x ?? "").trim()).filter(Boolean).join("; "); return s || null; }
  const s = String(v).trim();
  return s || null;
};
const parts = (s: string | null): string[] =>
  (s ?? "").toLowerCase().replace(/\([^)]*\)/g, " ").split(/\s*[;\/+]\s*|,\s+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
const toDate = (v: unknown): string | null => {
  const s = str(v); if (!s) return null;
  const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString();
};

async function download(): Promise<{ top: string[]; items: Record<string, unknown>[] }> {
  const res = await fetch(EMA_URL, { headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: "application/json,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9",
  }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`ema_http_${res.status} retry-after=${res.headers.get("retry-after") ?? "-"} server=${res.headers.get("server") ?? "-"} ${snippet}`);
  }
  const d = await res.json();
  let arr: unknown = d;
  let top: string[] = [];
  if (!Array.isArray(d) && d && typeof d === "object") {
    top = Object.keys(d as object);
    arr = Object.values(d as Record<string, unknown>).find((v) => Array.isArray(v)) ?? [];
  }
  const items = (arr as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && "name_of_medicine" in (x as object));
  return { top, items };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: { action?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const action = typeof body.action === "string" ? body.action : "";
  if (!["peek", "sync"].includes(action)) return json({ error: "invalid_action", allowed: ["peek", "sync"] }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await db.rpc("check_rate_limit", { p_key: `ema-${action}:${ip}`, p_limit: 3, p_window_seconds: 60 });
  if (!rl.error && rl.data === false) return json({ error: "rate_limited" }, 429);

  try {
    if (action === "sync") {
      const last = await db.from("ema_medicine").select("synced_at").order("synced_at", { ascending: false }).limit(1);
      const t = last.data?.[0]?.synced_at ? new Date(last.data[0].synced_at as string).getTime() : 0;
      if (Date.now() - t < 6 * 3600 * 1000) return json({ skipped: "synced_recently", last_synced_at: last.data![0].synced_at });
    }
    const { top, items } = await download();
    if (action === "peek") {
      const first = items[0] ?? {};
      const sample = Object.fromEntries(Object.entries(first).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 120) : v]));
      const cats: Record<string, number> = {};
      for (const i of items) { const c = String(i.category ?? "?"); cats[c] = (cats[c] ?? 0) + 1; }
      return json({ top_level_keys: top, items: items.length, categories: cats, first_item_keys: Object.keys(first), first_item: sample });
    }
    const now = new Date().toISOString();
    const rows = items.map((i) => {
      const sub = str(i.active_substance) ?? str(i.international_non_proprietary_name_common_name);
      const name = str(i.name_of_medicine) ?? "";
      const p = parts(sub);
      return {
        ema_id: str(i.ema_product_number) ?? str(i.medicine_url) ?? name,
        name, category: str(i.category)?.toLowerCase() ?? null, medicine_status: str(i.medicine_status),
        active_substance: sub, substances: p, n_substances: p.length,
        atc_code: str(i.atc_code_human), pharmacotherapeutic_group: str(i.pharmacotherapeutic_group_human),
        therapeutic_indication: str(i.therapeutic_indication), medicine_url: str(i.medicine_url),
        source_updated_at: toDate(i.last_updated_date), synced_at: now,
      };
    }).filter((r) => r.name && r.ema_id);
    let saved = 0;
    for (let k = 0; k < rows.length; k += 300) {
      const up = await db.from("ema_medicine").upsert(rows.slice(k, k + 300), { onConflict: "ema_id" });
      if (up.error) { console.error("upsert_error", up.error.message); return json({ error: "db_error", saved }, 500); }
      saved += Math.min(300, rows.length - k);
    }
    return json({ synced: saved, downloaded: items.length });
  } catch (e) {
    console.error("ema_sync_error", e instanceof Error ? e.message : e);
    return json({ error: "sync_failed", detail: (e instanceof Error ? e.message : "error").slice(0, 200) }, 502);
  }
});
