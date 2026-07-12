-- =====================================================================
-- 修正: learning_contributions の RLS 無効化を解消（2026-07-08 対応）
--
-- 背景:
--   - Supabase警告 rls_disabled_in_public の対象は learning_contributions。
--   - このテーブルは旧Render学習サーバー専用の永続化用（Renderは廃止済み）。
--   - 配布中アプリ(app/src)・Edge Functions は一切参照していない → 完全ロックで安全。
--
-- ★落とし穴:
--   migrationのポリシー "service_role_all" は FOR ALL USING(true) でロール指定が無く、
--   anon含む全ロールに全許可。RLSをONにするだけでは匿名アクセスが素通りになる。
--   → このポリシーを削除する（service_roleはRLSをバイパスするので不要）。
--
-- 実行場所: Supabase → SQL Editor（service_role）
-- =====================================================================

-- 1) RLS有効化
alter table public.learning_contributions enable row level security;

-- 2) 広すぎる(anon含む全許可)ポリシーを削除 → 匿名アクセスを完全遮断
drop policy if exists "service_role_all" on public.learning_contributions;

-- 3) 残存ポリシー確認（出力が空ならOK。anon向けが残っていたら同様にdrop）
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'learning_contributions';

-- 4) 最終確認（rowsecurity = true ならOK）
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'learning_contributions';
