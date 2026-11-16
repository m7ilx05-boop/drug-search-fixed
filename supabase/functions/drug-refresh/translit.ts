import { norm } from "./extract.ts";
import { editDistance } from "./fuzzy.ts";

// Consonant skeletons let an Arabic spelling be compared with a Latin one without any dictionary:
//   Valtrex -> f l t r k s      فالتريكس -> f l t r k s
// Vowels, h and w/y are dropped on both sides because they are written inconsistently across scripts.
const AR: Record<string, string> = {
  "\u0628": "b", "\u062A": "t", "\u062B": "t", "\u062C": "g", "\u062E": "k", "\u062F": "d", "\u0630": "d",
  "\u0631": "r", "\u0632": "z", "\u0633": "s", "\u0634": "s", "\u0635": "s", "\u0636": "d", "\u0637": "t",
  "\u0638": "z", "\u063A": "g", "\u0641": "f", "\u0642": "k", "\u0643": "k", "\u0644": "l", "\u0645": "m",
  "\u0646": "n",
};

const squeeze = (s: string) => s.replace(/(.)\1+/g, "$1");

export function arabicSkeleton(w: string): string {
  let o = "";
  for (const ch of norm(w)) o += AR[ch] ?? "";
  return squeeze(o);
}

export function latinSkeleton(s: string): string {
  return squeeze(
    norm(s)
      .replace(/ph/g, "f").replace(/ck/g, "k").replace(/x/g, "ks")
      .replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/q/g, "k")
      .replace(/v/g, "f").replace(/p/g, "b").replace(/j/g, "g")
      .replace(/[^a-z]/g, "").replace(/[aeiouyhw]/g, ""),
  );
}

// Arabic words found in `titles` that sound like the Latin query. Used only as extra search/match terms; never written
// to the database. A word is accepted only when its consonant skeleton is within one edit of the query's skeleton.
export function soundAlikeNames(query: string, titles: string[], limit = 2): string[] {
  const qs = latinSkeleton(query);
  if (qs.length < 4) return [];
  const qn = norm(query);
  const seen = new Map<string, { shown: string; dist: number; count: number }>();
  for (const t of titles) {
    for (const raw of String(t ?? "").split(/[^\u0600-\u06FF]+/)) {
      const n = norm(raw);
      if (n.length < 4 || n.length > 20 || n === qn) continue;
      const sk = arabicSkeleton(n);
      if (sk.length < 4) continue;
      const d = editDistance(sk, qs, 1);
      if (d > 1) continue;
      const cur = seen.get(n);
      if (cur) cur.count++;
      else seen.set(n, { shown: raw, dist: d, count: 1 });
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.dist - b.dist || b.count - a.count)
    .slice(0, limit)
    .map((x) => x.shown);
}
