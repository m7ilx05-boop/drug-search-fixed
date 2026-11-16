// Temporary diagnostic: asks Tavily for the usage of every TAVILY* secret. Never returns or logs a key.
const TOKEN = "p4Wn8cXr2Jv7Ty5LqD9mZe3A";

const pick = (o: unknown) =>
  o && typeof o === "object"
    ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([, v]) => typeof v === "number" || (typeof v === "string" && v.length < 40)))
    : null;

Deno.serve(async (req) => {
  if (req.method !== "POST" || req.headers.get("x-check-token") !== TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  const slots = Object.keys(Deno.env.toObject())
    .filter((k) => /^tavily/i.test(k) && Deno.env.get(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const keys: Record<string, unknown>[] = [];
  for (const slot of slots) {
    try {
      const r = await fetch("https://api.tavily.com/usage", {
        headers: { Authorization: `Bearer ${Deno.env.get(slot)}` },
        signal: AbortSignal.timeout(15000),
      });
      const b = await r.json().catch(() => null);
      keys.push({
        slot, status: r.status, key: pick(b?.key), account: pick(b?.account),
        error: r.ok ? null : String(b?.detail?.error ?? b?.error ?? "").slice(0, 120),
      });
    } catch (e) {
      keys.push({ slot, status: 0, error: e instanceof Error ? e.name : "error" });
    }
  }
  return new Response(JSON.stringify({ count: keys.length, keys }), { headers: { "Content-Type": "application/json" } });
});
