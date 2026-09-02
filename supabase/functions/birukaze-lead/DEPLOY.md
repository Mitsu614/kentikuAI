# birukaze-lead のデプロイ手順

公開中のビル風診断（`docs/birukaze/`）で、診断結果を出す前にうかがった
会社名・お名前・メールと、その方が入力した診断条件を運営あてに通知する関数。

**`send-mail` とは別にしてある。** `send-mail` は先頭でライセンストークンを
必ず解決し、無効なら 401 で弾く。公開ページの訪問者はトークンを持たないので
そもそも通せない。かといって `send-mail` にトークン不要の抜け道を足すと、
有償顧客向けの送信経路が誰でも叩ける口に変わってしまう。

## 1. シークレット

**追加作業は不要。** `send-mail` と同じシークレットをそのまま読む。

```
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / OWNER_EMAIL
MAIL_FROM / MAIL_FROM_NAME
```

まだ `send-mail` を設定していない場合は `../send-mail/DEPLOY.md` の手順を先に。

## 2. デプロイ

```bash
supabase functions deploy birukaze-lead --no-verify-jwt
```

Supabase CLI を入れていない場合は `npx` でも通る。

```bash
npx supabase functions deploy birukaze-lead --no-verify-jwt
```

⚠️ **`--no-verify-jwt` は必須。** これを付けないと呼び出しに JWT が要り、
anon キーを公開ページのソースに埋め込む羽目になる。この関数は
「ライセンスを持たない一般の訪問者から呼ばれる」ことが前提なので、
認証は掛けず、下記の対策で守る。

## 3. 関数のURLを画面側に設定

デプロイすると次の形のURLが発行される。

```
https://<PROJECT>.supabase.co/functions/v1/birukaze-lead
```

これを `docs/birukaze/index.html` の先頭付近にある `LEAD.endpoint` に貼る。

```js
const LEAD = {
  endpoint: "",   // ← ここに貼る
  ...
};
```

**空のままなら登録フォームは一切出ない。** 診断はいまと同じく、誰でも
最後まで無料で使える状態のままになる。URLを入れた時点でフォームが有効になる。

## 4. 動作確認

```bash
curl -X POST 'https://<PROJECT>.supabase.co/functions/v1/birukaze-lead' \
  -H "Origin: https://mitsu614.github.io" \
  -H "Content-Type: application/json" \
  -d '{"company":"テスト建設","name":"中野 太郎","email":"test@example.com","summary":"高さ60m 幅40m 奥行20m / 村上ランク3"}'
```

`{"ok":true}` が返り、`OWNER_EMAIL` に届けば成功。

**件名が「【ビル風診断】テスト建設 様から利用登録」と読めるか必ず目視する。**
`=?utf-8?Q?=e3=80=90...` と生で出ていたらヘッダーエンコードが壊れている
（`send-mail/DEPLOY.md` の「既知の落とし穴」を参照）。

**返信先（Reply-To）がご本人のアドレスになっているかも確認する。** 届いたメールに
そのまま返信すれば見込み客へ返せる、という意図で `replyTo` を指定してある。
ただし denomailer 側の対応を実地で確認できていないため、初回のテスト送信で
返信ボタンを押し、宛先が `test@example.com` になるかを見ておくこと。
なっていなければ `index.ts` の `replyTo` の行を消して、本文中のメールアドレスを
手でコピーする運用に切り替えればよい（送信自体には影響しない）。

## 悪用対策として入れてあるもの

| 対策 | 内容 |
|---|---|
| Origin 制限 | `mitsu614.github.io` と `kentiku-boost.jp` 以外からの POST は 403 |
| ハニーポット | 画面に出ない `website` 項目が埋まっていたら bot と見なし、200 を返して黙って捨てる |
| レート制限 | 同一IPから1時間に5件まで。超えたら 429 |
| 入力長の上限 | 会社名120 / 氏名80 / メール200 / 要望400 / 診断要約4000 文字で切り捨て |
| ヘッダー注入対策 | 件名に入る会社名から改行を除去 |
| 宛先の固定 | 送信先は `OWNER_EMAIL` のみ。**任意の宛先には送れない**（踏み台にされない） |

⚠️ **レート制限は best effort。** Edge Function のインスタンスは使い回されるが
永続はしないため、「同じインスタンスに連続で当たった場合だけ効く」。
フォームの連打とナイーブな bot は落ちるが、本気の攻撃は止まらない。
恒久的に止めたくなったらテーブルに記録して IP 単位で数えること。

## 独自ドメインに移すとき

`kentiku-boost.jp` が開通したら、`index.ts` の `ALLOWED_ORIGINS` は既に
対応済みなので**関数側の変更は不要**。画面側のURLだけ差し替える。
