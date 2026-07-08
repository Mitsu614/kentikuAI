-- =====================================================================
-- STEP3-d: remote_licenses のデータ掃除（テスト行削除＋同名重複の統合）
--
-- ⚠️ 破壊的操作を含む。必ず STEP1 の SELECT で中身を確認してから STEP2/3 を実行すること。
-- Supabase → SQL Editor（service_role）で実行。anon(公開キー)では実行できない。
-- =====================================================================

-- ---------------------------------------------------------------------
-- STEP1｜まず全件を目視確認（トークンは表示しない）
-- ---------------------------------------------------------------------
select id, company_name, plan, active,
       (claimed_at is not null) as claimed,
       (license_token is not null) as has_token,
       credits, max_credits, created_at
from public.remote_licenses
order by company_name, created_at;

-- ---------------------------------------------------------------------
-- STEP2｜明らかな合成テスト行を削除（company_name が '__' で始まるもの）
--   例: __test_lc_15b0e046 / __test_lc_3079fa55 / __sec_test_delete_me
--   ↓まず対象を確認してから、下の delete を実行。
-- ---------------------------------------------------------------------
-- 確認:
select id, company_name, plan, active from public.remote_licenses
where company_name like '\_\_%' escape '\';
-- 実行（上の結果に問題なければ）:
-- delete from public.remote_licenses where company_name like '\_\_%' escape '\';

-- ---------------------------------------------------------------------
-- STEP3｜その他のテスト候補行（自動削除しない・1件ずつ判断）
--   tesuto / テストです２９ / クレジット確認 などは本当にテストか要確認。
--   消す場合は id を指定して個別に:
-- ---------------------------------------------------------------------
-- 確認:
select id, company_name, plan, active, claimed_at from public.remote_licenses
where company_name in ('tesuto','テストです２９','クレジット確認');
-- 実行例（消すと決めた id だけ列挙）:
-- delete from public.remote_licenses where id in ('<id1>','<id2>');

-- ---------------------------------------------------------------------
-- STEP4｜「中野工務店」の二重登録を統合
--   現状2行: (pending/inactive/token無) と (standard/active/token有)。
--   ※中野工務店はオーナー(ナカノコウムテン)自身の会社。配布顧客ではないため、
--     オーナー用途なら remote_licenses 上の行は不要（syncRemoteLicense は tenant=1 で
--     早期returnし、そもそもリモート照合しない）。方針を選ぶ:
--
--   (A) オーナー自身なので2行とも削除する:
--       確認 → 実行
-- ---------------------------------------------------------------------
-- 確認:
select id, company_name, plan, active, claimed_at, created_at
from public.remote_licenses where company_name = '中野工務店' order by created_at;
-- ★決定(2026-07-04): オーナー自身の会社のため 2行とも削除する（オプションA）:
delete from public.remote_licenses where company_name = '中野工務店';
--
--   (参考) 1行だけ残す場合（残す id を KEEP、他を消す）:
-- delete from public.remote_licenses
--   where company_name = '中野工務店' and id <> '<残すid>';

-- ---------------------------------------------------------------------
-- STEP5｜掃除後の再確認（重複ゼロを保証）
-- ---------------------------------------------------------------------
select company_name, count(*)
from public.remote_licenses
group by company_name
having count(*) > 1;   -- 0件になれば同名重複は解消
