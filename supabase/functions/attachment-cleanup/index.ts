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
    const url = new URL(req.url)
    let days = DEFAULT_MAX_AGE_DAYS
    const qDays = url.searchParams.get('days')
    if (qDays && !isNaN(Number(qDays))) days = Number(qDays)
    if (req.method === 'POST') {
      try {
        const body = await req.json()
        if (body?.days && !isNaN(Number(body.days))) days = Number(body.days)
      } catch { /* no/invalid body — ignore, keep days as-is */ }
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

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
