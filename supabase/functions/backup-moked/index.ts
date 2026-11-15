// Supabase Edge Function — backup-moked
// Deploy: supabase functions deploy backup-moked
// Env vars needed: RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    // Parse request body
    let toEmail = 'adir2112@gmail.com';
    let includeOrgs = [];
    try {
      const body = await req.json();
      if (body.to) toEmail = body.to;
      if (body.orgs) includeOrgs = body.orgs;
    } catch (_) {}
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: orgs } = await sb.from('organizations').select('*');
    const { data: files } = await sb.from('files').select('*');
    // גיבוי מלא של כל הרשומות — לא סומכים על מגבלת max_rows של הפרויקט,
    // דוגמים בעמודים כדי שגיבוי לא יתחתך בשקט אם הכמות תגדל בעתיד
    const allRecords: any[] = [];
    {
      const PAGE = 1000;
      let from = 0;
      while(true){
        const { data: page } = await sb.from('records').select('*').order('created_at', { ascending: false }).range(from, from + PAGE - 1);
        if (!page || page.length === 0) break;
        allRecords.push(...page);
        if (page.length < PAGE) break;
        from += PAGE;
      }
    }
    const { data: managers } = await sb.from('app_managers').select('*');
    const { data: agents } = await sb.from('app_users').select('*');
    const { data: settingsRows } = await sb.from('app_settings').select('*');
    const orgList = orgs || [];
    const fileList = files || [];
    const records = allRecords || [];
    const managerList = managers || [];
    const agentList = agents || [];
    const settingsList = settingsRows || [];
    const relevantFiles = includeOrgs.length > 0 ? fileList.filter((f)=>includeOrgs.includes(f.org_id)) : fileList;
    const now = new Date();
    const dateStr = now.toLocaleDateString('he-IL');
    const isoDate = now.toISOString().slice(0, 10);
    // Build CSV
    const csvLines = [];
    csvLines.push([
      'ארגון',
      'קובץ',
      'תאריך',
      'שם פרטי',
      'שם משפחה',
      'טלפון',
      'ת"ז',
      'נציג',
      'תאריך טיפול'
    ].join(','));
    for (const f of relevantFiles){
      const org = orgList.find((o)=>o.id === f.org_id);
      const fileRecords = records.filter((r)=>r.file_id === f.id);
      for (const r of fileRecords){
        csvLines.push([
          `"${org?.name || ''}"`,
          `"${f.name}"`,
          `"${new Date(r.created_at).toLocaleDateString('he-IL')}"`,
          `"${r.first_name || ''}"`,
          `"${r.last_name || ''}"`,
          `"${r.phone || ''}"`,
          `"${r.id_num || ''}"`,
          `"${r.agent_name || ''}"`,
          `"${r.treated_at ? new Date(r.treated_at).toLocaleDateString('he-IL') : ''}"`
        ].join(','));
      }
    }
    const csvContent = '﻿' + csvLines.join('\n');
    const base64CSV = btoa(unescape(encodeURIComponent(csvContent)));
    // Build full JSON backup (used for in-app restore)
    const fullBackup = {
      backup_version: 1,
      generated_at: now.toISOString(),
      organizations: orgList,
      files: fileList,
      records,
      app_managers: managerList,
      app_users: agentList,
      app_settings: settingsList
    };
    const fullBackupJSON = JSON.stringify(fullBackup);
    const base64Full = btoa(unescape(encodeURIComponent(fullBackupJSON)));
    // Summary per file
    const summaryRows = relevantFiles.map((f)=>{
      const org = orgList.find((o)=>o.id === f.org_id);
      const fileRecs = records.filter((r)=>r.file_id === f.id);
      const treated = fileRecs.filter((r)=>r.treated_at).length;
      return {
        fileName: f.name,
        orgName: org?.name || '',
        total: fileRecs.length,
        treated
      };
    });
    const summaryTable = summaryRows.map((r)=>`
      <tr>
        <td style="padding:6px 12px;border:1px solid #e2e6ef">${r.orgName}</td>
        <td style="padding:6px 12px;border:1px solid #e2e6ef">${r.fileName}</td>
        <td style="padding:6px 12px;border:1px solid #e2e6ef;text-align:center">${r.total}</td>
        <td style="padding:6px 12px;border:1px solid #e2e6ef;text-align:center">${r.treated}</td>
        <td style="padding:6px 12px;border:1px solid #e2e6ef;text-align:center;color:${r.total > 0 ? '#16a34a' : '#9ca3af'}">
          ${r.total > 0 ? Math.round(r.treated / r.total * 100) + '%' : '—'}
        </td>
      </tr>`).join('');
    const html = `
      <div dir="rtl" style="font-family:Arial,sans-serif;padding:24px;max-width:700px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:20px 24px;border-radius:12px;margin-bottom:24px">
          <h2 style="color:#fff;margin:0">גיבוי שבועי — מוקד מובמנט</h2>
          <p style="color:rgba(255,255,255,.6);margin:6px 0 0;font-size:13px">תאריך: ${dateStr} · סה"כ ${records.length} רשומות</p>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <thead><tr style="background:#1e3a8a;color:#fff">
            <th style="padding:8px 12px;text-align:right">ארגון</th>
            <th style="padding:8px 12px;text-align:right">קובץ</th>
            <th style="padding:8px 12px;text-align:center">רשומות</th>
            <th style="padding:8px 12px;text-align:center">טופלו</th>
            <th style="padding:8px 12px;text-align:center">% טיפול</th>
          </tr></thead>
          <tbody>${summaryTable}</tbody>
        </table>
        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:12px 16px;font-size:13px;color:#15803d">
          📎 קובץ CSV מלא מצורף לייבוא ל-Excel (Hebrew UTF-8)<br>
          🗄️ קובץ JSON מלא מצורף — לשחזור בממשק האדמין (״גיבוי ושחזור״) במקרה הצורך
        </div>
        <p style="font-size:11px;color:#9ca3af;margin-top:20px;text-align:center">
          נשלח אוטומטית ממערכת מוקד מובמנט · ${now.toLocaleString('he-IL')}
        </p>
      </div>`;
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: toEmail,
        subject: `📊 גיבוי שבועי מוקד מובמנט — ${dateStr}`,
        html,
        attachments: [
          {
            filename: `moked-backup-${isoDate}.csv`,
            content: base64CSV
          },
          {
            filename: `moked-full-backup-${isoDate}.json`,
            content: base64Full
          }
        ]
      })
    });
    const resendData = await resendRes.json();
    return new Response(JSON.stringify({
      ok: resendRes.ok,
      records: records.length,
      to: toEmail,
      resend: resendData
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: String(err)
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
