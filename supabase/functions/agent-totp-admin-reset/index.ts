// Supabase Edge Function — agent-totp-admin-reset
// מאפסת רישום Authenticator של נציג (לחיצת "איפוס קוד אימות" בפאנל הניהול, זמין רק
// למנהל-על דרך ה-UI). מוחקת את ה-secret הפעיל/הממתין, מנקה נעילות, ורושמת ל-audit log
// מי ביצע את האיפוס. בכניסה הבאה של הנציג — agent-login יחזיר stage='enroll' מחדש.
// הקורא חייב להיות מנהל מחובר אמיתי — מאומת כאן בצד השרת (לא רק client-side gating),
// ע"י בדיקת ה-JWT שהתקבל ב-Authorization מול טבלת app_managers.
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
    const { data: mgr } = await sbAdmin.from('app_managers').select('email').eq('email', callerEmail).eq('active', true).maybeSingle();
    if (!mgr) return jsonRes({ ok: false, error: 'פעולה זו זמינה למנהלים בלבד' }, 403);
    if (jwtAal(token) !== 'aal2') return jsonRes({ ok: false, error: 'נדרש אימות דו-שלבי' }, 401);

    const { agentId } = await req.json();
    if (!agentId) return jsonRes({ ok: false, error: 'חסר agentId' }, 400);

    const { data: agent, error: agentErr } = await sbAdmin.from('app_users').select('id,name').eq('id', agentId).maybeSingle();
    if (agentErr || !agent) return jsonRes({ ok: false, error: 'נציג לא נמצא' }, 404);

    await sbAdmin
      .from('app_users')
      .update({
        authenticator_secret: null,
        authenticator_pending_secret: null,
        authenticator_pending_created_at: null,
        authenticator_enrolled_at: null,
        totp_failed_attempts: 0,
        totp_locked_until: null
      })
      .eq('id', agent.id);

    await sbAdmin.from('authenticator_audit_log').insert({
      user_id: agent.id,
      action: 'reset',
      performed_by: mgr.email
    });

    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ ok: false, error: String(err) }, 500);
  }
});
