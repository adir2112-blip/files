// Supabase Edge Function — manager-mfa-status
// מחזיר לכל מנהל (app_managers) האם יש לו TOTP factor מאומת ב-Supabase Auth המובנה,
// ומתי נוצר. auth.users/auth.mfa_factors לא נגישים ללקוח — חייב service role.
// הערה: listUsers() לא מחזיר את שדה factors (רק getUserById עושה זאת) — לכן שולפים
// לכל מנהל בנפרד.
// הקורא חייב להיות סופר-מנהל מחובר אמיתי (מאומת כאן בצד השרת) — תואם להגבלת ה-UI
// (טאב "מנהלים" גלוי רק ל-is_super_admin). מונע חשיפת רשימת כל האימיילים/סטטוס 2FA.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// אימות דו-שלבי בצד השרת (15.11.2026): סיסמה לבד (aal1) לא מספיקה לפעולת מנהל —
// ה-JWT חייב להיות aal2, כלומר אחרי הזנת קוד ה-Authenticator. ה-JWT כבר אומת ע"י getUser.
function jwtAal(token: string): string {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).aal || 'aal1'; } catch { return 'aal1'; }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const sbAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const { data: callerData, error: callerErr } = await sbAdmin.auth.getUser(token);
    const callerEmail = callerData?.user?.email;
    if (callerErr || !callerEmail) return jsonRes({ ok: false, error: 'נדרשת התחברות' }, 401);
    const { data: caller } = await sbAdmin.from('app_managers').select('is_super_admin').eq('email', callerEmail).eq('active', true).maybeSingle();
    if (!caller?.is_super_admin) return jsonRes({ ok: false, error: 'פעולה זו זמינה לסופר-מנהלים בלבד' }, 403);
    if (jwtAal(token) !== 'aal2') return jsonRes({ ok: false, error: 'נדרש אימות דו-שלבי' }, 401);

    const { data: managers, error: mgrErr } = await sbAdmin.from('app_managers').select('email');
    if (mgrErr) return jsonRes({ ok: false, error: String(mgrErr.message || mgrErr) }, 500);

    const { data: listData, error: listErr } = await sbAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return jsonRes({ ok: false, error: String(listErr.message || listErr) }, 500);

    const idByEmail = new Map();
    for (const u of (listData?.users || [])) {
      if (u.email) idByEmail.set(u.email.toLowerCase(), u.id);
    }

    const result = [];
    for (const m of (managers || [])) {
      const uid = idByEmail.get((m.email || '').toLowerCase());
      if (!uid) { result.push({ email: m.email, enrolled: false, enrolled_at: null }); continue; }
      const { data: userData } = await sbAdmin.auth.admin.getUserById(uid);
      const factors = userData?.user?.factors || [];
      const verified = factors.find((f) => f.factor_type === 'totp' && f.status === 'verified');
      result.push({ email: m.email, enrolled: !!verified, enrolled_at: verified?.created_at || null });
    }

    return jsonRes({ ok: true, managers: result });
  } catch (err) {
    return jsonRes({ ok: false, error: String(err) }, 500);
  }
});
