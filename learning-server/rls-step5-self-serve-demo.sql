-- ============================================================================
-- STEP5: 承認制をやめ、デモを「その場で開始」できるようにする（偽造は1社1回で止める）
-- ----------------------------------------------------------------------------
-- 目的:
--   ・新規登録に管理者の承認を挟まない（申請 → 待つ、を廃止）。
--     メールに届く確認番号を入れたらその場でデモが始まる。
--   ・そのかわり「同じ会社が名前を変えて何度でもデモを取る」を止める。
--     同一性は3つの鍵で見る：
--       device_hash  … 端末の指紋（入れ直しても変わらない）
--       email_key    … 正規化したメール（gmailのドット/＋別名を潰す）
--       company_key  … 正規化した会社名（株式会社・空白・全半角の違いを潰す）
--     どれか1つでも既存に当たれば新しいデモは配らず、既存のライセンスへ戻す。
--     ＝入れ直しても残クレジットと残り期間は増えない。
--   ・デモの期限をサーバーが持つ（expires_at）。
--     これまでは期限がローカルDBの plan_started_at だけにあり、アプリを
--     入れ直すと30日が復活していた（サーバーはクレジットしか見ていなかった）。
--
-- ★実行場所: Supabase ダッシュボード → SQL Editor（service role）
-- ★後方互換: 既存の有料ライセンスは新しい列がすべて NULL のまま。何も変わらない。
--   （部分UNIQUE索引なので NULL は何行あっても衝突しない）
-- ============================================================================

BEGIN;

-- 1) 申込みの身元と、デモの期限
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS device_hash       text;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS contact_email     text;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS email_key         text;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS email_domain      text;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS contact_tel       text;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS company_key       text;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS expires_at        timestamptz;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS signup_source     text;

-- 2) メール確認（番号）
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS verify_code       text;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS verify_expires_at timestamptz;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS verify_attempts   integer NOT NULL DEFAULT 0;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS verified_at       timestamptz;

-- 3) 同一性の鍵。NULL は衝突しないので、既存の有料ライセンスには一切影響しない
CREATE UNIQUE INDEX IF NOT EXISTS uq_remote_licenses_device_hash
  ON remote_licenses(device_hash) WHERE device_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_remote_licenses_email_key
  ON remote_licenses(email_key)   WHERE email_key   IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_remote_licenses_company_key
  ON remote_licenses(company_key) WHERE company_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_remote_licenses_email_domain
  ON remote_licenses(email_domain) WHERE email_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_remote_licenses_expires
  ON remote_licenses(expires_at) WHERE expires_at IS NOT NULL;

-- 4) 消費RPCに期限を足す。
--    ★クレジットが残っていても期限切れなら消費させない。
--      ここで止めないと、期限の判定がアプリ側（ローカルDB）だけになり、
--      入れ直しで日付をリセットされたときに素通りしてしまう。
CREATE OR REPLACE FUNCTION consume_credits_seat(p_token text, p_amount integer)
RETURNS TABLE(status text, credits integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_license_id text;
  v_active     boolean;
  v_credits    integer;
  v_expires    timestamptz;
BEGIN
  -- device_token（席）→ 親ライセンスを特定
  SELECT s.license_id INTO v_license_id
  FROM license_seats s
  WHERE s.device_token = p_token;

  IF v_license_id IS NULL THEN
    -- 席が無ければ従来の license_token 直参照（後方互換：単独利用）
    SELECT l.id INTO v_license_id
    FROM remote_licenses l
    WHERE l.license_token = p_token;
  END IF;

  IF v_license_id IS NULL THEN
    RETURN QUERY SELECT 'invalid_token'::text, 0; RETURN;
  END IF;

  -- 親ライセンス行をロックして減算
  SELECT l.active, l.credits, l.expires_at INTO v_active, v_credits, v_expires
  FROM remote_licenses l
  WHERE l.id = v_license_id
  FOR UPDATE;

  IF NOT v_active THEN
    RETURN QUERY SELECT 'inactive'::text, COALESCE(v_credits,0); RETURN;
  END IF;
  IF v_expires IS NOT NULL AND v_expires < now() THEN
    RETURN QUERY SELECT 'expired'::text, COALESCE(v_credits,0); RETURN;
  END IF;
  IF COALESCE(v_credits,0) < p_amount THEN
    RETURN QUERY SELECT 'insufficient'::text, COALESCE(v_credits,0); RETURN;
  END IF;

  UPDATE remote_licenses
    SET credits = credits - p_amount, updated_at = now()
    WHERE id = v_license_id;

  RETURN QUERY SELECT 'ok'::text, (v_credits - p_amount);
END;
$$;

COMMIT;

-- ----------------------------------------------------------------------------
-- 確認用（任意）
--   デモの一覧と残り日数:
--     SELECT company_name, contact_email, credits, expires_at,
--            (expires_at::date - now()::date) AS days_left, verified_at, device_hash
--     FROM remote_licenses WHERE plan = 'demo' ORDER BY created_at DESC;
--
--   有料へ引き上げるとき（admin approve が自動でやるが、手で直すなら）:
--     UPDATE remote_licenses SET plan='standard', credits=20, max_credits=20,
--            active=true, expires_at=NULL WHERE id='reg_xxxx';
--     ★expires_at を NULL に戻すのを忘れないこと。残っていると有料なのに切れる。
-- ----------------------------------------------------------------------------
