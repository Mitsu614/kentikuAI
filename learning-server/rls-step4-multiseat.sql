-- ============================================================================
-- STEP4: マルチシート（1社ライセンスを複数端末で共有・クレジット共有）
-- ----------------------------------------------------------------------------
-- 目的:
--   ・1つの remote_licenses（＝1課金）を、max_seats までの端末で共有する。
--   ・各端末は license_seats に device_token を持つが、クレジットは親ライセンスの
--     credits を全端末で共有して消費する（＝1プール）。
--   ・端末は「会社名＋参加コード(join_code)」で席を取る（join）。上限で seats_full。
--   ・偽造対策: license_seats も RLS でロックし、書き込みは Edge Function(service_role)のみ。
--
-- ★実行場所: Supabase ダッシュボード → SQL Editor（service role）。
-- ★後方互換: 既存の1人ライセンスは license_token 直参照のまま動く（seatが無ければ従来経路）。
-- ============================================================================

BEGIN;

-- 1) remote_licenses に席数と参加コードを追加（既定は1席＝従来どおりの単独利用）
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS max_seats  integer NOT NULL DEFAULT 1;
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS join_code  text;

-- 2) 席テーブル（1ライセンスに複数端末）
CREATE TABLE IF NOT EXISTS license_seats (
  id            text PRIMARY KEY,
  license_id    text NOT NULL REFERENCES remote_licenses(id) ON DELETE CASCADE,
  device_token  text NOT NULL UNIQUE,
  device_label  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_license_seats_license ON license_seats(license_id);
CREATE INDEX IF NOT EXISTS idx_license_seats_token   ON license_seats(device_token);

-- 3) RLS: license_seats はロック（ポリシー無し＝anon/publicは一切不可。service_roleのみ通す）
ALTER TABLE license_seats ENABLE ROW LEVEL SECURITY;
-- ※ ポリシーを作らないことで anon からの select/insert/update/delete をすべて拒否する。
--   Edge Function は service_role で叩くため RLS を素通りできる。

-- 4) 共有クレジット消費RPC（device_token でも license_token でも減算できる原子関数）
--    親ライセンスの行をロックして減算するので、複数端末の同時 consume でも二重消費しない。
CREATE OR REPLACE FUNCTION consume_credits_seat(p_token text, p_amount integer)
RETURNS TABLE(status text, credits integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_license_id text;
  v_active     boolean;
  v_credits    integer;
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
  SELECT l.active, l.credits INTO v_active, v_credits
  FROM remote_licenses l
  WHERE l.id = v_license_id
  FOR UPDATE;

  IF NOT v_active THEN
    RETURN QUERY SELECT 'inactive'::text, COALESCE(v_credits,0); RETURN;
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

-- 確認用:
-- SELECT company_name, plan, credits, max_credits, max_seats, join_code FROM remote_licenses ORDER BY created_at DESC;
-- SELECT * FROM license_seats;
