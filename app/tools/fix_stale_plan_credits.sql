-- ============================================================================
-- 旧単位数で発行されたライセンスの是正スクリプト
-- ----------------------------------------------------------------------------
-- 背景: 2026-09-08 の単位引き上げ（スタンダード 20→50 / ベター 50→150 / プロ 100→300）
--       のあとも、stripe-webhook の PLAN_BY_AMOUNT と SettingsPage.tsx の plans が
--       旧単位のままだった。そのため、カード決済で自動有効化されたお客様には
--       契約より少ない単位しか付与されていない。
--       コード側は修正済み。この SQL は「すでに発行済みの行」を追いつかせるためのもの。
--
-- ★実行場所: Supabase ダッシュボード → SQL Editor（service role で実行＝RLSを越える）。
--
-- ★単位数の正は app/src/database/database.ts の PLANS。ここを変えるときは
--   そちらと stripe-webhook/index.ts、SettingsPage.tsx も必ず揃えること。
--
-- ★手順: まず (1) で影響範囲を目で確かめてから、(2) を実行すること。
--   credits（残り単位）は当月の使用分を消したくないので、
--   「増える場合だけ」引き上げる。max_credits（枠）は無条件に正しい値へ揃える。
-- ============================================================================

-- (1) 影響を受ける行の確認（UPDATE の前に必ず実行）
SELECT
  company_name,
  plan,
  credits      AS 現在の残り単位,
  max_credits  AS 現在の枠,
  CASE plan WHEN 'standard' THEN 50 WHEN 'better' THEN 150 WHEN 'pro' THEN 300 END AS 正しい枠,
  active,
  updated_at
FROM remote_licenses
WHERE plan IN ('standard', 'better', 'pro')
  AND max_credits IS DISTINCT FROM
      (CASE plan WHEN 'standard' THEN 50 WHEN 'better' THEN 150 WHEN 'pro' THEN 300 END)
ORDER BY plan, company_name;

-- (2) 是正（(1) の結果を確認してから実行）
UPDATE remote_licenses
SET
  max_credits = CASE plan WHEN 'standard' THEN 50 WHEN 'better' THEN 150 WHEN 'pro' THEN 300 END,
  -- 残り単位は減らさない。旧枠のぶん増やして、当月の使用分はそのまま残す。
  credits = GREATEST(
    COALESCE(credits, 0),
    COALESCE(credits, 0)
      + (CASE plan WHEN 'standard' THEN 50 WHEN 'better' THEN 150 WHEN 'pro' THEN 300 END)
      - COALESCE(max_credits, 0)
  ),
  updated_at = NOW()
WHERE plan IN ('standard', 'better', 'pro')
  AND max_credits IS DISTINCT FROM
      (CASE plan WHEN 'standard' THEN 50 WHEN 'better' THEN 150 WHEN 'pro' THEN 300 END);

-- (3) 結果の確認
SELECT company_name, plan, credits, max_credits, active
FROM remote_licenses
WHERE plan IN ('standard', 'better', 'pro')
ORDER BY plan, company_name;
