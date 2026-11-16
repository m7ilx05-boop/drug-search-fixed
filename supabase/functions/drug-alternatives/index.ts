import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { dwaprices_id?: unknown; limit?: unknown; offset?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const id = Number(body.dwaprices_id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return json({ error: "invalid_id" }, 400);
  const limitRaw = body.limit == null ? 20 : Number(body.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.trunc(limitRaw))) : 20;
  const offRaw = body.offset == null ? 0 : Number(body.offset);
  const offset = Number.isFinite(offRaw) ? Math.max(0, Math.min(10000, Math.trunc(offRaw))) : 0;

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await db.rpc("check_rate_limit", { p_key: `alt:${ip}`, p_limit: 30, p_window_seconds: 60 });
  if (rl.error) { console.error("rate_limit_error", rl.error.message); return json({ error: "internal_error" }, 500); }
  if (rl.data === false) return json({ error: "rate_limited" }, 429);

  const { data, error } = await db.rpc("get_alternatives", { p_dwaprices_id: id, p_limit: limit + 1, p_offset: offset });
  if (error) { console.error("alternatives_error", error.message); return json({ error: "internal_error" }, 500); }

  const rows = (data ?? []) as Record<string, unknown>[];
  const has_more = rows.length > limit;
  const alternatives = rows.slice(0, limit);

  let reason: string | null = null;
  if (offset === 0 && alternatives.length === 0) {
    const r = await db.rpc("alternatives_eligibility", { p_dwaprices_id: id });
    if (r.error) console.error("eligibility_error", r.error.message);
    else reason = r.data as string;
  }

  return json({ dwaprices_id: id, count: alternatives.length, offset, has_more, reason, alternatives });
});
