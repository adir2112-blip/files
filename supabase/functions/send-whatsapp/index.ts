// Supabase Edge Function — send-whatsapp (20.11.2026)
// The page used to call the WhatsApp bot's open /api/send straight from the
// browser. The bot is closing that route, so the page now sends here and this
// function forwards with the bot's secret (Supabase secret WA_BOT_SECRET).
// Without the secret it still forwards (the bot then delivers only to
// recipients it already knows), so nothing breaks before the secret is set.
// Who may send: the same rule as send-alert-email — a signed-in agent
// (agent-N@moked.internal) or a manager after the Authenticator code (aal2),
// or a server with the service role key. 60 messages a minute per instance.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_SEND = 'https://whatsapp-bot-production-120a.up.railway.app/api/send'

function jwtAal(token: string): string {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).aal || 'aal1' } catch { return 'aal1' }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

let recent: number[] = []

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405)

  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  let allowed = !!token && token === SERVICE_KEY
  if (!allowed && token) {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE_KEY!)
    const { data: u } = await sb.auth.getUser(token)
    const em = u?.user?.email || ''
    allowed = !!em && (/^agent-\d+@moked\.internal$/.test(em) || jwtAal(token) === 'aal2')
  }
  if (!allowed) return json({ ok: false, error: 'נדרשת התחברות' }, 401)

  let body: { phone?: string; message?: string }
  try { body = await req.json() } catch { return json({ ok: false, error: 'bad json' }, 400) }
  const phone = String(body.phone || '').replace(/[^0-9@a-z.]/gi, '').slice(0, 40)
  const message = String(body.message || '').slice(0, 4000)
  if (!phone || !message) return json({ ok: false, error: 'missing phone/message' }, 400)

  const now = Date.now()
  recent = recent.filter((t) => now - t < 60_000)
  if (recent.length >= 60) return json({ ok: false, error: 'rate limit' }, 429)
  recent.push(now)

  const secret = Deno.env.get('WA_BOT_SECRET') || ''
  const r = await fetch(BOT_SEND, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ phone, message, source: 'מערכת קבצים' }),
  })
  const text = await r.text()
  if (!r.ok) console.error('bot', r.status, text.slice(0, 200))
  return json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502)
})
