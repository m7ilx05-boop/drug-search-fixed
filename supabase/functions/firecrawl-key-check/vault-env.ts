// بيحمّل مفاتيح الـ API من Supabase Vault في متغيرات البيئة عند بداية تشغيل الدالة.
// الأسرار العادية ليها الأولوية، ومفتاح Vault بيتضاف بس لو مفيش سر بنفس الاسم.
// الباقي من الكود (Deno.env.get / toObject) شغال زي ما هو من غير تغيير.
import { createClient } from "npm:@supabase/supabase-js@2";

try {
  const url = Deno.env.get("SUPABASE_URL");
  const srv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (url && srv) {
    const db = createClient(url, srv, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await db.rpc("get_vault_keys");
    if (error) {
      console.error("vault_keys_error", error.message);
    } else {
      let added = 0;
      for (const r of (data ?? []) as { name: string; secret: string }[]) {
        if (r.name && r.secret && !Deno.env.get(r.name)) { Deno.env.set(r.name, r.secret); added++; }
      }
      if (added) console.log("vault_keys_loaded", added);
    }
  }
} catch (e) {
  console.error("vault_keys_exception", e instanceof Error ? e.message : String(e));
}

// الدوال بتستورد kenv من هنا؛ Deno.env فيه get / set / toObject.
export const kenv = Deno.env;
