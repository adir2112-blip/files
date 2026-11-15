// Supabase Edge Function — send-alert-email
// Using Brevo (Sendinblue) API
// Env vars needed: BREVO_API_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// אימות דו-שלבי בצד השרת (15.11.2026): סיסמה לבד (aal1) לא מספיקה לפעולת מנהל —
// ה-JWT חייב להיות aal2, כלומר אחרי הזנת קוד ה-Authenticator. ה-JWT כבר אומת ע"י getUser.
function jwtAal(token: string): string {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).aal || 'aal1'; } catch { return 'aal1'; }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY')!

    // הרשאה (15.11.2026): שליחה רק למשתמש מחובר אמיתי של המערכת (מנהל או נציג),
    // או לשרת עם ה-service role key. לפני כן כל מי שראה את ה-anon key בקוד הדף
    // יכל לשלוח דרך הפונקציה מייל HTML חופשי לכל כתובת, מהשולח של המערכת.
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    let allowed = !!token && token === SERVICE_KEY
    if (!allowed && token) {
      const sb = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE_KEY!)
      const { data: u } = await sb.auth.getUser(token)
      const em = u?.user?.email || ''
      // נציג (משתמש סינתטי agent-N@moked.internal) — מספיק החיבור שלו; מנהל — חייב aal2
      allowed = !!em && (/^agent-\d+@moked\.internal$/.test(em) || jwtAal(token) === 'aal2')
    }
    if (!allowed) {
      return new Response(JSON.stringify({ ok: false, error: 'נדרשת התחברות' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { to, fileName, orgName, breached, fieldLabel, days, subject: customSubject, htmlOverride } = await req.json()

    if (!to?.length || !fileName) {
      return new Response(JSON.stringify({ ok: false, error: 'missing params' }), {
        status: 400, headers: corsHeaders
      })
    }

    const now = new Date().toLocaleString('he-IL')
    const subject = customSubject || `עדכון מובמנט — ${fileName}: ${breached} ממתינות`
    const html = htmlOverride || `
      <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:20px 24px;border-radius:12px;margin-bottom:20px">
          <h2 style="color:#fff;margin:0;font-size:18px">עדכון מובמנט</h2>
          <p style="color:rgba(255,255,255,.6);margin:4px 0 0;font-size:13px">${now}</p>
        </div>
        <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:16px;margin-bottom:16px">
          <div style="font-size:13px;color:#991b1b;font-weight:700;margin-bottom:8px">⚠️ חריגות SLA</div>
          <div style="font-size:24px;font-weight:900;color:#7f1d1d">${breached} רשומות ממתינות</div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr style="background:#f1f5f9">
            <td style="padding:10px 14px;font-size:13px;color:#64748b;font-weight:600">קובץ</td>
            <td style="padding:10px 14px;font-size:14px;font-weight:700;color:#0f172a">${fileName}</td>
          </tr>
          <tr>
            <td style="padding:10px 14px;font-size:13px;color:#64748b;font-weight:600">ארגון</td>
            <td style="padding:10px 14px;font-size:14px;color:#0f172a">${orgName||'—'}</td>
          </tr>
          <tr style="background:#f1f5f9">
            <td style="padding:10px 14px;font-size:13px;color:#64748b;font-weight:600">תנאי</td>
            <td style="padding:10px 14px;font-size:14px;color:#0f172a">${fieldLabel||'—'}${days?` · מעל ${days} ימים`:''}</td>
          </tr>
        </table>
        <a href="https://movement-moked.github.io"
          style="display:inline-block;background:#1e3a8a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
          כניסה למערכת
        </a>
        <p style="font-size:11px;color:#94a3b8;margin-top:20px;text-align:center">
          נשלח אוטומטית ממערכת מוקד מובמנט
        </p>
      </div>`

    // Brevo API
    const toList = (Array.isArray(to) ? to : [to]).map(email => ({ email }))

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'מובמנט מוקד', email: 'adirlevi1991@gmail.com' },
        to: toList,
        subject,
        htmlContent: html
      })
    })

    const data = await res.json()
    return new Response(JSON.stringify({ ok: res.ok, data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})