# stripe-webhook の設置手順

カードの入金・解約を受けて、ライセンスを**自動で有効化／停止**する受け口です。
これを入れると「カードで払われた → 管理画面で手動承認」の1手が無くなります。

所要 10分ほど。**上から順にやってください。**

---

## 1. テーブルに列を1つ足す

Supabase の SQL Editor で1行流します。

```sql
ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS stripe_customer_id text;
CREATE INDEX IF NOT EXISTS remote_licenses_stripe_customer_id_idx
  ON remote_licenses (stripe_customer_id);
```

**なぜ要るか。** 会社名を聞けるのは決済画面の1回だけで、毎月の請求や解約の通知には
会社名が入っていません。そこで初回に「Stripeの顧客ID ↔ 会社」を控えておき、
2回目以降はそれで引きます。**Stripeに問い合わせないので、この受け口は
Stripeの秘密鍵を持たずに済みます**（漏れても課金・返金・顧客情報の取得はできない）。

既存の行は空のままで構いません。次に決済があった時点で自動的に埋まります。

## 2. Function を置く

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

**`--no-verify-jwt` を必ず付けてください。** StripeはJWTを付けて来ないので、
既定のままだと全部401で弾かれます。**Stripe側は「送信済み」と表示されるのに
何も起きない**、という一番わかりにくい詰まり方をします。

## 3. Stripe側でエンドポイントを作る

https://dashboard.stripe.com/acct_1ThIETLC2RqljG35/webhooks → 「エンドポイントを追加」

**URL**（そのまま貼れます）

```
https://slhgkedzlormaovwpadi.supabase.co/functions/v1/stripe-webhook
```

**選ぶイベントは次の4つだけです。**

| イベント | 起きること |
|---|---|
| `checkout.session.completed` | 初回の入金。プランを設定して**有効化**。行が無ければ作る |
| `invoice.paid` | 毎月の請求が通った。**単位を上限まで戻す**（月次リセット） |
| `invoice.payment_failed` | 支払い失敗。**止めずに**画面へ注意書きを出すだけ |
| `customer.subscription.deleted` | 解約。**停止**する |

**支払い失敗で止めないのは意図的です。** Stripeはこのあと数日かけて再試行します。
1回の失敗で止めると、カードの有効期限切れくらいで現場が使えなくなります。
本当に駄目なときは Stripe が購読を終了し、4つ目の通知が届いて停止されます。

## 4. 署名の秘密を登録する

エンドポイントを作ると `whsec_...` が表示されます。それを登録します。

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
```

`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` は自動で入るので不要です。

## 5. 動作を確かめる

Stripeのエンドポイント画面から `checkout.session.completed` をテスト送信します。

- **200 が返る** … 受け口は生きています
- **400 bad_signature** … 手順4の秘密が違う、または貼り間違い
- **401** … 手順2の `--no-verify-jwt` が抜けている

テスト送信は中身が空なので `skipped` と返りますが、それで正常です。
**本当の確認はテストモードで1件通してください。**
テストカード `4242 4242 4242 4242`（有効期限は未来の日付、CVCは任意の3桁）で
決済し、`remote_licenses` の該当行が `active=true`・プラン・単位まで
書き換わっていれば完了です。

ログは `supabase functions logs stripe-webhook` で見られます。
`[stripe-webhook] checkout.session.completed {"action":"activated",...}` と出ます。

---

## 金額とプランの対応

`index.ts` の `PLAN_BY_AMOUNT` が金額（円）でプランを決めています。
税別で登録しても税込で登録しても拾えるよう、両方の金額を並べてあります。

| 金額 | プラン | 単位 |
|---|---|---|
| 30,000 / 33,000 | スタンダード | 20 |
| 70,000 / 77,000 | ベター | 50 |
| 100,000 / 110,000 | プロ | 100 |

**★値段を変えたら、ここと `app/src/database/database.ts` の `PLANS`、
`SettingsPage.tsx` の `STRIPE_LINKS`、Stripeの決済リンクを、すべて揃えてください。**
表に無い金額が来たときは**何もしません**。近いプランへ寄せると、
少ない入金で上位プランが開いてしまうためです。その場合はログに残るので、
Stripeの画面で入金を確認して手動で承認してください。

## 会社名が一致しなかったとき

決済画面の**会社名**で `remote_licenses` を引いています。

- **見つからない** … その会社名で行を新しく作り、有効にします（LPから直接申し込むと起こります）
- **同じ会社名が複数ある** … **何もしません**。取り違えると別の会社のライセンスを
  書き換えてしまうためです。ログに残るので手動で承認してください
- **会社名が空** … 何もしません。決済リンクの会社名欄が「必須」になっているか確認してください
