import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { tavilySearch } from "./tavily.ts";
import { firecrawlScrapeJson } from "./firecrawl.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const UA = "Mozilla/5.0 (compatible; DrugKnowledgeVetBot/1.0)";
const TEST_TERMS = ["Panadol", "Mebo"];
const NON_PRODUCT = /\/(blog|blogs|article|articles|news|category|product-category|tag|brand|brands|page\/\d+)(\/|$)/;
const SAMPLE_PATHS = ["/", "/product/", "/products/", "/shop/", "/eg-ar/nowProduct/", "/p/"];

type Src = {
  id: string; source_name: string; domain: string; website_url: string | null;
  enabled: boolean; access_policy: string; notes: string | null;
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, " ").trim();
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const pathOf = (u: string) => { try { return new URL(u).pathname.toLowerCase(); } catch { return ""; } };
const hostMatches = (host: string, domain: string) => {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return host === d || host.endsWith("." + d);
};

async function get(url: string, ms = 15000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ar,en;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    const text = (await r.text()).slice(0, 600_000);
    return { ok: r.ok, status: r.status, text, ms: Date.now() - t0, err: null as string | null };
  } catch (e) {
    return { ok: false, status: 0, text: "", ms: Date.now() - t0, err: e instanceof Error ? e.name : "error" };
  }
}

// ---------- robots.txt ----------
function analyseRobots(text: string) {
  const groups: { agents: string[]; rules: [string, string][] }[] = [];
  let cur: { agents: string[]; rules: [string, string][] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const l = line.replace(/#.*/, "").trim();
    const m = l.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
    } else if (cur && (k === "disallow" || k === "allow")) cur.rules.push([k, v]);
  }
  const rules = groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules).filter(([, v]) => v !== "");
  // longest matching rule wins (standard robots.txt behaviour)
  const allowed = (path: string) => {
    let best: [string, string] | null = null;
    for (const r of rules) if (path.startsWith(r[1]) && (!best || r[1].length > best[1].length)) best = r;
    return !best || best[0] === "allow";
  };
  return { blocks_all: !allowed("/") && rules.some(([k, v]) => k === "disallow" && v === "/"), blocked_sample_paths: SAMPLE_PATHS.filter((p) => !allowed(p)), rules_for_all: rules.length };
}

// ---------- terms of use ----------
const stripHtml = (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function termsLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 12) {
    const label = stripHtml(m[2]);
    if (!/terms|condition|\btos\b|legal|polic|\u0627\u0644\u0634\u0631\u0648\u0637|\u0627\u0644\u0623\u062D\u0643\u0627\u0645|\u0627\u0644\u0627\u062D\u0643\u0627\u0645|\u0633\u064A\u0627\u0633\u0629|\u0627\u0644\u0627\u0633\u062A\u062E\u062F\u0627\u0645|\u0634\u0631\u0648\u0637/i.test(label + " " + m[1])) continue;
    try {
      const u = new URL(m[1], base);
      if (hostOf(u.href) !== hostOf(base)) continue;
      if (!out.includes(u.href)) out.push(u.href);
    } catch { /* ignore */ }
  }
  // pages that are really about terms of use first, privacy-only pages last
  return out.sort((a, b) => Number(/privacy|\u062e\u0635\u0648\u0635/i.test(a)) - Number(/privacy|\u062e\u0635\u0648\u0635/i.test(b))).slice(0, 3);
}

const TOPIC = /(scrap(?:e|er|ers|ing)|crawl(?:er|ers|ing)?|spider|web robot|\brobots?\b|\bbots?\b|automated (?:means|access|tool|tools|system|process|software|queries)|data[- ]mining|data extraction|harvest(?:ing)?|\u0627\u0633\u062A\u062E\u0631\u0627\u062C \u0627\u0644\u0628\u064A\u0627\u0646\u0627\u062A|\u0643\u0634\u0637|\u0627\u0644\u0632\u0648\u0627\u062D\u0641|\u0631\u0648\u0628\u0648\u062A|\u0628\u0631\u0627\u0645\u062C \u0622\u0644\u064A\u0629|\u0623\u062F\u0648\u0627\u062A \u0622\u0644\u064A\u0629|\u0628\u0634\u0643\u0644 \u0622\u0644\u064A|\u0627\u0644\u0627\u0633\u062A\u062E\u0631\u0627\u062C \u0627\u0644\u0622\u0644\u064A)/gi;
const PROHIBIT = /(prohibit|forbidden|not (?:be )?(?:allowed|permitted)|may not|must not|shall not|strictly|unauthori[sz]ed|without (?:prior )?(?:written )?(?:consent|permission)|\u064A\u062D\u0638\u0631|\u064A\u0645\u0646\u0639|\u063A\u064A\u0631 \u0645\u0633\u0645\u0648\u062D|\u0644\u0627 \u064A\u062C\u0648\u0632|\u0645\u062D\u0638\u0648\u0631|\u0645\u0645\u0646\u0648\u0639|\u062F\u0648\u0646 \u0625\u0630\u0646)/i;

function findProhibitions(text: string): string[] {
  const hits: string[] = [];
  TOPIC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOPIC.exec(text)) && hits.length < 5) {
    const a = Math.max(0, m.index - 180), b = Math.min(text.length, m.index + m[0].length + 180);
    const win = text.slice(a, b);
    if (PROHIBIT.test(win)) hits.push(win.slice(0, 260));
  }
  return hits;
}

// ---------- extraction test ----------
const SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          product_name: { type: "string" }, manufacturer: { type: "string" }, dosage_form: { type: "string" },
          pack_size: { type: "string" }, ingredients: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        },
        required: ["product_name"],
      },
    },
  },
  required: ["products"],
};
const PROMPT = "Extract the pharmaceutical products on this page. Use only what the page explicitly states; omit anything it does not state. Return at most 5 products.";

async function extractionTest(db: SupabaseClient, src: Src) {
  let url: string | null = null, expect: string | null = null, via = "stored_page";
  const ev = await db.from("data_evidence").select("source_url,field_value").eq("source_id", src.id).eq("field_name", "product_name")
    .order("extracted_at", { ascending: false }).limit(1);
  if (ev.data?.[0]?.source_url) { url = ev.data[0].source_url; expect = ev.data[0].field_value; }
  if (!url) {
    via = "search_discovery";
    for (const term of TEST_TERMS) {
      try {
        const r = await tavilySearch(db, term, { includeDomains: [src.domain] });
        const hit = r.results.find((x: { url: string; title: string }) =>
          hostMatches(hostOf(x.url), src.domain) && !NON_PRODUCT.test(pathOf(x.url)) && pathOf(x.url).length > 3 &&
          norm(`${x.title} ${decodeURIComponent(pathOf(x.url))}`).includes(term.toLowerCase()));
        if (hit) { url = hit.url; expect = term; break; }
      } catch (e) { return { ok: false, reason: "search_failed", detail: e instanceof Error ? e.message.slice(0, 100) : "error" }; }
    }
  }
  if (!url || !expect) return { ok: false, reason: "no_test_page_found", via };
  try {
    const r = await firecrawlScrapeJson(db, url, SCHEMA, PROMPT);
    if (!r.ok) return { ok: false, reason: r.reason, url, via };
    const list = ((r.json as { products?: Record<string, unknown>[] })?.products ?? []).filter((p) => typeof p?.product_name === "string");
    const names = list.map((p) => String(p.product_name));
    const e = norm(expect);
    const matched = list.find((p) => { const n = norm(String(p.product_name)); return n.length >= 3 && (n.includes(e) || e.includes(n)); });
    return {
      ok: !!matched, via, url, expected: expect, got: names.slice(0, 5),
      has_manufacturer: list.some((p) => !!p.manufacturer), has_form: list.some((p) => !!p.dosage_form),
      has_ingredients: list.some((p) => Array.isArray(p.ingredients) && p.ingredients.length > 0),
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 100) : "error", url, via };
  }
}

// ---------- health status ----------
async function recompute(db: SupabaseClient, srcId: string) {
  const { data } = await db.from("source_health_checks").select("ok").eq("source_id", srcId).order("checked_at", { ascending: false }).limit(3);
  const rows = data ?? [];
  if (!rows.length) return;
  const status = rows.length === 3 && rows.every((r) => !r.ok) ? "down" : !rows[0].ok ? "degraded" : "healthy";
  await db.from("search_sources").update({ health_status: status, last_health_at: new Date().toISOString() }).eq("id", srcId);
}

async function runHealth(db: SupabaseClient, src: Src) {
  const r = await get(src.website_url ?? `https://${src.domain}/`);
  // reachable = the server answered (a 403 for our bot is not an outage); down = no answer or a 5xx
  const ok = r.status > 0 && r.status < 500;
  await db.from("source_health_checks").insert({
    source_id: src.id, check_type: "http", ok, http_status: r.status || null, latency_ms: r.ms,
    detail: { error: r.err, bot_blocked: [401, 403, 429].includes(r.status) },
  });
  await recompute(db, src.id);
}

async function runProbe(db: SupabaseClient, src: Src) {
  const t0 = Date.now();
  const x = await extractionTest(db, src);
  await db.from("source_health_checks").insert({
    source_id: src.id, check_type: "extraction", ok: x.ok, latency_ms: Date.now() - t0, detail: x,
  });
  await recompute(db, src.id);
}

async function runVet(db: SupabaseClient, src: Src, trigger: string) {
  const base = src.website_url ?? `https://${src.domain}/`;
  const origin = new URL(base).origin;
  const home = await get(base);
  const reachable = home.status > 0 && home.status < 500;

  const rob = await get(origin + "/robots.txt");
  const robots = rob.ok && /user-agent/i.test(rob.text)
    ? { fetched: true, ...analyseRobots(rob.text) }
    : { fetched: false, status: rob.status, blocks_all: false, blocked_sample_paths: [] as string[] };

  const links = home.text ? termsLinks(home.text, base) : [];
  const pages: { url: string; status: number; prohibitions: string[] }[] = [];
  for (const l of links) {
    const p = await get(l);
    pages.push({ url: l, status: p.status, prohibitions: p.ok ? findProhibitions(stripHtml(p.text)) : [] });
  }
  const tosChecked = pages.some((p) => p.status >= 200 && p.status < 400);
  const prohibitions = pages.flatMap((p) => p.prohibitions);

  const ext = reachable ? await extractionTest(db, src) : { ok: false, reason: "unreachable" };
  await db.from("source_health_checks").insert({
    source_id: src.id, check_type: "extraction", ok: ext.ok, detail: ext,
  });
  await recompute(db, src.id);

  const blocked = robots.blocks_all || prohibitions.length > 0;
  const verdict = !reachable ? "unreachable" : blocked ? "blocked" : !tosChecked || !robots.fetched ? "needs_review" : "no_prohibition_found";
  const e = ext as Record<string, unknown>;
  const score =
    (reachable ? 10 : 0) + (robots.fetched && !robots.blocks_all ? 15 : 0) + (tosChecked && !prohibitions.length ? 25 : 0) +
    (ext.ok ? 25 : 0) + (e.has_manufacturer ? 8 : 0) + (e.has_form ? 8 : 0) + (e.has_ingredients ? 9 : 0);

  let action = "none";
  if (verdict === "blocked") {
    action = src.enabled ? "disabled_and_restricted" : "kept_disabled";
    await db.from("search_sources").update({
      enabled: false, access_policy: "restricted", vetting_verdict: verdict, last_verified_at: new Date().toISOString(),
      notes: `${src.notes ?? ""} | Auto-restricted ${new Date().toISOString().slice(0, 10)}: ${robots.blocks_all ? "robots.txt disallows everything" : "terms of use appear to prohibit automated access"}. See source_vetting.`.trim(),
    }).eq("id", src.id);
  } else {
    await db.from("search_sources").update({ vetting_verdict: verdict, last_verified_at: new Date().toISOString() }).eq("id", src.id);
  }
  await db.from("source_vetting").insert({
    source_id: src.id, trigger, verdict, score,
    robots, tos: { pages, prohibitions, terms_pages_fetched: tosChecked }, extraction: ext, action_taken: action,
  });
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    for (;;) {
      const x = q.shift();
      if (!x) return;
      try { await fn(x); } catch (e) { console.error("source_job_error", e instanceof Error ? e.message : String(e)); }
    }
  }));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: s } = await db.from("app_secrets").select("value").eq("name", "cron_secret").maybeSingle();
  if (!secret || !s || secret !== s.value) return json({ error: "forbidden" }, 403);

  let body: { mode?: string; source_id?: string } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const mode = body.mode ?? "health";
  if (!["health", "probe", "vet"].includes(mode)) return json({ error: "invalid_mode" }, 400);

  let q = db.from("search_sources").select("id,source_name,domain,website_url,enabled,access_policy,notes");
  if (body.source_id) q = q.eq("id", body.source_id);
  else if (mode !== "vet") q = q.eq("enabled", true);
  else q = q.eq("enabled", true);
  const { data: sources, error } = await q;
  if (error) return json({ error: error.message }, 500);

  const work = pool((sources ?? []) as Src[], 3, (src) =>
    mode === "health" ? runHealth(db, src) : mode === "probe" ? runProbe(db, src) : runVet(db, src, body.source_id ? "manual" : "scheduled"));
  EdgeRuntime.waitUntil(work);
  return json({ accepted: true, mode, sources: (sources ?? []).length }, 202);
});
