# update-coefficients Edge Function デプロイ手順

> プロジェクトルート（`kentikuAI` フォルダ）で実行する。Docker は不要（deploy はアップロードのみ）。
> このセッションで実行するなら各行の先頭に `!` を付けて打つ（ログインは対話式なので特に）。

## 1. Supabase CLI にログイン（対話・ブラウザが開く）
```
npx supabase login
```

## 2. プロジェクトにリンク
```
npx supabase link --project-ref slhgkedzlormaovwpadi
```

## 3. シークレットを設定（サーバー側だけが持つ）
```
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-あなたのキー
```
（任意・乱用抑止したい場合）
```
npx supabase secrets set FUNCTION_SECRET=好きなランダム文字列
```
※ FUNCTION_SECRET を設定した場合は、アプリ側の呼び出しヘッダにも同じ値を
   `x-function-secret` として付ける必要がある（現状アプリは未送信なので、
   まずは FUNCTION_SECRET を設定しない＝未検証で運用するのが簡単）。

## 4. デプロイ
```
npx supabase functions deploy update-coefficients --no-verify-jwt
```
`--no-verify-jwt`：配布アプリが公開キーで呼べるようにする。
（関数内部は service_role を使うので、外部から係数を“注入”はできない＝安全）

## 5. 動作確認（公開キーで叩いてみる）
```
curl -i -X POST "https://slhgkedzlormaovwpadi.supabase.co/functions/v1/update-coefficients" \
  -H "apikey: sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e" \
  -H "Authorization: Bearer sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e"
```
→ `{"updated":N,"feedback":M}` が返ればOK。

## 6. アプリを新バージョンでリリース
- `analyzeAndUpdateCoefficients` が Edge Function を呼ぶ版（このコミット）を含める
- CURRENT_VERSION と package.json を上げて Release 作成（通常のアップデート手順）

## 7. 新バージョンが行き渡ったら、最後に RLS を締める
- `learning-server/rls-step2-tighten.sql` を Supabase SQL Editor で実行
- これで公開キーでの「係数書き換え」「実績の全件閲覧」が不可になる
