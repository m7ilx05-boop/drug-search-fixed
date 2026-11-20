// Deterministic reader for dwaprices.com product pages (med.php?id=N).
// It reads the page's own "بيانات وتفاصيل" table and header prices from the page markdown. No AI is involved, so nothing is
// guessed: a field the page does not show, or shows in a way this reader cannot parse safely, stays null and is explained
// in `notes` (the same note style used for the first manual import).

export type DwaIngredient = { name: string; strength_value: number | null; strength_unit: string | null; strength_per: string | null };

export type DwaParsed = {
  dwaprices_id: number;
  trade_name: string;
  arabic_name: string | null;
  scientific_name: string | null;
  classification: string | null;
  manufacturer: string | null;
  dosage_form: string | null;
  size: string | null;
  current_price: number | null;
  old_price: number | null;
  price_updated_on: string | null;
  major_unit_qty: number | null;
  minor_unit_qty: number | null;
  barcode: string | null;
  image_url: string | null;
  ingredients: DwaIngredient[];
  notes: string[];
};

const AR_DIGITS = /[\u0660-\u0669]/g;
const ascii = (s: string) =>
  s.replace(AR_DIGITS, (c) => String(c.charCodeAt(0) - 0x660)).replace(/\u066B/g, ".").replace(/\u066C/g, ",");

export const isDwapricesDomain = (d: string) => /^(www\.)?dwaprices\.com$/i.test(d.trim());

// A product page is exactly /med.php?id=N. Search / category / listing pages of the site are not product pages.
export function dwapricesIdOf(u: string): number | null {
  try {
    const x = new URL(u);
    if (!isDwapricesDomain(x.hostname) || x.pathname.toLowerCase() !== "/med.php") return null;
    const id = x.searchParams.get("id");
    return id && /^\d{1,9}$/.test(id) ? Number(id) : null;
  } catch { return null; }
}

function num(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = ascii(s).replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  const m = t.match(/\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const v = Number(m[0].replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

const mdClean = (v: string) =>
  v.replace(/<br\s*\/?>/gi, "\n").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/~~/g, "").replace(/[*`]+/g, "").replace(/[ \t]+/g, " ").trim();

function cellsOf(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const LABELS: Record<string, string> = {
  "الاسمالتجاري": "trade_name", "الاسمالعلمي": "scientific_name", "التصنيف": "classification",
  "الشركةالمنتجة": "manufacturer", "السعرالحاليالجديد": "price", "السعرالحالي": "price", "السعرالقديم": "old_price",
  "تحديثالسعر": "price_date", "عددالوحداتالكبرى": "major", "عددالوحداتالصغرى": "minor", "الحجم": "size",
  "التركيز": "strength", "رمزالباركود": "barcode",
};

const UNIT_ALIASES: [RegExp, string][] = [[/مجم|ملجم|ملغ/g, "mg"], [/جم|جرام/g, "g"], [/مل/g, "ml"]];
const normUnit = (u: string) => (u === "gm" ? "g" : u === "µg" ? "mcg" : u === "ug" ? "mcg" : u);

type Str = { value: number; unit: string; per: string | null };
const N = "(\\d+(?:\\.\\d+)?)";
const MASS = "(?:mg|mcg|ug|µg|iu|g|gm|%)";
const VOL = "(?:ml|g|gm)";

// "1%", "75mg", "5/5 mg", "500mg/150mg", "75mg/3ml", "1mg/ml". Anything else returns null (never guessed).
export function parseStrength(raw: string): Str[] | null {
  let s = ascii(raw).toLowerCase().replace(/\s+/g, " ").trim();
  for (const [re, u] of UNIT_ALIASES) s = s.replace(re, u);
  s = s.replace(/(\d),(\d)/g, "$1.$2");
  if (!s) return null;
  let m = s.match(new RegExp(`^${N}\\s*(${MASS})$`));
  if (m) return [{ value: Number(m[1]), unit: normUnit(m[2]), per: null }];
  // amount per volume: 75mg/3ml, 1mg/ml
  m = s.match(new RegExp(`^${N}\\s*(${MASS})\\s*/\\s*${N}?\\s*(${VOL})$`));
  if (m && m[2] !== "%") return [{ value: Number(m[1]), unit: normUnit(m[2]), per: `${m[3] ?? "1"} ${normUnit(m[4])}` }];
  // several amounts sharing one unit: 5/5 mg, 500+150 mg
  m = s.match(new RegExp(`^(${N}(?:\\s*[/+]\\s*${N})+)\\s*(${MASS})$`));
  if (m) {
    const unit = normUnit(m[m.length - 1]);
    const vals = m[1].split(/[/+]/).map((x) => Number(x.trim()));
    if (vals.every((v) => Number.isFinite(v))) return vals.map((value) => ({ value, unit, per: null }));
  }
  // several amounts, each with its own unit: 500mg/150mg
  if (new RegExp(`^${N}\\s*${MASS}(?:\\s*[/+]\\s*${N}\\s*${MASS})+$`).test(s)) {
    const parts = s.split(/[/+]/).map((x) => x.trim());
    const out: Str[] = [];
    for (const p of parts) {
      const pm = p.match(new RegExp(`^${N}\\s*(${MASS})$`));
      if (!pm) return null;
      out.push({ value: Number(pm[1]), unit: normUnit(pm[2]), per: null });
    }
    return out;
  }
  return null;
}

const FORM_TOKENS: [RegExp, string, string][] = [
  [/\b(tab|tabs|tablet|tablets)\b/, "Tablet", "tabs"], [/\b(cap|caps|capsule|capsules)\b/, "Capsule", "caps"],
  [/\bsyrup\b/, "Syrup", "syrup"], [/\b(amp|amps|ampoule|ampoules|ampoulles)\b/, "Ampoule", "amp"],
  [/\b(supp|suppository|suppositories)\b/, "Suppository", "supp"], [/\bemulgel\b/, "Emulgel", "emulgel"],
  [/\bgel\b/, "Gel", "gel"], [/\bcream\b/, "Cream", "cream"], [/\b(oint|ointment)\b/, "Ointment", "oint"],
  [/\bdrops?\b/, "Drops", "drops"], [/\bspray\b/, "Spray", "spray"], [/\bsachets?\b/, "Sachet", "sachet"],
  [/\b(susp|suspension)\b/, "Suspension", "susp"], [/\b(vial|vials)\b/, "Vial", "vial"],
  [/\blozenges?\b/, "Lozenge", "lozenge"], [/\b(inj|injection)\b/, "Injection", "inj"],
];

// Several amounts written as one token in a name ("5/5mg", "75mg/3ml") cannot be cleaned by the single-amount rules,
// so they are removed here before the normal name cleaning. Used for names only, never for strengths.
const U = "(?:mg|mcg|ug|iu|gm|g|ml|%|\u0645\u062c\u0645|\u0645\u0644\u062c\u0645|\u062c\u0645|\u0645\u0644)";
export function cleanComboStrengths(s: string): string {
  return s
    .replace(new RegExp(`\\d+(?:[.,]\\d+)?\\s*${U}\\s*/\\s*\\d*(?:[.,]\\d+)?\\s*${U}`, "gi"), " ")
    .replace(new RegExp(`\\d+(?:[.,]\\d+)?(?:\\s*[/+]\\s*\\d+(?:[.,]\\d+)?)+\\s*${U}?`, "gi"), " ")
    .replace(/\s+/g, " ").trim();
}

function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
}

function agree(a: number | null, b: number | null) { return a != null && b != null && Math.abs(a - b) < 0.005; }

export function parseDwapricesMarkdown(md: string, url: string): DwaParsed | null {
  const id = dwapricesIdOf(url);
  if (id == null || typeof md !== "string" || md.length < 200) return null;
  const lines = md.split(/\r?\n/);
  const notes: string[] = [];

  // 1) the details table: first row for each known label wins; nothing outside the table is trusted for these fields
  const row: Record<string, string> = {};
  for (const line of lines) {
    const c = cellsOf(line);
    if (!c || c.length < 2) continue;
    const key = LABELS[mdClean(c[0]).replace(/\s+/g, "")];
    if (!key || key in row) continue;
    row[key] = mdClean(c.slice(1).join(" | "));
  }
  const trade = (row.trade_name ?? "").split("\n")[0].trim();
  if (!trade || !/[A-Za-z]{2,}/.test(trade)) return null; // no English trade name: not a page this reader understands

  const field = (k: string) => {
    const v = (row[k] ?? "").trim();
    return v && !/^[-\u2013\u2014]+$/.test(v) ? v : null;
  };

  // 2) prices: header and table must agree; a conflict is left null and explained
  const headerLine = (re: RegExp) => { const l = lines.map(mdClean).find((x) => re.test(x)); return l ?? null; };
  let hCur: number | null = null;
  const iCur = lines.findIndex((l) => /\u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u062c\u062f\u064a\u062f \u0627\u0644\u062d\u0627\u0644\u064a \u0644\u0644\u0639\u0644\u0628\u0629/.test(mdClean(l)));
  if (iCur >= 0) {
    for (let k = iCur + 1; k < Math.min(iCur + 6, lines.length); k++) {
      const t = mdClean(lines[k]);
      if (!t) continue;
      if (/^[\d\u0660-\u0669.,]+\s*(\u062c\u0646\u064a\u0647|\u062c\.\u0645)/.test(t)) hCur = num(t);
      break;
    }
  }
  const oldLine = headerLine(/^\u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0642\u062f\u064a\u0645:/);
  const hOld = oldLine ? num(oldLine.replace(/^[^:]*:/, "")) : null;
  const tCur = field("price") ? num(field("price")) : null;
  const tOld = field("old_price") ? num(field("old_price")) : null;

  let currentPrice: number | null = null;
  if (hCur != null && tCur != null) {
    if (agree(hCur, tCur)) currentPrice = hCur;
    else notes.push(`current_price_conflict: page header shows ${hCur.toFixed(2)}, details table shows ${tCur.toFixed(2)}; left null`);
  } else if (hCur != null || tCur != null) {
    currentPrice = (hCur ?? tCur) as number;
    notes.push(`current_price_from_${hCur != null ? "header" : "table"}_only`);
  }
  if (currentPrice != null && currentPrice <= 0) { notes.push("current_price_zero:left null"); currentPrice = null; }

  let oldPrice: number | null = null;
  if (hOld != null && tOld != null) {
    if (agree(hOld, tOld)) oldPrice = hOld > 0 ? hOld : null;
    else notes.push(`old_price_conflict: page header shows ${hOld.toFixed(2)}, details table shows ${tOld.toFixed(2)}; left null`);
  } else if (hOld != null || tOld != null) {
    const v = (hOld ?? tOld) as number;
    if (v > 0) { oldPrice = v; notes.push(`old_price_from_${hOld != null ? "header" : "table"}_only`); }
  }

  // 3) price date: ISO in the table, dd/mm/yyyy in the header
  let tDate: string | null = null;
  const dm = (field("price_date") ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dm) tDate = isoDate(Number(dm[1]), Number(dm[2]), Number(dm[3]));
  let hDate: string | null = null;
  const hl = headerLine(/\u0622\u062e\u0631 \u062a\u062d\u062f\u064a\u062b \u0644\u0644\u0633\u0639\u0631:/);
  const hm = hl ? ascii(hl).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/) : null;
  if (hm) hDate = isoDate(Number(hm[3]), Number(hm[2]), Number(hm[1]));
  let priceDate: string | null = tDate ?? hDate;
  if (tDate && hDate && tDate !== hDate) { notes.push(`price_date_conflict: header ${hDate}, table ${tDate}; left null`); priceDate = null; }

  // 4) barcode: the cell repeats it ("6223013531628<br>الباركود الدولي<br>6223013531628"); only one clean 8-14 digit code is used
  const codes = [...new Set((ascii(row.barcode ?? "").match(/(?<!\d)\d{8,14}(?!\d)/g) ?? []))];
  let barcode: string | null = null;
  if (codes.length === 1) barcode = codes[0];
  else if (codes.length > 1) notes.push("barcode_multiple_values:left null");
  else notes.push("barcode_not_shown");

  // 5) dosage form: only when the product's own name states exactly one form word
  const lname = trade.toLowerCase();
  const forms = FORM_TOKENS.filter(([re]) => re.test(lname));
  let dosageForm: string | null = null;
  const distinct = new Set(forms.map((f) => f[1]));
  if (distinct.size === 1) { dosageForm = forms[0][1]; notes.push(`dosage_form_from_pack_text:${forms[0][2]}`); }
  else if (distinct.size > 1) notes.push("dosage_form_ambiguous:left null");

  // 6) ingredients + strengths
  const sci = field("scientific_name");
  const names = (sci ?? "").split("+").map((x) => x.trim()).filter(Boolean);
  const rawStrength = field("strength");
  if (rawStrength) notes.push(`source_strength:${rawStrength.slice(0, 60)}`);
  let strengths: Str[] | null = rawStrength ? parseStrength(rawStrength) : null;
  if (rawStrength && !strengths) notes.push("strength_unparsed:left null");
  if (!rawStrength) notes.push("strength_not_shown");
  if (!strengths && names.length === 1) {
    const found = [...ascii(trade).toLowerCase().matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(mg|mcg|ug|iu|%)(?![a-z])/g)];
    if (found.length === 1) {
      strengths = [{ value: Number(found[0][1]), unit: normUnit(found[0][2]), per: null }];
      notes.push("strength_from_trade_name");
    }
  }
  const ingredients: DwaIngredient[] = names.map((name) => ({ name, strength_value: null, strength_unit: null, strength_per: null }));
  if (strengths && names.length > 1) {
    // The site lists the scientific names alphabetically but writes the strengths in the product's own order, so for a
    // product with several ingredients the position of a strength does not say which ingredient it belongs to
    // (Exforge HCT 10/160/25 = amlodipine 10, valsartan 160, hydrochlorothiazide 25 -> wrongly paired by order).
    // Doses are therefore never assigned by position: they stay empty and the raw text stays in `source_strength`.
    notes.push(`multi_ingredient_strengths_not_paired: ${names.length} ingredients, ${strengths.length} strength values; order not guaranteed, doses left empty`);
  } else if (strengths && strengths.length === names.length && names.length === 1) {
    ingredients[0].strength_value = strengths[0].value;
    ingredients[0].strength_unit = strengths[0].unit;
    ingredients[0].strength_per = strengths[0].per;
  } else if (strengths && names.length > 0) {
    notes.push(`strength_count_mismatch: ${names.length} ingredients, ${strengths.length} strength values; left null`);
  }
  if (!names.length) notes.push("scientific_name_not_shown");

  const img = md.match(/https:\/\/dwaprices\.com\/upload\/[^\s)"']+/);
  const ar = md.match(/^##\s*\u0633\u0639\u0631\s+(.+?)\s+20\d{2}\s+\u0641\u064a \u0645\u0635\u0631/m);

  return {
    dwaprices_id: id, trade_name: trade, arabic_name: ar ? ar[1].trim() : null,
    scientific_name: sci, classification: field("classification"), manufacturer: field("manufacturer"),
    dosage_form: dosageForm, size: field("size"),
    current_price: currentPrice, old_price: oldPrice, price_updated_on: priceDate,
    major_unit_qty: field("major") ? num(field("major")) : null, minor_unit_qty: field("minor") ? num(field("minor")) : null,
    barcode, image_url: img ? img[0] : null, ingredients, notes,
  };
}
