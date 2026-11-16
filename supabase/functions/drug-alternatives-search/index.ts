import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const STALE_JOB_MS = 4 * 60_000;
const COOLDOWN_AFTER_COMPLETED_MS = 24 * 3600_000;
const COOLDOWN_AFTER_FAILED_MS = 2 * 60_000;
const ELIGIBLE = new Set(["ok", "ok_ingredient_only"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { dwaprices_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const id = Number(body.dwaprices_id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return json({ error: "invalid_id" }, 400);

  const supaUrl = Deno.env.get("SUPABASE_URL")!;
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supaUrl, svcKey, { auth: { persistSession: false } });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await db.rpc("check_rate_limit", { p_key: `altsearch:${ip}`, p_limit: 6, p_window_seconds: 60 });
  if (rl.error) { console.error("rate_limit_error", rl.error.message); return json({ error: "internal_error" }, 500); }
  if (rl.data === false) return json({ error: "rate_limited" }, 429);

  const el = await db.rpc("alternatives_eligibility", { p_dwaprices_id: id });
  if (el.error) { console.error("eligibility_error", el.error.message); return json({ error: "internal_error" }, 500); }
  const reason = el.data as string;
  if (reason === "not_found") return json({ error: "not_found" }, 404);
  if (!ELIGIBLE.has(reason)) return json({ error: "not_eligible", reason }, 422);

  const prod = await db.from("dwaprices_products").select("trade_name").eq("dwaprices_id", id).maybeSingle();
  if (prod.error || !prod.data) { console.error("product_error", prod.error?.message); return json({ error: "internal_error" }, 500); }

  const normalized = `alt:${id}`;
  const searchType = "auto";
  const jobKind = "alternatives";

  const reap = await db.from("search_jobs")
    .update({ status: "failed", error_message: "timed_out", completed_at: new Date().toISOString() })
    .in("status", ["queued", "running"]).lt("created_at", new Date(Date.now() - STALE_JOB_MS).toISOString());
  if (reap.error) console.error("reap_error", reap.error.message);

  const active = await db.from("search_jobs").select("id,status")
    .eq("normalized_query", normalized).eq("search_type", searchType).eq("job_kind", jobKind)
    .in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (active.data) return json({ dwaprices_id: id, job_id: active.data.id, status: active.data.status, reused: true });

  const recent = await db.from("search_jobs").select("id,status,completed_at,stats")
    .eq("normalized_query", normalized).eq("search_type", searchType).eq("job_kind", jobKind)
    .in("status", ["completed", "failed"]).order("completed_at", { ascending: false }).limit(1).maybeSingle();
  const r = recent.data;
  if (r?.completed_at) {
    const age = Date.now() - new Date(r.completed_at).getTime();
    const limit = r.status === "completed" ? COOLDOWN_AFTER_COMPLETED_MS : COOLDOWN_AFTER_FAILED_MS;
    if (age < limit) {
      return json({ dwaprices_id: id, job_id: r.id, status: r.status, cooldown: true });
    }
  }

  const ins = await db.from("search_jobs")
    .insert({
      query: prod.data.trade_name, normalized_query: normalized, search_type: searchType, job_kind: jobKind,
      status: "queued", stats: { alt_source_id: id },
    })
    .select("id,status").single();
  if (ins.error) {
    if (ins.error.code === "23505") {
      const ex = await db.from("search_jobs").select("id,status")
        .eq("normalized_query", normalized).eq("search_type", searchType).eq("job_kind", jobKind)
        .in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (ex.data) return json({ dwaprices_id: id, job_id: ex.data.id, status: ex.data.status, reused: true });
    }
    console.error("job_insert_error", ins.error.message);
    return json({ error: "internal_error" }, 500);
  }

  const runner = fetch(`${supaUrl}/functions/v1/drug-refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${svcKey}` },
    body: JSON.stringify({ job_id: ins.data.id }),
    signal: AbortSignal.timeout(120000),
  }).then(async (r2) => { if (!r2.ok) console.error("refresh_runner_http", r2.status); await r2.body?.cancel(); })
    .catch((e) => console.error("refresh_runner_error", e instanceof Error ? e.name : "error"));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(runner);

  return json({ dwaprices_id: id, job_id: ins.data.id, status: ins.data.status });
});
