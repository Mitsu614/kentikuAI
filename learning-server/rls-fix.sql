-- =====================================================================
-- RLS 有効化＆ポリシー設定（Supabase 警告 rls_disabled_in_public 対応）
-- 対象: public スキーマの全テーブル
--   estimate_feedback / cost_coefficients / remote_licenses / app_activity / credit_log
--   （learning_contributions は既にRLS有効のため対象外）
--
-- 使い方: Supabase ダッシュボード → SQL Editor に貼り付けて Run
-- 方針(STEP1): 配布中アプリを止めず、最悪の「誰でも全削除／盗み見」を即遮断する。
--   - anon(公開キー) には「いまアプリが実際に行う操作」だけ許可
--   - service_role(サーバー/管理) は RLS を常にバイパス（=管理ダッシュボードは
--     service_role キーで動かすこと。後述）
--
-- 【重要・残存リスク】本SQLだけでは「公開キーでのライセンス発行/更新・係数更新・
--   実績投函」は塞げない（配布アプリがその操作を公開キーで行っているため）。
--   これらは STEP2/3 で Edge Function（秘密鍵）へ移して初めて塞がる。
-- =====================================================================


-- ---------------------------------------------------------------------
-- remote_licenses : ★最重要★ ライセンス/課金の根幹
--   アプリ(anon)の動作 = SELECT(認証/一覧) + INSERT(自動登録) + UPDATE(クレジット/状態)
--   → SELECT/INSERT/UPDATE 許可。DELETE は anon 不可（削除は管理者=service_roleのみ）。
-- ---------------------------------------------------------------------
alter table public.remote_licenses enable row level security;

drop policy if exists anon_select_licenses on public.remote_licenses;
create policy anon_select_licenses on public.remote_licenses
  for select to anon using (true);

drop policy if exists anon_insert_licenses on public.remote_licenses;
create policy anon_insert_licenses on public.remote_licenses
  for insert to anon with check (true);

drop policy if exists anon_update_licenses on public.remote_licenses;
create policy anon_update_licenses on public.remote_licenses
  for update to anon using (true) with check (true);
-- DELETE ポリシー無し → anon は削除不可（有料顧客のライセンス消去を防止）


-- ---------------------------------------------------------------------
-- app_activity : 利用テレメトリ。アプリ(anon)の動作 = INSERT のみ
--   → INSERT だけ許可。閲覧は管理ダッシュボード(service_role)で行う。
-- ---------------------------------------------------------------------
alter table public.app_activity enable row level security;

drop policy if exists anon_insert_activity on public.app_activity;
create policy anon_insert_activity on public.app_activity
  for insert to anon with check (true);
-- SELECT/UPDATE/DELETE ポリシー無し → anon は閲覧・改ざん・削除 不可


-- ---------------------------------------------------------------------
-- credit_log : public スキーマに存在しないため対象外（anon GET が 404 を返す）。
--   もし別名で存在する場合は、その名前で同様に RLS を有効化すること。
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- estimate_feedback : 匿名化された実績の投函箱
--   アプリ(anon)の動作 = INSERT(送信) + SELECT(クライアント側分析で全件読取 ※STEP2で廃止)
--   → STEP1では INSERT/SELECT 許可。UPDATE/DELETE は anon 不可。
-- ---------------------------------------------------------------------
alter table public.estimate_feedback enable row level security;

drop policy if exists anon_insert_feedback on public.estimate_feedback;
create policy anon_insert_feedback on public.estimate_feedback
  for insert to anon with check (true);

drop policy if exists anon_select_feedback on public.estimate_feedback;
create policy anon_select_feedback on public.estimate_feedback
  for select to anon using (true);


-- ---------------------------------------------------------------------
-- cost_coefficients : 見積補正係数
--   アプリ(anon)の動作 = SELECT(取得) + upsert(INSERT/UPDATE) ※STEP2で書込はEdge Funcへ
--   → STEP1では SELECT/INSERT/UPDATE 許可。DELETE は anon 不可。
-- ---------------------------------------------------------------------
alter table public.cost_coefficients enable row level security;

drop policy if exists anon_select_coeff on public.cost_coefficients;
create policy anon_select_coeff on public.cost_coefficients
  for select to anon using (true);

drop policy if exists anon_insert_coeff on public.cost_coefficients;
create policy anon_insert_coeff on public.cost_coefficients
  for insert to anon with check (true);

drop policy if exists anon_update_coeff on public.cost_coefficients;
create policy anon_update_coeff on public.cost_coefficients
  for update to anon using (true) with check (true);


-- =====================================================================
-- STEP1 実行後の状態:
--   ✅ 誰でも「全削除」 → 不可（特に remote_licenses / 各テーブルの DELETE 遮断）
--   ✅ credit_log / app_activity の盗み見 → 不可
--   ✅ Supabase「Table publicly accessible」警告 → 解消
--   ✅ 配布中アプリ（認証・自動登録・クレジット更新・学習ループ）→ そのまま動作
--   ⚠️ 公開キーでのライセンス発行/更新・係数更新・実績投函 → STEP2/3で対応
--
-- ※ 管理ダッシュボード(admin-dashboard)は anon キーのままだと、本SQL後に
--   DELETE / credit_log・app_activity の閲覧が効かなくなる。
--   → ダッシュボードを service_role キーで動かすよう変更すること
--     （管理者専用ツール。service_role キーはコードに固定せず、起動時に貼る運用）。
-- =====================================================================
