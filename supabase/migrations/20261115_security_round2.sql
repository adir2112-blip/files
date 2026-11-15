-- Security round 2 (15.11.2026). Apply AFTER index.html v1.0.162 is live.

-- 1) app_users: the PIN and the Authenticator (TOTP) secrets are no longer readable from the
--    browser. Until now every logged-in user (any agent too) could read every agent's PIN and
--    TOTP secret through the REST API. agent-login / agent-totp-* use the service role and are
--    not affected. Writes (managers setting a PIN) still work.
revoke select on public.app_users from authenticated;
grant select (id, name, role, active, created_at, last_login, allowed_orgs, auth_user_id,
              failed_pin_attempts, pin_locked_until, authenticator_pending_created_at,
              authenticator_enrolled_at, totp_failed_attempts, totp_locked_until, totp_exempt)
  on public.app_users to authenticated;
revoke select (pin, authenticator_secret, authenticator_pending_secret) on public.app_users from anon;

-- 2) attachments bucket: only logged-in users can upload (everyone who saves a record is logged
--    in already), and only images / PDF / phone videos. Reading stays public (links in records).
drop policy if exists "allow all attachments insert" on storage.objects;
create policy "attachments insert authenticated" on storage.objects
  for insert to authenticated with check (bucket_id = 'attachments');
update storage.buckets
  set allowed_mime_types = array['image/*', 'application/pdf', 'video/mp4', 'video/quicktime']
  where id = 'attachments';
