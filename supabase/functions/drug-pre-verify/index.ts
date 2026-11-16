import { createClient } from "npm:@supabase/supabase-js@2";

// Called by the AFTER INSERT trigger on public.drug_pre (through pg_net), and by itself for retries.
// 1) if no source page is staged for the row yet (or this is a retry), run the normal search pipeline (drug-refresh)
//    for its name; a retry uses a different query wording so it can reach other pages/sources
// 2) process_drug_pre(): layered vote (>=3 sources; name -> ingredients -> strengths -> form -> manufacturer, >=2 agreeing
//    sources per layer), approve into drug_products, link ingredients, then delete the drug_pre row.
// 3) a layer that fails or conflicts is retried (claim_drug_pre_verify allows 3 attempts in total); after the last
//    attempt process_drug_pre sends it to drug_pre_review with every layer result attached.
// Rows that already have a staged page never start a new search on the first attempt, so this cannot loop.

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 3;

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Search wording per attempt. The NAME part stays the entered name (drug-refresh strips sizes/strengths from it and
// only uses them to order pages), so a different wording reaches different pages without breaking name matching.
function queryFor(pre: { drug_name: string; strength: string | null; pack_size: string | null }, attempt: number): string {
  const first = (pre.strength ?? "").split("+")[0].trim();
  if (attempt <= 1) return pre.drug_name;
  if (attempt === 2) return `${pre.drug_name} ${first}`.trim();
  return pre.pack_size ? `${pre.drug_name} ${pre.pack_size}` : `${first} ${pre.drug_name}`.trim();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, svc, { auth: { persistSession: false } });

  const { data: secret, error: sErr } = await db.rpc("get_drug_pre_verify_secret");
  const given = req.headers.get("x-verify-secret") ?? "";
  if (sErr || typeof secret !== "string" || !secret || !same(given, secret)) return json({ error: "forbidden" }, 403);

  let body: { pre_id?: unknown; retry?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const preId = typeof body.pre_id === "string" && UUID.test(body.pre_id) ? body.pre_id : null;
  if (!preId) return json({ error: "invalid_pre_id" }, 400);
  const forceSearch = body.retry === true;

  const { data: claimed, error: cErr } = await db.rpc("claim_drug_pre_verify", { p_pre_id: preId });
  if (cErr) { console.error("claim_error", cErr.message); return json({ error: "internal_error" }, 500); }
  if (!claimed) return json({ status: "skipped" });

  const fail = async (note: string) => {
    const { error } = await db.from("drug_pre").update({ verify_status: "failed", verify_note: note.slice(0, 500) })
      .eq("id", preId).eq("verify_status", "verifying");
    if (error) console.error("fail_mark_error", error.message);
  };

  const work = async () => {
    try {
      const pre = await db.from("drug_pre").select("drug_name,strength,pack_size,verify_attempts").eq("id", preId).maybeSingle();
      if (pre.error) throw new Error("pre_select: " + pre.error.message);
      if (!pre.data) return; // already gone
      const attempt = Number(pre.data.verify_attempts ?? 1);

      const staged = await db.from("drug_pre_payloads").select("id", { count: "exact", head: true })
        .eq("pre_id", preId).eq("status", "pending");
      if (staged.error) throw new Error("staged_count: " + staged.error.message);

      if (!staged.count || forceSearch) {
        const query = queryFor(pre.data, attempt);
        const nq = await db.rpc("normalize_text", { t: query });
        if (nq.error) throw new Error("normalize: " + nq.error.message);
        const job = await db.from("search_jobs")
          .insert({ query, normalized_query: nq.data, search_type: "brand", job_kind: "full", status: "queued" })
          .select("id").single();
        if (job.error && job.error.code === "23505") {
          // the same query is already being searched: wait for that job instead of starting another
          for (let i = 0; i < 26; i++) {
            await sleep(5000);
            const act = await db.from("search_jobs").select("id")
              .eq("normalized_query", nq.data).eq("search_type", "brand").eq("job_kind", "full")
              .in("status", ["queued", "running"]).limit(1);
            if (!act.data?.length) break;
          }
        } else if (job.error) {
          throw new Error("job_insert: " + job.error.message);
        } else {
          const r = await fetch(`${url}/functions/v1/drug-refresh`, {
            method: "POST",
            headers: { Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
            body: JSON.stringify({ job_id: job.data.id }),
            signal: AbortSignal.timeout(140_000),
          });
          await r.text();
        }
      }

      const { data, error } = await db.rpc("process_drug_pre", { p_pre_id: preId });
      if (error) throw new Error("process: " + error.message);
      console.log("processed", preId, "attempt", attempt, JSON.stringify(data));

      // A failed or conflicting layer is searched again (new wording) until the attempts are used up.
      const r = data as { status?: string; retryable?: boolean } | null;
      if (r?.status === "needs_review" && r.retryable === true && attempt < MAX_ATTEMPTS) {
        const reset = await db.from("drug_pre").update({ verify_status: "new" })
          .eq("id", preId).eq("verify_status", "failed").lt("verify_attempts", MAX_ATTEMPTS).select("id");
        if (reset.error) throw new Error("retry_reset: " + reset.error.message);
        if (reset.data?.length) {
          const nr = await fetch(`${url}/functions/v1/drug-pre-verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-verify-secret": secret as string },
            body: JSON.stringify({ pre_id: preId, retry: true }),
            signal: AbortSignal.timeout(20_000),
          });
          await nr.text();
        }
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.error("verify_error", preId, m);
      await fail("verification error: " + m);
    }
  };

  // respond right away; the pg_net caller does not wait for the search
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil(work());
  return json({ status: "accepted" }, 202);
});
