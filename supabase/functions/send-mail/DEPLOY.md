# send-mail のデプロイ手順

通知メールの送信をアプリからサーバー側へ移すための Edge Function。
**SMTPのパスワードと運営あての宛先アドレスは、ここのシークレットにしか置かない。**
（以前は main.ts に直書きしていたため、公開リポジトリからも配布アプリからも取り出せる状態だった）

## 1. シークレットを設定

```bash
supabase secrets set \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=465 \
  SMTP_USER='送信に使うアドレス' \
  SMTP_PASS='アプリパスワード（新しく発行したもの）' \
  OWNER_EMAIL='運営あて通知の受信先' \
  MAIL_FROM_NAME='建築ブースト'
```

- `MAIL_FROM` を省略すると `SMTP_USER` が差出人になる
- `OWNER_EMAIL` を省略すると `SMTP_USER` に届く
- Google Workspace に移行したら `SMTP_USER` / `SMTP_PASS` / `OWNER_EMAIL` を
  `info@kentiku-boost.jp` 系に差し替えるだけでよい（アプリの再ビルドは不要）

## 2. デプロイ

```bash
supabase functions deploy send-mail
```

## 3. 動作確認

有効なライセンストークンが要る（アプリの `api-config.json` の `licenseToken`）。

```bash
curl -X POST 'https://<PROJECT>.supabase.co/functions/v1/send-mail' \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"token":"<LICENSE_TOKEN>","subject":"テスト","text":"送信テスト"}'
```

`{"ok":true,"sent":1,...}` が返り、`OWNER_EMAIL` に届けば成功。

## 呼び出し仕様

```
POST { token, subject, text, toOwner?, alsoTo?, attachments? }
```

| 項目 | 説明 |
|---|---|
| `token` | ライセンストークン。無効なら 401。**発信者の確認はこれだけ**なので、漏れたライセンスは止めれば送信も止まる |
| `toOwner` | 既定 true。運営(`OWNER_EMAIL`)を宛先に含める。クライアントは運営アドレスを知らないし指定もできない |
| `alsoTo` | 顧客など追加の宛先。**最大3件**。無関係な相手への一斉送信に使えないよう上限を設けている |
| `attachments` | `[{filename, contentBase64}]`。合計 **8MB** を超えた分は捨てて本文だけ送る |

## 注意

- この関数を止めると、アプリからの通知メール（利用通知・申込・学習完了・月次レポート等）が
  すべて止まる。逆に言えば、**送信を止めたいときはここを止めれば全部止まる**
- 送信元アカウントのパスワードを変えたら、`supabase secrets set SMTP_PASS=...` と
  `supabase functions deploy send-mail` の2つが要る（アプリ側の対応は不要）
