// Mirrors public.normalize_text() so identity keys and normalized names match the database.
export function norm(t: string | null | undefined): string {
  return (t ?? "").toLowerCase()
    .replace(/[\u0623\u0625\u0622\u0671\u0649\u0629\u0660-\u0669]/g, (c) => {
      if (c >= "\u0660" && c <= "\u0669") return String(c.charCodeAt(0) - 0x660);
      return ({ "\u0623": "\u0627", "\u0625": "\u0627", "\u0622": "\u0627", "\u0671": "\u0627", "\u0649": "\u064A", "\u0629": "\u0647" } as Record<string, string>)[c];
    })
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .trim();
}

export const hasArabic = (s: string) => /[\u0600-\u06FF]/.test(s);

// A name matches a search term when one contains the other, ALSO when the two are written with different spacing or
// hyphens ("Galvusmet" / "Galvus Met", "Sansozyme" / "Sanso zyme", "Codiovan" / "Co-Diovan"). The spacing-free
// comparison needs at least 4 characters so short names do not match by accident.
export function nameHit(cand: string, term: string): boolean {
  const n = norm(cand), t = norm(term);
  if (!n || !t) return false;
  if (n.includes(t) || (n.length >= 4 && t.includes(n))) return true;
  const nc = n.replace(/ /g, ""), tc = t.replace(/ /g, "");
  return tc.length >= 4 && (nc.includes(tc) || (nc.length >= 4 && tc.includes(nc)));
}

// `name` is the ingredient as the page wrote it (any language); `inn` is the standard English name used for
// matching and storage so the same ingredient written in Arabic and in English is ONE ingredient.
export type Ing = { name: string; inn: string; strength_value: number | null; strength_unit: string | null; strength_per: string | null };
export type Product = {
  identity_key: string; product_name: string; normalized_name: string;
  arabic_name: string | null; manufacturer: string | null; dosage_form: string | null; pack_size: string | null;
  strength_summary: string | null; is_combination: boolean | null; ingredients: Ing[];
};

export const PRODUCT_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          product_name: { type: "string", description: "Trade name ONLY, exactly as the page shows it, WITHOUT any number, size, count, strength or dosage form (write 'Mebo', not 'Mebo 15 grams'; write 'Panadol Extra', not 'Panadol Extra 24 tablets')" },
          arabic_name: { type: "string", description: "Arabic trade name if the page shows one" },
          manufacturer: { type: "string", description: "Company that manufactures or markets the product, ONLY if the page states it as the manufacturer/maker/marketing company. Never the store's brand or category label." },
          dosage_form: { type: "string" },
          pack_size: { type: "string", description: "Size or count of THIS exact product variant, with its unit (e.g. '15 g', '30 tablets', '100 ml'). Omit if the page lists several pack sizes or options." },
          ingredients: {
            type: "array",
            description: "Only rows of a supplement facts / composition table that prints an amount. No limit on the number of rows. Never marketing highlights, never group names such as 'B vitamins'.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Ingredient exactly as written on the page" },
                inn_en: { type: "string", description: "Standard English INN of that ingredient (e.g. Paracetamol)" },
                strength_value: { type: "number", description: "Amount exactly as printed on the page. Omit if the page does not print it; never a placeholder." },
                strength_unit: { type: "string" },
                strength_per: { type: "string" },
              },
              required: ["name"],
            },
          },
        },
        required: ["product_name"],
      },
    },
  },
  required: ["products"],
};

export function buildPrompt(query: string): string {
  const q = query.replace(/["\r\n]+/g, " ").trim();
  return `Extract the pharmaceutical products on this page that match "${q}" (as a trade name or an active ingredient). ` +
    `Use only what the page explicitly states. Omit any field the page does not state; never guess strengths, forms, pack sizes or manufacturers. ` +
    `product_name is the trade name only: never put numbers, sizes, counts, strengths or the dosage form in it. Put the size or count (for example 15 g, 30 tablets) in pack_size. ` +
    `If the page does not state an ingredient's strength, omit strength_value, strength_unit and strength_per for it; never write 0 for an unknown strength. ` +
    `For multivitamins list EVERY vitamin and mineral of the composition table (there is no limit on how many), but never a group name such as 'B vitamins' and never a marketing highlight that has no printed amount. ` +
    `The manufacturer is the company that makes or markets the product; do not use a store brand, category, or breadcrumb label as the manufacturer. ` +
    `Only report a pack size if the page gives one unambiguous size for this exact product. ` +
    `Return at most 15 products. If nothing matches, return an empty products array.`;
}

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
}

// ---- Product names never contain numbers -------------------------------------------------------------------
// A size or count written inside the name ("Mebo 15 grams", "Panadol 24 tablets") is moved to pack_size; a strength
// written inside the name ("500 mg") is dropped, because strengths come from the ingredients. A name that still
// contains a digit after this (e.g. "Vitamin B12", a bare "Cetal 500") is rejected, never guessed at.
// (Cosmetics are exempt from the last rule: validateProducts gets allowDigits for them.)
const NUM = "[0-9\\u0660-\\u0669]+(?:[.,\\u066B][0-9\\u0660-\\u0669]+)?";
const PACK_UNITS = "g|gm|gms|gram|grams|ml|tab|tabs|tablet|tablets|cap|caps|capsule|capsules|amp|amps|ampoule|ampoules|sachet|sachets|strip|strips|vial|vials|pcs|pc|piece|pieces|supp|supps|suppository|suppositories|جم|جرام|غرام|مل|قرص|اقراص|أقراص|كبسولة|كبسوله|كبسولات|امبول|أمبول|امبولات|كيس|اكياس|أكياس|لبوس|لبوسة|لبوسه|تحاميل|تحميلة|تحميله";
const STRENGTH_UNITS = "mg|mcg|ug|µg|iu|%|مجم|ملجم|ملغ|ملغم";
const PACK_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${NUM})\\s*(${PACK_UNITS})(?![\\p{L}\\p{N}])`, "giu");
const STRENGTH_RE = new RegExp(`(?<![\\p{L}\\p{N}])${NUM}\\s*(?:${STRENGTH_UNITS})(?![\\p{L}\\p{N}])`, "giu");
const PACK_ONLY_RE = new RegExp(`^\\s*(${NUM})\\s*(${PACK_UNITS})\\s*$`, "iu");
// Bump when product validation / name cleaning changes: pages rejected under an older version are read again.
export const RULES_VERSION = 3;
export const HAS_DIGIT = /[0-9\u0660-\u0669\u06F0-\u06F9]/;

// Group / marketing labels are never an ingredient ("B Vitamins", "Vitamins and minerals", "Antioxidants").
const GROUP_NAME = /^(b complex|b vitamins?|b group|vitamin b complex|vitamins?|multivitamins?|vitamins and minerals?|vitamins minerals|minerals?|antioxidants?|herbal blend|herbal extracts?)$/;
// No limit on the number of ingredients (multivitamins can list ~100); this is only a sanity ceiling.
const MAX_INGREDIENTS = 150;

const PACK_CANON: Record<string, string> = {
  g: "g", gm: "g", gms: "g", gram: "g", grams: "g", "جم": "g", "جرام": "g", "غرام": "g",
  ml: "mL", "مل": "mL",
  tab: "tablets", tabs: "tablets", tablet: "tablets", tablets: "tablets", "قرص": "tablets", "اقراص": "tablets", "أقراص": "tablets",
  cap: "capsules", caps: "capsules", capsule: "capsules", capsules: "capsules", "كبسولة": "capsules", "كبسوله": "capsules", "كبسولات": "capsules",
  amp: "ampoules", amps: "ampoules", ampoule: "ampoules", ampoules: "ampoules", "امبول": "ampoules", "أمبول": "ampoules", "امبولات": "ampoules",
  sachet: "sachets", sachets: "sachets", "كيس": "sachets", "اكياس": "sachets", "أكياس": "sachets",
  strip: "strips", strips: "strips", vial: "vials", vials: "vials",
  supp: "suppositories", supps: "suppositories", suppository: "suppositories", suppositories: "suppositories",
  "لبوس": "suppositories", "لبوسة": "suppositories", "لبوسه": "suppositories", "تحاميل": "suppositories", "تحميلة": "suppositories", "تحميله": "suppositories",
  pcs: "pcs", pc: "pcs", piece: "pcs", pieces: "pcs",
};
const asciiNum = (n: string) =>
  n.replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[,\u066B]/g, ".");
const packText = (n: string, u: string) => `${asciiNum(n)} ${PACK_CANON[u.toLowerCase()] ?? u}`;

// "15 grams" / "١٥ جم" -> "15 g"; anything that is not a plain size or count is left as the page wrote it.
function canonPack(s: string): string {
  const m = PACK_ONLY_RE.exec(s);
  return m ? packText(m[1], m[2]) : s;
}

export function splitName(raw: string): { name: string; pack: string | null } {
  const found: { pack: string | null } = { pack: null };
  let s = raw.replace(PACK_RE, (_m, n: string, u: string) => { if (!found.pack) found.pack = packText(n, u); return " "; });
  s = s.replace(STRENGTH_RE, " ").replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[\s\-\u2013*\/.,+()]+/, "").replace(/[\s\-\u2013*\/.,+(]+$/, "").trim();
  return { name: s, pack: found.pack };
}

// Identity-key form: "Tablet" and "Tablets" are the same form. Display value stays as the source wrote it.
// (English plurals only; Arabic forms like قرص/أقراص are unified by FORM_MAP below.)
export const canonForm = (f: string | null) =>
  norm(f).split(" ").map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).join(" ");

// Deterministic unit / form vocabulary. Anything not listed is kept exactly as the page wrote it.
const UNIT_MAP: Record<string, string> = {
  mg: "mg", "ملجم": "mg", "مجم": "mg", "ملغ": "mg", "ملغم": "mg", "ملجرام": "mg",
  "مللي جرام": "mg", "ملليجرام": "mg", "مليجرام": "mg",
  g: "g", gm: "g", "جم": "g", "جرام": "g", "غرام": "g",
  mcg: "mcg", ug: "mcg", "\u00b5g": "mcg", "\u03bcg": "mcg", "ميكروجرام": "mcg", "ميكروغرام": "mcg",
  ml: "mL", "مل": "mL", "ملل": "mL", iu: "IU", "%": "%",
};
const FORM_MAP: Record<string, string> = {
  "قرص": "Tablet", "اقراص": "Tablet", "حبوب": "Tablet",
  "شراب": "Syrup", "كبسوله": "Capsule", "كبسولات": "Capsule", "كبسول": "Capsule",
  "امبول": "Ampoule", "امبولات": "Ampoule", "حقن": "Injection", "حقنه": "Injection",
  "كريم": "Cream", "مرهم": "Ointment", "جل": "Gel", "لبوس": "Suppository", "تحاميل": "Suppository",
  "معلق": "Suspension", "بخاخ": "Spray", "قطره": "Drops", "نقط": "Drops",
  "اكياس": "Sachet", "كيس": "Sachet", "ساشيه": "Sachet",
  tablet: "Tablet", syrup: "Syrup", capsule: "Capsule", cream: "Cream", ointment: "Ointment", gel: "Gel", suspension: "Suspension",
  injection: "Injection", ampoule: "Ampoule", suppository: "Suppository", spray: "Spray", drops: "Drops", sachet: "Sachet",
};
const canonUnit = (u: string | null): string | null => (u == null ? null : (UNIT_MAP[u.toLowerCase().trim()] ?? UNIT_MAP[norm(u)] ?? u));
const canonFormDisplay = (f: string | null): string | null => (f == null ? null : (FORM_MAP[canonForm(f)] ?? f));

// Edit distance <= 1: catches a store's brand label that is only a respelling of the product's own brand
// (e.g. a brand taxonomy page showing "BANADOL" for Panadol) being mistaken for the manufacturer.
function withinOneEdit(a: string, b: string): boolean {
  if (!a || !b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Page content is untrusted: everything is type-checked, length-capped and de-duplicated before it touches the DB.
// Identity key = name | dosage form | per-ingredient strengths | pack size, built from canonical (English) values so
// the same product read from an Arabic page and an English page produces one key.
// Relevance is decided by TEXT MATCH only (query or known synonyms vs name / Arabic name / ingredient names).
// `trustSingle`: the caller already knows the page's own title/URL contains the searched name; when such a page lists
// exactly ONE product, that product is accepted without the text match (its name may be in another script).
// `allowDigits`: the product is a cosmetic (decided by the caller from the page's own classification), so a number that
// is part of the trade name ("SPF 50") is kept. Drugs never get this: a name with a digit is rejected.
// A strength of 0 (or less) is treated as "not stated", never stored as a real zero.
export function validateProducts(
  raw: unknown, query: string, extraTerms: string[] = [], opts: { trustSingle?: boolean; allowDigits?: boolean } = {},
): Product[] {
  const list = (raw as { products?: unknown })?.products;
  if (!Array.isArray(list)) return [];
  const terms = [norm(query), ...extraTerms.map((t) => norm(t))].filter((t) => t.length >= 2);
  if (!terms.length) return [];
  const trusted = !!opts.trustSingle && list.length === 1;
  const out = new Map<string, Product>();

  for (const item of list.slice(0, 30)) {
    const r = item as Record<string, unknown>;
    const rawName = clean(r?.product_name, 150);
    if (!rawName) continue;
    // the name column never holds numbers: sizes/counts go to pack_size, strengths are dropped
    const split = splitName(rawName);
    const name = split.name;
    if (!name || name.length < 2 || !norm(name)) continue;
    if (HAS_DIGIT.test(name) && !opts.allowDigits) continue;

    const ings: Ing[] = [];
    for (const g of (Array.isArray(r.ingredients) ? r.ingredients : []).slice(0, MAX_INGREDIENTS)) {
      const gi = g as Record<string, unknown>;
      const iname = clean(gi?.name, 100);
      if (!iname || iname.length < 2 || !norm(iname)) continue;
      const innEn = clean(gi?.inn_en, 100);
      // use the English INN only when it is really Latin script; otherwise keep what the page wrote
      const inn = innEn && !hasArabic(innEn) && norm(innEn).length >= 2 ? innEn : iname;
      if (GROUP_NAME.test(norm(iname)) || GROUP_NAME.test(norm(inn))) continue;
      const v = typeof gi.strength_value === "number" && Number.isFinite(gi.strength_value) && gi.strength_value > 0 && gi.strength_value <= 1e6
        ? gi.strength_value : null;
      ings.push({
        name: iname, inn,
        strength_value: v,
        strength_unit: v == null ? null : canonUnit(clean(gi.strength_unit, 20)),
        strength_per: v == null ? null : clean(gi.strength_per, 40),
      });
    }

    const arabic = clean(r.arabic_name, 150);
    const cands = [name, arabic, ...ings.flatMap((i) => [i.name, i.inn])].filter((x): x is string => !!x);
    const match = cands.some((c) => terms.some((t) => nameHit(c, t)));
    if (!match && !trusted) continue;

    const form = canonFormDisplay(clean(r.dosage_form, 60));
    // the pack size field wins; a size found inside the name is used only when the field is empty
    const packField = clean(r.pack_size, 60);
    const pack = packField ? canonPack(packField) : split.pack;
    let manufacturer = clean(r.manufacturer, 150);
    if (manufacturer) {
      const mn = norm(manufacturer);
      const firstToken = norm(name).split(" ")[0] ?? "";
      // a "manufacturer" that is just a respelling of the product's own brand is a store label, not a company
      if (mn === firstToken || withinOneEdit(mn, firstToken)) manufacturer = null;
    }
    const summary = ings.length
      ? ings.map((i) => [i.inn, i.strength_value, i.strength_unit].filter((x) => x != null).join(" ") +
          (i.strength_per ? " / " + i.strength_per : "")).join(" + ").slice(0, 8000)
      : null;
    const key = [norm(name), canonForm(form), norm(summary), norm(pack)].join("|");
    if (out.has(key)) continue;

    out.set(key, {
      identity_key: key, product_name: name, normalized_name: norm(name),
      arabic_name: arabic, manufacturer, dosage_form: form,
      pack_size: pack, strength_summary: summary,
      is_combination: ings.length ? ings.length > 1 : null, ingredients: ings,
    });
  }
  return [...out.values()];
}
