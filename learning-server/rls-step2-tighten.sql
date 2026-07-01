-- =====================================================================
-- STEP2 仕上げ: 係数更新を Edge Function に移したあとの RLS 厳格化
--
-- ★実行タイミング厳守★
--   このSQLは「Edge Function(update-coefficients)をデプロイし、かつ
--   それを呼ぶ新バージョンのアプリが顧客に行き渡ったあと」に実行すること。
--   先に実行すると、旧バージョンのアプリ（クライアント側で係数計算する版）の
--   学習更新が止まる（※認証や見積もり自体は止まらない。学習だけ更新されなくなる）。
--
-- これで閉じるもの:
--   ✅ 公開キーでの「係数の書き換え（汚染）」→ 不可（書込はEdge Function=service_roleのみ）
--   ✅ 公開キーでの「全実績の閲覧」→ 不可（分析はサーバー側に移行済み）
-- 残すもの:
--   ・estimate_feedback への INSERT（アプリが実績を投函する）
--   ・cost_coefficients の SELECT（アプリが係数を取得して見積もりに使う）
-- =====================================================================

-- estimate_feedback: 投函(INSERT)だけ残し、全件閲覧(SELECT)を停止
drop policy if exists anon_select_feedback on public.estimate_feedback;
-- anon_insert_feedback はそのまま維持

-- cost_coefficients: 取得(SELECT)だけ残し、書き込み(INSERT/UPDATE)を停止
drop policy if exists anon_insert_coeff on public.cost_coefficients;
drop policy if exists anon_update_coeff on public.cost_coefficients;
-- anon_select_coeff はそのまま維持

-- =====================================================================
-- 実行後の anon(公開キー) 権限まとめ:
--   estimate_feedback  : INSERT のみ（投函箱）
--   cost_coefficients  : SELECT のみ（読むだけ）
--   app_activity       : INSERT のみ
--   remote_licenses    : SELECT/INSERT/UPDATE（★STEP3で要対応：偽造発行がまだ可能）
-- =====================================================================
