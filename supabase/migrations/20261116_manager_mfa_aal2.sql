-- אכיפת אימות דו-שלבי למנהלים בבסיס הנתונים (16.11.2026)
--
-- הבעיה: הדף מחייב קוד Authenticator לפני כניסה, אבל בבסיס הנתונים עצמו מנהל
-- שהתחבר רק עם סיסמה (aal1) קיבל את אותן הרשאות. מי שגנב סיסמה של מנהל יכל
-- לפנות ישירות ל-API ולדלג על מסך הקוד.
--
-- הפתרון: מדיניות RESTRICTIVE על כל טבלה (נוספת ב-AND על המדיניות הקיימת, לא מחליפה
-- אותה): משתמש מחובר עובר רק אם הוא נציג (משתמש סינתטי agent-N@moked.internal, נכנס
-- דרך agent-login / agent-totp-verify) או שה-session שלו ב-aal2 (אחרי קוד Authenticator).
--
-- חריג אחד: מנהל ב-aal1 רואה את השורה של עצמו ב-app_managers — הדף בודק "האם זה מנהל"
-- לפני מסך הקוד / ה-QR (initLogin, loginManager). ההרשמה ל-Authenticator עצמה
-- (mfa.enroll / challenge / verify) עוברת ב-Supabase Auth ולא מושפעת מ-RLS.
--
-- anon (רשימת הנציגים במסך הכניסה, pg_cron) ו-service_role לא מושפעים.

create or replace function public.mfa_ok()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or coalesce(auth.jwt() ->> 'email', '') ~ '^agent-[0-9]+@moked\.internal$'
$$;

grant execute on function public.mfa_ok() to authenticated, anon;

-- כל הטבלאות ב-public עם RLS פעיל, חוץ מ-app_managers
do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and c.relname <> 'app_managers'
  loop
    execute format('drop policy if exists mfa_required on public.%I', t.relname);
    execute format(
      'create policy mfa_required on public.%I as restrictive for all to authenticated
         using (public.mfa_ok()) with check (public.mfa_ok())', t.relname);
  end loop;
end $$;

-- app_managers: קריאה של השורה של עצמי מותרת גם ב-aal1; כל השאר רק ב-aal2
drop policy if exists mfa_required_select on public.app_managers;
drop policy if exists mfa_required_insert on public.app_managers;
drop policy if exists mfa_required_update on public.app_managers;
drop policy if exists mfa_required_delete on public.app_managers;

create policy mfa_required_select on public.app_managers as restrictive for select to authenticated
  using (public.mfa_ok() or lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy mfa_required_insert on public.app_managers as restrictive for insert to authenticated
  with check (public.mfa_ok());
create policy mfa_required_update on public.app_managers as restrictive for update to authenticated
  using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa_required_delete on public.app_managers as restrictive for delete to authenticated
  using (public.mfa_ok());

-- קבצים מצורפים (Storage)
drop policy if exists mfa_required on storage.objects;
create policy mfa_required on storage.objects as restrictive for all to authenticated
  using (public.mfa_ok()) with check (public.mfa_ok());

-- ביטול מהיר (אם משהו נשבר):
--   do $$ declare t record; begin
--     for t in select tablename from pg_policies where schemaname='public' and policyname='mfa_required' loop
--       execute format('drop policy mfa_required on public.%I', t.tablename); end loop; end $$;
--   drop policy mfa_required_select on public.app_managers; drop policy mfa_required_insert on public.app_managers;
--   drop policy mfa_required_update on public.app_managers; drop policy mfa_required_delete on public.app_managers;
--   drop policy mfa_required on storage.objects;
