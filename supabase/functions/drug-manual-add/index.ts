import { createClient } from "npm:@supabase/supabase-js@2";

// Manual entry for a drug the web search could not find (e.g. checked by hand on the EDA site).
// It does NOT write to drug_products: the entry goes through the same staging path as a search result
// (stage_new_product -> drug_pre / drug_pre_review + drug_pre_payloads) and waits for approval.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const bad = (error: string, message_ar: string, extra: Record<string, unknown> = {}) =>
  json({ error, message_ar, ...extra }, 400);

// Mirrors public.normalize_text() and the helpers in drug-refresh/extract.ts so identity keys match.
function norm(t: string | null | undefined): string {
  return (t ?? "").toLowerCase()
    .replace(/[\u0623\u0625\u0622\u0671\u0649\u0629\u0660-\u0669]/g, (c) => {
      if (c >= "\u0660" && c <= "\u0669") return String(c.charCodeAt(0) - 0x660);
      return ({ "\u0623": "\u0627", "\u0625": "\u0627", "\u0622": "\u0627", "\u0671": "\u0627", "\u0649": "\u064A", "\u0629": "\u0647" } as Record<string, string>)[c];
    })
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .trim();
}
const hasArabic = (s: string) => /[\u0600-\u06FF]/.test(s);
const canonForm = (f: string | null) =>
  norm(f).split(" ").map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).join(" ");

const UNIT_MAP: Record<string, string> = {
  mg: "mg", "ملجم": "mg", "مجم": "mg", "ملغ": "mg", "ملغم": "mg",
  g: "g", gm: "g", "جم": "g", "جرام": "g", "غرام": "g",
  mcg: "mcg", ug: "mcg", "\u00b5g": "mcg", "\u03bcg": "mcg", "ميكروجرام": "mcg",
  ml: "mL", "مل": "mL", iu: "IU", "%": "%",
};
const ALLOWED_UNITS = new Set(["mg", "g", "mcg", "mL", "IU", "%"]);
const FORM_MAP: Record<string, string> = {
  "قرص": "Tablet", "اقراص": "Tablet", "شراب": "Syrup", "كبسوله": "Capsule", "كبسولات": "Capsule", "كبسول": "Capsule",
  "امبول": "Ampoule", "حقن": "Injection", "حقنه": "Injection", "كريم": "Cream", "مرهم": "Ointment", "جل": "Gel",
  "لبوس": "Suppository", "تحاميل": "Suppository", "معلق": "Suspension", "بخاخ": "Spray", "قطره": "Drops", "نقط": "Drops",
  "اكياس": "Sachet", "كيس": "Sachet", "ساشيه": "Sachet",
  tablet: "Tablet", syrup: "Syrup", capsule: "Capsule", cream: "Cream", ointment: "Ointment", gel: "Gel", suspension: "Suspension",
  injection: "Injection", ampoule: "Ampoule", suppository: "Suppository", spray: "Spray", drops: "Drops", sachet: "Sachet",
};

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
}

async function sha16(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

const REVIEW_REASON_AR: Record<string, string> = {
  unknown_form: "الشكل الدوائي مش في القائمة المعتمدة",
  invalid_strength: "صيغة التركيز مش مقبولة",
  invalid_name: "الاسم مش مطابق للصيغة المسموحة",
  similar_name: "فيه اسم مشابه جداً متسجل بنفس التركيز والشكل",
  non_english: "فيه حروف عربية في الاسم أو الشكل أو التركيز",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // a signed-in user is required (the anon key alone is not enough)
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = token ? await db.auth.getUser(token) : { data: { user: null } };
  const user = u?.user ?? null;
  if (!user) return json({ error: "auth_required", message_ar: "لازم تسجّل دخول الأول." }, 401);

  const { data: allowed, error: rlErr } = await db.rpc("check_rate_limit", { p_key: `manual:${user.id}`, p_limit: 20, p_window_seconds: 60 });
  if (rlErr) { console.error("rate_limit_error", rlErr.message); return json({ error: "internal_error" }, 500); }
  if (allowed === false) return json({ error: "rate_limited", message_ar: "كتر الطلبات، جرّب بعد شوية." }, 429);

  // ---- validation (everything is type-checked and length-capped) ----
  const name = clean(body.product_name, 60);
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9 .&'+()\/-]{1,59}$/.test(name)) {
    return bad("invalid_name", "الاسم التجاري لازم يكون بحروف إنجليزي (الاسم العربي يتكتب في خانة arabic_name).");
  }
  const formRaw = clean(body.dosage_form, 60);
  if (!formRaw) return bad("invalid_form", "الشكل الدوائي مطلوب.");
  const form = FORM_MAP[canonForm(formRaw)] ?? formRaw;

  const rawIngs = Array.isArray(body.ingredients) ? body.ingredients.slice(0, 10) : [];
  if (!rawIngs.length) return bad("ingredients_required", "لازم تحدد مادة فعالة واحدة على الأقل بتركيزها.");
  const ings: { name: string; inn: string; strength_value: number; strength_unit: string; strength_per: string | null }[] = [];
  for (const g of rawIngs) {
    const gi = (g ?? {}) as Record<string, unknown>;
    const inn = clean(gi.inn, 100);
    if (!inn || hasArabic(inn) || norm(inn).length < 2) return bad("invalid_inn", "اسم المادة الفعالة (inn) لازم يكون بالإنجليزي.");
    const v = typeof gi.strength_value === "number" ? gi.strength_value : Number(gi.strength_value);
    if (!Number.isFinite(v) || v <= 0 || v > 1e6) return bad("invalid_strength", `تركيز ${inn} لازم يكون رقم أكبر من صفر.`);
    const unitRaw = clean(gi.strength_unit, 20);
    const unit = unitRaw ? (UNIT_MAP[unitRaw.toLowerCase()] ?? UNIT_MAP[norm(unitRaw)] ?? null) : null;
    if (!unit || !ALLOWED_UNITS.has(unit)) return bad("invalid_unit", "الوحدة لازم تكون واحدة من: mg, g, mcg, mL, IU, %.");
    ings.push({ name: clean(gi.name, 100) ?? inn, inn, strength_value: v, strength_unit: unit, strength_per: clean(gi.strength_per, 40) });
  }

  const arabic = clean(body.arabic_name, 150);
  const manufacturer = clean(body.manufacturer, 150);
  const pack = clean(body.pack_size, 60);
  const note = clean(body.note, 300);
  let refUrl = clean(body.reference_url, 500);
  if (refUrl && !/^https:\/\/[^\s]+$/i.test(refUrl)) refUrl = null;

  const summary = ings.map((i) => [i.inn, i.strength_value, i.strength_unit].join(" ") + (i.strength_per ? " / " + i.strength_per : "")).join(" + ").slice(0, 300);
  const key = [norm(name), canonForm(form), norm(summary), norm(pack)].join("|");

  // already approved? then there is nothing to add
  const known = await db.from("drug_products").select("id").eq("identity_key", key).maybeSingle();
  if (known.error) { console.error("known_error", known.error.message); return json({ error: "internal_error" }, 500); }
  if (known.data) {
    return json({ status: "exists", product_id: known.data.id, identity_key: key, message_ar: "الدوا ده موجود بالفعل في قاعدة البيانات الأساسية." });
  }

  // manual entries are attributed to the EDA registry row (extraction_method=manual) and never create product_sources
  const src = await db.from("search_sources").select("id").eq("domain", "edaegypt.gov.eg").maybeSingle();
  if (src.error || !src.data) { console.error("eda_source_error", src.error?.message ?? "missing"); return json({ error: "eda_source_missing" }, 500); }

  const sourceUrl = refUrl ?? `manual://eda/${await sha16(key)}`;
  const product = {
    identity_key: key, product_name: name, normalized_name: norm(name), arabic_name: arabic, manufacturer,
    dosage_form: form, pack_size: pack, strength_summary: summary, is_combination: ings.length > 1,
    ingredients: ings,
    manual_entry: { entered_by: user.id, note, entered_at: new Date().toISOString() },
  };

  // page_products = 2 on purpose: promote_payload only creates a product_sources row for single-product pages,
  // and a manual entry has no product page of its own.
  const { data: st, error: stErr } = await db.rpc("stage_new_product", {
    p_source_id: src.data.id, p_source_url: sourceUrl, p_job_id: null, p_page_products: 2, p_product: product,
  });
  if (stErr) { console.error("stage_error", stErr.message); return json({ error: "stage_failed", message_ar: "حصلت مشكلة وإحنا بنسجّل الدوا، جرّب تاني." }, 500); }

  const status = (st as { status?: string })?.status ?? "unknown";
  const preId = (st as { pre_id?: string })?.pre_id ?? null;
  const reviewId = (st as { review_id?: string })?.review_id ?? null;

  let reason: string | null = null;
  if (status === "needs_review" && reviewId) {
    const r = await db.from("drug_pre_review").select("reason").eq("id", reviewId).maybeSingle();
    reason = r.data?.reason ?? null;
  }
  const message_ar = status === "created" ? "اتضاف وهو دلوقتي في انتظار الموافقة. لسه ماتسجّلش في قاعدة البيانات الأساسية."
    : status === "matched" ? "نفس الدوا موجود بالفعل في الانتظار، واتحدّثت بياناته."
    : status === "needs_review" ? `اتحوّل للمراجعة${reason ? ` (${REVIEW_REASON_AR[reason] ?? reason})` : ""} قبل ما يدخل الانتظار.`
    : "تم الاستلام.";

  return json({
    status, pre_id: preId, review_id: reviewId, review_reason: reason, identity_key: key,
    source: "EDA (manual)", message_ar,
  });
});
