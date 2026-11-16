import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9_]{1,40}$/i;

// One explicit outcome so the UI never has to guess from a bare "completed":
//   queued | running | failed
//   completed + discovery_only: no_enabled_sources | no_pages_on_enabled_sources | only_non_product_pages | firecrawl_unavailable | extraction_failed
//   completed + extracted:      saved | partial | no_products_found | save_failed
//   completed + extracted_pending_review: pending_review (new products wait in drug_pre for approval)
function outcomeOf(status: string, s: Record<string, unknown>): string {
  if (status === "queued" || status === "running" || status === "failed") return status;
  if (status === "cancelled") return "cancelled";
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  if (s.stage === "discovery_only") return s.skipped_reason === "all_pages_failed" ? "extraction_failed" : String(s.skipped_reason ?? "discovery_only");
  if (s.stage === "extracted_pending_review") return "pending_review";
  if (s.stage === "extracted_no_match") return "no_products_found";
  if (s.stage === "extracted") {
    if (num(s.products_written) > 0) return num(s.pages_failed) > 0 ? "partial" : "saved";
    return num(s.products_found) > 0 ? "save_failed" : "no_products_found";
  }
  return "unknown";
}

// "Nothing found" only ever means: not visible on the sources we search. It never means the drug is unregistered.
const NOT_SEEN_AR = " ده معناه إنه مش ظاهر في المصادر اللي بنبحث فيها، مش إنه مش مسجّل أو مش موجود في السوق.";

// Codes whose meaning is "no matching product page was found"; the UI offers alternatives + manual entry for these.
const NO_RESULT = new Set([
  "only_articles", "nothing_related", "no_relevant_product_page", "no_pages_on_enabled_sources",
  "no_match_on_pages", "name_mismatch", "no_products_found", "only_non_product_pages",
]);

// Codes written by drug-refresh (and the legacy skipped_reason values).
const MESSAGE_AR: Record<string, string> = {
  only_articles: "لقينا مقالات عن الاسم ده، بس مفيش صفحة منتج مطابقة في الصيدليات المفعّلة.",
  only_non_product_pages: "لقينا مقالات بس، مفيش صفحة منتج مطابقة في الصيدليات المفعّلة.",
  nothing_related: "ملقيناش أي صفحة مرتبطة بالاسم ده في الصيدليات المفعّلة. اتأكد من الإملاء أو جرّب الاسم العلمي.",
  no_relevant_product_page: "لقينا صفحات منتجات في الصيدليات، بس ولا واحدة مرتبطة بالاسم ده.",
  no_pages_on_enabled_sources: "مفيش أي نتيجة للاسم ده في الصيدليات المفعّلة.",
  no_enabled_sources: "مفيش مصادر مفعّلة للبحث دلوقتي.",
  no_match_on_pages: "فحصنا صفحات المنتجات، بس ملقيناش منتج بنفس الاسم.",
  no_products_found: "فحصنا صفحات المنتجات، بس ملقيناش منتج بنفس الاسم.",
  name_mismatch: "ملقيناش الاسم ده بالظبط.",
  firecrawl_unavailable: "خدمة قراءة الصفحات مش متاحة دلوقتي، جرّب بعد شوية.",
  extraction_failed: "فشلت قراءة صفحات المنتجات، جرّب تاني بعد شوية.",
  saved: "تم حفظ النتائج.",
  pending_review: "لقينا منتجات جديدة، وهي دلوقتي في انتظار مراجعتك قبل ما تتضاف لقاعدة البيانات.",
};

function messageAr(
  status: string, errorMessage: string | null, code: string | null, didYouMean: string[], staged: number,
  pendingNames: string[] = [],
): string | null {
  if (status === "queued" || status === "running") return null;
  if (status === "failed") {
    return errorMessage === "provider_exhausted"
      ? "خدمة البحث وصلت للحد الأقصى دلوقتي، جرّب بعد شوية."
      : "حصلت مشكلة أثناء البحث، جرّب تاني.";
  }
  if (!code) return null;
  if (code === "pending_review" && pendingNames.length) {
    return `لقينا ${[...new Set(pendingNames)].join("، ")}، وهو في انتظار المراجعة قبل ما يتضاف لقاعدة البيانات.`;
  }
  let msg = MESSAGE_AR[code] ?? null;
  if (!msg) return null;
  if (NO_RESULT.has(code)) {
    if (didYouMean.length) msg += ` تقصد: ${didYouMean.join("، ")}؟`;
    msg += NOT_SEEN_AR;
  }
  if (code === "saved" && staged > 0) msg += ` وفيه ${staged} منتج جديد في انتظار المراجعة.`;
  return msg;
}

// ---- local fuzzy matching: names already stored here (pending review + approved products) ----------------
// Search results on the web are noise when a name is misspelled, so the names this system already knows are the
// most reliable source of a correction. Nothing is invented: only stored names are ever suggested.
const FUZZ_NORM = (t: string) => t.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, " ").trim();

function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const c = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(c);
      if (c < rowMin) rowMin = c;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const maxDist = (len: number) => (len <= 4 ? 1 : len <= 9 ? 2 : 3);

// Rough "how it sounds" key for Latin names (th->s, ph->f, z/c->s, v->f, vowels dropped, repeats collapsed),
// so spellings by ear (Zesromax / Zithromax, Ctal / Cetal) land on the same key.
function soundKey(s: string): string {
  if (!/^[a-z0-9]+$/.test(s)) return "";
  return s.replace(/ph/g, "f").replace(/th/g, "s").replace(/ck/g, "k").replace(/[zc]/g, "s").replace(/v/g, "f")
    .replace(/[aeiouy]/g, "").replace(/(.)\1+/g, "$1");
}

type LocalHit = { text: string; strong: boolean; dist: number };

async function localFuzzy(db: SupabaseClient, query: string): Promise<LocalHit[]> {
  const q = FUZZ_NORM(query);
  if (q.length < 3 || q.includes(" ")) return [];
  const names: string[] = [];
  const pre = await db.from("drug_pre").select("drug_name").limit(2000);
  if (pre.error) console.error("fuzzy_pre_error", pre.error.message);
  for (const r of pre.data ?? []) if (typeof r.drug_name === "string") names.push(r.drug_name);
  const prod = await db.from("drug_products").select("product_name").limit(2000);
  if (prod.error) console.error("fuzzy_products_error", prod.error.message);
  for (const r of prod.data ?? []) if (typeof r.product_name === "string") names.push(r.product_name);

  const qs = soundKey(q);
  const m = maxDist(q.length);
  const best = new Map<string, LocalHit>();
  for (const name of names) {
    const full = FUZZ_NORM(name);
    if (!full) continue;
    // compare with the whole name and with each word of it ("Panadol Migraine" -> "panadol")
    for (const c of [full, ...full.split(" ").filter((t) => t.length >= 3)]) {
      const d = editDistance(c, q, m + 1);
      if (d === 0) continue;
      const sound = qs.length >= 3 && soundKey(c) === qs;
      const ok = d <= 1 || (d <= m && c[0] === q[0]) || (sound && d <= m + 1);
      if (!ok) continue;
      const key = full;
      const prev = best.get(key);
      if (!prev || d < prev.dist) best.set(key, { text: name.trim(), strong: d <= 1 || sound, dist: d });
    }
  }
  return [...best.values()].sort((a, b) => a.dist - b.dist).slice(0, 5);
}

type Suggestion = { text: string; kind: "alias" | "spelling"; search_type: "auto" | "brand" | "brand_family" | "ingredient" };

// Alternative names to try. Only names already stored in this database (ingredient aliases, known brands)
// or spellings found in the search itself are offered; nothing is invented.
async function suggestionsFor(db: SupabaseClient, query: string, normalized: string, didYouMean: string[]): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const seen = new Set<string>([normalized, query.trim().toLowerCase()]);
  const add = (text: unknown, kind: Suggestion["kind"], search_type: Suggestion["search_type"]) => {
    if (typeof text !== "string") return;
    const t = text.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    if (t.length < 2 || t.length > 60) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ text: t, kind, search_type });
  };
  for (const d of didYouMean) add(d, "spelling", "auto");

  // other stored names of the same ingredient (English INN, Arabic name, merged aliases)
  const hit = await db.from("ingredient_aliases").select("ingredient_id").eq("normalized_alias", normalized).maybeSingle();
  if (hit.error) console.error("suggest_alias_error", hit.error.message);
  else if (hit.data) {
    const all = await db.from("ingredient_aliases").select("alias").eq("ingredient_id", hit.data.ingredient_id).limit(10);
    if (all.error) console.error("suggest_alias_all_error", all.error.message);
    for (const r of all.data ?? []) add(r.alias, "alias", "ingredient");
  }

  // close spellings of names already stored locally
  const sg = await db.rpc("suggest_drug_names", { p_query: query, p_limit: 5 });
  if (sg.error) console.error("suggest_names_error", sg.error.message);
  else {
    for (const r of (sg.data ?? []) as { suggestion: string; kind: string }[]) {
      add(r.suggestion, "spelling", r.kind === "ingredient" ? "ingredient" : r.kind === "brand_family" ? "brand_family" : "brand");
    }
  }
  return out.slice(0, 6);
}

// ---- ranked spelling candidates (phonetic + edit distance + number of sources) -------------------------------
// Computed by drug-suggest from the titles this job already stored; only when that finds nothing does it run one
// extra search and read the page snippets. The answer is cached in the job's stats so polling again costs nothing.
// Suggestions only: nothing here is written to the product tables and nothing is searched automatically.
type Ranked = { name: string; score: number; sources: number; egypt: boolean };

const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

const cleanRanked = (r: unknown): Ranked[] => (Array.isArray(r) ? r : []).flatMap((x) => {
  const v = x as Record<string, unknown>;
  return typeof v?.name === "string" && /^[A-Za-z]{3,30}$/.test(v.name) && typeof v.score === "number"
    ? [{ name: v.name, score: v.score, sources: typeof v.sources === "number" ? v.sources : 1, egypt: v.egypt === true }]
    : [];
}).slice(0, 5);

async function rankedFor(db: SupabaseClient, job: { id: string; query: string }, s: Record<string, unknown>): Promise<Ranked[]> {
  if (Array.isArray(s.ranked_suggestions)) return cleanRanked(s.ranked_suggestions);
  const items: { text: string; domain?: string }[] = [];
  for (const u of Array.isArray(s.urls) ? s.urls : []) {
    const x = u as { url?: unknown; title?: unknown };
    if (typeof x?.title === "string") items.push({ text: x.title, domain: typeof x.url === "string" ? hostOf(x.url) : undefined });
  }
  for (const r of Array.isArray(s.rejected_samples) ? s.rejected_samples : []) {
    const x = r as { name?: unknown };
    if (typeof x?.name === "string") items.push({ text: x.name });
  }
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/drug-suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ query: job.query, items }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) { await res.body?.cancel(); console.error("drug_suggest_http", res.status); return []; }
    const body = await res.json();
    const ranked = cleanRanked(body?.ranked);
    const up = await db.from("search_jobs").update({ stats: { ...s, ranked_suggestions: ranked } }).eq("id", job.id);
    if (up.error) console.error("ranked_cache_error", up.error.message);
    return ranked;
  } catch (e) {
    console.error("drug_suggest_error", e instanceof Error ? e.name : "error");
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let jobId: unknown;
  try { jobId = (await req.json()).job_id; } catch { return json({ error: "invalid_json" }, 400); }
  if (typeof jobId !== "string" || !UUID.test(jobId)) return json({ error: "invalid_job_id" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: job, error } = await db.from("search_jobs")
    .select("id,query,normalized_query,search_type,job_kind,status,progress,attempts,error_message,result_ids,created_at,started_at,completed_at,stats")
    .eq("id", jobId).maybeSingle();
  if (error) { console.error("job_status_error", error.message); return json({ error: "internal_error" }, 500); }
  if (!job) return json({ error: "job_not_found" }, 404);

  let results: unknown[] = [];
  if (job.status === "completed" && job.result_ids?.length) {
    const { data } = await db.from("drug_products")
      .select("*, brand_families(name), product_ingredients(strength_value,strength_unit,strength_per,chemical_form, active_ingredients(inn,arabic_name))")
      .in("id", job.result_ids);
    results = data ?? [];
  }

  const s = (job.stats ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const outcomeCode = typeof s.outcome_code === "string" && CODE.test(s.outcome_code) ? s.outcome_code : null;
  // "did you mean" words come from page text: keep them short, plain words only
  const didYouMean = Array.isArray(s.did_you_mean)
    ? s.did_you_mean.filter((x): x is string => typeof x === "string" && x.length <= 60 && /^[A-Za-z0-9\u0600-\u06FF]+$/.test(x)).slice(0, 3)
    : [];
  const outcome = outcomeOf(job.status, s);
  const code = outcomeCode ?? (outcome !== "unknown" ? outcome : null);
  const staged = num(s.products_staged);

  // names of products from THIS job that wait for human review (name + form only; page text is untrusted)
  let pendingProducts: { name: string; dosage_form: string | null }[] = [];
  if (job.status === "completed" && staged > 0) {
    const { data, error: pendErr } = await db.from("drug_pre_payloads")
      .select("payload").eq("job_id", job.id).eq("status", "pending").limit(5);
    if (pendErr) console.error("pending_products_error", pendErr.message);
    const clean = (v: unknown, max: number) => typeof v === "string"
      ? v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null;
    pendingProducts = (data ?? []).map((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return { name: clean(p.product_name, 80), dosage_form: clean(p.dosage_form, 40) };
    }).filter((x): x is { name: string; dosage_form: string | null } => !!x.name);
  }

  // articles found for this query: reading material, never product data (title + public link only)
  let references: { title: string | null; url: string }[] = [];
  if (job.status === "completed" && typeof s.editorial_saved === "number" && s.editorial_saved > 0) {
    const { data } = await db.from("editorial_references").select("title,url")
      .eq("normalized_query", job.normalized_query).eq("page_kind", "article")
      .order("relevance", { ascending: false, nullsFirst: false }).limit(5);
    references = (data ?? []).filter((r) => typeof r.url === "string" && /^https:\/\//.test(r.url));
  }

  // no matching product page: offer other names to try, and say manual entry is available
  const noResult = job.status === "completed" && !!code && NO_RESULT.has(code);
  const local = noResult ? await localFuzzy(db, job.query) : [];
  const ranked = noResult ? await rankedFor(db, job, s) : [];
  const suggestions = noResult
    ? await suggestionsFor(db, job.query, job.normalized_query, [...ranked.map((r) => r.name), ...didYouMean, ...local.map((c) => c.text)])
    : [];

  // one clearly-best corrected name: the UI may search it automatically (the product still waits for human review)
  let autoSearch: { text: string; search_type: string } | null = null;
  if (noResult) {
    const strong = new Map<string, string>();
    for (const d of didYouMean) strong.set(FUZZ_NORM(d), d);
    for (const c of local) if (c.strong) strong.set(FUZZ_NORM(c.text), c.text);
    if (strong.size === 1) autoSearch = { text: [...strong.values()][0], search_type: "auto" };
  }

  // names of the sources that were actually searched (public registry names only)
  const searchedSources = Array.isArray(s.eligible_sources)
    ? s.eligible_sources.filter((x): x is string => typeof x === "string" && x.length <= 60).slice(0, 10)
    : [];

  // expose only non-sensitive stats (never key slot names or raw provider data)
  const stats = {
    stage: s.stage ?? null, urls_found: s.urls_found ?? null,
    pages_attempted: s.pages_attempted ?? null, pages_scraped: s.pages_scraped ?? null, pages_failed: s.pages_failed ?? null,
    products_found: s.products_found ?? null, products_written: s.products_written ?? null, products_staged: s.products_staged ?? null,
    skipped_reason: s.skipped_reason ?? null, fallback_used: s.fallback_used ?? null,
    non_product_pages_skipped: s.non_product_pages_skipped ?? null, irrelevant_product_pages_skipped: s.irrelevant_product_pages_skipped ?? null,
    failures: Array.isArray(s.failures) ? s.failures.filter((f) => typeof f === "string" && CODE.test(f)).slice(0, 10) : [],
  };
  const { result_ids: _r, stats: _s, normalized_query: _n, ...rest } = job;
  return json({
    ...rest, outcome, outcome_code: outcomeCode,
    message_ar: messageAr(job.status, job.error_message ?? null, code, didYouMean, staged, pendingProducts.map((x) => x.name)),
    did_you_mean: didYouMean, ranked_suggestions: ranked, reading_material: references, stats, results,
    no_result: noResult, searched_sources: searchedSources, suggestions,
    manual_entry_available: noResult, products_staged: staged,
    pending_products: pendingProducts,
    auto_search: autoSearch,
  });
});
