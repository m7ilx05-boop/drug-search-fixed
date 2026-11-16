import { createClient } from "npm:@supabase/supabase-js@2";

// translate-label: translates ONE piece of FDA label text (already split into lines by the app) into Arabic, on request only.
// The text goes through llm-gateway (the only place that holds the Gemini/Grok keys). Nothing is stored.
// Safety: every number in the source (doses, hours, ages, ml, mg) must still be in the translation, otherwise the answer is
// rejected and the app keeps showing the English original. Rate limited per IP. Internal limit: 6000 characters per call.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_CHARS = 6000;
const SYSTEM = [
  "You translate text from a US FDA drug label into clear Modern Standard Arabic for pharmacists and patients in Egypt.",
  "Rules, all mandatory:",
  "1. Translate faithfully. Do not add, remove, soften, summarize or explain anything.",
  "2. Keep every number, dose, unit (ml, mg, hours), age and frequency exactly as written, using Western digits 0-9.",
  "3. Keep drug and ingredient names in English.",
  "4. The input has one item per line. Return exactly one translated line for each input line, in the same order.",
  "5. A line that starts with ## (a heading) or with ▪ (a bullet) must keep that same prefix in the output.",
  "6. Keep phone numbers and label ids as they are.",
  'Return only JSON: {"text":"<the translated lines joined by \\n>"}',
].join("\n");

const toWestern = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
const nums = (s: string) => (toWestern(s).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
function numbersKept(src: string, out: string): boolean {
  const have = new Map<string, number>();
  for (const n of nums(out)) have.set(n, (have.get(n) ?? 0) + 1);
  for (const n of nums(src)) {
    const c = have.get(n) ?? 0;
    if (c <= 0) return false;
    have.set(n, c - 1);
  }
  return true;
}

const arabicShare = (s: string) => {
  const ar = (s.match(/[\u0600-\u06FF]/g) ?? []).length, la = (s.match(/[A-Za-z]/g) ?? []).length;
  return ar + la === 0 ? 0 : ar / (ar + la);
};

// Tries Gemini, then Grok. An answer counts only when it is real Arabic (not the English echoed back) and every number survived.
async function translate(text: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/llm-gateway`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const prompt = `Translate the following FDA drug label text into Arabic. The output must be in Arabic script, not English.\nReturn only JSON: {"text": "<translated lines joined by \\n>"}\n\nTEXT:\n<<<\n${text}\n>>>`;
  let code = "translation_unavailable";
  for (const provider of ["gemini", "grok"]) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ provider, prompt, system: SYSTEM, json: true, purpose: "translate_label" }),
        signal: AbortSignal.timeout(45_000),
      });
      const b = await r.json().catch(() => ({}));
      if (!(r.ok && b?.ok && typeof b.text === "string")) { console.error("gateway", provider, b?.error ?? r.status); continue; }
      let out = "";
      try { out = String(JSON.parse(b.text.replace(/^```json|```$/gm, "").trim()).text ?? "").trim(); } catch { code = "bad_model_output"; continue; }
      if (!out) { code = "bad_model_output"; continue; }
      if (arabicShare(out) < 0.4) { console.error("not_arabic", provider); code = "not_translated"; continue; }
      if (!numbersKept(text, out)) { console.error("numbers_mismatch", provider); code = "numbers_mismatch"; continue; }
      return { ok: true as const, text: out };
    } catch (e) { console.error("network", provider, String(e)); }
  }
  return { ok: false as const, code };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { text?: unknown; target?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_CHARS) return json({ error: "invalid_text" }, 400);
  if (body.target !== "ar") return json({ error: "invalid_target" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await db.rpc("check_rate_limit", { p_key: `translate-label:${ip}`, p_limit: 8, p_window_seconds: 60 });
  if (rl.error) { console.error("rate_limit_error", rl.error.message); return json({ error: "internal_error" }, 500); }
  if (rl.data === false) return json({ error: "rate_limited" }, 429);

  const r = await translate(text);
  if (!r.ok) return json({ error: r.code }, r.code === "translation_unavailable" ? 503 : 422);
  return json({ ok: true, text: r.text });
});
