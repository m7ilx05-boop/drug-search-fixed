// بيحمّل مفاتيح الـ API من Supabase Vault عند بداية تشغيل الدالة.
// Deno.env.set مش مدعوم في Supabase Edge Runtime، فالمفاتيح بتتخزن في Map محلي،
// والدوال بتقرا من kenv (get / toObject) بدل Deno.env.
// الأسرار العادية ليها الأولوية، ومفتاح Vault بيتضاف بس لو مفيش سر بنفس الاسم.
import { createClient } from "npm:@supabase/supabase-js@2";

const extra = new Map<string, string>();

try {
  const url = Deno.env.get("SUPABASE_URL");
  const srv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (url && srv) {
    const db = createClient(url, srv, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await db.rpc("get_vault_keys");
    if (error) {
      console.error("vault_keys_error", error.message);
    } else {
      for (const r of (data ?? []) as { name: string; secret: string }[]) {
        if (r.name && r.secret && !Deno.env.get(r.name)) extra.set(r.name, r.secret);
      }
      if (extra.size) console.log("vault_keys_loaded", extra.size);
    }
  }
} catch (e) {
  console.error("vault_keys_exception", e instanceof Error ? e.message : String(e));
}

export const kenv = {
  get: (k: string): string | undefined => Deno.env.get(k) ?? extra.get(k),
  toObject: (): Record<string, string> => ({ ...Object.fromEntries(extra), ...Deno.env.toObject() }),
};
