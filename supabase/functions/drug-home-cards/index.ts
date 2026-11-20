import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Random products WITH an image for the home-page rotating cards. Public product data only (name, form, price, image).
// One product per brand (first word of the trade name) so the strip is varied. Read-only.
const https = (u: unknown) => { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch { return null; } };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  let n = 10;
  try { const b = await req.json(); n = Math.min(Math.max(parseInt(b?.n) || 10, 3), 16); } catch { /* default */ }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await db
    .from("dwaprices_products")
    .select("id,trade_name,arabic_name,scientific_name,dosage_form,strength,manufacturer,current_price,image_url,review_status")
    .not("image_url", "is", null).neq("image_url", "").not("trade_name", "is", null)
    .limit(1500);
  if (error) { console.error("home_cards_db", error.message); return json({ error: "db_error" }, 500); }

  const rows = (data ?? []).filter((r) => r.review_status !== "rejected" && https(r.image_url));
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  const seen = new Set<string>(), items: unknown[] = [];
  for (const r of rows) {
    const brand = String(r.trade_name).toLowerCase().split(/[\s\d]/)[0];
    if (!brand || seen.has(brand)) continue;
    seen.add(brand);
    items.push({
      id: r.id, product_name: r.trade_name, arabic_name: r.arabic_name, scientific_name: r.scientific_name,
      dosage_form: r.dosage_form, strength: r.strength, manufacturer: r.manufacturer, current_price: r.current_price,
      image: { has_image: true, url: https(r.image_url) },
    });
    if (items.length >= n) break;
  }
  return json({ items });
});
