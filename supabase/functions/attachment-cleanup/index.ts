// Supabase Edge Function — attachment-cleanup
// Deletes files from the "attachments" Storage bucket older than a given age,
// so uploaded אסמכתאות (receipts/images/PDFs from the agent entry form) never
// accumulate toward the project's storage quota.
// - Called with no body / no "days" -> defaults to 120 days (~4 months). This is
//   how the daily pg_cron job calls it.
// - Called with {"days": N} (POST body) or ?days=N (query string) -> manual
//   on-demand cleanup from the admin "ניהול אחסון" panel, any custom threshold.
// Note: this only removes the stored file — it does not clear the (now dead)
// URL that may still sit in a record's extra/admin_data JSON. The UI shows a
// "📎 פג תוקף" fallback for images whose URL 404s, so this is a cosmetic
// edge case rather than a broken feature.

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

const BUCKET = 'attachments'
const DEFAULT_MAX_AGE_DAYS = 120 // ~4 חודשים

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

    // הרשאה (15.11.2026): רק סופר-מנהל מחובר אמיתי (או ה-service role key) רשאי לבחור
    // סף ימים. כל קריאה אחרת, כולל ה-pg_cron היומי שנשלח עם ה-anon key, מנקה רק לפי
    // ברירת המחדל (120 יום). כך מי שמחזיק את ה-anon key כבר לא יכול לשלוח days=0
    // ולמחוק את כל האסמכתאות.
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    let trusted = !!token && token === SUPABASE_KEY
    if (!trusted && token) {
      const { data: u } = await sb.auth.getUser(token)
      const email = u?.user?.email
      if (email) {
        const { data: mgr } = await sb.from('app_managers').select('is_super_admin').eq('email', email).eq('active', true).maybeSingle()
        trusted = !!mgr?.is_super_admin && jwtAal(token) === 'aal2'
      }
    }

    const url = new URL(req.url)
    let days = DEFAULT_MAX_AGE_DAYS
    if (trusted) {
      const qDays = url.searchParams.get('days')
      if (qDays && !isNaN(Number(qDays))) days = Number(qDays)
      if (req.method === 'POST') {
        try {
          const body = await req.json()
          if (body?.days && !isNaN(Number(body.days))) days = Number(body.days)
        } catch { /* no/invalid body — ignore, keep days as-is */ }
      }
    }
    // גם למנהל: לא פחות מיום אחד, כדי שקלט שגוי לא ימחק את מה שהועלה היום
    if (!(days >= 1)) days = DEFAULT_MAX_AGE_DAYS

    const cutoff = Date.now() - days * 86400000
    const toDelete: string[] = []

    const { data: topLevel, error: topErr } = await sb.storage.from(BUCKET).list('', { limit: 1000 })
    if (topErr) throw topErr

    for (const entry of (topLevel || [])) {
      // Real files have an id; folders (one per field id, per our upload path scheme) don't.
      if (entry.id) continue
      const { data: files, error: fileErr } = await sb.storage.from(BUCKET).list(entry.name, { limit: 1000 })
      if (fileErr) continue
      for (const file of (files || [])) {
        const createdAt = file.created_at || file.updated_at
        if (!createdAt) continue
        if (new Date(createdAt).getTime() < cutoff) {
          toDelete.push(`${entry.name}/${file.name}`)
        }
      }
    }

    let deletedCount = 0
    if (toDelete.length) {
      const { data: removed, error: delErr } = await sb.storage.from(BUCKET).remove(toDelete)
      if (delErr) throw delErr
      deletedCount = removed?.length ?? toDelete.length
    }

    return new Response(JSON.stringify({ ok: true, days, deletedCount, deletedPaths: toDelete }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
