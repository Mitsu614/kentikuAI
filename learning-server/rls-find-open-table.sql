-- =====================================================================
-- 緊急: Supabase警告 rls_disabled_in_public 対応
--   「publicにRLS無効のテーブルがある」= STEP1後に増えた/取りこぼした1テーブル。
--   既にRLS済み: remote_licenses / app_activity / estimate_feedback /
--               cost_coefficients / learning_contributions
--   → それ以外で rowsecurity=false のものが今回の犯人。
--
-- 実行場所: Supabase ダッシュボード → SQL Editor（service_role）
-- 手順: ①犯人を特定 → ②アプリが公開キー(anon)で使うか確認 → ③A/Bどちらかで修正
-- =====================================================================


-- ---------------------------------------------------------------------
-- ① 犯人を特定：public のテーブルでRLSが無効なものを洗い出す
-- ---------------------------------------------------------------------
select tablename, rowsecurity as rls_enabled
from pg_tables
where schemaname = 'public'
order by rowsecurity, tablename;   -- rls_enabled = false の行が今回の対象

-- （参考）各テーブルの既存ポリシーも確認
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
order by tablename, policyname;


-- =====================================================================
-- ② 修正：犯人テーブル名を <TABLE> に入れて、A か B を実行
--    判断基準 = 配布中アプリが「公開キー(anon)」でそのテーブルを読み書きするか？
--    （分からなければ、アプリのソースをテーブル名で検索して確認。
--      → 中野に「テーブル名」を伝えれば app/src を調べて A/B を判定します）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【A】アプリが anon で"使わない"テーブル（テレメトリ/管理/内部用など）
--     → RLS有効化のみ・ポリシー無し = service_role だけがアクセス可。最も安全。
--     警告は即解消。誰でも読み書き削除は不可になる。
-- ---------------------------------------------------------------------
-- alter table public.<TABLE> enable row level security;
-- （ポリシーを作らない＝anonは一切不可。service_roleはRLSをバイパスするので管理は可）


-- ---------------------------------------------------------------------
-- 【B】アプリが anon で"使う"テーブル（STEP1の他テーブルと同じ扱い）
--     → RLS有効化＋「アプリが実際にやる操作だけ」anonに許可。DELETEは付けない。
--     実際に使う操作(SELECT/INSERT/UPDATE)だけ残し、不要な行は消すこと。
-- ---------------------------------------------------------------------
-- alter table public.<TABLE> enable row level security;
--
-- drop policy if exists anon_select_<t> on public.<TABLE>;
-- create policy anon_select_<t> on public.<TABLE>
--   for select to anon using (true);
--
-- drop policy if exists anon_insert_<t> on public.<TABLE>;
-- create policy anon_insert_<t> on public.<TABLE>
--   for insert to anon with check (true);
--
-- drop policy if exists anon_update_<t> on public.<TABLE>;
-- create policy anon_update_<t> on public.<TABLE>
--   for update to anon using (true) with check (true);
-- -- DELETE ポリシーは作らない → anon は削除不可（顧客データ消去を防止）


-- ---------------------------------------------------------------------
-- ③ 修正後の確認：犯人が rls_enabled=true になったか
-- ---------------------------------------------------------------------
-- select tablename, rowsecurity from pg_tables
-- where schemaname='public' and rowsecurity = false;   -- 0件になればOK
