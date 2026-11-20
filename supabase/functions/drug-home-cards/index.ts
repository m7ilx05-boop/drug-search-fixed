import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Latest price-moved products WITH an image for the home-page rotating cards (newest price change first). Public product data only (name, form, price, image).
// One product per brand (first word of the trade name) so the strip is varied. Read-only.
const https = (u: unknown) => { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch { return null; } };

// Same rule as drug-barcode: only a valid GS1 code (8/12/13/14 digits with a correct check digit) is shown.
function barcodeOf(code: unknown): { value: string; display: string } | null {
  const c = typeof code === "string" ? code.trim() : "";
  if (!/^(\d{8}|\d{12,14})$/.test(c)) return null;
  const d = c.split("").map(Number), check = d.pop() as number;
  let sum = 0; d.reverse().forEach((x, i) => { sum += x * (i % 2 === 0 ? 3 : 1); });
  if ((10 - (sum % 10)) % 10 !== check) return null;
  return { value: c, display: c.length === 13 ? `${c[0]} ${c.slice(1, 7)} ${c.slice(7)}` : c };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  let n = 10;
  try { const b = await req.json(); n = Math.min(Math.max(parseInt(b?.n) || 10, 3), 16); } catch { /* default */ }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Latest price movers: products whose price changed (old_price != current_price), newest price update first.
  const { data, error } = await db
    .from("dwaprices_products")
    .select("id,trade_name,arabic_name,scientific_name,dosage_form,strength,manufacturer,current_price,old_price,price_updated_on,image_url,barcode,review_status")
    .not("image_url", "is", null).neq("image_url", "")
    .not("trade_name", "is", null)
    .not("old_price", "is", null).not("current_price", "is", null)
    .not("price_updated_on", "is", null)
    .order("price_updated_on", { ascending: false })
    .limit(400);
  if (error) { console.error("home_cards_db", error.message); return json({ error: "db_error" }, 500); }

  const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
  const rows = (data ?? []).filter((r) => {
    const a = num(r.current_price), b = num(r.old_price);
    return r.review_status !== "rejected" && https(r.image_url) && a != null && b != null && a !== b;
  });
  // Keep DB order (newest price change first). One product per brand so the strip stays varied.
  const seen = new Set<string>(), items: unknown[] = [];
  for (const r of rows) {
    const brand = String(r.trade_name).toLowerCase().split(/[\s\d]/)[0];
    if (!brand || seen.has(brand)) continue;
    seen.add(brand);
    const cur = num(r.current_price) as number, old = num(r.old_price) as number;
    items.push({
      id: r.id, product_name: r.trade_name, arabic_name: r.arabic_name, scientific_name: r.scientific_name,
      dosage_form: r.dosage_form, strength: r.strength, manufacturer: r.manufacturer, current_price: r.current_price,
      old_price: r.old_price, price_updated_on: r.price_updated_on,
      price_change_pct: Math.round(((cur - old) / old) * 1000) / 10,
      barcode: barcodeOf(r.barcode)?.display ?? null,
      image: { has_image: true, url: https(r.image_url) },
    });
    if (items.length >= n) break;
  }
  return json({ items });
});
