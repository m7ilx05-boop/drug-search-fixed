import { norm } from "./extract.ts";

// Bounded Levenshtein: returns max+1 as soon as the distance is known to exceed `max`.
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const c = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(c);
      if (c < rowMin) rowMin = c;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Allowed edits grow slowly with the name length so short names do not match everything.
export const maxDist = (len: number) => (len <= 4 ? 1 : len <= 9 ? 2 : 3);

export const tokensOf = (s: string): string[] => norm(s).split(" ").filter((t) => t.length >= 3);

// Single-word terms only. The first letter must match: typos rarely change it and it removes most noise.
export function fuzzyHasToken(hayTokens: string[], term: string): boolean {
  if (term.length < 4 || term.includes(" ")) return false;
  const m = maxDist(term.length);
  return hayTokens.some((t) => t.length >= 4 && t[0] === term[0] && editDistance(t, term, m) <= m);
}

// "Did you mean" candidates. These are SUGGESTIONS ONLY: nothing derived from them is ever written to the database.
// Returns the words exactly as the source text spelled them (original case/script), closest first.
export function suggestNames(query: string, texts: string[], limit = 3): string[] {
  const qn = norm(query);
  if (qn.length < 4 || qn.includes(" ")) return [];
  const m = maxDist(qn.length);
  const seen = new Map<string, { shown: string; dist: number; count: number }>();
  for (const text of texts) {
    for (const raw of String(text ?? "").split(/[^A-Za-z0-9\u0600-\u06FF]+/)) {
      const n = norm(raw);
      if (n.length < 4 || n === qn || n[0] !== qn[0]) continue;
      const d = editDistance(n, qn, m);
      if (d === 0 || d > m) continue;
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
