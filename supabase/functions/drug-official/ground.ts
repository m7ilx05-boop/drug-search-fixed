import { norm, splitName } from "./extract.ts";

// Grounding: the page's own text (markdown) is the only truth. Whatever the AI extractor returned that the page text does not
// literally contain is thrown away: products whose name is not on the page, ingredients that are not on the page, strengths whose
// number+unit is not printed on the same line as the ingredient, and pack size / form / manufacturer / Arabic name not on the page.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const digits = (s: string) => s.replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/\u066B/g, ".");
const UNITS: Record<string, string[]> = {
  mg: ["mg", "milligram", "milligrams", "مجم", "ملجم", "ملغ", "ملغم"],
  mcg: ["mcg", "µg", "μg", "ug", "microgram", "micrograms", "ميكروجرام", "ميكروغرام"],
  g: ["g", "gm", "gram", "grams", "جم", "جرام", "غرام"],
  iu: ["iu", "i.u."],
  "%": ["%"],
  ml: ["ml", "مل"],
};
const unitRe = (u: string) => (UNITS[u.toLowerCase().trim()] ?? [u.toLowerCase().trim()]).map(esc).join("|");
const numRe = (v: number) => esc(String(v)).replace("\\.", "[.,]");
const L = "[A-Za-z\u0600-\u06FF]";

export type Dropped = Record<string, number>;

export function groundProducts(json: unknown, md: string): { json: { products: Record<string, unknown>[] }; dropped: Dropped } {
  const dropped: Dropped = { products: 0, ingredients: 0, strengths: 0, pack: 0, dosage_form: 0, manufacturer: 0, arabic_name: 0 };
  const list = Array.isArray((json as { products?: unknown })?.products) ? (json as { products: Record<string, unknown>[] }).products : [];
  const text = digits(md).replace(/(\d),(\d{3})/g, "$1$2");
  const low = text.toLowerCase();
  const nmd = norm(text);
  const lines = text.split("\n");
  const out: Record<string, unknown>[] = [];
  for (const it of list) {
    if (typeof it?.product_name !== "string") continue;
    const sp = splitName(it.product_name);
    if (!sp.name || !nmd.includes(norm(sp.name))) { dropped.products++; continue; }
    const p: Record<string, unknown> = { ...it, product_name: sp.name };
    const ings: Record<string, unknown>[] = [];
    for (const g of Array.isArray(it.ingredients) ? (it.ingredients as Record<string, unknown>[]) : []) {
      const nm = typeof g?.name === "string" ? g.name : "";
      const keys = [nm, nm.split("(")[0], typeof g?.inn_en === "string" ? g.inn_en : ""].map(norm).filter((k) => k.length >= 3);
      const hit = (re?: RegExp) => lines.some((l) => { const n = norm(l); return keys.some((k) => n.includes(k)) && (!re || re.test(l)); });
      if (!keys.length || !hit()) { dropped.ingredients++; continue; }
      const q: Record<string, unknown> = { ...g };
      const v = q.strength_value;
      const u = typeof q.strength_unit === "string" ? q.strength_unit : "";
      let ok = false;
      if (typeof v === "number" && Number.isFinite(v) && u) {
        ok = hit(new RegExp(`(?<![0-9.,])${numRe(v)} *(?:${unitRe(u)})(?!${L})`, "i"));
      }
      if (!ok && (q.strength_value != null || q.strength_unit != null)) dropped.strengths++;
      if (!ok) { delete q.strength_value; delete q.strength_unit; delete q.strength_per; }
      ings.push(q);
    }
    p.ingredients = ings;
    const packRaw = typeof p.pack_size === "string" && p.pack_size.trim() ? p.pack_size : sp.pack;
    delete p.pack_size;
    if (packRaw) {
      const m = /^ *([0-9.]+) *(.*)$/.exec(digits(packRaw));
      if (m && new RegExp(`(?<![0-9.])${esc(m[1])} *(?:x *)?${L}{2,12}`, "i").test(text)) p.pack_size = packRaw;
      else dropped.pack++;
    }
    for (const k of ["dosage_form", "manufacturer", "arabic_name"]) {
      const x = p[k];
      if (typeof x === "string" && x.trim() && !low.includes(x.trim().toLowerCase())) { dropped[k]++; delete p[k]; }
    }
    out.push(p);
  }
  return { json: { products: out }, dropped };
}
