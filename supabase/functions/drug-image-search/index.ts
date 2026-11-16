import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// drug-image-search v3: reads ONE photo of a medicine pack (gallery or live camera: same endpoint) with Gemini vision
// (through llm-gateway) and returns what is printed on it.
// v2: STRICT matching of name + strength + dosage form against dwaprices.com (exact_ids / unverified_ids / hidden_count).
// v3 adds:
//   1. barcode lookup in the same call: if a valid barcode was read from the photo it is looked up in dwaprices_products
//      (same RPC as drug-barcode). Result: mode = "barcode" | "name" | "none".
//   2. cross-check: if the barcode product and the printed name are different products, conflict = true.
//   3. one automatic retry when the vision provider answers 429/502/503 or is unreachable; the final error carries retry_after.
// Whatever the model returns is untrusted text: trimmed, length-limited and only ever shown with textContent.

const PROMPT = `You are reading ONE photo of a medicine package (front, back or blister). Extract ONLY text that is actually printed and legible in the photo. Never guess, never complete a name from memory, never translate.
Return a single JSON object with exactly these keys:
{
  "is_medicine_pack": boolean,   // true only if the photo shows a medicine/supplement package or blister
  "legible": boolean,            // false if the text is too blurry, cut off or too small to read
  "brand_name": string|null,     // the full trade/brand name exactly as printed, INCLUDING variant words (e.g. "Panadol Extra", "Centrum Silver"), without the strength and without the dosage form
  "brand_family": string|null,   // ONLY the family root of the brand name: "Panadol" for "Panadol Extra", "Centrum" for "Centrum Silver". Same letters as printed. null if unsure
  "arabic_name": string|null,    // the Arabic printed name, if present
  "active_ingredients": string[],// generic names printed on the pack
  "strength": string|null,       // every strength printed on the front, exactly as printed, e.g. "500 mg" or "500 mg / 65 mg" or "250 mg/5 ml"
  "dosage_form": string|null,    // e.g. "tablets", "syrup", "cream" as printed
  "manufacturer": string|null,
  "barcode_digits": string|null  // ONLY the digits printed under a linear barcode, with no spaces; null if you cannot read every digit
}
If a field is not visible use null (or [] for the list). Output JSON only.`;

function checkOk(code: string): boolean {
  const d = code.split("").map(Number);
  const check = d.pop() as number;
  let sum = 0;
  d.reverse().forEach((x, i) => { sum += x * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

// Stored barcodes have 12, 13 or 14 digits: compare every equivalent form (leading zeros are padding). Same as drug-barcode.
function candidatesOf(code: string): string[] {
  const g14 = code.padStart(14, "0");
  const out = new Set<string>([g14, code]);
  for (const len of [8, 12, 13]) if (/^0*$/.test(g14.slice(0, 14 - len))) out.add(g14.slice(14 - len));
  return [...out];
}

const clean = (v: unknown, max = 100): string | null => {
  if (typeof v !== "string") return null;
  // deno-lint-ignore no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s.length ? s : null;
};

// ---------- strict matching helpers ----------
const UNIT_MAP: Record<string, string> = {
  mg: "mg", "مجم": "mg", "ملجم": "mg", "ملجرام": "mg",
  g: "g", gm: "g", gr: "g", "جم": "g", "جرام": "g",
  mcg: "mcg", ug: "mcg", "µg": "mcg", "μg": "mcg", "ميكروجرام": "mcg",
  ml: "ml", "مل": "ml",
  iu: "iu", "وحدة": "iu",
  "%": "%",
};
const UNIT_RE = "(mg|mcg|µg|μg|ug|gm|gr|g|ml|iu|%|مجم|ملجم|ملجرام|جم|جرام|ميكروجرام|مل|وحدة)";
const BARE_OK_UNITS = new Set(["mg", "g", "mcg", "iu", "%"]); // a bare number in a name may stand for a strength, but never for ml

type Req = { num: string; unit: string };

function parseStrength(s: string | null): Req[] {
  if (!s) return [];
  const out: Req[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${UNIT_RE}`, "gi");
  for (const m of s.matchAll(re)) {
    const num = String(Number(m[1].replace(",", ".")));
    const unit = UNIT_MAP[m[2].toLowerCase()] ?? UNIT_MAP[m[2]];
    if (!unit || num === "NaN") continue;
    const k = num + unit;
    if (!seen.has(k)) { seen.add(k); out.push({ num, unit }); }
  }
  return out.slice(0, 6);
}

// the text of a record with units unified and spaces removed: "Panadol 500 mg" -> "panadol500mg"
function squash(s: string): string {
  let t = s.toLowerCase().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/,/g, ".");
  t = t.replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT_RE}`, "gi"), (_m, n, u) => `${Number(n)}${UNIT_MAP[u.toLowerCase()] ?? UNIT_MAP[u] ?? u}`);
  return t.replace(/\s+/g, "");
}
const hasUnitStrength = (sq: string) => /\d(?:\.\d+)?(mg|mcg|g|ml|iu|%)/.test(sq);
function hasReq(sq: string, r: Req): boolean {
  const esc = r.num.replace(".", "\\.");
  if (new RegExp(`(?<![\\d.])${esc}${r.unit === "%" ? "%" : r.unit}`).test(sq)) return true;
  return false;
}

// dosage-form class: tablet / capsule / syrup / drops / cream / injection / suppository / sachet / spray
function formClass(s: string | null): string | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/inj|amp|vial|syringe|حقن|امبول|أمبول|فيال/.test(t)) return "injection";
  if (/supp|لبوس|تحميل/.test(t)) return "suppository";
  if (/drop|قطر/.test(t)) return "drops";
  if (/syr|susp|solution|elixir|شراب|معلق|محلول/.test(t)) return "syrup";
  if (/cream|gel|oint|lotion|كريم|جل|مرهم|لوشن/.test(t)) return "cream";
  if (/sachet|powder|ساشيه|ساشي|بودرة|فوار/.test(t)) return "sachet";
  if (/spray|بخاخ|اسبراي|سبراي/.test(t)) return "spray";
  if (/cap|كبسول/.test(t)) return "capsule";
  if (/tab|قرص|اقراص|أقراص/.test(t)) return "tablet";
  return null;
}

// the words of a name that identify the product itself (variant words stay; numbers, units, pack counts, form words go)
const DROP_WORDS = new Set([
  "tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules", "syrup", "susp", "suspension", "drops", "drop",
  "cream", "gel", "oint", "ointment", "amp", "amps", "ampoule", "ampoules", "vial", "vials", "inj", "injection", "fc", "film", "coated",
  "sachet", "sachets", "supp", "suppositories", "spray", "lotion", "solution", "mg", "ml", "mcg", "g", "gm", "iu", "for", "the",
  "قرص", "اقراص", "أقراص", "كبسول", "شراب", "كريم", "جل", "مرهم", "حقن", "امبول", "لبوس", "قطرة", "اقراص", "مل", "مجم", "جم",
]);
function nameTokens(s: string | null): string[] {
  if (!s) return [];
  const t = s.toLowerCase().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/f\.\s*c\.?/g, " fc ")
    .replace(/[^a-z0-9\u0621-\u064A. ]+/g, " ").replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
  return t.split(/\s+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter((w) => w && !/^\d+(\.\d+)?(mg|mcg|ug|g|gm|ml|iu|%)?$/.test(w) && !DROP_WORDS.has(w));
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

type Cand = { dwaprices_id: number; trade_name: string | null; arabic_name: string | null; scientific_name: string | null; dosage_form: string | null };
type BarcodeRow = Cand & {
  manufacturer: string | null; current_price: number | string | null; price_updated_on: string | null;
  source_url: string | null; image_url: string | null; barcode: string | null; shared_count: number | null;
};

// ---------- vision call with ONE automatic retry ----------
type VisionOk = { ok: true; body: Record<string, unknown> };
type VisionFail = { ok: false; status: number; code: string; retry: boolean };

async function callVision(url: string, svc: string, mime: string, data: string): Promise<VisionOk | VisionFail> {
  const attempt = async (timeoutMs: number): Promise<VisionOk | VisionFail> => {
    try {
      const gw = await fetch(`${url}/functions/v1/llm-gateway`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${svc}` },
        body: JSON.stringify({ provider: "gemini", prompt: PROMPT, json: true, image: { mime, data } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await gw.json().catch(() => ({} as Record<string, unknown>));
      if (gw.ok && body.ok) return { ok: true, body };
      const code = String(body.error ?? `status_${gw.status}`);
      console.error("gateway_error", gw.status, JSON.stringify(body).slice(0, 400));
      const retry = [429, 502, 503, 504].includes(gw.status) || code === "quota_exhausted" || code === "provider_overloaded";
      return { ok: false, status: gw.status, code, retry };
    } catch (e) {
      console.error("gateway_unreachable", String(e));
      return { ok: false, status: 0, code: "gateway_unreachable", retry: true };
    }
  };
  let r = await attempt(40_000);
  if (!r.ok && r.retry) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await attempt(30_000);
  }
  return r;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { image?: unknown; mime?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const mime = body.mime;
  const data = typeof body.image === "string" ? body.image.replace(/^data:[^,]*,/, "") : "";
  if (typeof mime !== "string" || !/^image\/(jpeg|png|webp)$/.test(mime) || data.length < 100 || data.length > 5_000_000 || !/^[A-Za-z0-9+/=]+$/.test(data)) {
    return json({ error: "invalid_image" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, svc, { auth: { persistSession: false } });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { data: allowed, error: rlErr } = await db.rpc("check_rate_limit", { p_key: `img:${ip}`, p_limit: 12, p_window_seconds: 60 });
  if (rlErr) { console.error("rate_limit_error", rlErr.message); return json({ error: "internal_error" }, 500); }
  if (allowed === false) return json({ error: "rate_limited" }, 429);

  const vis = await callVision(url, svc, mime, data);
  if (!vis.ok) {
    if (vis.code === "quota_exhausted" || vis.code === "provider_overloaded" || vis.status === 429) {
      return json({ error: "provider_exhausted", gateway_error: vis.code, retry_after: 20 }, 503);
    }
    return json({ error: "vision_unavailable", gateway_error: vis.code, retry_after: 5 }, 502);
  }
  const gwBody = vis.body;

  let raw: Record<string, unknown>;
  try {
    const t = String(gwBody.text ?? "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    raw = JSON.parse(t);
  } catch {
    return json({ error: "vision_bad_output" }, 502);
  }

  const ingredients = (Array.isArray(raw.active_ingredients) ? raw.active_ingredients : [])
    .map((x) => clean(x, 60)).filter((x): x is string => !!x).slice(0, 6);
  const extracted = {
    is_medicine_pack: raw.is_medicine_pack === true,
    legible: raw.legible !== false,
    brand_name: clean(raw.brand_name),
    brand_family: clean(raw.brand_family, 60),
    arabic_name: clean(raw.arabic_name),
    active_ingredients: ingredients,
    strength: clean(raw.strength, 60),
    dosage_form: clean(raw.dosage_form, 60),
    manufacturer: clean(raw.manufacturer, 80),
  };

  // a barcode read from a photo is only trusted when its check digit is valid
  const digits = typeof raw.barcode_digits === "string" ? raw.barcode_digits.replace(/\D/g, "") : "";
  const gtins = /^(\d{8}|\d{12,14})$/.test(digits) && checkOk(digits) ? [digits] : [];

  let search: { text: string; type: string } | null = null;
  if (extracted.is_medicine_pack) {
    if (extracted.brand_name && extracted.brand_name.length >= 2) search = { text: extracted.brand_name, type: "auto" };
    else if (extracted.arabic_name && extracted.arabic_name.length >= 2) search = { text: extracted.arabic_name, type: "auto" };
    else if (ingredients.length) search = { text: ingredients[0], type: "ingredient" };
  }

  // brand family (Panadol, Centrum): the model's answer, else the first word of the brand name. Latin or Arabic letters only.
  let familyText: string | null = extracted.brand_family;
  if (!familyText) {
    const w = (extracted.brand_name ?? extracted.arabic_name ?? "").split(/\s+/)[0] ?? "";
    familyText = w.length >= 3 ? w : null;
  }
  if (familyText && !/^[A-Za-z0-9\u0600-\u06FF][A-Za-z0-9\u0600-\u06FF .'-]{1,59}$/.test(familyText)) familyText = null;
  const family = extracted.is_medicine_pack && familyText ? { text: familyText, type: "brand_family" } : null;

  // ---------- STRICT match against dwaprices.com ----------
  // exact_ids      : same name (incl. variant words) + same strength(s) + same dosage-form class
  // unverified_ids : same name and form, but the record shows no strength at all, so it cannot be confirmed
  // hidden_count   : similar products that were removed (other strength, other form, other variant)
  // exact_ids === null means the check could not run (the front end must then say so and not call anything exact)
  let exact_ids: number[] | null = null;
  const unverified_ids: number[] = [];
  let hidden_count = 0;
  const reqs = parseStrength(extracted.strength);
  const wantForm = formClass(extracted.dosage_form);
  const wantTokens = nameTokens(extracted.brand_name ?? extracted.arabic_name);
  const queryText = extracted.brand_name ?? extracted.arabic_name ?? familyText;
  if (extracted.is_medicine_pack && queryText && wantTokens.length) {
    try {
      const sr = await db.rpc("search_dwaprices", { p_query: familyText ?? queryText, p_type: "brand_family", p_limit: 60 });
      if (sr.error) throw new Error(sr.error.message);
      const rows = (sr.data ?? []) as Cand[];
      exact_ids = [];
      for (const r of rows) {
        const names = [r.trade_name, r.arabic_name];
        const nameOk = names.some((n) => sameSet(nameTokens(n), wantTokens));
        const gotForm = formClass(r.dosage_form) ?? formClass(r.trade_name);
        const formOk = !wantForm || !gotForm || wantForm === gotForm;
        if (!nameOk || !formOk) { hidden_count++; continue; }
        if (!reqs.length) { exact_ids.push(r.dwaprices_id); continue; } // photo shows no strength: name + form only
        const sq = squash(`${r.trade_name ?? ""} ${r.scientific_name ?? ""}`);
        if (hasUnitStrength(sq)) {
          if (reqs.every((q) => hasReq(sq, q))) exact_ids.push(r.dwaprices_id);
          else hidden_count++;
        } else {
          // the record has no unit strength: accept a bare number in the name for mg/g/mcg/iu/% only, else leave it unverified
          const bare = reqs.filter((q) => BARE_OK_UNITS.has(q.unit)).every((q) => new RegExp(`(?<![\\d.])${q.num.replace(".", "\\.")}(?![\\d.])`).test(sq));
          if (bare && reqs.some((q) => BARE_OK_UNITS.has(q.unit)) && /\d/.test(squash(r.trade_name ?? ""))) exact_ids.push(r.dwaprices_id);
          else unverified_ids.push(r.dwaprices_id);
        }
      }
    } catch (e) {
      console.error("strict_match_error", String(e));
      exact_ids = null; unverified_ids.length = 0; hidden_count = 0;
    }
  }

  // ---------- v3: barcode lookup (same RPC as drug-barcode) ----------
  // barcode_unresolved = a valid barcode was read but dwaprices has no product with it: the front end should then
  // ask for the name (typed or from the name match) instead of calling anything verified.
  let barcodeRows: BarcodeRow[] = [];
  let barcodeLookupFailed = false;
  if (gtins.length) {
    try {
      const cands = [...new Set(gtins.flatMap(candidatesOf))];
      const br = await db.rpc("lookup_dwaprices_by_barcode", { p_candidates: cands });
      if (br.error) throw new Error(br.error.message);
      barcodeRows = (br.data ?? []) as BarcodeRow[];
    } catch (e) {
      console.error("barcode_lookup_error", String(e));
      barcodeLookupFailed = true;
    }
  }
  const barcode_ids = barcodeRows.map((r) => r.dwaprices_id);

  // cross-check: the printed name must be one of the products that carry this barcode, otherwise warn
  let conflict = false;
  if (barcodeRows.length && wantTokens.length) {
    conflict = !barcodeRows.some((r) => [r.trade_name, r.arabic_name].some((n) => sameSet(nameTokens(n), wantTokens)));
  }

  const nameFound = (exact_ids?.length ?? 0) + unverified_ids.length > 0;
  const mode = barcode_ids.length ? "barcode" : nameFound ? "name" : "none";

  return json({
    ok: true, extracted, gtins, barcode_read: digits.length > 0, search, family,
    mode,
    conflict,
    barcode: {
      read: gtins.length > 0,
      found: barcode_ids.length,
      ids: barcode_ids,
      ambiguous: barcodeRows.length > 1 || barcodeRows.some((r) => (r.shared_count ?? 0) > 1),
      unresolved: gtins.length > 0 && !barcodeLookupFailed && barcode_ids.length === 0,
      lookup_failed: barcodeLookupFailed,
      results: barcodeRows.slice(0, 5).map((r) => ({
        dwaprices_id: r.dwaprices_id, trade_name: r.trade_name, arabic_name: r.arabic_name, scientific_name: r.scientific_name,
        dosage_form: r.dosage_form, manufacturer: r.manufacturer, current_price: r.current_price, price_updated_on: r.price_updated_on,
        source_url: r.source_url, image_url: r.image_url,
      })),
    },
    match: {
      exact_ids, unverified_ids, hidden_count,
      strength_checked: reqs.length > 0,
      required_strength: reqs.map((q) => `${q.num} ${q.unit}`),
      form_class: wantForm,
    },
    model: gwBody.model ?? null,
  });
});
