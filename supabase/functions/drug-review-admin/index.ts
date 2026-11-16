import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// drug-review-admin: admin-only entry point for the review page.
// Auth: one shared password, sent in the x-review-password header, compared by SHA-256 hash against app_secrets.review_password_sha256.
// Actions:
//   list            pending product items of review_queue + their official lookup state + latest site submissions
//   search_official starts drug-official (internal, service-key only) for the item's brand; returns immediately
//   submit_site     validates a manually entered official-site URL, records it in official_site_submissions and verifies the
//                   domain in the background (same rules as drug-official: named like the brand/manufacturer, source-vet clean)
//   status          lookup state + submissions of one item (the page polls this)
//   list_pre        pending name-error rows (review_queue item_type=pre_review -> drug_pre_review)
//   edit_pre        edits raw_name / raw_strength / raw_form of a pending drug_pre_review row (does not touch status or drug_products)
// This function never writes drug_products or changes review_queue.status: promotion stays with the existing pipeline
// (drug-official -> stage_new_product / attach_official_to_product -> promote_payload -> register_official_families).

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-review-password",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256Hex = async (s: string) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

const VET_WAIT_MS = 45_000;
const TLD_WORDS = new Set(["com", "net", "org", "eg", "co", "gov", "edu", "info", "biz", "io", "app", "store", "shop", "health", "uk", "us", "ae", "sa"]);
const NOT_OFFICIAL = /(^|\.)(amazon|ebay|noon|jumia|facebook|instagram|twitter|x|youtube|tiktok|linkedin|wikipedia|pinterest|reddit|walmart|target|iherb|vitacost|drugs|webmd|healthline|goodrx|boots|cvs|walgreens|google|bing|yahoo|alibaba|aliexpress|temu|shein|olx|dubizzle|souq)\./i;
const REGION_WORDS = /^(arabia|egypt|eg|mena|gulf|me|middleeast)$/;
const BRAND_SUFFIX = /^(naturals?|official|health|healthcare|pharma|vitamins?|supplements?|global|usa|us|uk|group|labs?|nutrition|wellness)$/;

const hostMatches = (host: string, domain: string) => { const d = domain.toLowerCase().replace(/^www\./, ""); return host === d || host.endsWith("." + d); };
const coreLabel = (host: string) => {
  const l = host.replace(/^www\./, "").split(".");
  while (l.length > 1 && TLD_WORDS.has(l[l.length - 1])) l.pop();
  return l[l.length - 1] ?? "";
};
const namedLikeBrand = (host: string, brandKey: string) => {
  const core = coreLabel(host).replace(/[^a-z0-9]/g, "");
  return core === brandKey || (core.startsWith(brandKey) && REGION_WORDS.test(core.slice(brandKey.length)));
};
const ownBrand = (host: string, brandKey: string) => {
  const core = coreLabel(host).replace(/[^a-z0-9]/g, "");
  return namedLikeBrand(host, brandKey) || (core.startsWith(brandKey) && BRAND_SUFFIX.test(core.slice(brandKey.length)));
};
const marketOf = (u: string): "EG" | "MENA" | "GLOBAL" => {
  let h = "", p = "";
  try { const x = new URL(u); h = x.hostname.toLowerCase().replace(/^www\./, ""); p = decodeURIComponent(x.pathname.toLowerCase()); } catch { return "GLOBAL"; }
  if (/\.eg$/.test(h) || /^eg\./.test(h) || /\/(eg|en-eg|ar-eg|eg-ar|eg-en|egypt)(\/|$)/.test(p) || /egypt/.test(h)) return "EG";
  if (/(arabia|mena|gulf|middleeast|\.ae$|\.sa$|\.kw$|\.qa$)/.test(h) || /\/(mena|me|ae|sa)(\/|$)/.test(p)) return "MENA";
  return "GLOBAL";
};
const normWords = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// first Latin word of the product name = brand (same idea as drug-official, which needs a Latin trade name of 3+ letters)
function brandOf(name: unknown): { brand: string; key: string } | null {
  if (typeof name !== "string") return null;
  const first = name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ")[0] ?? "";
  const key = first.toLowerCase();
  return /^[a-z0-9]{3,}$/.test(key) && /[a-z]/.test(key) ? { brand: first, key } : null;
}

// accepts a bare domain or a URL; http(s) only, no credentials, no IPs, no single-label or local hosts
function parseSite(raw: unknown): { url: string; host: string } | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().slice(0, 300);
  if (!s) return null;
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (/^\d+(\.\d+)+$/.test(host) || /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host)) return null;
  u.hash = "";
  return { url: u.toString(), host };
}

const lookupView = (l: Record<string, unknown> | null) => {
  if (!l) return null;
  const s = (l.stats ?? {}) as Record<string, unknown>;
  return {
    status: l.status, domain: l.domain, market: l.market, checked_at: l.checked_at,
    products_staged: s.products_staged ?? null, already_approved: s.already_approved ?? null,
    official_attached: s.official_attached ?? null, pages_scraped: s.pages_scraped ?? null, pages_failed: s.pages_failed ?? null,
  };
};

async function callOfficial(baseUrl: string, svc: string, brand: string, force: boolean) {
  const r = await fetch(`${baseUrl}/functions/v1/drug-official`, {
    method: "POST", headers: { Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
    body: JSON.stringify({ brand, force }), signal: AbortSignal.timeout(20_000),
  });
  const b = await r.json().catch(() => null) as { status?: string; last?: string; error?: string } | null;
  return { http: r.status, status: b?.status ?? null, last: b?.last ?? null, error: b?.error ?? null };
}

// registers + vets the submitted domain exactly like drug-official does, then asks drug-official to run for the brand
async function verifySubmission(db: SupabaseClient, baseUrl: string, svc: string, sub: { id: string; url: string; host: string; brand: string; key: string; manuTokens: string[] }) {
  const finish = async (status: "matched" | "mismatch" | "failed", result: Record<string, unknown>) => {
    const { error } = await db.from("official_site_submissions").update({ status, result, checked_at: new Date().toISOString() }).eq("id", sub.id);
    if (error) console.error("submission_finish", error.message);
  };
  try {
    await db.from("official_site_submissions").update({ status: "fetching" }).eq("id", sub.id);
    const now = new Date().toISOString();
    const market = marketOf(sub.url);
    let src = (await db.from("search_sources").select("id,access_policy,enabled,extraction_method,notes").eq("domain", sub.host).maybeSingle()).data;
    if (!src) {
      const ins = await db.from("search_sources").insert({
        source_name: `${sub.brand} Official (${sub.host})`, domain: sub.host, website_url: `https://${sub.host}/`,
        source_category: "MANUFACTURER", supported_data: ["composition", "product_identity"], enabled: false,
        access_policy: "unverified", extraction_method: "unverified", reliability_score: 0.9,
        notes: `Submitted manually by admin for brand ${sub.brand} on ${now.slice(0, 10)} (market ${market})`,
      }).select("id,access_policy,enabled,extraction_method,notes").single();
      if (ins.error) throw new Error("source_insert: " + ins.error.message);
      src = ins.data;
    }
    const sourceId = src!.id as string;
    if (["restricted", "prohibited", "manual_only"].includes(src!.access_policy)) {
      await finish("mismatch", { reason: "source_blocked", access_policy: src!.access_policy, source_id: sourceId });
      return;
    }
    let verdict: string | null = "already_permitted";
    if (!(src!.access_policy === "permitted" && src!.enabled && src!.extraction_method === "firecrawl")) {
      const sec = await db.from("app_secrets").select("value").eq("name", "cron_secret").maybeSingle();
      if (!sec.data?.value) throw new Error("cron_secret missing");
      const started = new Date(Date.now() - 2000).toISOString();
      const r = await fetch(`${baseUrl}/functions/v1/source-vet`, {
        method: "POST", headers: { "x-cron-secret": sec.data.value, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "vet", source_id: sourceId }), signal: AbortSignal.timeout(20_000),
      });
      await r.text();
      verdict = null;
      for (let waited = 0; waited < VET_WAIT_MS && !verdict; waited += 5000) {
        await new Promise((res) => setTimeout(res, 5000));
        const v = await db.from("source_vetting").select("verdict").eq("source_id", sourceId).gte("checked_at", started).order("checked_at", { ascending: false }).limit(1);
        verdict = v.data?.[0]?.verdict ?? null;
      }
      const clean = verdict === "no_prohibition_found";
      const byName = verdict === "needs_review" && ownBrand(sub.host, sub.key);
      if (!clean && !byName) {
        await finish(verdict === "blocked" ? "mismatch" : "failed", { reason: verdict === "blocked" ? "blocked_by_robots_or_terms" : "vet_failed", verdict, source_id: sourceId });
        return;
      }
      const why = clean ? "source-vet found no prohibition (robots.txt and terms checked)" : "domain is named like the brand and source-vet found no prohibition (no terms page could be read)";
      const u = await db.from("search_sources").update({
        access_policy: "permitted", extraction_method: "firecrawl", enabled: true, last_verified_at: new Date().toISOString(),
        notes: `${src!.notes ?? ""} | Permitted ${now.slice(0, 10)} (manual submission): ${why}. See source_vetting.`.trim(),
      }).eq("id", sourceId);
      if (u.error) throw new Error("source_update: " + u.error.message);
    }
    // the domain is accepted: let drug-official run for this brand (force: the previous lookup may have ended as no_official_site)
    const off = await callOfficial(baseUrl, svc, sub.brand, true);
    await finish("matched", { source_id: sourceId, domain: sub.host, market, verdict, drug_official: off });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("verify_submission", sub.id, m);
    await finish("failed", { reason: "internal_error", detail: m.slice(0, 200) });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const baseUrl = Deno.env.get("SUPABASE_URL")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(baseUrl, svc, { auth: { persistSession: false } });

  // shared password: rate-limited per IP, compared by SHA-256 hash (fails closed when no hash is stored)
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const rl0 = await db.rpc("check_rate_limit", { p_key: `reviewadmin:login:${ip}`, p_limit: 10, p_window_seconds: 60 });
  if (rl0.error) { console.error("rate_limit_error", rl0.error.message); return json({ error: "internal_error" }, 500); }
  if (rl0.data === false) return json({ error: "rate_limited", message_ar: "كتر الطلبات، جرّب بعد شوية." }, 429);
  const pw = req.headers.get("x-review-password") ?? "";
  const hs = await db.from("app_secrets").select("value").eq("name", "review_password_sha256").maybeSingle();
  if (!pw || !hs.data?.value || !safeEqual(await sha256Hex(pw), String(hs.data.value))) {
    return json({ error: "wrong_password", message_ar: "الباسورد غلط." }, 401);
  }
  const user = { id: "shared-admin" };

  const action = typeof body.action === "string" ? body.action : "";
  const limits: Record<string, number> = { list: 60, status: 120, search_official: 10, submit_site: 15, list_pre: 60, edit_pre: 60 };
  if (!(action in limits)) return json({ error: "invalid_action", allowed: Object.keys(limits) }, 400);
  const { data: allowed, error: rlErr } = await db.rpc("check_rate_limit", { p_key: `reviewadmin:${action}:${user.id}`, p_limit: limits[action], p_window_seconds: 60 });
  if (rlErr) { console.error("rate_limit_error", rlErr.message); return json({ error: "internal_error" }, 500); }
  if (allowed === false) return json({ error: "rate_limited", message_ar: "كتر الطلبات، جرّب بعد شوية." }, 429);

  if (action === "list") {
    const limit = typeof body.limit === "number" && body.limit >= 1 ? Math.min(Math.floor(body.limit), 100) : 50;
    const q = await db.from("review_queue").select("id,item_id,reason,current_tier,details,created_at")
      .eq("item_type", "product").eq("status", "pending").order("created_at", { ascending: false }).limit(limit);
    if (q.error) { console.error("list_error", q.error.message); return json({ error: "internal_error" }, 500); }
    const rows = q.data ?? [];
    const keys = [...new Set(rows.map((r) => brandOf((r.details as { name?: unknown } | null)?.name)?.key).filter((k): k is string => !!k))];
    const lk = keys.length ? await db.from("official_lookups").select("brand_key,status,domain,market,checked_at,stats").in("brand_key", keys) : { data: [] as Record<string, unknown>[] };
    const sb = rows.length ? await db.from("official_site_submissions").select("id,queue_id,submitted_url,domain,status,result,created_at,checked_at").in("queue_id", rows.map((r) => r.id)).order("created_at", { ascending: false }) : { data: [] as Record<string, unknown>[] };
    const items = rows.map((r) => {
      const b = brandOf((r.details as { name?: unknown } | null)?.name);
      const l = (lk.data ?? []).find((x) => x.brand_key === b?.key) ?? null;
      return {
        queue_id: r.id, item_id: r.item_id, reason: r.reason, tier: r.current_tier, created_at: r.created_at, details: r.details,
        brand: b?.brand ?? null, lookup: lookupView(l as Record<string, unknown> | null),
        submissions: (sb.data ?? []).filter((s) => s.queue_id === r.id).slice(0, 3),
      };
    });
    return json({ items, count: items.length });
  }

  if (action === "list_pre") {
    const q = await db.from("review_queue").select("id,item_id,created_at").eq("item_type", "pre_review").eq("status", "pending").order("created_at", { ascending: false }).limit(200);
    if (q.error) { console.error("list_pre_error", q.error.message); return json({ error: "internal_error" }, 500); }
    const ids = (q.data ?? []).map((r) => r.item_id as string);
    const p = ids.length ? await db.from("drug_pre_review").select("id,raw_name,raw_strength,raw_form,reason,context").in("id", ids) : { data: [] as Record<string, unknown>[], error: null };
    if (p.error) { console.error("list_pre_error", p.error.message); return json({ error: "internal_error" }, 500); }
    return json({ items: p.data ?? [], count: (p.data ?? []).length });
  }

  if (action === "edit_pre") {
    const id = typeof body.id === "string" && UUID.test(body.id) ? body.id : null;
    if (!id) return json({ error: "invalid_id" }, 400);
    const f = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : undefined);
    const raw_name = f(body.raw_name, 200);
    if (!raw_name) return json({ error: "name_required", message_ar: "الاسم مطلوب." }, 400);
    const patch: Record<string, string> = { raw_name };
    const st = f(body.raw_strength, 100); if (st !== undefined) patch.raw_strength = st;
    const fm = f(body.raw_form, 60); if (fm !== undefined) patch.raw_form = fm;
    const u = await db.from("drug_pre_review").update(patch).eq("id", id).eq("status", "pending").select("id").maybeSingle();
    if (u.error) { console.error("edit_pre_error", u.error.message); return json({ error: "internal_error" }, 500); }
    return u.data ? json({ status: "saved" }) : json({ error: "not_found_or_closed", message_ar: "الصف مش موجود أو اتقفل." }, 404);
  }

  const queueId = typeof body.queue_id === "string" && UUID.test(body.queue_id) ? body.queue_id : null;
  if (!queueId) return json({ error: "invalid_queue_id" }, 400);
  const qi = await db.from("review_queue").select("id,item_type,status,details").eq("id", queueId).maybeSingle();
  if (qi.error) { console.error("queue_error", qi.error.message); return json({ error: "internal_error" }, 500); }
  if (!qi.data || qi.data.item_type !== "product") return json({ error: "not_found", message_ar: "العنصر ده مش منتج في قايمة المراجعة." }, 404);
  if (qi.data.status !== "pending" && action !== "status") return json({ error: "not_pending", message_ar: "العنصر ده اتقفل خلاص." }, 409);
  const details = (qi.data.details ?? {}) as { name?: unknown; manufacturer?: unknown };
  const b = brandOf(details.name);
  if (!b) return json({ error: "invalid_brand", message_ar: "الاسم لازم يبدأ باسم تجاري لاتيني (3 حروف على الأقل)." }, 422);

  if (action === "status") {
    const l = await db.from("official_lookups").select("status,domain,market,checked_at,stats").eq("brand_key", b.key).maybeSingle();
    const s = await db.from("official_site_submissions").select("id,submitted_url,domain,status,result,created_at,checked_at").eq("queue_id", queueId).order("created_at", { ascending: false }).limit(5);
    return json({ queue_status: qi.data.status, brand: b.brand, lookup: lookupView(l.data as Record<string, unknown> | null), submissions: s.data ?? [] });
  }

  if (action === "search_official") {
    try {
      const off = await callOfficial(baseUrl, svc, b.brand, body.force === true);
      if (off.status === "accepted" || off.status === "already_running") {
        return json({ status: off.status, brand: b.brand, message_ar: off.status === "accepted" ? "بدأ البحث عن الموقع الرسمي. تابع الحالة بعد شوية." : "البحث شغّال بالفعل للبراند ده." }, 202);
      }
      if (off.status === "skipped_recent") return json({ status: "skipped_recent", last: off.last, brand: b.brand, message_ar: "البراند ده اتبحث عنه قريب. استخدم force لإعادة البحث." });
      console.error("drug_official_unexpected", off.http, off.error);
      return json({ error: "search_failed", message_ar: "مقدرناش نبدأ البحث." }, 502);
    } catch (e) {
      console.error("search_official_error", e instanceof Error ? e.message : String(e));
      return json({ error: "search_failed", message_ar: "مقدرناش نبدأ البحث." }, 502);
    }
  }

  // submit_site
  const site = parseSite(body.url);
  if (!site) return json({ error: "invalid_url", message_ar: "الرابط مش صالح. اكتب موقع عادي بدون بيانات دخول." }, 400);
  if (NOT_OFFICIAL.test(site.host)) return json({ error: "not_official", message_ar: "الموقع ده متجر أو منصة، مش موقع رسمي." }, 422);
  const stores = await db.from("search_sources").select("domain").in("source_category", ["ONLINE_PHARMACY", "PHARMACEUTICAL_DATABASE", "REGULATORY"]);
  if ((stores.data ?? []).some((s) => hostMatches(site.host, s.domain as string))) return json({ error: "not_official", message_ar: "الموقع ده صيدلية أو قاعدة بيانات، مش موقع رسمي." }, 422);

  const manuTokens = typeof details.manufacturer === "string" ? normWords(details.manufacturer).split(" ").filter((t) => t.length >= 4) : [];
  const core = coreLabel(site.host).replace(/[^a-z0-9]/g, "");
  const manuJoined = typeof details.manufacturer === "string" ? normWords(details.manufacturer).replace(/ /g, "") : "";
  const matchesBrand = ownBrand(site.host, b.key) || manuTokens.includes(core) || (manuJoined.length >= 5 && core === manuJoined);
  const ins = await db.from("official_site_submissions").insert({
    queue_id: queueId, submitted_url: site.url, domain: site.host, status: matchesBrand ? "pending" : "mismatch",
    result: matchesBrand ? {} : { reason: "domain_not_named_like_brand_or_manufacturer", brand: b.brand },
    submitted_by: null, ...(matchesBrand ? {} : { checked_at: new Date().toISOString() }),
  }).select("id").single();
  if (ins.error) { console.error("submission_insert", ins.error.message); return json({ error: "internal_error" }, 500); }
  if (!matchesBrand) {
    return json({ error: "domain_mismatch", submission_id: ins.data.id, message_ar: `اسم الدومين مش شبه البراند (${b.brand}) ولا الشركة المصنّعة، فاتسجّل كرابط مرفوض.` }, 422);
  }
  EdgeRuntime.waitUntil(verifySubmission(db, baseUrl, svc, { id: ins.data.id as string, url: site.url, host: site.host, brand: b.brand, key: b.key, manuTokens }));
  return json({ status: "accepted", submission_id: ins.data.id, domain: site.host, message_ar: "اتسجّل الرابط وبنتحقق منه. تابع الحالة بعد شوية." }, 202);
});
