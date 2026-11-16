import { createClient } from "npm:@supabase/supabase-js@2";

// Admin-only review of products waiting in drug_pre / drug_pre_review.
// Actions: list | approve | reject | resolve_review | merge_review | reject_review
// Every write goes through the existing SECURITY DEFINER functions (approve_drug_pre, reject_drug_pre, ...);
// this function only checks WHO is calling and validates the input.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
}
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : null);

// Only the fields a reviewer needs; the raw payload is never returned as-is.
function summarize(p: unknown) {
  const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const ings = Array.isArray(o.ingredients) ? o.ingredients.slice(0, 10) : [];
  const manual = (o.manual_entry && typeof o.manual_entry === "object" ? o.manual_entry : null) as Record<string, unknown> | null;
  return {
    product_name: str(o.product_name, 150), arabic_name: str(o.arabic_name, 150), manufacturer: str(o.manufacturer, 150),
    dosage_form: str(o.dosage_form, 60), pack_size: str(o.pack_size, 60), strength_summary: str(o.strength_summary, 300),
    is_combination: typeof o.is_combination === "boolean" ? o.is_combination : null,
    ingredients: ings.map((g) => {
      const i = (g ?? {}) as Record<string, unknown>;
      return {
        inn: str(i.inn, 100), name: str(i.name, 100),
        strength_value: typeof i.strength_value === "number" ? i.strength_value : null,
        strength_unit: str(i.strength_unit, 20), strength_per: str(i.strength_per, 40),
      };
    }),
    manual: !!manual, manual_note: manual ? str(manual.note, 300) : null,
  };
}

// deno-lint-ignore no-explicit-any
function shapePayload(r: any) {
  const src = Array.isArray(r.search_sources) ? r.search_sources[0] : r.search_sources;
  return {
    id: r.id, source_name: src?.source_name ?? null, source_url: r.source_url, page_products: r.page_products,
    created_at: r.created_at, ...summarize(r.payload),
  };
}

const PAYLOAD_COLS = "id,source_url,page_products,created_at,status,payload,search_sources(source_name)";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // signed-in AND admin (same rule as public.is_admin(): app_metadata.role = 'admin')
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = token ? await db.auth.getUser(token) : { data: { user: null } };
  const user = u?.user ?? null;
  if (!user) return json({ error: "auth_required", message_ar: "لازم تسجّل دخول الأول." }, 401);
  if ((user.app_metadata as Record<string, unknown> | undefined)?.role !== "admin") {
    return json({ error: "admin_required", message_ar: "الصلاحية دي للأدمن بس." }, 403);
  }

  const { data: allowed, error: rlErr } = await db.rpc("check_rate_limit", { p_key: `preadmin:${user.id}`, p_limit: 120, p_window_seconds: 60 });
  if (rlErr) { console.error("rate_limit_error", rlErr.message); return json({ error: "internal_error" }, 500); }
  if (allowed === false) return json({ error: "rate_limited", message_ar: "كتر الطلبات، جرّب بعد شوية." }, 429);

  const action = typeof body.action === "string" ? body.action : "";
  const id = (k: string) => (typeof body[k] === "string" && UUID.test(body[k] as string) ? (body[k] as string) : null);
  const fail = (what: string, e: { message: string }) => {
    console.error(what, e.message);
    return json({ error: "action_failed", message_ar: "مقدرناش ننفّذ الطلب ده.", detail: e.message.slice(0, 200) }, 409);
  };

  if (action === "list") {
    const limit = typeof body.limit === "number" && body.limit >= 1 ? Math.min(Math.floor(body.limit), 100) : 50;

    const pre = await db.from("drug_pre")
      .select(`id,drug_name,strength,dosage_form,created_at,drug_pre_payloads!inner(${PAYLOAD_COLS})`)
      .eq("drug_pre_payloads.status", "pending")
      .order("created_at", { ascending: false }).limit(limit);
    if (pre.error) return fail("list_pre_error", pre.error);

    const rev = await db.from("drug_pre_review")
      .select(`id,raw_name,raw_strength,raw_form,reason,similarity,created_at,candidate:drug_pre!drug_pre_review_candidate_id_fkey(id,drug_name,strength,dosage_form),drug_pre_payloads(${PAYLOAD_COLS})`)
      .eq("status", "pending")
      .order("created_at", { ascending: false }).limit(limit);
    if (rev.error) return fail("list_review_error", rev.error);

    // deno-lint-ignore no-explicit-any
    const pending = (pre.data ?? []).map((d: any) => ({
      pre_id: d.id, drug_name: d.drug_name, strength: d.strength, dosage_form: d.dosage_form, created_at: d.created_at,
      // deno-lint-ignore no-explicit-any
      payloads: (d.drug_pre_payloads ?? []).filter((p: any) => p.status === "pending").map(shapePayload),
    }));
    // deno-lint-ignore no-explicit-any
    const reviews = (rev.data ?? []).map((r: any) => {
      const cand = Array.isArray(r.candidate) ? r.candidate[0] : r.candidate;
      return {
        review_id: r.id, raw_name: r.raw_name, raw_strength: r.raw_strength, raw_form: r.raw_form, reason: r.reason,
        similarity: r.similarity, created_at: r.created_at,
        candidate: cand ? { pre_id: cand.id, drug_name: cand.drug_name, strength: cand.strength, dosage_form: cand.dosage_form } : null,
        // deno-lint-ignore no-explicit-any
        payloads: (r.drug_pre_payloads ?? []).filter((p: any) => p.status === "pending").map(shapePayload),
      };
    });
    return json({ pending, reviews, counts: { pending: pending.length, reviews: reviews.length } });
  }

  if (action === "approve") {
    const preId = id("pre_id");
    if (!preId) return json({ error: "invalid_pre_id" }, 400);
    const { data, error } = await db.rpc("approve_drug_pre", { p_pre_id: preId });
    if (error) return fail("approve_error", error);
    const promoted = Number((data as { promoted?: number })?.promoted ?? 0);
    return json({
      ...(data as object),
      message_ar: promoted > 0 ? `تمت الموافقة واتضاف ${promoted} منتج لقاعدة البيانات.` : "مفيش منتجات منتظرة على العنصر ده.",
    });
  }

  if (action === "reject") {
    const preId = id("pre_id");
    if (!preId) return json({ error: "invalid_pre_id" }, 400);
    const { data, error } = await db.rpc("reject_drug_pre", { p_pre_id: preId });
    if (error) return fail("reject_error", error);
    return json({ discarded: data, message_ar: Number(data) > 0 ? `تم الرفض (${data}).` : "مفيش منتجات منتظرة على العنصر ده." });
  }

  if (action === "resolve_review") {
    const reviewId = id("review_id");
    const name = clean(body.name, 100), strength = clean(body.strength, 100), form = clean(body.form, 60);
    if (!reviewId || !name || !strength || !form) return json({ error: "invalid_input", message_ar: "لازم review_id والاسم والتركيز والشكل." }, 400);
    const { data, error } = await db.rpc("resolve_drug_pre_review", { p_review_id: reviewId, p_name: name, p_strength: strength, p_form: form });
    if (error) return fail("resolve_error", error);
    const st = (data as { status?: string })?.status;
    return json({
      ...(data as object),
      message_ar: st === "created" || st === "matched" ? "اتصلّح العنصر واتنقل للانتظار العادي." : "القيم الجديدة بضو لسه محتاجة مراجعة (شوف new_review_id).",
    });
  }

  if (action === "merge_review") {
    const reviewId = id("review_id"), preId = id("pre_id");
    if (!reviewId || !preId) return json({ error: "invalid_input" }, 400);
    const { data, error } = await db.rpc("merge_review_into_pre", { p_review_id: reviewId, p_pre_id: preId });
    if (error) return fail("merge_error", error);
    return json({ payloads_moved: data, message_ar: "تم نقل المنتجات للعنصر الموجود." });
  }

  if (action === "reject_review") {
    const reviewId = id("review_id");
    if (!reviewId) return json({ error: "invalid_review_id" }, 400);
    const { data, error } = await db.rpc("reject_drug_pre_review", { p_review_id: reviewId });
    if (error) return fail("reject_review_error", error);
    return json({ discarded: data, message_ar: "تم رفض العنصر." });
  }

  return json({ error: "invalid_action", allowed: ["list", "approve", "reject", "resolve_review", "merge_review", "reject_review"] }, 400);
});
