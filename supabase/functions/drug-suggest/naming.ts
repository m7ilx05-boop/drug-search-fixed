// naming.ts - English drug-name typo suggestions from SEARCH RESULTS (titles + snippets + extracted names).
// Pure functions, no I/O, no database writes. Suggestions only: nothing here may auto-replace a name.

export type Item = { text: string; domain?: string; egypt?: boolean };
export type Suggestion = {
  name: string;          // spelling exactly as a source wrote it
  score: number;         // 0..1, ranking aid only (NOT a probability)
  sources: number;       // distinct domains that mention this spelling
  egypt: boolean;        // mentioned by at least one enabled Egyptian source
  why: string[];         // human-readable reasons: "phonetic" | "edit1" | ...
};

const lower = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Damerau-Levenshtein (optimal string alignment): a swapped pair counts as ONE edit.
export function damerau(a: string, b: string, max = 99): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Rough "how it sounds" key for Latin drug names: consonant skeleton with sound classes merged.
// Zesromax / Zithromax -> srmks ; Konkor / Concor -> knkr ; Ctal / Cetal -> ktl
export function phoneticKey(raw: string): string {
  let s = lower(raw).replace(/ /g, "");
  if (!s) return "";
  s = s.replace(/^kn/, "n").replace(/^ps/, "s").replace(/^x/, "z")
    .replace(/ph/g, "f").replace(/ck/g, "k").replace(/ch/g, "k").replace(/sh/g, "x")
    .replace(/th/g, "s").replace(/q/g, "k").replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s").replace(/c/g, "k")
    .replace(/z/g, "s").replace(/v/g, "f").replace(/j/g, "g").replace(/p/g, "b").replace(/d/g, "t")
    .replace(/[aeiouyhw]/g, "").replace(/[0-9]/g, "")
    .replace(/(.)\1+/g, "$1");
  return s;
}

// First letters that sound alike may differ (C/K/Q, S/Z, F/V/P(h)); other first letters must match.
const FIRST: Record<string, string> = { c: "k", q: "k", z: "s", v: "f", g: "g", j: "g" };
const firstClass = (s: string) => FIRST[s[0]] ?? s[0];

const STOP = new Set(("tablet tablets capsule capsules syrup cream gel drops injection ampoule ampoules price prices pharmacy online " +
  "egypt egyptian buy order store shop product products medicine medication drug drugs dose dosage side effects uses use usage " +
  "with for the and from that this what how best cheap sale available review reviews home page category brand brands news").split(" "));

export function tokensFrom(text: string, joinPairs = false): string[] {
  const words = lower(text).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    out.push(words[i]);
    if (joinPairs && i + 1 < words.length) out.push(words[i] + words[i + 1]); // "sanso zyme" -> "sansozyme"
  }
  // drug trade names hold letters only (digits are strengths/sizes), so "concor5" / "eliquis5" are never candidates
  return out.filter((t) => t.length >= 4 && t.length <= 24 && /^[a-z]+$/.test(t) && !STOP.has(t));
}

// The typed name without strengths/sizes ("Eliquis 5mg" -> "eliquis").
export function typedName(query: string): string {
  return lower(String(query ?? "").replace(/[0-9]+(?:[.,][0-9]+)?\s*(?:mg|mcg|ug|iu|gm|g|ml|%)?/gi, " "));
}

// True when the typed (single-word) name already appears as a word in the results: the spelling is right.
export function nameMentioned(query: string, items: Item[]): boolean {
  const typed = typedName(query);
  if (typed.includes(" ")) return false;
  return items.some((it) => tokensFrom(it.text ?? "").includes(typed));
}

type Acc = { shown: string; domains: Set<string>; egypt: boolean; best: number; why: Set<string> };

export function rankCandidates(query: string, items: Item[], limit = 5, minScore = 0.55): Suggestion[] {
  const typed = typedName(query);
  const q = typed.replace(/ /g, "");                  // spaces removed, used for comparison
  const spaced = typed.includes(" ");
  if (q.length < 3 || !/[a-z]/.test(q)) return [];
  const qk = phoneticKey(q);
  const acc = new Map<string, Acc>();
  // the typed name already appears as a word in a result: the spelling is right, so there is nothing to correct
  // (a spaced query like "sanso zyme" is different: its joined spelling "sansozyme" IS the suggestion)
  if (nameMentioned(query, items)) return [];

  for (const it of items) {
    const seenInItem = new Set<string>();
    // keep original spelling for display: map normalized -> raw word
    const raws = new Map<string, string>();
    for (const w of String(it.text ?? "").split(/[^A-Za-z0-9]+/).filter(Boolean)) raws.set(w.toLowerCase(), w);
    for (const t of tokensFrom(it.text ?? "", spaced)) {
      if (t === typed || seenInItem.has(t)) continue;   // a joined spelling of a spaced query IS a suggestion
      seenInItem.add(t);
      const lenGap = Math.abs(t.length - q.length);
      if (lenGap > 4) continue;
      const tk = phoneticKey(t);
      const dist = damerau(t, q, 4);
      const editSim = 1 - dist / Math.max(t.length, q.length);
      const kd = qk.length >= 3 && tk.length >= 3 ? damerau(tk, qk, 2) : 9;
      const firstOk = t[0] === q[0] || firstClass(t) === firstClass(q);
      const why: string[] = [];
      let score = 0;
      if (kd === 0 && firstOk && lenGap <= 3) { score = Math.max(score, 0.6 + 0.4 * editSim * 0.5 + 0.2 * 0 ); why.push("phonetic"); }
      if (kd === 1 && firstOk && lenGap <= 2 && editSim >= 0.7) { score = Math.max(score, 0.5 + 0.3 * editSim); why.push("phonetic~"); }
      if (dist <= (q.length <= 4 ? 1 : q.length <= 9 ? 2 : 3) && (firstOk || dist <= 1)) { score = Math.max(score, 0.45 + 0.5 * editSim); why.push(dist <= 1 ? "edit1" : "edit"); }
      // dropped letters: every typed letter appears in order (Ctal -> Cetal, Cnor -> Concor)
      if (q.length >= 3 && t.length > q.length && t.length - q.length <= 3 && t[0] === q[0] &&
          new RegExp("^" + q.split("").join(".*") + "").test(t)) { score = Math.max(score, 0.9 - 0.08 * (t.length - q.length)); why.push("subsequence"); }
      if (score <= 0) continue;
      const cur = acc.get(t) ?? { shown: raws.get(t) ?? t, domains: new Set<string>(), egypt: false, best: 0, why: new Set<string>() };
      cur.domains.add(it.domain ?? "unknown:" + acc.size);
      if (it.egypt) cur.egypt = true;
      cur.best = Math.max(cur.best, score);
      why.forEach((w) => cur.why.add(w));
      acc.set(t, cur);
    }
  }

  const out: Suggestion[] = [];
  for (const [, a] of acc) {
    const consensus = Math.min(0.15, 0.05 * (a.domains.size - 1));
    const score = Math.min(1, a.best + consensus + (a.egypt ? 0.1 : 0));
    if (score >= minScore) out.push({ name: a.shown, score: Math.round(score * 100) / 100, sources: a.domains.size, egypt: a.egypt, why: [...a.why] });
  }
  // case-insensitive duplicates already merged by key; sort by score, then sources
  return out.sort((x, y) => y.score - x.score || y.sources - x.sources || x.name.localeCompare(y.name)).slice(0, limit);
}
