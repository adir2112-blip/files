// Supabase Edge Function — moked-scheduler
// Handles: SLA alerts, daily report to Adir, inactivity alerts, project-manager escalation alerts, weekly backup email
// Schedule: every 30 minutes (*/30 * * * 0-4) — Sun-Thu only

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const WA_API = 'https://whatsapp-bot-production-120a.up.railway.app/api/send'
const WA_GROUP = '120363429161263528@g.us'
const WA_BOT_SECRET = Deno.env.get('WA_BOT_SECRET') || ''
const BACKUP_FUNC_URL = 'https://vlhqkwwgmkriwojffced.supabase.co/functions/v1/backup-moked'

async function sendWA(phone: string, message: string): Promise<boolean> {
  try {
    const res = await fetch(WA_API, {
      method: 'POST',
      // 28.11.2026: send with the bot's secret, so this keeps working once the
      // bot accepts tokenless sends to the owner only (TOKENLESS_SCOPE=owner).
      headers: { 'Content-Type': 'application/json', ...(WA_BOT_SECRET ? { Authorization: `Bearer ${WA_BOT_SECRET}` } : {}) },
      body: JSON.stringify({ phone, message, source: 'מערכת קבצים' })
    })
    return res.ok
  } catch (e) { return false }
}

// יומן שליחות וואטסאפ משותף (טבלת wa_log) — כדי שההיסטוריה בממשק תשקף גם
// שליחות אוטומטיות מהשרת, לא רק שליחות ידניות מהדפדפן
async function logWA(sb: any, entry: { recipient_name: string, recipient_phone: string, file_name: string, msg_type: string, ok: boolean }) {
  try { await sb.from('wa_log').insert(entry) } catch (e) {}
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '')
  if (digits.startsWith('972')) return digits
  if (digits.startsWith('0')) return '972' + digits.slice(1)
  return '972' + digits
}

function businessDaysBetween(from: Date, to: Date): number {
  // יום היצירה עצמו לא נספר — ה-SLA מתחיל להיספר מהיום שאחריו
  let count = 0
  const cur = new Date(from); cur.setHours(0,0,0,0); cur.setDate(cur.getDate() + 1)
  const end = new Date(to); end.setHours(0,0,0,0)
  while (cur < end) {
    const day = cur.getDay()
    if (day !== 5 && day !== 6) count++
    cur.setDate(cur.getDate() + 1)
  }
  return count
}

// "פתוח" = יש שרשור הערות שבו ההודעה האחרונה היא של נציג וטרם נענתה ע"י מנהל
function recordChatIsOpen(record: any): boolean {
  const threads = Object.values(record.field_comments || {})
  for (const thread of threads as any[]) {
    if (thread.length && thread[thread.length - 1].role === 'agent') return true
  }
  return false
}

function recordMatchesAlert(record: any, file: any): boolean {
  const rule = file.alert_rule || {}
  if (!rule.enabled || !rule.fieldId) return false
  if (rule.days) {
    const age = businessDaysBetween(new Date(record.created_at), new Date())
    if (age < parseFloat(rule.days)) return false
  }
  // ערכים מיוחדים: "סגירת רשומה" ו"סטטוס טיפול", במקום שדה רגיל
  if (rule.fieldId === '__closed__') return !record.closed_at
  if (rule.fieldId === '__chat_open__') return recordChatIsOpen(record)
  const adminFields = file.admin_fields || []
  const isAdmin = adminFields.find((f: any) => f.id === rule.fieldId)
  const val = isAdmin
    ? ((record.admin_data || {})[rule.fieldId] || '').toString()
    : ((record.extra || {})[rule.fieldId] || '').toString()
  if (rule.condition === 'empty') return !val || val.trim() === ''
  if (rule.condition === 'not_value') return val !== (rule.value || '')
  if (rule.condition === 'value') return val === (rule.value || '')
  return false
}

// שדה ניהולי המוגדר כ"תת-שדה למנהל פרויקט": תלוי בשדה אחר + ערך מפעיל + ימי SLA
// שדה שמסומן ישירות "עקוב במוניטור אחמ"ש" (ahmashAlertDays) — עצמאי מ"כלל ה-SLA" הכללי
// של הקובץ. תנאי קבוע: השדה ריק. שעון: אם תלוי בשדה אחר — מרגע שהתנאי התקיים
// (escalated_at); אחרת מרגע יצירת הרשומה. תואם ל-recordMatchesAhmashField בצד הלקוח.
function recordMatchesAhmashField(record: any, af: any, file: any): boolean {
  if (af.ahmashAlertDays == null) return false
  const val = ((record.admin_data || {})[af.id] || '').toString()
  if (val.trim() !== '') return false
  if (af.dependsOn) {
    const parentField = (file.admin_fields || []).find((x: any) => x.id === af.dependsOn)
    const adminData = record.admin_data || {}
    const parentVal = adminData[af.dependsOn]
    const conditionMet = parentField?.type === 'checkbox'
      ? String(!!parentVal) === af.dependsOnValue
      : String(parentVal || '') === (af.dependsOnValue || '')
    if (!conditionMet || !record.escalated_at) return false
    return businessDaysBetween(new Date(record.escalated_at), new Date()) >= parseFloat(af.ahmashAlertDays)
  }
  if (!record.created_at) return false
  return businessDaysBetween(new Date(record.created_at), new Date()) >= parseFloat(af.ahmashAlertDays)
}

function isEscalationField(af: any): boolean {
  // מעקב הסלמה עצמאי מהרשאת עריכה (projectManagerOnly) — ימי הסלמה מספיקים, גם על
  // שדה עצמאי (בלי dependsOn), למשל טופס חד-שלבי בלי אחמ"ש נפרד
  return !!(af && af.escalationAlertDays != null)
}

function defaultSlaDigestTpl() {
  return {
    header: '📊 *דוח חריגות SLA יומי — {date}*',
    orgBlock: '📁 *{org}{contact}*\n{files}',
    fileLine: '• {file}\n  {count} פניות בחריגה · ⏱ ישנה ביותר: {days} ימים',
    footer: '📌 סה"כ: {total} פניות בחריגה'
  }
}
function fillSlaTpl(tpl: string, vars: Record<string, any>): string {
  return (tpl || '').replace(/\{(\w+)\}/g, (m, k) => vars[k] !== undefined ? vars[k] : m)
}

// גרסה כללית של בניית הודעת SLA: מקבלת רשימת שורות שרירותית (למשל רק הקבצים של מנהל
// פרויקט ספציפי, או רק של איש קשר ספציפי) ומקבצת אותן לפי ארגון — אותו טמפלט בדיוק
// כמו דוח ה-SLA של אדיר וליאת, כדי שכל דוח יומי ייראה אותו הדבר (ראו buildOrgGroupedMessage בצד הלקוח)
function buildOrgGroupedMessage(tpl: any, lines: { orgId: string, name: string, count: number, oldestDays: number }[], orgs: any[], dateStr: string): string | null {
  if (!lines.length) return null
  const byOrg: Record<string, any[]> = {}
  lines.forEach(l => (byOrg[l.orgId] = byOrg[l.orgId] || []).push(l))
  const orgIds = Object.keys(byOrg).sort((a, b) =>
    byOrg[b].reduce((s, x) => s + x.count, 0) - byOrg[a].reduce((s, x) => s + x.count, 0)
  )
  const total = orgIds.reduce((s, oid) => s + byOrg[oid].reduce((s2, x) => s2 + x.count, 0), 0)
  if (!total) return null
  const sections = orgIds.map(oid => {
    const org = orgs.find((o: any) => o.id === oid)
    const orgName = org?.name || 'ארגון לא ידוע'
    const contact = org?.sla_contact_name ? ` (${org.sla_contact_name})` : ''
    const filesStr = byOrg[oid].map((l: any) => fillSlaTpl(tpl.fileLine, { file: l.name, count: l.count, days: l.oldestDays })).join('\n')
    return fillSlaTpl(tpl.orgBlock, { org: orgName, contact, files: filesStr })
  }).join('\n\n')
  const header = fillSlaTpl(tpl.header, { date: dateStr })
  const footer = fillSlaTpl(tpl.footer, { total })
  return `${header}\n\n${sections}\n\n${footer}`
}

function recordCurrentlyEscalated(record: any, af: any, file: any): boolean {
  if (!af.dependsOn) return true // שדה עצמאי — תמיד "רלוונטי", אין תנאי הפעלה
  const adminFields = file.admin_fields || []
  const parentField = adminFields.find((x: any) => x.id === af.dependsOn)
  const adminData = record.admin_data || {}
  const parentVal = adminData[af.dependsOn]
  return parentField?.type === 'checkbox'
    ? String(!!parentVal) === af.dependsOnValue
    : String(parentVal || '') === (af.dependsOnValue || '')
}

// חורג אם עדיין פתוח (לא נסגר) מעל X ימים — לא בודקים אם השדה עצמו ריק (ראו הערה
// מקבילה בצד הלקוח). שעון: escalated_at אם תלוי בשדה אחר, אחרת created_at.
function recordEscalationBreached(record: any, af: any, file: any): boolean {
  if (af.escalationAlertDays == null || record.closed_at) return false
  if (af.dependsOn) {
    if (!recordCurrentlyEscalated(record, af, file) || !record.escalated_at) return false
    return businessDaysBetween(new Date(record.escalated_at), new Date()) >= parseFloat(af.escalationAlertDays)
  }
  if (!record.created_at) return false
  return businessDaysBetween(new Date(record.created_at), new Date()) >= parseFloat(af.escalationAlertDays)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

    const now = new Date()
    const dayIST = now.getDay()
    const hourUTC = now.getHours()
    const hourIST = (hourUTC + 3) % 24
    const minuteIST = now.getMinutes()
    const dateStr = now.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })

    // Load settings
    const { data: settings } = await sb.from('app_settings').select('key,value')
    const getSetting = (key: string) => {
      const row = (settings || []).find((s: any) => s.key === key)
      if (!row) return null
      try {
        const v = row.value
        if (typeof v === 'string') return JSON.parse(v)
        if (typeof v === 'object') return v
        return null
      } catch { return null }
    }

    const waEnabled = getSetting('wa_enabled') !== false
    const waPolicy = getSetting('wa_policy') || { startHour: 8, endHour: 18, intervalHours: 2, blockedDays: [5,6] }
    const dailyReport = getSetting('daily_report')
    const inactivityConfig = getSetting('inactivity_config')
    const backupConfig = getSetting('backup_config')

    // Load data
    const { data: allFiles } = await sb.from('files').select('*')
    const files = (allFiles || []).filter((f: any) => f.active !== false)
    const { data: orgs } = await sb.from('organizations').select('*')
    const log: any[] = []

    // ── 1. אחמ"ש DAILY DIGEST (הודעה אחת מרוכזת ליום לכל איש קשר, מקובצת לפי ארגון,
    // באותו טמפלט של דוח ה-SLA לאדיר וליאת — ניתן לעריכה בנפרד תחת ahmash_digest.tpl) ──
    {
      const ahmashDigest = getSetting('ahmash_digest') || {}
      const ahmashEnabled = waEnabled && ahmashDigest.enabled !== false
      const ahmashHour = ahmashDigest.hour ?? 12
      const ahmashDays: number[] = ahmashDigest.days ?? [0, 1, 2, 3, 4]
      const ahmashTpl = { ...defaultSlaDigestTpl(), ...(ahmashDigest.tpl || {}) }

      if (ahmashEnabled && ahmashDays.includes(dayIST) && hourIST === ahmashHour && minuteIST < 30) {
        const sentKey = 'ahmash_digest_last_sent'
        const { data: lastSentRow } = await sb.from('app_settings').select('value').eq('key', sentKey).maybeSingle()
        const lastSent = lastSentRow ? JSON.parse(lastSentRow.value) : null

        if (lastSent !== dateStr) {
          const filesWithAlerts = (files || []).filter((f: any) =>
            f.alert_rule?.enabled && f.alert_rule?.fieldId && ((f.wa_contacts || []).length > 0 || f.wa_notify_group === true)
          )

          const linesByPhone: Record<string, { name: string; phone: string; lines: any[] }> = {}
          const groupLines: any[] = []

          for (const f of filesWithAlerts) {
            const { data: recs } = await sb.from('records')
              .select('id,created_at,extra,admin_data,closed_at,field_comments')
              .eq('file_id', f.id).eq('archived', false)
            const breached = (recs || []).filter((r: any) => recordMatchesAlert(r, f))
            if (!breached.length) continue
            const oldest = breached.reduce((min: any, r: any) => r.created_at < min.created_at ? r : min, breached[0])
            const oldestDays = Math.floor((now.getTime() - new Date(oldest.created_at).getTime()) / 86400000)

            for (const contact of (f.wa_contacts || [])) {
              const key = formatPhone(contact.phone)
              if (!linesByPhone[key]) linesByPhone[key] = { name: contact.name, phone: contact.phone, lines: [] }
              linesByPhone[key].lines.push({ orgId: f.org_id, name: f.name, count: breached.length, oldestDays })
            }
            if (f.wa_notify_group === true) groupLines.push({ orgId: f.org_id, name: f.name, count: breached.length, oldestDays })
          }

          for (const { name, phone, lines } of Object.values(linesByPhone)) {
            const msg = buildOrgGroupedMessage(ahmashTpl, lines, orgs || [], dateStr)
            if (!msg) continue
            const ok = await sendWA(formatPhone(phone), msg)
            await logWA(sb, { recipient_name: name, recipient_phone: phone, file_name: lines.map((l: any) => l.name).join(', '), msg_type: 'AHMASH_DIGEST', ok })
            log.push({ type: 'AHMASH_DIGEST', to: name, files: lines.length })
          }

          if (groupLines.length) {
            const msg = buildOrgGroupedMessage(ahmashTpl, groupLines, orgs || [], dateStr)
            if (msg) {
              const ok = await sendWA(WA_GROUP, msg)
              await logWA(sb, { recipient_name: 'קבוצת מנהל ובכירי אדיר', recipient_phone: WA_GROUP, file_name: groupLines.map((l: any) => l.name).join(', '), msg_type: 'AHMASH_DIGEST_GROUP', ok })
              log.push({ type: 'AHMASH_DIGEST_GROUP', files: groupLines.length })
            }
          }

          await sb.from('app_settings').upsert({ key: sentKey, value: JSON.stringify(dateStr) })
        }
      }
    }

    // ── 2. DAILY REPORT TO ADIR ──
    if (dailyReport?.enabled && dailyReport?.phone) {
      const startHour = dailyReport.hour || 8
      const intervalHours = dailyReport.intervalHours || 24
      const blockedDays = dailyReport.blockedDays || [5,6]

      if (!blockedDays.includes(dayIST) && hourIST >= startHour && hourIST < 18) {
        const slotStart = startHour + Math.floor((hourIST - startHour) / intervalHours) * intervalHours
        if (hourIST === slotStart && minuteIST < 30) {
          const fileIds = dailyReport.files || []
          const filesToCheck = fileIds.length > 0
            ? (files || []).filter((f: any) => fileIds.includes(f.id))
            : (files || [])

          const lines: any[] = []
          for (const f of filesToCheck) {
            if (!f.alert_rule?.enabled || !f.alert_rule?.fieldId) continue
            const { data: recs } = await sb.from('records')
              .select('id,created_at,extra,admin_data,closed_at,field_comments')
              .eq('file_id', f.id).eq('archived', false)
            const breached = (recs || []).filter((r: any) => recordMatchesAlert(r, f)).length
            if (breached > 0) lines.push({ name: f.name, breached })
          }

          if (lines.length > 0) {
            lines.sort((a: any, b: any) => b.breached - a.breached)
            const msg = `מובמנט | ${dateStr}\n\n${lines.map((l: any) => `${l.name}: ${l.breached} פניות ממתינות לטיפול`).join('\n')}\n\nלכניסה: https://adir2112-blip.github.io/files/`
            const ok = await sendWA(formatPhone(dailyReport.phone), msg)
            await logWA(sb, { recipient_name: 'דוח יומי', recipient_phone: dailyReport.phone, file_name: `${lines.length} קבצים`, msg_type: 'DAILY_REPORT', ok })
            log.push({ type: 'DAILY_REPORT', lines: lines.length })
          }
        }
      }
    }

    // ── 3. INACTIVITY ALERTS ──
    if (inactivityConfig?.enabled) {
      const startHour = inactivityConfig.startHour || 8
      const endHour = inactivityConfig.endHour || 18
      const blockedDays = inactivityConfig.blockedDays || [5,6]

      if (!blockedDays.includes(dayIST) && hourIST >= startHour && hourIST < endHour) {
        const filesWithInactivity = (files || []).filter((f: any) =>
          f.inactivity_alert?.enabled && f.inactivity_alert?.hours
        )

        for (const f of filesWithInactivity) {
          const hours = f.inactivity_alert.hours
          const since = new Date(now.getTime() - hours * 3600000).toISOString()
          const { data: recs } = await sb.from('records')
            .select('id').eq('file_id', f.id).gte('created_at', since).limit(1)

          if (recs && recs.length > 0) continue

          const sentKey = `inactivity_sent_${f.id}`
          const windowNum = Math.floor(now.getTime() / (hours * 3600000))
          const { data: lastSentRow } = await sb.from('app_settings')
            .select('value').eq('key', sentKey).maybeSingle()
          if (lastSentRow && JSON.parse(lastSentRow.value) === windowNum) continue

          const customMsg = f.inactivity_alert.message || ''
          const msg = customMsg
            ? customMsg.replace('{תאריך}', dateStr).replace('{קובץ}', f.name).replace('{שעות}', String(hours))
            : `מובמנט | ${dateStr}\nמנהל יקר הנציגים לא מבצעים את המשימה שהם קיבלו ממך.\nבקובץ "${f.name}" אין פעילות מעל ${hours} שעות\nתעצור כעת את המשמרת ותוודא שגם נציגים מהבית וגם נציגים במוקד מבצעים כל אחד 5 תיעודים כאלה ביום.\n\nאדיר סומך עלייך שזה יבוצע!`

          for (const contact of (f.wa_contacts || [])) {
            const ok = await sendWA(formatPhone(contact.phone), msg)
            await logWA(sb, { recipient_name: contact.name, recipient_phone: contact.phone, file_name: f.name, msg_type: 'INACTIVITY', ok })
          }
          if (f.wa_notify_group === true) {
            const ok = await sendWA(WA_GROUP, msg)
            await logWA(sb, { recipient_name: 'קבוצת מנהל ובכירי אדיר', recipient_phone: WA_GROUP, file_name: f.name, msg_type: 'INACTIVITY_GROUP', ok })
          }
          await sb.from('app_settings').upsert({ key: sentKey, value: JSON.stringify(windowNum) })
          log.push({ type: 'INACTIVITY', file: f.name, hours })
        }
      }
    }

    // ── 4. PROJECT MANAGER DAILY DIGEST ──
    // הודעה אחת מרוכזת ליום לכל מנהל פרויקט, מקובצת לפי ארגון, באותו טמפלט של דוח
    // ה-SLA לאדיר וליאת (pm_digest.tpl). הניתוב הוא לפי pm_digest.managerFiles
    // (מנהל → רשימת מזהי קבצים, נקבע במסך "התראות WA" → מנהלי פרויקטים) — לא לפי
    // assignedManagerEmail על השדה (זה הוחלף ב-2026-09-23). קובץ שלא סומן לאף מנהל
    // מדולג בשקט — אין יותר שידור לכל מנהלי הפרויקט (זה מה שגרם להצפה ב-2026-09-23).
    {
      const pmDigest = getSetting('pm_digest') || {}
      const pmDigestEnabled = pmDigest.enabled !== false
      const pmDigestHour = pmDigest.hour ?? 12
      const pmDigestDays: number[] = pmDigest.days ?? [0, 1, 2, 3, 4]
      const pmTpl = { ...defaultSlaDigestTpl(), ...(pmDigest.tpl || {}) }
      const managerFiles: Record<string, string[]> = pmDigest.managerFiles || {}

      if (pmDigestEnabled && pmDigestDays.includes(dayIST) && hourIST === pmDigestHour && minuteIST < 30) {
        const sentKey = 'pm_digest_last_sent'
        const { data: lastSentRow } = await sb.from('app_settings').select('value').eq('key', sentKey).maybeSingle()
        const lastSent = lastSentRow ? JSON.parse(lastSentRow.value) : null

        if (lastSent !== dateStr) {
          const { data: managers } = await sb.from('app_managers').select('email,name,phone,active')
          const managerByEmail: Record<string, any> = {}
          ;(managers || []).forEach((m: any) => { managerByEmail[m.email] = m })
          const filesById: Record<string, any> = {}
          ;(files || []).forEach((f: any) => { filesById[f.id] = f })

          for (const [email, fileIds] of Object.entries(managerFiles)) {
            const mgr = managerByEmail[email]
            if (!mgr?.phone || !mgr.active) continue

            const lines: any[] = []
            for (const fid of (fileIds || [])) {
              const f = filesById[fid]
              if (!f) continue
              const escalationFields = (f.admin_fields || []).filter((af: any) => isEscalationField(af))
              if (!escalationFields.length) continue
              const { data: recs } = await sb.from('records')
                .select('id,created_at,escalated_at,closed_at,admin_data')
                .eq('file_id', f.id).eq('archived', false).is('closed_at', null)
              let breached: any[] = []
              for (const af of escalationFields) breached = breached.concat((recs || []).filter((r: any) => recordEscalationBreached(r, af, f)))
              if (!breached.length) continue
              const refDate = (r: any) => r.escalated_at || r.created_at
              const oldest = breached.reduce((min: any, r: any) => refDate(r) < refDate(min) ? r : min, breached[0])
              const oldestDays = Math.floor((now.getTime() - new Date(refDate(oldest)).getTime()) / 86400000)
              lines.push({ orgId: f.org_id, name: f.name, count: breached.length, oldestDays })
            }

            const msg = buildOrgGroupedMessage(pmTpl, lines, orgs || [], dateStr)
            if (!msg) continue
            const ok = await sendWA(formatPhone(mgr.phone), msg)
            await logWA(sb, { recipient_name: mgr.name, recipient_phone: mgr.phone, file_name: lines.map((l: any) => l.name).join(', '), msg_type: 'PM_DIGEST', ok })
            log.push({ type: 'PM_DIGEST', pm: mgr.name, files: lines.length })
          }

          await sb.from('app_settings').upsert({ key: sentKey, value: JSON.stringify(dateStr) })
        }
      }
    }

    // ── 5. WEEKLY BACKUP EMAIL ──
    if (backupConfig?.enabled && backupConfig?.to) {
      const dayOfWeek = backupConfig.dayOfWeek ?? 0
      const hour = backupConfig.hour ?? 8

      if (dayIST === dayOfWeek && hourIST === hour && minuteIST < 30) {
        const { data: lastSentRow } = await sb.from('app_settings')
          .select('value').eq('key', 'backup_last_sent').maybeSingle()
        const lastSent = lastSentRow ? JSON.parse(lastSentRow.value) : null

        if (lastSent !== dateStr) {
          let ok = false
          let recordCount = 0
          try {
            const res = await fetch(BACKUP_FUNC_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_KEY}` },
              body: JSON.stringify({ to: backupConfig.to })
            })
            ok = res.ok
            const resData = await res.json().catch(() => null)
            if (resData?.records) recordCount = resData.records
          } catch (e) { ok = false }

          await sb.from('app_settings').upsert({ key: 'backup_last_sent', value: JSON.stringify(dateStr) })

          const { data: histRow } = await sb.from('app_settings').select('value').eq('key', 'backup_history').maybeSingle()
          const hist = histRow ? JSON.parse(histRow.value) : []
          const entry = { date: now.toISOString().slice(0,10), ts: now.toISOString(), to: backupConfig.to, records: recordCount, ok, manual: false }
          const newHist = [entry, ...hist].slice(0, 50)
          if (histRow) {
            await sb.from('app_settings').update({ value: JSON.stringify(newHist) }).eq('key', 'backup_history')
          } else {
            await sb.from('app_settings').insert({ key: 'backup_history', value: JSON.stringify(newHist) })
          }
          log.push({ type: 'BACKUP', to: backupConfig.to, ok })
        }
      }
    }

    // ── 6. SLA BREACH DIGEST (מקובץ לפי ארגון, לנמענים נבחרים) ──
    const slaDigest = getSetting('sla_digest')
    if (slaDigest?.enabled && (slaDigest.recipients || []).length) {
      const days: number[] = slaDigest.days ?? [0,1,2,3,4]
      const hour: number = slaDigest.hour ?? 8

      if (days.includes(dayIST) && hourIST === hour && minuteIST < 30) {
        const sentKey = 'sla_digest_last_sent'
        const { data: lastSentRow } = await sb.from('app_settings').select('value').eq('key', sentKey).maybeSingle()
        const lastSent = lastSentRow ? JSON.parse(lastSentRow.value) : null

        if (lastSent !== dateStr) {
          const selectedFileIds: string[] = slaDigest.files || []
          // כלל SLA שמצביע על שדה שכבר מתויג "מנהל פרויקט" שייך למעקב ההסלמה, לא לדוח
          // האחמ"ש הזה — נמנע מסיווג שגוי (אין דיגסט נפרד למנהלים כרגע, רק לאחמ"ש)
          const filesWithSLA = (files || []).filter((f: any) => {
            if (!(f.alert_rule?.enabled && f.alert_rule?.fieldId)) return false
            if (selectedFileIds.length && !selectedFileIds.includes(f.id)) return false
            const targetField = (f.admin_fields || []).find((af: any) => af.id === f.alert_rule.fieldId)
            return targetField?.escalationAlertDays == null
          })
          const byOrg: Record<string, any[]> = {}
          for (const f of filesWithSLA) {
            const { data: recs } = await sb.from('records')
              .select('id,created_at,extra,admin_data,closed_at,field_comments')
              .eq('file_id', f.id).eq('archived', false)
            const breached = (recs || []).filter((r: any) => recordMatchesAlert(r, f))
            if (!breached.length) continue
            const oldest = breached.reduce((min: any, r: any) => r.created_at < min.created_at ? r : min, breached[0])
            const oldestDays = Math.floor((now.getTime() - new Date(oldest.created_at).getTime()) / 86400000)
            ;(byOrg[f.org_id] = byOrg[f.org_id] || []).push({ name: f.name, count: breached.length, oldestDays })
          }

          // קבצים בלי "כלל SLA" כללי מופעל, אבל עם שדה שסומן ישירות למוניטור אחמ"ש
          // (כדי לא לספור פעמיים קובץ שכבר מכוסה ע"י כלל ה-SLA)
          const filesWithAhmashFields = (files || []).filter((f: any) =>
            !(f.alert_rule?.enabled && f.alert_rule?.fieldId) &&
            (!selectedFileIds.length || selectedFileIds.includes(f.id)) &&
            (f.admin_fields || []).some((af: any) => af.ahmashAlertDays != null)
          )
          for (const f of filesWithAhmashFields) {
            const { data: recs } = await sb.from('records')
              .select('id,created_at,escalated_at,closed_at,admin_data')
              .eq('file_id', f.id).eq('archived', false)
            const ahmashFields = (f.admin_fields || []).filter((af: any) => af.ahmashAlertDays != null)
            let breached: any[] = []
            for (const af of ahmashFields) {
              breached = breached.concat((recs || []).filter((r: any) => !r.closed_at && recordMatchesAhmashField(r, af, f)))
            }
            if (!breached.length) continue
            const refDate = (r: any) => r.escalated_at || r.created_at
            const oldest = breached.reduce((min: any, r: any) => refDate(r) < refDate(min) ? r : min, breached[0])
            const oldestDays = Math.floor((now.getTime() - new Date(refDate(oldest)).getTime()) / 86400000)
            ;(byOrg[f.org_id] = byOrg[f.org_id] || []).push({ name: f.name, count: breached.length, oldestDays })
          }

          const orgIds = Object.keys(byOrg).sort((a, b) =>
            byOrg[b].reduce((s, x) => s + x.count, 0) - byOrg[a].reduce((s, x) => s + x.count, 0)
          )
          const totalBreached = orgIds.reduce((s, oid) => s + byOrg[oid].reduce((s2, x) => s2 + x.count, 0), 0)

          if (totalBreached > 0) {
            const defTpl = defaultSlaDigestTpl()
            const tpl = { ...defTpl, ...(slaDigest.tpl || {}) }
            const sections = orgIds.map(oid => {
              const org = (orgs || []).find((o: any) => o.id === oid)
              const orgName = org?.name || 'ארגון לא ידוע'
              const contact = org?.sla_contact_name ? ` (${org.sla_contact_name})` : ''
              const filesStr = byOrg[oid].map((f: any) =>
                fillSlaTpl(tpl.fileLine, { file: f.name, count: f.count, days: f.oldestDays })
              ).join('\n')
              return fillSlaTpl(tpl.orgBlock, { org: orgName, contact, files: filesStr })
            }).join('\n\n')

            const header = fillSlaTpl(tpl.header, { date: dateStr })
            const footer = fillSlaTpl(tpl.footer, { total: totalBreached })
            const msg = `${header}\n\n${sections}\n\n${footer}`

            for (const r of (slaDigest.recipients || [])) {
              const ok = await sendWA(formatPhone(r.phone), msg)
              await logWA(sb, { recipient_name: r.name || r.phone, recipient_phone: r.phone, file_name: `${orgIds.length} ארגונים`, msg_type: 'SLA_DIGEST', ok })
              log.push({ type: 'SLA_DIGEST', to: r.name, total: totalBreached })
            }
            await sb.from('app_settings').upsert({ key: sentKey, value: JSON.stringify(dateStr) })
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, timeIST: `${hourIST}:${minuteIST}`, log }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
