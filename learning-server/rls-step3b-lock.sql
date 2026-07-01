-- =====================================================================
-- STEP3-b（最終ロック）: remote_licenses への公開キー(anon)アクセスを全停止
--
-- ★★★ 実行前チェックリスト（すべて済んでから実行）★★★
--   [ ] license Edge Function をデプロイ済み（verify/consume/claim/register/admin）
--   [ ] ADMIN_SECRET を Supabase secret に設定済み（承認/却下に必要）
--   [ ] トークン方式の新バージョンアプリをリリースし、既存顧客に行き渡った
--       （各アプリが claim で自分のトークンを取得済み ＝ remote_licenses.claimed_at が埋まっている）
--   [ ] オーナーのアプリで adminSecret を設定済み（承認/却下UI用）
--   [ ] 管理者用クレジット調整（main.ts の fetchLicenseByName 使用箇所）を
--       admin アクション経由に付け替え済み、または使わないと決めた
--   [ ] 管理ダッシュボードを service_role キーで動かすよう変更済み
--
-- ⚠️ 上が未完了のまま実行すると、有料顧客の認証や管理機能が止まる。必ず確認してから。
--
-- 移行状況の確認（unclaimed が 0 になっていれば全員移行済み）:
--   select count(*) filter (where claimed_at is null) as unclaimed,
--          count(*) as total
--   from public.remote_licenses;
-- =====================================================================

-- 公開キー(anon)の remote_licenses への全ポリシーを削除 → anon は一切アクセス不可に
drop policy if exists anon_select_licenses on public.remote_licenses;
drop policy if exists anon_insert_licenses on public.remote_licenses;
drop policy if exists anon_update_licenses on public.remote_licenses;

-- これ以降、remote_licenses に触れるのは Edge Function(service_role)だけ。
-- 公開キーでのライセンス閲覧・偽造発行・改ざんは完全に不可能になる。

-- =====================================================================
-- 実行後の anon(公開キー) 権限まとめ（最終形）:
--   remote_licenses   : なし（全操作 license 関数経由）
--   estimate_feedback : INSERT のみ
--   cost_coefficients : SELECT のみ
--   app_activity      : INSERT のみ
-- =====================================================================
