import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { canonForm, hasArabic, norm, type Product } from "./extract.ts";

export type Src = {
  source_id: string; source_name: string; domain: string; source_category: string;
  extraction_method: string; access_policy: string; reliability_score: number | null;
};

const fail = (what: string, e: { message: string }) => new Error(`${what}: ${e.message}`);

// Ingredient identity is decided by the DATABASE (link_ingredient_names -> ingredient_aliases), never by this code.
// Every known name (English INN, Arabic name, merged alias) maps to ONE ingredient. A name the database is not
// sure about is queued in ingredient_review_queue and returns null: the product is still saved, but it is NOT linked
// to a guessed ingredient. The Arabic wording only fills arabic_name when that field is still empty.
async function ingredientId(db: SupabaseClient, inn: string, pageName: string, productId: string): Promise<string | null> {
  const { data, error } = await db.rpc("link_ingredient_names", {
    p_inn: inn,
    p_page_name: pageName && norm(pageName) !== norm(inn) ? pageName : null,
    p_context: { product_id: productId },
  });
  if (error) throw fail("ingredient_link", error);
  const row = Array.isArray(data) ? data[0] : data;
  const id: string | null = row?.out_ingredient_id ?? null;
  if (!id) {
    console.error("ingredient_not_linked", row?.out_status ?? "unknown", inn.slice(0, 60));
    return null;
  }
  if (hasArabic(pageName)) {
    const cur = await db.from("active_ingredients").select("arabic_name").eq("id", id).maybeSingle();
    if (!cur.error && cur.data && !cur.data.arabic_name) {
      const up = await db.from("active_ingredients").update({ arabic_name: pageName }).eq("id", id);
      if (up.error) console.error("ingredient_arabic_fill_error", up.error.message);
    }
  }
  return id;
}

async function upsertProduct(db: SupabaseClient, p: Product): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ex = await db.from("drug_products")
      .select("id,arabic_name,manufacturer,dosage_form,pack_size")
      .eq("identity_key", p.identity_key).maybeSingle();
    if (ex.error) throw fail("product_select", ex.error);

    if (ex.data) {
      // The first stated value is kept and a later source only fills gaps. A different value from another
      // source is NOT written over it: it is kept as its own data_evidence row and flagged 'conflicting'.
      const e = ex.data;
      const { error } = await db.from("drug_products").update({
        arabic_name: e.arabic_name ?? p.arabic_name, manufacturer: e.manufacturer ?? p.manufacturer,
        dosage_form: e.dosage_form ?? p.dosage_form, pack_size: e.pack_size ?? p.pack_size,
        identity_verified_at: new Date().toISOString(),
      }).eq("id", e.id);
      if (error) throw fail("product_update", error);
      return e.id;
    }
    const ins = await db.from("drug_products").insert({
      identity_key: p.identity_key, product_name: p.product_name, normalized_name: p.normalized_name,
      arabic_name: p.arabic_name, manufacturer: p.manufacturer, dosage_form: p.dosage_form, pack_size: p.pack_size,
      identity_verified_at: new Date().toISOString(), // registration_status stays UNKNOWN: only the regulator can set it
    }).select("id").single();
    if (!ins.error) return ins.data.id;
    if (ins.error.code !== "23505") throw fail("product_insert", ins.error);
  }
  throw new Error("product_conflict");
}

async function syncIngredients(db: SupabaseClient, productId: string, p: Product) {
  const ex = await db.from("product_ingredients").select("id,ingredient_id,chemical_form").eq("product_id", productId);
  if (ex.error) throw fail("pi_select", ex.error);
  for (const ing of p.ingredients) {
    // An ingredient is never imported without its strength and unit: nothing is linked or created for it,
    // and an existing strength is never overwritten with an empty value.
    if (ing.strength_value == null || ing.strength_value <= 0 || !ing.strength_unit) continue;
    const ingId = await ingredientId(db, ing.inn, ing.name, productId);
    if (!ingId) continue; // queued for review; never link to a guessed ingredient
    const vals = { strength_value: ing.strength_value, strength_unit: ing.strength_unit, strength_per: ing.strength_per };
    // A row that already carries a form (e.g. 'Retinol' under Vitamin A) is the same link when the page names that form.
    const hit = (ex.data ?? []).find((r) =>
      r.ingredient_id === ingId && (!r.chemical_form || norm(r.chemical_form) === norm(ing.inn)));
    const res = hit
      ? await db.from("product_ingredients").update(vals).eq("id", hit.id)
      : await db.from("product_ingredients").insert({ product_id: productId, ingredient_id: ingId, ...vals });
    if (res.error && res.error.code !== "23505") throw fail("pi_write", res.error);
  }
}

// Aliases come only from values a page explicitly stated (the Arabic trade name). Nothing is derived or guessed.
// Unique (product_id, normalized_alias) makes this idempotent.
async function writeAliases(db: SupabaseClient, productId: string, p: Product) {
  const rows: { product_id: string; alias: string; language: string; normalized_alias: string }[] = [];
  if (p.arabic_name && norm(p.arabic_name) && norm(p.arabic_name) !== p.normalized_name) {
    rows.push({ product_id: productId, alias: p.arabic_name, language: "ar", normalized_alias: norm(p.arabic_name) });
  }
  if (!rows.length) return;
  const { error } = await db.from("product_aliases").upsert(rows, { onConflict: "product_id,normalized_alias", ignoreDuplicates: true });
  if (error) throw fail("alias_upsert", error);
}

const POOL_TYPE: Record<string, string> = { REGULATORY: "official", PHARMACEUTICAL_DATABASE: "database", ONLINE_PHARMACY: "pharmacy" };

async function pharmacyIdFor(db: SupabaseClient, src: Src): Promise<string> {
  const reg = await db.from("search_sources").select("pharmacy_id").eq("id", src.source_id).maybeSingle();
  if (reg.error) throw fail("source_select", reg.error);
  if (reg.data?.pharmacy_id) return reg.data.pharmacy_id;

  let id: string | null = null;
  const ph = await db.from("pharmacies").select("id").eq("name", src.source_name).maybeSingle();
  if (ph.error) throw fail("pharmacy_select", ph.error);
  id = ph.data?.id ?? null;
  if (!id) {
    const ins = await db.from("pharmacies").insert({
      name: src.source_name, website: src.domain, source_type: POOL_TYPE[src.source_category] ?? "other",
    }).select("id").single();
    if (!ins.error) id = ins.data.id;
    else if (ins.error.code === "23505") {
      const again = await db.from("pharmacies").select("id").eq("name", src.source_name).maybeSingle();
      id = again.data?.id ?? null;
    } else throw fail("pharmacy_insert", ins.error);
  }
  if (!id) throw new Error("pharmacy_missing");
  await db.from("search_sources").update({ pharmacy_id: id }).eq("id", src.source_id);
  return id;
}

// After a page's evidence is written, compare every source's value per field for this product:
// more than one distinct (normalized) value => all of that field's rows are 'conflicting', otherwise 'unverified'.
// Rows a human marked 'verified' are never touched. Idempotent, so re-running a page cannot lose a conflict.
async function flagConflicts(db: SupabaseClient, productId: string, fieldNames: string[]) {
  const { data, error } = await db.from("data_evidence")
    .select("id,field_name,field_value,verification_status")
    .eq("product_id", productId).in("field_name", fieldNames);
  if (error) throw fail("evidence_select", error);
  const byField = new Map<string, NonNullable<typeof data>>();
  for (const r of data ?? []) {
    const arr = byField.get(r.field_name) ?? [];
    arr.push(r);
    byField.set(r.field_name, arr);
  }
  for (const [field, rows] of byField) {
    const keyOf = (v: string | null) => (field === "dosage_form" ? canonForm(v) : norm(v));
    const want = new Set(rows.map((r) => keyOf(r.field_value))).size > 1 ? "conflicting" : "unverified";
    const ids = rows.filter((r) => r.verification_status !== "verified" && r.verification_status !== want).map((r) => r.id);
    if (!ids.length) continue;
    const up = await db.from("data_evidence").update({ verification_status: want }).in("id", ids);
    if (up.error) throw fail("evidence_flag", up.error);
  }
}

// Evidence rows are never deleted. Re-running the same page updates the row for (product, source, url, field)
// in place, or inserts it when it is new. A human-'verified' row keeps its status (flagConflicts skips it).
async function writeEvidence(db: SupabaseClient, productId: string, src: Src, pageUrl: string, p: Product) {
  const fields: [string, string | null][] = [
    ["product_name", p.product_name], ["arabic_name", p.arabic_name], ["manufacturer", p.manufacturer],
    ["dosage_form", p.dosage_form], ["pack_size", p.pack_size], ["strength_summary", p.strength_summary],
  ];
  const wanted = fields.filter((f): f is [string, string] => !!f[1]);
  if (!wanted.length) return;

  const ex = await db.from("data_evidence").select("id,field_name,field_value")
    .eq("product_id", productId).eq("source_id", src.source_id).eq("source_url", pageUrl);
  if (ex.error) throw fail("evidence_existing", ex.error);
  const byField = new Map((ex.data ?? []).map((r) => [r.field_name as string, r]));

  const inserts: Record<string, unknown>[] = [];
  for (const [field_name, field_value] of wanted) {
    const hit = byField.get(field_name);
    if (!hit) {
      inserts.push({
        product_id: productId, field_name, field_value, source_name: src.source_name, source_url: pageUrl,
        source_id: src.source_id, confidence_score: src.reliability_score, verification_status: "unverified",
      });
    } else if (hit.field_value !== field_value) {
      const up = await db.from("data_evidence").update({ field_value, extracted_at: new Date().toISOString() }).eq("id", hit.id);
      if (up.error) throw fail("evidence_update", up.error);
    }
  }
  if (inserts.length) {
    const ins = await db.from("data_evidence").insert(inserts);
    if (ins.error) throw fail("evidence_insert", ins.error);
  }
  await flagConflicts(db, productId, wanted.map(([f]) => f));
}

// Writes validated products from one page. Returns the product ids written.
// `singlePage` says whether the WHOLE page held exactly one product (the caller may pass only a subset of the page's
// products, e.g. the ones already approved); only then does the page URL belong to a single product.
export async function persistProducts(
  db: SupabaseClient, src: Src, pageUrl: string, products: Product[], singlePage: boolean = products.length === 1,
): Promise<string[]> {
  const ids: string[] = [];
  for (const p of products) {
    const id = await upsertProduct(db, p);
    await syncIngredients(db, id, p);
    await writeAliases(db, id, p);
    await writeEvidence(db, id, src, pageUrl, p);
    ids.push(id);
  }
  // product_sources is unique per (pharmacy, url): only a single-product page can own its URL.
  // On listing pages the per-field provenance lives in data_evidence.source_url instead.
  if (singlePage && products.length === 1) {
    const pharmacyId = await pharmacyIdFor(db, src);
    const { error } = await db.from("product_sources").upsert({
      product_id: ids[0], pharmacy_id: pharmacyId, source_url: pageUrl,
      source_product_name: products[0].product_name, last_checked_at: new Date().toISOString(),
    }, { onConflict: "pharmacy_id,source_url" });
    if (error) throw fail("product_source_upsert", error);
  }
  return ids;
}

// TTL for cached identity results, read from refresh_policies (interval text like "90 days" or "12:00:00").
export async function identityTtlMs(db: SupabaseClient): Promise<number> {
  const { data } = await db.from("refresh_policies").select("ttl").eq("field_group", "identity").maybeSingle();
  const t = String(data?.ttl ?? "");
  let ms = 0;
  const d = t.match(/(\d+)\s+days?/);
  if (d) ms += Number(d[1]) * 864e5;
  const hms = t.match(/(\d+):(\d{2}):(\d{2})/);
  if (hms) ms += (Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) * 1000;
  return ms > 0 ? ms : 7 * 864e5; // conservative fallback if the interval text is in an unexpected format
}
