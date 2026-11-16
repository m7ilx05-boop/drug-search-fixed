import { norm } from "./extract.ts";
import { fuzzyHasToken, tokensOf } from "./fuzzy.ts";
import { dwapricesIdOf, isDwapricesDomain } from "./dwaprices.ts";

// viaId: the page was derived from a dwaprices.com hit that only carried the product's id (aorder.php / similars.php), see dwaProductPages.
export type Found = { url: string; title: string; score: number; viaId?: boolean };

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
export const pathRaw = (u: string) => { try { return new URL(u).pathname.toLowerCase(); } catch { return ""; } };
export const hostMatches = (host: string, domain: string) => {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return host === d || host.endsWith("." + d);
};

// Pages that are not product pages: articles, taxonomy/brand/category listings, pagination.
// Their text is editorial or navigational, so they are never extracted as product data.
export const NON_PRODUCT = /\/(blog|blogs|article|articles|news|category|product-category|tag|brand|brands|page\/\d+)(\/|$)/;
export const PRODUCT_LIKE = /\/(nowproduct|product|products|item|p)\//;

// dwaprices.com: only /med.php?id=N is a product page. Its search / category / listing pages (ause.php, similars.php ...)
// are dropped from planning completely: they are neither scraped nor stored as reading material.
const isDwaListing = (u: string) => isDwapricesDomain(hostOf(u)) && dwapricesIdOf(u) == null;

// dwaprices.com search hits such as aorder.php?id=N or similars.php?id=N are other pages of product N, so the product's own
// page is med.php?id=N. Such a hit is turned into that product page (marked viaId, because its title is often Arabic and
// cannot be matched by text). Nothing is trusted from the title: the page is read and its own English trade name has to
// contain the searched name (validateProducts), otherwise it is dropped. Duplicates of one id are merged.
export function dwaProductPages(found: Iterable<Found>): Found[] {
  const out = new Map<string, Found>();
  for (const p of found) {
    let url = p.url;
    let via = false;
    try {
      const x = new URL(p.url);
      const path = x.pathname.toLowerCase();
      const id = x.searchParams.get("id");
      if (isDwapricesDomain(x.hostname) && (path === "/aorder.php" || path === "/similars.php") && id && /^\d{1,9}$/.test(id)) {
        url = `https://dwaprices.com/med.php?id=${id}`;
        via = true;
      }
    } catch { /* not a URL: kept as it is */ }
    const cur = out.get(url);
    if (!cur) out.set(url, { ...p, url, ...(via ? { viaId: true } : {}) });
    else out.set(url, { ...cur, score: Math.max(cur.score ?? 0, p.score ?? 0), viaId: !!cur.viaId || via });
  }
  return [...out.values()];
}

// A search hit with no text link to the query still counts as related when the search engine scored it at least this high.
export const MIN_SCORE = 0.5;

const hayOf = (p: Found) => norm(`${p.title ?? ""} ${decode(pathRaw(p.url))}`);

// The same name written with different spacing / hyphens ("Galvusmet" / "Galvus Met") is the same name: compared without spaces,
// only for terms of at least 4 characters.
const spaceless = (s: string) => s.replace(/ /g, "");

// 3 = the query (or a known synonym) appears in the title/URL, 2 = a close misspelling does, 1 = only a high search score, 0 = unrelated.
export function relevance(p: Found, terms: string[]): number {
  const hay = hayOf(p);
  const words = hay.split(" ");
  if (terms.some((t) => (t.length >= 3 ? hay.includes(t) : words.includes(t)))) return 3;
  const hc = spaceless(hay);
  if (terms.some((t) => { const tc = spaceless(t); return tc.length >= 4 && hc.includes(tc); })) return 3;
  const toks = tokensOf(hay);
  if (terms.some((t) => fuzzyHasToken(toks, t))) return 2;
  return (p.score ?? 0) >= MIN_SCORE ? 1 : 0;
}

// Strengths written in the query ("Eliquis 5mg" -> ["5mg"]). Used only to ORDER pages, never to exclude them:
// stores write the same strength as "5 MG", "5mg" or "5 مجم".
const STRENGTH_IN_QUERY = /(\d+(?:[.,]\d+)?)\s*(mg|mcg|ug|iu|g|ml|%|مجم|ملجم|ملغ|ملغم)/gi;
export function strengthsOf(q: string): string[] {
  const out: string[] = [];
  for (const m of String(q ?? "").toLowerCase().matchAll(STRENGTH_IN_QUERY)) out.push(`${m[1].replace(",", ".")}|${m[2]}`);
  return out;
}

// True when the page TITLE states one of the strengths ("5 MG" matches 5mg, but "2.5 MG" does not match 5mg).
function strengthInTitle(p: Found, strengths: string[]): boolean {
  if (!strengths.length) return false;
  const t = (p.title ?? "").toLowerCase().replace(/,/g, ".");
  return strengths.some((s) => {
    const [num, unit] = s.split("|");
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![0-9.])${esc(num)}\\s*${esc(unit)}(?![a-z])`, "i").test(t);
  });
}

export function pageKind(u: string): "article" | "tag" | "listing" {
  const p = decode(pathRaw(u));
  if (/\/tag\//.test(p)) return "tag";
  if (/\/(brand|brands|category|product-category)\//.test(p) || /page\/\d+/.test(p)) return "listing";
  return "article";
}

export type Plan = {
  onSource: Found[];
  productPages: Found[];
  editorial: Found[];
  picks: Found[];
  irrelevantProductPages: number;
  relevantArticles: Found[];
};

export function planPages(found: Iterable<Found>, domains: string[], terms: string[], maxPages: number, strengths: string[] = []): Plan {
  const onSource = [...found].filter((p) => !isDwaListing(p.url) && domains.some((d) => hostMatches(hostOf(p.url), d)));
  const editorial = onSource.filter((p) => NON_PRODUCT.test(pathRaw(p.url)));
  const productPages = onSource.filter((p) => !NON_PRODUCT.test(pathRaw(p.url)));
  const rated = productPages.map((p) => ({ p, rel: relevance(p, terms) }));
  const picks = rated
    // a dwaprices.com page derived from an id-only hit (viaId) is read even without a text link: the page itself decides
    .filter((x) => x.rel > 0 || x.p.viaId)
    .sort((a, b) =>
      (Number(PRODUCT_LIKE.test(pathRaw(b.p.url))) - Number(PRODUCT_LIKE.test(pathRaw(a.p.url)))) ||
      (b.rel - a.rel) ||
      (Number(strengthInTitle(b.p, strengths)) - Number(strengthInTitle(a.p, strengths))) ||
      (b.p.score - a.p.score))
    .slice(0, maxPages)
    .map((x) => x.p);
  // an article counts as "about this name" only when its title/URL contains it (or a close misspelling); a high search score alone is not enough
  const relevantArticles = editorial.filter((p) => pageKind(p.url) === "article" && relevance(p, terms) >= 2);
  return {
    onSource, productPages, editorial, picks, relevantArticles,
    irrelevantProductPages: rated.filter((x) => x.rel === 0 && !x.p.viaId).length,
  };
}

// True when some result's title/URL already contains the name as typed, so the name itself is not the problem.
export function exactMentioned(found: Iterable<Found>, terms: string[]): boolean {
  return [...found].some((p) => {
    const h = hayOf(p);
    const hc = spaceless(h);
    return terms.some((t) => (t.length >= 3 && h.includes(t)) || (spaceless(t).length >= 4 && hc.includes(spaceless(t))));
  });
}

// Extra discovery queries, used once, only when the first round gave no relevant product page.
export function fallbackQueries(q: string, extra: string[]): string[] {
  const alt = extra.find((t) => /^[a-z0-9 ]+$/.test(t) && t !== norm(q));
  return [
    `${q} nowProduct`,
    alt ? `${alt} nowProduct` : `${q} سعر شراء اونلاين مصر`,
  ];
}

export type Code =
  | "no_enabled_sources" | "no_pages_on_enabled_sources" | "only_articles" | "nothing_related"
  | "name_mismatch" | "no_match_on_pages" | "saved" | "pending_review" | "extraction_failed" | "firecrawl_unavailable";

// Why nothing was scraped.
//   name_mismatch    a close spelling exists (suggestion)
//   only_articles    articles that really mention the name exist, but no product page
//   nothing_related  results exist, but none mentions the name at all (usually a spelling problem)
export function noScrapeCode(plan: Plan, didYouMean: string[]): Code {
  if (didYouMean.length) return "name_mismatch";
  if (!plan.onSource.length) return "no_pages_on_enabled_sources";
  if (plan.relevantArticles.length) return "only_articles";
  return "nothing_related";
}
