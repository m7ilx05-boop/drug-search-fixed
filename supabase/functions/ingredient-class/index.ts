import { kenv } from "./vault-env.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ingredient-class: purpose / therapeutic class of each single active ingredient.
//   action "get"      { names: ["Metformin+sitagliptin", ...] } -> classes already stored (what the app shows next to an ingredient; also the class details)
//   action "fill_for" { names: ["paracetamol", ...] }           -> called by the app right after search results are shown: fills the classes of THOSE ingredients,
//                                                                 only if they are known ingredients of this database and have no class yet
//   action "fill"     { limit?: 1..25 }                         -> fills the next ingredients that have no class yet and stores them
//   action "status"   {}                                        -> counts, and whether the FDA_key_1 secret exists (never its value)
// "fill" never takes a name from the caller. "fill_for" does, but a name is only processed when it is an ingredient already in the database
// (active_ingredients or a dwaprices scientific name) with no stored class, so it cannot be used to burn the API quota with arbitrary names.
//
// Sources, in this order:
//   0) Nutrient rule: vitamins, minerals and amino acids are tagged by a fixed rule (they are supplements here, not drugs). openFDA / RxClass are NOT asked for them:
//      their labels belong to other products (zinc -> pyrithione zinc shampoo = "anti-dandruff", copper -> copper IUD).
//   1) RxClass (NLM RxNav, no key): the ingredient is resolved to an RxNorm ingredient (term type IN/PIN) and its FDA classes (EPC / MoA) are read by that ingredient.
//      Synonyms (paracetamol = acetaminophen) are handled by RxNorm itself. ATC is NOT used: RxClass mixes in the classes of combination products.
//   2) openFDA (secret FDA_key_1): the label "purpose" text, and EPC/MoA when RxClass had none. A label counts ONLY when its single substance name is the
//      same substance as the searched name (salts ignored): "PYRITHIONE ZINC" is not "zinc". Oral labels are tried first.
//      A purpose is kept only when most of the matching labels agree on it. There is no fallback to combination labels.
//   3) EMA (table ema_medicine, official EU data): ONLY when RxClass and openFDA both found nothing. Single-substance, human, centrally authorised medicines;
//      the pharmacotherapeutic group is kept when most of them agree. Stored with source = "ema".
// The simple tag is chosen by the patterns in class_purpose_map. No AI is involved. A wrong tag is fixed with purpose_override_en / purpose_override_ar.
//
// Label sections (table ingredient_label_section): original FDA text (+ an Arabic translation when one was stored). Returned as "sections" by get / fill_for. Nothing is generated here.
// RxClass facts (table ingredient_rxclass_fact, filled by the ingredient-rxclass function): uses / prevention / contraindications from MED-RT. Returned as "rxclass" by get / fill_for. Nothing is generated here.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const FDA_URL = "https://api.fda.gov/drug/label.json";
const RX_URL = "https://rxnav.nlm.nih.gov/REST";
// the openFDA key lives in the project secrets (FDA_key_1; the older name FDA_1 is accepted too)
const fdaKey = () => kenv.get("FDA_key_1") ?? kenv.get("FDA_1") ?? null;

// International (INN / British) names that openFDA writes differently (US names), plus known misspellings found in the database.
const SYN: Record<string, string> = {
  "paracetamol": "acetaminophen", "acetylsalicylic acid": "aspirin", "salbutamol": "albuterol", "adrenaline": "epinephrine",
  "noradrenaline": "norepinephrine", "glibenclamide": "glyburide", "ciclosporin": "cyclosporine", "rifampicin": "rifampin",
  "lignocaine": "lidocaine", "pethidine": "meperidine", "thyroxine": "levothyroxine", "vitamin b12": "cyanocobalamin",
  "vitamin c": "ascorbic acid", "vitamin d3": "cholecalciferol", "vitamin d": "cholecalciferol", "vitamin e": "tocopherol",
  "vitamin b1": "thiamine", "vitamin b6": "pyridoxine", "vitamin k": "phytonadione", "frusemide": "furosemide",
  "benzylpenicillin": "penicillin g", "phenobarbitone": "phenobarbital", "chlorpheniramine": "chlorpheniramine maleate",
  "phenylepherine": "phenylephrine",
};

// Salt / hydrate words dropped to get the base substance ("bisoprolol fumarate" -> "bisoprolol").
const SALTS = new Set([
  "hydrochloride", "dihydrochloride", "hcl", "hydrobromide", "sodium", "disodium", "potassium", "dipotassium", "calcium", "magnesium",
  "sulfate", "sulphate", "maleate", "mesylate", "mesilate", "tartrate", "citrate", "phosphate", "acetate", "besylate", "besilate",
  "fumarate", "succinate", "bromide", "chloride", "nitrate", "tosylate", "hydrate", "monohydrate", "dihydrate", "trihydrate",
  "anhydrous", "hemihydrate", "lactate", "gluconate", "oxalate", "pamoate", "napsylate", "hyclate", "medoxomil", "axetil",
  "proxetil", "cilexetil", "dipropionate", "propionate", "valerate", "furoate", "micronized",
]);

const normComp = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const splitNames = (name: string) => name.split("+").map(normComp).filter(Boolean);

// "bisoprolol fumarate" -> "bisoprolol". A name made only of salt words ("calcium") is kept as it is.
const stripSalts = (s: string) => {
  const t = normComp(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const w = t.split(" ").filter((x) => !SALTS.has(x)).join(" ").trim();
  return w || t;
};

// ---- Nutrients: fixed rule, never asked from openFDA / RxClass ----
const MINERAL_RE = /^(zinc( (sulfate|sulphate|gluconate|acetate|citrate|picolinate|bisglycinate))?|copper( (sulfate|gluconate))?|iron|ferrous( [a-z ]+)?|selenium|manganese|chromium|iodine|minerals?|magnesium|calcium)$/;
const VITAMIN_RE = /^(vitamins?( [a-z0-9]+)?|ascorbic acid|cholecalciferol|ergocalciferol|thiamine|riboflavin|pyridoxine|cyanocobalamin|methylcobalamin|folic acid|folate|biotin|tocopherol|retinol|beta carotene)$/;
const AMINO_RE = /^(lysine|l-lysine|arginine|l-arginine|taurine|glutamine|l-glutamine)$/;
function nutrientTag(component: string): { en: string; ar: string } | null {
  const base = normComp(component.replace(/\([^)]*\)/g, " "));
  if (!base) return null;
  if (MINERAL_RE.test(base)) return { en: "Mineral / dietary supplement", ar: "معدن / مكمل غذائي" };
  if (VITAMIN_RE.test(base)) return { en: "Vitamin / dietary supplement", ar: "فيتامين / مكمل غذائي" };
  if (AMINO_RE.test(base)) return { en: "Amino acid / dietary supplement", ar: "حمض أميني / مكمل غذائي" };
  return null;
}

// Names to try, best first: the US name, the name written in brackets, the name as written, the name without salts.
function candidates(component: string): string[] {
  const out: string[] = [];
  const add = (x: string | undefined | null) => {
    const t = (x ?? "").replace(/[^a-z0-9 ,'\-]/g, " ").replace(/\s+/g, " ").trim();
    if (t.length >= 3 && !out.includes(t)) out.push(t);
  };
  const paren = component.match(/\(([^)]+)\)/)?.[1];
  const base = component.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const stripped = base.split(" ").filter((w) => !SALTS.has(w)).join(" ").trim();
  for (const c of [SYN[base], SYN[stripped], paren, base, stripped]) add(c);
  return out.slice(0, 5);
}

type FdaLabel = {
  openfda?: { pharm_class_epc?: string[]; pharm_class_moa?: string[]; substance_name?: string[]; route?: string[] };
  purpose?: string[];
};
class RateLimited extends Error {}

// a label counts only when it has ONE substance and that substance is the searched one (salts ignored)
const sameSubstance = (r: FdaLabel, term: string) => {
  const n = r.openfda?.substance_name;
  return !!n && n.length === 1 && stripSalts(n[0]) === stripSalts(term);
};

async function fdaQuery(search: string, key: string, limit: number): Promise<FdaLabel[]> {
  const url = `${FDA_URL}?search=${encodeURIComponent(search)}&limit=${limit}&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) { await res.body?.cancel(); return []; } // openFDA answers 404 when nothing matches
  if (res.status === 429) { await res.body?.cancel(); throw new RateLimited("openfda_rate_limited"); }
  if (!res.ok) { await res.body?.cancel(); throw new Error("openfda_http_" + res.status); }
  const d = await res.json();
  return (d?.results ?? []) as FdaLabel[];
}

// Labels of the exact substance. Order: exact name + oral, then phrase + oral, then phrase without route.
// Every result is filtered with sameSubstance, so a label of a different substance that merely contains the word never gets in.
async function fdaSearch(term: string, key: string): Promise<FdaLabel[]> {
  const t = term.replace(/"/g, "").trim();
  const T = t.toUpperCase();
  const steps: [string, number][] = [
    [`(openfda.substance_name.exact:"${T}" OR openfda.generic_name.exact:"${T}") AND openfda.route:"ORAL"`, 25],
    [`(openfda.generic_name:"${t}" OR openfda.substance_name:"${t}") AND openfda.route:"ORAL"`, 25],
    [`(openfda.generic_name:"${t}" OR openfda.substance_name:"${t}")`, 25],
  ];
  for (const [q, limit] of steps) {
    const ok = (await fdaQuery(q, key, limit)).filter((r) => sameSubstance(r, t));
    if (ok.length) return ok;
  }
  return [];
}

// ---- RxClass (NLM RxNav, no key) ----
async function rxJson(path: string) {
  const res = await fetch(RX_URL + path, { signal: AbortSignal.timeout(12000) });
  if (res.status === 429) { await res.body?.cancel(); throw new RateLimited("rxnav_rate_limited"); }
  if (!res.ok) { await res.body?.cancel(); throw new Error("rxnav_http_" + res.status); }
  return await res.json();
}
// the name -> an RxNorm INGREDIENT (term type IN / PIN). A combination concept or a product is never accepted.
async function rxIngredient(term: string): Promise<{ rxcui: string; name: string } | null> {
  const d = await rxJson(`/rxcui.json?name=${encodeURIComponent(term)}&search=2`);
  const ids: string[] = d?.idGroup?.rxnormId ?? [];
  for (const id of ids.slice(0, 3)) {
    const p = await rxJson(`/rxcui/${encodeURIComponent(id)}/properties.json`);
    const tty = p?.properties?.tty;
    if (tty === "IN" || tty === "PIN") return { rxcui: id, name: String(p.properties.name ?? term) };
  }
  return null;
}
async function rxFdaClasses(rxcui: string): Promise<{ epc: string[]; moa: string[] }> {
  const d = await rxJson(`/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(rxcui)}&relaSource=DAILYMED`);
  const items: { rxclassMinConceptItem?: { classType?: string; className?: string } }[] = d?.rxclassDrugInfoList?.rxclassDrugInfo ?? [];
  const pick = (t: string) => [...new Set(items.filter((i) => i.rxclassMinConceptItem?.classType === t).map((i) => String(i.rxclassMinConceptItem?.className ?? "")).filter(Boolean))].slice(0, 3);
  return { epc: pick("EPC"), moa: pick("MOA") };
}

// Most frequent values. minShare = the share of labels (0..1) that must carry the value; a value stated by too few labels is dropped.
const top = (lists: (string[] | undefined)[], n: number, minShare = 0): string[] => {
  const m = new Map<string, number>();
  for (const l of lists) for (const x of new Set(l ?? [])) m.set(x, (m.get(x) ?? 0) + 1);
  const need = Math.max(1, Math.ceil(lists.length * minShare));
  return [...m.entries()].filter((e) => e[1] >= need).sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, n);
};
const cleanPurpose = (s: string) => s.replace(/^\s*purposes?\s*[:\-]?\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 160);

type MapRow = { pattern: string; purpose_en: string; purpose_ar: string };
function pickTag(text: string, map: MapRow[]): MapRow | null {
  for (const m of map) {
    try { if (new RegExp(m.pattern, "i").test(text)) return m; } catch { /* a bad pattern is skipped */ }
  }
  return null;
}

// ---- EMA fallback (only when RxClass and openFDA found nothing) ----
async function emaLookup(db: ReturnType<typeof createClient>, cands: string[]) {
  try {
    const names = [...new Set(cands.flatMap((c) => [c.toLowerCase(), stripSalts(c)]))].filter(Boolean);
    const q = await db.from("ema_medicine").select("substances,atc_code,pharmacotherapeutic_group")
      .eq("n_substances", 1).eq("category", "human").overlaps("substances", names).limit(40);
    if (q.error || !q.data?.length) return null;
    const rows = q.data as { substances: string[]; atc_code: string | null; pharmacotherapeutic_group: string | null }[];
    const group = top(rows.map((r) => (r.pharmacotherapeutic_group ? [r.pharmacotherapeutic_group.slice(0, 160)] : [])), 1, 0.5);
    if (!group.length) return null;
    return { group: group[0], used: rows.length, name: rows[0].substances[0] };
  } catch (e) { console.error("ema_lookup_error", e instanceof Error ? e.message : e); return null; }
}

async function lookup(component: string, key: string, map: MapRow[], db: ReturnType<typeof createClient>) {
  // 0) nutrients (vitamins / minerals / amino acids): fixed tag, no API call
  const nut = nutrientTag(component);
  if (nut) {
    return {
      component, status: "found", purpose_en: nut.en, purpose_ar: nut.ar,
      pharm_class_epc: [] as string[], pharm_class_moa: [] as string[], fda_purpose: [] as string[],
      matched_name: component, labels_used: 0, error: null, source: "nutrient_rule", fetched_at: new Date().toISOString(),
    };
  }

  const cands = candidates(component);

  // 1) RxClass: classes of the ingredient itself. A failure here is not fatal (openFDA still runs), but it is remembered.
  let rx: { epc: string[]; moa: string[]; name: string } | null = null;
  let rxErr: unknown = null;
  for (const cand of cands.slice(0, 3)) {
    try {
      const ing = await rxIngredient(cand);
      if (!ing) continue;
      const c = await rxFdaClasses(ing.rxcui);
      if (c.epc.length || c.moa.length) { rx = { ...c, name: ing.name }; break; }
    } catch (e) { rxErr = e; break; }
  }

  // 2) openFDA: the purpose text (and EPC/MoA when RxClass had none). Only labels of exactly this one substance.
  let fda: { epc: string[]; moa: string[]; purpose: string[]; cand: string; used: number } | null = null;
  for (const cand of cands) {
    const single = await fdaSearch(cand, key);
    if (!single.length) continue; // no fallback to other substances or combination labels
    const epc = top(single.map((r) => r.openfda?.pharm_class_epc), 3);
    const moa = top(single.map((r) => r.openfda?.pharm_class_moa), 3);
    // a purpose is kept only when at least half of the matching labels state it
    const purpose = top(single.map((r) => r.purpose?.map(cleanPurpose)), 2, 0.5);
    if (!epc.length && !moa.length && !purpose.length) continue;
    fda = { epc, moa, purpose, cand, used: single.length };
    break;
  }

  const epc = rx?.epc.length ? rx.epc : (fda?.epc ?? []);
  const moa = rx?.moa.length ? rx.moa : (fda?.moa ?? []);
  const purpose = fda?.purpose ?? [];
  const empty = !epc.length && !moa.length && !purpose.length;
  // nothing found and RxClass was down: do not record "not found", record an error so it is retried
  if (empty && rxErr) throw rxErr;

  if (empty) {
    const ema = await emaLookup(db, cands);
    if (ema) {
      const t = pickTag(ema.group, map);
      return {
        component, status: "found", purpose_en: t?.purpose_en ?? null, purpose_ar: t?.purpose_ar ?? null,
        pharm_class_epc: [ema.group], pharm_class_moa: [] as string[], fda_purpose: [] as string[],
        matched_name: ema.name, labels_used: ema.used, error: null, source: "ema", fetched_at: new Date().toISOString(),
      };
    }
    return {
      component, status: "not_found", purpose_en: null, purpose_ar: null,
      pharm_class_epc: [] as string[], pharm_class_moa: [] as string[], fda_purpose: [] as string[],
      matched_name: null, labels_used: 0, error: null, source: "rxclass+openfda", fetched_at: new Date().toISOString(),
    };
  }
  const tag = pickTag([...epc, ...moa, ...purpose].join(" ; "), map);
  return {
    component, status: "found", purpose_en: tag?.purpose_en ?? null, purpose_ar: tag?.purpose_ar ?? null,
    pharm_class_epc: epc, pharm_class_moa: moa, fda_purpose: purpose,
    matched_name: rx?.name ?? fda?.cand ?? null, labels_used: fda?.used ?? 0, error: null,
    source: rx && fda ? "rxclass+openfda" : rx ? "rxclass" : "openfda", fetched_at: new Date().toISOString(),
  };
}

// what the app receives for one stored ingredient (the tag + the class details shown when the ingredient is tapped)
type ClassRow = {
  status: string; purpose_en?: string | null; purpose_ar?: string | null; purpose_override_en?: string | null; purpose_override_ar?: string | null;
  pharm_class_epc?: string[] | null; pharm_class_moa?: string[] | null; fda_purpose?: string[] | null; matched_name?: string | null; source?: string | null;
};
const shape = (r: ClassRow) => ({
  status: r.status,
  purpose_en: r.purpose_override_en ?? r.purpose_en ?? null,
  purpose_ar: r.purpose_override_ar ?? r.purpose_ar ?? null,
  fda_class: r.pharm_class_epc?.[0] ?? null,
  epc: r.pharm_class_epc ?? [],
  moa: r.pharm_class_moa ?? [],
  fda_purpose: (r.fda_purpose ?? []).slice(0, 3),
  matched_name: r.matched_name ?? null,
  source: r.source ?? null,
});

// Curated class / subclass / max daily dose (tables ingredient_reference + ingredient_max_dose).
// Only rows with review_status = 'reviewed' are returned, doses also need a source. Nothing here is generated: no row -> no "reference" key.
type RefOut = { review_status: string | null; class_en?: string | null; class_ar?: string | null; subclass_en?: string | null; subclass_ar?: string | null;
  source_title?: string | null; source_url?: string | null; doses: Record<string, unknown>[] };
async function loadRefs(db: ReturnType<typeof createClient>, comps: string[]): Promise<Record<string, RefOut>> {
  const out: Record<string, RefOut> = {};
  if (!comps.length) return out;
  const [r, d] = await Promise.all([
    db.from("ingredient_reference").select("component,class_en,class_ar,subclass_en,subclass_ar,source_title,source_url,review_status")
      .in("component", comps).eq("review_status", "reviewed"),
    db.from("ingredient_max_dose").select("component,age_group,age_min_years,age_max_years,max_daily_dose,max_single_dose,unit,route,notes_ar,source_title,source_url,review_status")
      .in("component", comps).eq("review_status", "reviewed").not("source_title", "is", null),
  ]);
  if (r.error || d.error) { console.error("reference_error", r.error?.message ?? d.error?.message); return out; } // the card still works without it
  for (const x of (r.data ?? []) as Record<string, string | null>[]) {
    out[x.component as string] = { review_status: x.review_status, class_en: x.class_en, class_ar: x.class_ar, subclass_en: x.subclass_en,
      subclass_ar: x.subclass_ar, source_title: x.source_title, source_url: x.source_url, doses: [] };
  }
  for (const x of (d.data ?? []) as Record<string, unknown>[]) {
    const c = x.component as string;
    (out[c] ??= { review_status: null, doses: [] }).doses.push(x);
  }
  return out;
}

// FDA label sections stored in ingredient_label_section (original text + a translation when one exists). No row -> no "sections" key.
async function loadSections(db: ReturnType<typeof createClient>, comps: string[]): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  if (!comps.length) return out;
  const q = await db.from("ingredient_label_section")
    .select("component,section_key,title_ar,text_en,text_ar,set_id,effective_time,sort_order,source,source_ref")
    .in("component", comps).order("sort_order", { ascending: true });
  if (q.error) { console.error("sections_error", q.error.message); return out; } // the card still works without it
  for (const x of (q.data ?? []) as Record<string, unknown>[]) {
    const c = x.component as string;
    (out[c] ??= []).push({ section_key: x.section_key, title_ar: x.title_ar, text_en: x.text_en, text_ar: x.text_ar, set_id: x.set_id, effective_time: x.effective_time, source: x.source ?? null, source_ref: x.source_ref ?? null });
  }
  return out;
}

// RxClass (MED-RT) uses / prevention / contraindications stored in ingredient_rxclass_fact (filled by the ingredient-rxclass function).
// Class-level facts about the active ingredient, English MeSH names (name_ar only when a translation was stored). No row -> no "rxclass" key.
type RxItem = { id: string; name: string; name_ar: string | null };
type RxOut = { rxcui: string | null; name: string | null; source: string; note_ar: string; fetched_at: string | null; indications: RxItem[]; prevention: RxItem[]; contraindications: RxItem[] };
const RX_NOTE_AR = "معلومات عامة عن المادة الفعّالة من تصنيف MED-RT (المكتبة الطبية الأمريكية عبر RxClass)، مش لمنتج معيّن في السوق المصري، ومش بديل لرأي الصيدلي أو الطبيب.";
async function loadRxclass(db: ReturnType<typeof createClient>, comps: string[]): Promise<Record<string, RxOut>> {
  const out: Record<string, RxOut> = {};
  if (!comps.length) return out;
  const [f, m] = await Promise.all([
    db.from("ingredient_rxclass_fact").select("component,fact_kind,class_id,class_name,name_ar").in("component", comps).order("class_name", { ascending: true }),
    db.from("ingredient_rxclass_fetch").select("component,rxcui,rxnorm_name,fetched_at").in("component", comps).eq("status", "found"),
  ]);
  if (f.error || m.error) { console.error("rxclass_error", f.error?.message ?? m.error?.message); return out; } // the card still works without it
  const meta = new Map<string, { rxcui: string | null; rxnorm_name: string | null; fetched_at: string | null }>();
  for (const r of (m.data ?? []) as { component: string; rxcui: string | null; rxnorm_name: string | null; fetched_at: string | null }[]) meta.set(r.component, r);
  for (const r of (f.data ?? []) as { component: string; fact_kind: string; class_id: string; class_name: string; name_ar: string | null }[]) {
    const mt = meta.get(r.component);
    const o = (out[r.component] ??= {
      rxcui: mt?.rxcui ?? null, name: mt?.rxnorm_name ?? null, source: "RxClass (MED-RT)", note_ar: RX_NOTE_AR, fetched_at: mt?.fetched_at ?? null,
      indications: [], prevention: [], contraindications: [],
    });
    const it = { id: r.class_id, name: r.class_name, name_ar: r.name_ar ?? null };
    if (r.fact_kind === "indication") o.indications.push(it);
    else if (r.fact_kind === "prevention") o.prevention.push(it);
    else if (r.fact_kind === "contraindication") o.contraindications.push(it);
  }
  return out;
}

// a name is accepted for fill_for only when it is an ingredient this database already knows (so arbitrary text cannot spend the API quota)
async function isKnownComponent(db: ReturnType<typeof createClient>, comp: string): Promise<boolean> {
  const like = comp.replace(/[\\%_]/g, (m) => "\\" + m);
  const [a, b] = await Promise.all([
    db.from("active_ingredients").select("inn").ilike("inn", like).or("ingredient_type.is.null,ingredient_type.eq.active").limit(1),
    db.from("dwaprices_products").select("scientific_name").ilike("scientific_name", `%${like}%`).limit(25),
  ]);
  if ((a.data ?? []).length) return true;
  return (b.data ?? []).some((r: { scientific_name: string | null }) =>
    String(r.scientific_name ?? "").toLowerCase().split("+").map(normComp).includes(comp));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { action?: unknown; names?: unknown; limit?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const action = typeof body.action === "string" ? body.action : "";
  if (!["get", "fill", "fill_for", "status"].includes(action)) return json({ error: "invalid_action", allowed: ["get", "fill", "fill_for", "status"] }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const isFill = action === "fill" || action === "fill_for";
  const rl = await db.rpc("check_rate_limit", { p_key: `class-${action}:${ip}`, p_limit: isFill ? 6 : 60, p_window_seconds: 60 });
  if (rl.error) { console.error("rate_limit_error", rl.error.message); if (isFill) return json({ error: "internal_error" }, 500); }
  else if (rl.data === false) return json({ error: "rate_limited" }, 429);

  if (action === "get") {
    const names = (Array.isArray(body.names) ? body.names : []).filter((x): x is string => typeof x === "string").slice(0, 50);
    const comps = [...new Set(names.flatMap((n) => splitNames(n.slice(0, 200))))].slice(0, 100);
    if (!comps.length) return json({ items: {} });
    const q = await db.from("ingredient_class")
      .select("component,status,purpose_en,purpose_ar,purpose_override_en,purpose_override_ar,pharm_class_epc,pharm_class_moa,fda_purpose,matched_name,source")
      .in("component", comps);
    if (q.error) { console.error("get_error", q.error.message); return json({ error: "internal_error" }, 500); }
    const items: Record<string, unknown> = {};
    for (const r of q.data ?? []) items[r.component as string] = shape(r as ClassRow);
    const [refs, secs, rxs] = await Promise.all([loadRefs(db, Object.keys(items)), loadSections(db, Object.keys(items)), loadRxclass(db, Object.keys(items))]);
    for (const c of Object.keys(refs)) (items[c] as Record<string, unknown>).reference = refs[c];
    for (const c of Object.keys(secs)) (items[c] as Record<string, unknown>).sections = secs[c];
    for (const c of Object.keys(rxs)) (items[c] as Record<string, unknown>).rxclass = rxs[c];
    return json({ items });
  }

  if (action === "status") {
    const all = await db.from("ingredient_class").select("status,purpose_en,purpose_override_en");
    if (all.error) return json({ error: "internal_error" }, 500);
    const counts: Record<string, number> = { found: 0, not_found: 0, error: 0, found_with_tag: 0 };
    for (const r of all.data ?? []) {
      counts[r.status as string] = (counts[r.status as string] ?? 0) + 1;
      if (r.status === "found" && (r.purpose_en || r.purpose_override_en)) counts.found_with_tag++;
    }
    const todo = await db.rpc("ingredient_components_todo", { p_limit: 50 });
    return json({ has_key: !!fdaKey(), counts, todo_next: (todo.data ?? []).length, todo_note: "50 means 50 or more" });
  }

  // fill / fill_for
  const key = fdaKey();
  if (!key) return json({ error: "missing_secret", detail: "the FDA_key_1 secret is not set for this project" }, 500);
  const mapQ = await db.from("class_purpose_map").select("pattern,purpose_en,purpose_ar").order("priority", { ascending: true });
  if (mapQ.error) { console.error("map_error", mapQ.error.message); return json({ error: "internal_error" }, 500); }
  const map = (mapQ.data ?? []) as MapRow[];

  // fill_for: the ingredients that were just shown in the app's search results
  if (action === "fill_for") {
    const names = (Array.isArray(body.names) ? body.names : []).filter((x): x is string => typeof x === "string").slice(0, 12);
    const comps = [...new Set(names.flatMap((n) => splitNames(n.slice(0, 200))))].slice(0, 8);
    if (!comps.length) return json({ processed: 0, items: {} });
    const have = await db.from("ingredient_class").select("component,status,fetched_at").in("component", comps);
    if (have.error) { console.error("have_error", have.error.message); return json({ error: "internal_error" }, 500); }
    const retryBefore = Date.now() - 24 * 3600 * 1000;
    const done = new Set((have.data ?? [])
      .filter((r: { status: string; fetched_at: string }) => r.status !== "error" || new Date(r.fetched_at).getTime() >= retryBefore)
      .map((r: { component: string }) => r.component));
    const sum = { processed: 0, skipped_unknown: 0, errors: 0, stopped: null as string | null };
    const out: Record<string, unknown> = {};
    const deadline = Date.now() + 60_000;
    for (const comp of comps.filter((c) => !done.has(c))) {
      if (Date.now() > deadline) { sum.stopped = "time_budget"; break; }
      if (!(await isKnownComponent(db, comp))) { sum.skipped_unknown++; continue; }
      let row: Awaited<ReturnType<typeof lookup>> | Record<string, unknown>;
      try {
        row = await lookup(comp, key, map, db);
      } catch (e) {
        if (e instanceof RateLimited) { sum.stopped = "api_rate_limited"; break; }
        row = {
          component: comp, status: "error", purpose_en: null, purpose_ar: null, pharm_class_epc: [], pharm_class_moa: [],
          fda_purpose: [], matched_name: null, labels_used: 0, source: "rxclass+openfda",
          error: (e instanceof Error ? e.message : "error").slice(0, 200), fetched_at: new Date().toISOString(),
        };
      }
      const up = await db.from("ingredient_class").upsert(row, { onConflict: "component" });
      if (up.error) { console.error("upsert_error", up.error.message); sum.stopped = "db_error"; break; }
      sum.processed++;
      if (row.status === "error") sum.errors++; else out[comp] = shape(row as ClassRow);
      await new Promise((r) => setTimeout(r, 250));
    }
    const [refs, secs, rxs] = await Promise.all([loadRefs(db, Object.keys(out)), loadSections(db, Object.keys(out)), loadRxclass(db, Object.keys(out))]);
    for (const c of Object.keys(refs)) (out[c] as Record<string, unknown>).reference = refs[c];
    for (const c of Object.keys(secs)) (out[c] as Record<string, unknown>).sections = secs[c];
    for (const c of Object.keys(rxs)) (out[c] as Record<string, unknown>).rxclass = rxs[c];
    return json({ ...sum, items: out });
  }

  // fill
  const limit = Math.min(Math.max(Math.floor(Number(body.limit)) || 10, 1), 25);
  const deadline = Date.now() + 100_000;
  const todo = await db.rpc("ingredient_components_todo", { p_limit: limit });
  if (todo.error) { console.error("todo_error", todo.error.message); return json({ error: "internal_error" }, 500); }

  const sum = { processed: 0, found: 0, found_with_tag: 0, not_found: 0, errors: 0, stopped: null as string | null };
  const rows: { component: string; status: string; purpose_en: string | null; epc: string | null; matched: string | null; source: string | null }[] = [];
  for (const t of (todo.data ?? []) as { component: string }[]) {
    if (Date.now() > deadline) { sum.stopped = "time_budget"; break; }
    let row: Awaited<ReturnType<typeof lookup>> | Record<string, unknown>;
    try {
      row = await lookup(t.component, key, map, db);
    } catch (e) {
      if (e instanceof RateLimited) { sum.stopped = "api_rate_limited"; break; }
      row = {
        component: t.component, status: "error", purpose_en: null, purpose_ar: null, pharm_class_epc: [], pharm_class_moa: [],
        fda_purpose: [], matched_name: null, labels_used: 0, source: "rxclass+openfda",
        error: (e instanceof Error ? e.message : "error").slice(0, 200), fetched_at: new Date().toISOString(),
      };
    }
    const up = await db.from("ingredient_class").upsert(row, { onConflict: "component" });
    if (up.error) { console.error("upsert_error", up.error.message); sum.stopped = "db_error"; break; }
    sum.processed++;
    const st = row.status as string;
    if (st === "found") { sum.found++; if (row.purpose_en) sum.found_with_tag++; } else if (st === "not_found") sum.not_found++; else sum.errors++;
    rows.push({
      component: t.component, status: st, purpose_en: (row.purpose_en as string | null) ?? null,
      epc: ((row.pharm_class_epc as string[] | undefined) ?? [])[0] ?? null, matched: (row.matched_name as string | null) ?? null,
      source: (row.source as string | null) ?? null,
    });
    await new Promise((r) => setTimeout(r, 250));
  }
  return json({ ...sum, rows });
});
