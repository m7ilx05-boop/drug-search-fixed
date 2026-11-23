import { kenv } from "./vault-env.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// llm-gateway: the ONLY place that calls Gemini and Grok. Two independent quota systems (one per provider), each with its own
// keys, daily cap per key, per-minute cap, reset clock and cooldowns. A call claims a key slot atomically (llm_claim_slot),
// calls the provider, then reports the outcome (llm_report) so exhausted/invalid keys are skipped automatically.
// Internal only: service-role bearer or the project's cron secret. Does its own authentication, so verify_jwt is off.
//
// v4: Gemini calls can carry ONE inline image ({ image: { mime, data(base64) } }) for product-photo reading. Grok is text-only.
// v5: every provider call is also written to key_usage_log (key slot, model, status, token usage). The caller may send an
//     optional { job_id, purpose } so the call is tied to a search job. Logging is best effort and never affects the call.
//
// v3 failure handling (what each failure means and what we do about it):
//  - 503/500/502 (model overloaded): the KEY is fine. Try the next model in the list with the same key; if every model is
//    overloaded return provider_overloaded at once (never burn the other keys on a model-wide outage).
//  - 429 on a grounded call: Google Search grounding is not in the free tier of Gemini 3.x, so it fails on every key at once.
//    The call is repeated once WITHOUT grounding on the same key (response says grounded_used:false).
//  - 429 that is a per-model quota: try the next model; a per-minute limit puts only that key on a short cooldown.
//  - 400/401/403 with 'api key' in the message: the key is invalid. It is reported as 401 (30 day cooldown) and the next key is tried.
//  - any other 400: our own bad request, the call is refunded and returned to the caller.

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

type Provider = "gemini" | "grok";
// Grok key secrets may be named GROK*, XAI* or X_<number> (x_1, x_2, ...)
const SLOT_RE: Record<Provider, RegExp> = { gemini: /^gemini/i, grok: /^(grok|xai|x_\d)/i };
const NOT_A_KEY = /url|endpoint|host|model|quota|limit/i;

const slotsFor = (p: Provider): string[] =>
  Object.keys(kenv.toObject())
    .filter((k) => SLOT_RE[p].test(k) && !NOT_A_KEY.test(k) && kenv.get(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

type Args = { prompt: string; system?: string; json?: boolean; grounded?: boolean; image?: { mime: string; data: string } };
type Usage = { in: number; out: number; total: number };
type CallResult = { status: number; text?: string; sources?: { title: string; uri: string }[]; err?: string; usage?: Usage };
type Ref = { job_id: string | null; purpose: string | null };

// Best effort: one row per provider call. A logging problem never changes the result of the call.
async function logCall(db: SupabaseClient, provider: Provider, slot: string, model: string, r: CallResult, ref: Ref, grounded: boolean) {
  try {
    const { error } = await db.from("key_usage_log").insert({
      job_id: ref.job_id, provider, slot, kind: "llm", status: r.status, model,
      tokens_in: r.usage ? r.usage.in : null, tokens_out: r.usage ? r.usage.out : null, tokens_total: r.usage ? r.usage.total : null,
      meta: { purpose: ref.purpose, grounded, ...(r.status === 200 ? {} : { err: (r.err ?? "").slice(0, 120) }) },
    });
    if (error) console.error("usage_log_error", error.message);
  } catch (e) {
    console.error("usage_log_exception", e instanceof Error ? e.message : String(e));
  }
}

async function callGemini(endpoint: string, model: string, key: string, a: Args): Promise<CallResult> {
  const parts: Record<string, unknown>[] = [];
  if (a.image) parts.push({ inlineData: { mimeType: a.image.mime, data: a.image.data } });
  parts.push({ text: a.prompt });
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0, ...(a.json && !a.grounded ? { responseMimeType: "application/json" } : {}) },
  };
  if (a.system) body.systemInstruction = { parts: [{ text: a.system }] };
  if (a.grounded) body.tools = [{ google_search: {} }];
  let res: Response;
  try {
    res = await fetch(`${endpoint}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(50_000),
    });
  } catch { return { status: 0, err: "network" }; }
  const raw = await res.text();
  if (!res.ok) return { status: res.status, err: raw.slice(0, 1200) };
  let b: any;
  try { b = JSON.parse(raw); } catch { return { status: 502, err: "bad_json" }; }
  const cand = b?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
  const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c: any) => ({ title: String(c?.web?.title ?? ""), uri: String(c?.web?.uri ?? "") })).filter((s: any) => s.uri);
  const um = b?.usageMetadata;
  const usage: Usage | undefined = um
    ? { in: Number(um.promptTokenCount) || 0, out: Number(um.candidatesTokenCount) || 0, total: Number(um.totalTokenCount) || 0 }
    : undefined;
  if (!text) return { status: 502, err: "empty_response", usage };
  return { status: 200, text, sources, usage };
}

async function callGrok(endpoint: string, model: string, key: string, a: Args): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model, temperature: 0,
    messages: [...(a.system ? [{ role: "system", content: a.system }] : []), { role: "user", content: a.prompt }],
    ...(a.json ? { response_format: { type: "json_object" } } : {}),
  };
  let res: Response;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(50_000),
    });
  } catch { return { status: 0, err: "network" }; }
  const raw = await res.text();
  if (!res.ok) return { status: res.status, err: raw.slice(0, 1200) };
  let b: any;
  try { b = JSON.parse(raw); } catch { return { status: 502, err: "bad_json" }; }
  const text = typeof b?.choices?.[0]?.message?.content === "string" ? b.choices[0].message.content.trim() : "";
  const gu = b?.usage;
  const usage: Usage | undefined = gu
    ? { in: Number(gu.prompt_tokens) || 0, out: Number(gu.completion_tokens) || 0, total: Number(gu.total_tokens) || 0 }
    : undefined;
  if (!text) return { status: 502, err: "empty_response", usage };
  return { status: 200, text, sources: [], usage };
}

// what kind of limit a failure is: 'daily' = per-day quota (blocks until the provider's reset), 'credits' = no balance left
const kindOf = (status: number, err: string): string | null => {
  if (status === 429) return /per ?day|daily|requests_per_day/i.test(err) ? "daily" : null;
  if (status === 402 || (status === 403 && /credit|spend|billing|balance|purchase/i.test(err))) return "credits";
  return null;
};
const modelMissing = (status: number, err: string) => status === 404 || (status === 400 && /model/i.test(err) && /(not found|does not exist|invalid|unsupported|not supported)/i.test(err));
const badKey = (status: number, err: string) =>
  status === 401 || ((status === 400 || status === 403) && /api[ _-]?key|incorrect api|invalid[ _-]?(api|key|credentials)|permission[ _]denied/i.test(err) && !/credit|spend|billing|balance/i.test(err));
const overloaded = (status: number) => status === 500 || status === 502 || status === 503 || status === 504;

async function overview(db: SupabaseClient) {
  const out: Record<string, unknown> = {};
  const today = new Date().toISOString().slice(0, 10);
  for (const p of ["gemini", "grok"] as Provider[]) {
    const slots = slotsFor(p);
    if (slots.length) await db.from("llm_key_quota").upsert(slots.map((slot) => ({ provider: p, slot, usage_day: today })), { onConflict: "provider,slot", ignoreDuplicates: true });
    out[p] = { key_slots_found: slots };
  }
  const ov = await db.from("llm_quota_overview").select("*").order("provider").order("slot");
  const cfg = await db.from("llm_provider_config").select("provider,models,default_daily_limit,default_rpm,reset_tz,enabled");
  return { providers: out, config: cfg.data ?? [], quota: ov.data ?? [] };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = kenv.get("SUPABASE_URL")!;
  const svc = kenv.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, svc, { auth: { persistSession: false } });

  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  let authed = !!bearer && same(bearer, svc);
  if (!authed) {
    const given = req.headers.get("x-cron-secret") ?? "";
    if (given) {
      const { data } = await db.from("app_secrets").select("value").eq("name", "cron_secret").maybeSingle();
      authed = !!data?.value && same(given, data.value as string);
    }
  }
  if (!authed) return json({ error: "forbidden" }, 403);

  let body: { action?: unknown; provider?: unknown; prompt?: unknown; system?: unknown; json?: unknown; grounded?: unknown; image?: unknown; job_id?: unknown; purpose?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  if (body.action === "status") return json(await overview(db));

  const provider = body.provider === "gemini" || body.provider === "grok" ? (body.provider as Provider) : null;
  if (!provider) return json({ error: "invalid_provider", detail: "provider must be gemini or grok" }, 400);
  if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 30_000) return json({ error: "invalid_prompt" }, 400);
  const args: Args = {
    prompt: body.prompt, system: typeof body.system === "string" ? body.system.slice(0, 8000) : undefined,
    json: body.json === true, grounded: body.grounded === true && provider === "gemini",
  };
  // optional: ties the call to a search job in key_usage_log (callers that do not send it are logged without a job)
  const ref: Ref = {
    job_id: typeof body.job_id === "string" && /^[0-9a-f-]{36}$/i.test(body.job_id) ? body.job_id : null,
    purpose: typeof body.purpose === "string" ? body.purpose.slice(0, 40) : null,
  };
  if (body.image != null) {
    if (provider !== "gemini") return json({ error: "image_requires_gemini" }, 400);
    const im = body.image as { mime?: unknown; data?: unknown };
    if (typeof im?.mime !== "string" || !/^image\/(jpeg|png|webp)$/.test(im.mime) || typeof im?.data !== "string" || im.data.length < 100 || im.data.length > 6_000_000 || !/^[A-Za-z0-9+/=]+$/.test(im.data)) {
      return json({ error: "invalid_image" }, 400);
    }
    args.image = { mime: im.mime, data: im.data };
  }

  const cfgRes = await db.from("llm_provider_config").select("models,endpoint,enabled").eq("provider", provider).maybeSingle();
  const cfg = cfgRes.data;
  if (!cfg || !cfg.enabled) return json({ error: "provider_disabled", provider }, 503);
  const slots = slotsFor(provider);
  if (!slots.length) return json({ error: "no_keys", provider, detail: provider === "gemini" ? "add secrets whose name starts with GEMINI" : "add secrets whose name starts with GROK, XAI or X_<number>" }, 503);

  const call = (model: string, key: string, a: Args) => provider === "gemini" ? callGemini(cfg.endpoint as string, model, key, a) : callGrok(cfg.endpoint as string, model, key, a);

  let last: { status: number; err?: string } = { status: 0 };
  const keyLog: { slot: string; status: number; note?: string }[] = [];
  let groundedDropped = false;

  for (let attempt = 0; attempt < slots.length + 1; attempt++) {
    const claim = await db.rpc("llm_claim_slot", { p_provider: provider, p_slots: slots });
    if (claim.error) { console.error("claim_error", claim.error.message); return json({ error: "internal_error" }, 500); }
    const slot = claim.data as string | null;
    if (!slot) return json({ error: "quota_exhausted", provider, detail: "every key is at its daily/minute cap or cooling down", last_status: last.status, keys: keyLog }, 429);
    const key = kenv.get(slot)!;

    let r: CallResult = { status: 404 };
    let usedModel = "", sawModelErr = false, allOverloaded = true, cur = args;
    for (const model of cfg.models as string[]) {
      usedModel = model;
      r = await call(model, key, cur);
      await logCall(db, provider, slot, model, r, ref, cur.grounded === true);
      // grounded call refused with a quota/billing 429: grounding is paid-only here, repeat once without it
      if (r.status === 429 && cur.grounded && /quota|billing|exceeded|resource_exhausted/i.test(r.err ?? "")) {
        console.error("grounding_unavailable", provider, slot, model, (r.err ?? "").slice(0, 300));
        cur = { ...cur, grounded: false }; groundedDropped = true;
        r = await call(model, key, cur);
        await logCall(db, provider, slot, model, r, ref, false);
      }
      if (r.status === 200) break;
      if (modelMissing(r.status, r.err ?? "")) { sawModelErr = true; allOverloaded = false; continue; }
      if (overloaded(r.status)) continue; // model busy: next model, same key
      allOverloaded = false;
      if (r.status === 429 && kindOf(r.status, r.err ?? "") === null && /per[- ]?model|model/i.test(r.err ?? "") && !/per ?minute/i.test(r.err ?? "")) continue; // quota of this model only
      break;
    }
    last = { status: r.status, err: r.err };
    keyLog.push({ slot, status: r.status });

    if (r.status === 200) {
      await db.rpc("llm_report", { p_provider: provider, p_slot: slot, p_status: 200, p_kind: null, p_refund: false });
      return json({ ok: true, provider, slot, model: usedModel, grounded_used: cur.grounded === true, grounding_dropped: groundedDropped, text: r.text, sources: r.sources ?? [] });
    }

    // every model busy: a provider-wide problem, not this key. Refund and stop instead of burning all the other keys
    if (allOverloaded && overloaded(r.status)) {
      await db.rpc("llm_report", { p_provider: provider, p_slot: slot, p_status: 200, p_kind: null, p_refund: true });
      return json({ error: "provider_overloaded", provider, models: cfg.models, last_status: r.status }, 503);
    }
    // invalid key: park it for 30 days and try the next one
    if (badKey(r.status, r.err ?? "")) {
      await db.rpc("llm_report", { p_provider: provider, p_slot: slot, p_status: 401, p_kind: null, p_refund: true });
      console.error("llm_bad_key", provider, slot, r.status, (r.err ?? "").slice(0, 200));
      continue;
    }
    if (sawModelErr && r.status === 404) {
      await db.rpc("llm_report", { p_provider: provider, p_slot: slot, p_status: 200, p_kind: null, p_refund: true });
      return json({ error: "model_not_found", provider, models: cfg.models, detail: "update llm_provider_config.models" }, 502);
    }
    if (r.status === 0) {
      await db.rpc("llm_report", { p_provider: provider, p_slot: slot, p_status: 200, p_kind: null, p_refund: true });
      continue;
    }
    if (r.status === 400) {
      await db.rpc("llm_report", { p_provider: provider, p_slot: slot, p_status: 200, p_kind: null, p_refund: true });
      console.error("llm_bad_request", provider, slot, (r.err ?? "").slice(0, 300));
      return json({ error: "bad_request", provider, detail: (r.err ?? "").slice(0, 300) }, 400);
    }
    const kind = kindOf(r.status, r.err ?? "");
    await db.rpc("llm_report", { p_provider: provider, p_slot: slot, p_status: r.status, p_kind: kind, p_refund: false });
    console.error("llm_call_failed", provider, slot, usedModel, r.status, (r.err ?? "").slice(0, 600));
  }
  return json({ error: "all_attempts_failed", provider, last_status: last.status, keys: keyLog }, 502);
});
