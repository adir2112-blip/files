// Supabase Edge Function — manager-mfa-admin-reset
// מאפסת רישום MFA (TOTP מובנה של Supabase Auth) למנהל — מוחקת כל ה-factors שלו,
// רושמת ל-audit log מי ביצע. בכניסה הבאה של המנהל — יידרש להירשם מחדש ל-Authenticator.
// הקורא חייב להיות סופר-מנהל מחובר אמיתי (מאומת כאן בצד השרת) — תואם להגבלת ה-UI
// (טאב "מנהלים" גלוי רק ל-is_super_admin).
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
    const { data: caller } = await sbAdmin.from('app_managers').select('email,is_super_admin').eq('email', callerEmail).eq('active', true).maybeSingle();
    if (!caller?.is_super_admin) return jsonRes({ ok: false, error: 'פעולה זו זמינה לסופר-מנהלים בלבד' }, 403);
    if (jwtAal(token) !== 'aal2') return jsonRes({ ok: false, error: 'נדרש אימות דו-שלבי' }, 401);

    const { email } = await req.json();
    if (!email) return jsonRes({ ok: false, error: 'חסר email' }, 400);

    const { data: listData, error: listErr } = await sbAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return jsonRes({ ok: false, error: String(listErr.message || listErr) }, 500);
    const userStub = (listData?.users || []).find((u) => (u.email || '').toLowerCase() === String(email).toLowerCase());
    if (!userStub) return jsonRes({ ok: false, error: 'משתמש לא נמצא' }, 404);

    // listUsers() לא מחזיר את שדה factors (רק getUserById עושה זאת)
    const { data: userData, error: getErr } = await sbAdmin.auth.admin.getUserById(userStub.id);
    if (getErr) return jsonRes({ ok: false, error: String(getErr.message || getErr) }, 500);

    const factors = (userData?.user?.factors || []).filter((f) => f.factor_type === 'totp');
    for (const f of factors) {
      await sbAdmin.auth.admin.mfa.deleteFactor({ id: f.id, userId: userStub.id });
    }

    await sbAdmin.from('authenticator_audit_log').insert({
      manager_email: email,
      action: 'reset',
      performed_by: caller.email
    });

    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ ok: false, error: String(err) }, 500);
  }
});
