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
- ⚠️ **`MAIL_FROM_NAME` は文字化けしやすい。** PowerShell から `supabase secrets set` すると
  コンソールの文字コード次第で日本語の末尾が壊れ、差出人名が「建築ブース□□□」になる。
  実際に一度これが起きている。**設定後は必ずテスト送信して差出人名を目視確認する**こと。
  化けた値が入っていた場合、関数側で検知して既定値「建築ブースト」に戻す実装にはしてあるが、
  そもそも設定しない（省略して既定値に任せる）のがいちばん安全。
- Google Workspace に移行したら `SMTP_USER` / `SMTP_PASS` / `OWNER_EMAIL` を
  `info@kentiku-boost.jp` 系に差し替える（アプリの再ビルドは不要）。ただし **先に下の DNS を済ませること**

### ⚠️ 独自ドメインに差し替える前に、DNS を先に整えること

2026-08-27 時点の実測: `kentiku-boost.jp` には **MX も SPF も DMARC も無い**。
この状態で `SMTP_USER` だけ `info@kentiku-boost.jp` に変えると、差出人のドメインに送信認証が
何も無いまま送ることになり、**Gmail・携帯キャリア宛がまとめて迷惑メール行き**になる。
学習完了メールもライセンス通知も「送ったのに届かない」形で失敗し、しかもこちらからは気づけない。

順番は必ず DNS が先。

1. Google Workspace 側でドメインを追加し、指示された **MX** を設定
2. **SPF** を TXT に追加 … `v=spf1 include:_spf.google.com ~all`
3. **DKIM** を Workspace 管理コンソールで生成し、指示された TXT を追加（鍵長2048bit）
4. **DMARC** を TXT に追加 … `_dmarc.kentiku-boost.jp` に
   `v=DMARC1; p=none; rua=mailto:（レポート受信先）` から始め、様子を見て `p=quarantine` へ上げる
5. ここまで済ませてから `SMTP_USER` / `SMTP_PASS` / `OWNER_EMAIL` を差し替え、**テスト送信して着信を確認**

確認コマンド（どれも値が返れば設定済み）:

```bash
nslookup -type=MX kentiku-boost.jp 8.8.8.8
nslookup -type=TXT kentiku-boost.jp 8.8.8.8          # v=spf1 が返るか
nslookup -type=TXT _dmarc.kentiku-boost.jp 8.8.8.8   # v=DMARC1 が返るか
```

なお `nakanokoumuten.com`（Xserver）にも DMARC が無い。こちらは SPF はあるので即死はしないが、
なりすまし対策としては入れておいた方がよい。


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

**日本語の件名で必ず確認すること。** 受信したメールの件名が

- ✅ 「【月次レポート送信】…」と読める → 正常
- ❌ 「=?utf-8?Q?=e3=80=90…」と生で見える → ヘッダーエンコードが壊れている

```bash
-d '{"token":"<LICENSE_TOKEN>","subject":"【月次レポート送信】中野工務店 — 0件利用","text":"件名の文字化けテスト"}'
```

差出人名も併せて「建築ブースト」と表示されるか目視する。

## 既知の落とし穴：denomailer のヘッダーエンコード

送信に使っている `denomailer@1.6.0` は、**日本語の件名を正しくエンコードできない**。
`quotedPrintableEncodeInline()` が「本文用」のQPエンコーダ（74文字ごとに `=\r\n` を挿入）で
ヘッダーを包むため、RFC 2047 が禁じている「encoded-word 内部の改行」が発生する。
加えて折り返しの最終断片で `=` が1〜2文字欠落するバグもある（issue #90／2023年以降ほぼ未メンテ）。

→ **対策として、件名は `index.ts` の `encodeHeaderWord()` で自前に Base64 encoded-word 化している。**
先頭に半角空白を1つ置いて denomailer の再エンコード判定（非ASCIIを含む／`=?` で始まる）を外し、
そのままヘッダーへ通す仕組み。**この先頭空白を「無駄」と思って消すと、件名の文字化けが再発する。**

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
