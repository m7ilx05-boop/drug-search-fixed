import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Which search job a database client is working for, so every provider call made through it can be written against that job.
const jobOf = new WeakMap<object, string>();
export function bindJob(db: SupabaseClient, jobId: string) { jobOf.set(db, jobId); }

export type UsageRow = {
  provider: "tavily" | "firecrawl"; slot: string; kind: string; status: number;
  credits?: number | null; credits_estimated?: boolean; meta?: Record<string, unknown>;
};

// Best effort: one row per provider API call in key_usage_log. A logging problem must never fail or change a search.
export async function logUsage(db: SupabaseClient, row: UsageRow): Promise<void> {
  try {
    const { error } = await db.from("key_usage_log").insert({ job_id: jobOf.get(db) ?? null, ...row });
    if (error) console.error("usage_log_error", error.message);
  } catch (e) {
    console.error("usage_log_exception", e instanceof Error ? e.message : String(e));
  }
}
