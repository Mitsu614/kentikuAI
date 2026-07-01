-- =====================================================================
-- STEP3-a: remote_licenses に「秘密トークン」列を追加（非破壊・安全）
--
-- これは列を足して既存6件にトークンを発行するだけ。アプリの動作は変わらない。
-- Supabase → SQL Editor に貼って Run。
-- =====================================================================

-- トークン列（各ライセンスの秘密の鍵）と、移行用の claimed_at 列を追加
alter table public.remote_licenses add column if not exists license_token text;
alter table public.remote_licenses add column if not exists claimed_at timestamptz;

-- 既存行にトークンを発行（64桁の16進。gen_random_uuid はSupabase標準で使える）
update public.remote_licenses
  set license_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  where license_token is null or license_token = '';

-- トークンは一意
create unique index if not exists idx_remote_licenses_token
  on public.remote_licenses (license_token);

-- 確認用（実行後、6件すべてに token が入っていればOK。※トークン自体は表示しない）
select count(*) as total,
       count(license_token) as with_token,
       count(*) filter (where claimed_at is null) as unclaimed
from public.remote_licenses;
