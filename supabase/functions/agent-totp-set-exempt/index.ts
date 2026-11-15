// Supabase Edge Function — agent-totp-set-exempt
// מסמנת/מבטלת פטור קבוע מ-2FA לנציג (toggle בפאנל הניהול, זמין רק למנהל-על דרך ה-UI).
// בניגוד ל"איפוס קוד אימות" (agent-totp-admin-reset) — זה לא מוחק authenticator_secret
// קיים, רק קובע אם agent-login בודק אותו בכלל. אם מבטלים את הפטור בעתיד, הנציג חוזר
// לדרוש את הקוד הקיים שלו (אם יש) בלי צורך ב-QR חדש.
// הקורא חייב להיות מנהל-על מחובר אמיתי — מאומת כאן בצד השרת, ע"י בדיקת ה-JWT מול
// app_managers (is_super_admin=true, בדיוק כמו ה-UI gating של טאב "מנהלים").
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
    const { data: mgr } = await sbAdmin.from('app_managers').select('email').eq('email', callerEmail).eq('active', true).eq('is_super_admin', true).maybeSingle();
    if (!mgr) return jsonRes({ ok: false, error: 'פעולה זו זמינה למנהלי-על בלבד' }, 403);
    if (jwtAal(token) !== 'aal2') return jsonRes({ ok: false, error: 'נדרש אימות דו-שלבי' }, 401);

    const { agentId, exempt } = await req.json();
    if (!agentId || typeof exempt !== 'boolean') return jsonRes({ ok: false, error: 'חסרים פרטים' }, 400);

    const { data: agent, error: agentErr } = await sbAdmin.from('app_users').select('id,name').eq('id', agentId).maybeSingle();
    if (agentErr || !agent) return jsonRes({ ok: false, error: 'נציג לא נמצא' }, 404);

    await sbAdmin.from('app_users').update({ totp_exempt: exempt }).eq('id', agent.id);

    await sbAdmin.from('authenticator_audit_log').insert({
      user_id: agent.id,
      action: exempt ? 'exempt_on' : 'exempt_off',
      performed_by: mgr.email
    });

    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ ok: false, error: String(err) }, 500);
  }
});
