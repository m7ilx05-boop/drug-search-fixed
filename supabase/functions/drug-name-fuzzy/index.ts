import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// "Did you mean": closest real brand names (from the Egyptian drug reference list) to names a vision model may have misread.
// Read-only. Returns suggestions only; nothing here writes to any table.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: { name?: unknown; names?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const raw = Array.isArray(body.names) ? body.names : [body.name];
  const names = raw.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 60)).filter((x) => x.length >= 4).slice(0, 10);
  if (!names.length) return json({ error: "name_required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const results = await Promise.all(names.map(async (name) => {
    const { data, error } = await db.rpc("rx_fuzzy_names", { p_name: name, p_limit: 6 });
    if (error) { console.error("fuzzy_rpc", error.message); return { name, suggestions: [] }; }
    return {
      name,
      suggestions: (data ?? []).map((r: { brand: string; scientific_name: string | null; score: number | string }) => ({
        brand: r.brand, scientific_name: r.scientific_name, score: Number(r.score),
      })),
    };
  }));
  return json({ results });
});
