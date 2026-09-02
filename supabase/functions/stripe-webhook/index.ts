// Supabase Edge Function: stripe-webhook
// 役割: Stripeの入金・解約を受けて remote_licenses を自動で有効化／停止する。
//       いままで「カードで払われた → 中野さんが管理画面で手動承認」だった1手を無くす。
//
// ★このFunctionは Stripeの秘密鍵を持たない。
//   持つのは署名検証用の STRIPE_WEBHOOK_SECRET だけで、これは「Stripeから来た本物か」を
//   確かめることしかできない。万一漏れても、これで課金・返金・顧客情報の取得はできない。
//   そのため、後続イベント（毎月の請求・解約）と会社を結ぶ紐は
//   Stripeに問い合わせず、こちら側の remote_licenses.stripe_customer_id に持つ。
//
// 事前に一度だけ必要（DEPLOY.md 参照）:
//   ALTER TABLE remote_licenses ADD COLUMN IF NOT EXISTS stripe_customer_id text;
//
// シークレット:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY … 自動
//   - STRIPE_WEBHOOK_SECRET … Stripeのエンドポイント作成時に出る whsec_...
//
// ★デプロイは必ず --no-verify-jwt を付けること。
//   StripeはJWTを付けて来ないので、既定のままだと全部401で弾かれ、
//   「Stripe側は送っているのに何も起きない」状態になる。

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";

const H = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

// 金額（円）→ プラン。日本円は小数を持たないので amount はそのまま円。
// 税別で登録しても税込で登録しても拾えるよう、両方の金額を並べてある。
// ★プランの値段を変えたらここも直すこと。合わない金額は「不明」として何もしない
//   （勝手に近いプランへ寄せると、少ない入金で上位プランが開いてしまう）。
const PLAN_BY_AMOUNT: Record<string, { plan: string; credits: number }> = {
  "30000": { plan: "standard", credits: 20 },
  "33000": { plan: "standard", credits: 20 },
  "70000": { plan: "better", credits: 50 },
  "77000": { plan: "better", credits: 50 },
  "100000": { plan: "pro", credits: 100 },
  "110000": { plan: "pro", credits: 100 },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sbGet(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) throw new Error(`get ${res.status}: ${await res.text()}`);
  return res.json();
}
async function sbPatch(path: string, body: unknown): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patch ${res.status}: ${await res.text()}`);
  return res.json();
}
async function sbInsert(body: unknown): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/remote_licenses`, {
    method: "POST",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`insert ${res.status}: ${await res.text()}`);
  return res.json();
}

function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function normalizeName(s: string): string {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// 長さで抜けないよう、必ず全桁を比べてから結果を返す
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stripe-Signature ヘッダの検証。
// 署名は「タイムスタンプ.生のリクエストボディ」に対するHMAC-SHA256。
// ★ボディはパースする前の文字列でなければならない。JSONを一度オブジェクトにして
//   詰め直すと、キーの順や空白が変わって署名が合わなくなる。
async function verifySignature(raw: string, header: string): Promise<{ ok: boolean; why?: string }> {
  if (!WEBHOOK_SECRET) return { ok: false, why: "STRIPE_WEBHOOK_SECRET 未設定" };
  const t = /(?:^|,)\s*t=(\d+)/.exec(header || "")?.[1];
  const sigs = [...(header || "").matchAll(/v1=([a-f0-9]+)/g)].map((m) => m[1]);
  if (!t || !sigs.length) return { ok: false, why: "署名ヘッダの形式が不正" };

  // 古い署名の使い回し（リプレイ）を防ぐ。5分を超えたものは受けない。
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (ageSec > 300) return { ok: false, why: `署名が古い(${ageSec}秒前)` };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`));
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => timingSafeEqual(s, expected))
    ? { ok: true }
    : { ok: false, why: "署名が一致しない" };
}

// 決済画面で入れてもらった会社名を取り出す。
// リンク作成時のラベル表記に幅があるので、何段か当てにいく。
function companyFromSession(s: any): string {
  const fields: any[] = Array.isArray(s?.custom_fields) ? s.custom_fields : [];
  for (const f of fields) {
    const label = String(f?.label?.custom || f?.key || "");
    if (/会社|社名|company/i.test(label)) {
      const v = f?.text?.value ?? f?.dropdown?.value ?? f?.numeric?.value;
      if (v) return normalizeName(String(v));
    }
  }
  // ラベルが想定と違っても、自由入力欄が1つだけならそれを会社名とみなす
  const texts = fields.filter((f) => f?.text?.value);
  if (texts.length === 1) return normalizeName(String(texts[0].text.value));
  return normalizeName(String(s?.customer_details?.name || ""));
}

async function findByCustomer(customerId: string): Promise<any | null> {
  if (!customerId) return null;
  const rows = await sbGet(
    `remote_licenses?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id,company_name,plan,credits,max_credits,active,license_token`,
  );
  return rows[0] || null;
}

async function findByCompany(company: string): Promise<{ row: any | null; ambiguous: boolean }> {
  if (!company) return { row: null, ambiguous: false };
  const rows = await sbGet(
    `remote_licenses?company_name=eq.${encodeURIComponent(company)}&select=id,company_name,plan,credits,max_credits,active,license_token`,
  );
  // 同名が複数あるときは選ばない。取り違えると別の会社のライセンスを書き換えてしまう。
  if (rows.length > 1) return { row: null, ambiguous: true };
  return { row: rows[0] || null, ambiguous: false };
}

// ── 入金（初回）: 有効化する ──
async function onCheckoutCompleted(s: any) {
  if (s?.mode && s.mode !== "subscription") {
    return { skipped: `mode=${s.mode}（継続課金でない）` };
  }
  const customerId = String(s?.customer || "");
  const company = companyFromSession(s);
  const yen = Number(s?.amount_total ?? 0);
  const mapped = PLAN_BY_AMOUNT[String(yen)];
  if (!mapped) return { skipped: `金額 ${yen} 円に対応するプランが無い`, company };

  // すでに顧客IDで結び付いていればそれを優先。無ければ会社名で引く。
  let row = await findByCustomer(customerId);
  let ambiguous = false;
  if (!row) ({ row, ambiguous } = await findByCompany(company));
  if (ambiguous) return { skipped: `会社名「${company}」が複数あり特定できない`, company };

  const patch: any = {
    plan: mapped.plan,
    credits: mapped.credits,
    max_credits: mapped.credits,
    active: true,
    blocked_message: null,
    stripe_customer_id: customerId || null,
    updated_at: new Date().toISOString(),
  };

  if (row) {
    // トークンが無い行（申請だけで承認前など）はここで発行し、アプリが取りに行けるようにする
    if (!row.license_token) {
      patch.license_token = newToken();
      patch.claimed_at = null;
    }
    await sbPatch(`remote_licenses?id=eq.${encodeURIComponent(row.id)}`, patch);
    return { action: "activated", company: row.company_name, plan: mapped.plan, credits: mapped.credits };
  }

  // アプリに登録する前に決済されることがある（LPから直接申し込むと起こる）。
  // 入金は済んでいるので、こちらで行を作って有効にしておく。
  if (!company) return { skipped: "会社名が取れず、既存の行も無い" };
  await sbInsert({
    id: "stp_" + newToken().slice(0, 12),
    company_name: company,
    license_token: newToken(),
    created_at: new Date().toISOString(),
    ...patch,
  });
  return { action: "created", company, plan: mapped.plan, credits: mapped.credits };
}

// ── 毎月の請求が通った: 単位を戻す ──
async function onInvoicePaid(inv: any) {
  const customerId = String(inv?.customer || "");
  const row = await findByCustomer(customerId);
  if (!row) return { skipped: `顧客 ${customerId} に対応する行が無い（初回は checkout 側で処理される）` };

  const yen = Number(inv?.amount_paid ?? 0);
  const mapped = PLAN_BY_AMOUNT[String(yen)];
  // 金額が既知ならプランごと合わせ直す（途中でプランを変えた場合に追随できる）。
  // 不明な金額のときは、いまのプランのまま単位だけ戻す。
  const credits = mapped ? mapped.credits : Number(row.max_credits ?? 0);
  const patch: any = {
    credits,
    max_credits: credits,
    active: true,
    blocked_message: null,
    updated_at: new Date().toISOString(),
  };
  if (mapped) patch.plan = mapped.plan;
  await sbPatch(`remote_licenses?id=eq.${encodeURIComponent(row.id)}`, patch);
  return { action: "renewed", company: row.company_name, credits };
}

// ── 支払いに失敗した: 止めずに知らせるだけ ──
//    Stripeはこのあと数日かけて再試行する。1回の失敗で止めると、
//    カードの有効期限切れくらいで現場が使えなくなってしまう。
//    本当に駄目なときは Stripe が購読を終了し、下の deleted が飛んでくる。
async function onPaymentFailed(inv: any) {
  const row = await findByCustomer(String(inv?.customer || ""));
  if (!row) return { skipped: "対応する行が無い" };
  await sbPatch(`remote_licenses?id=eq.${encodeURIComponent(row.id)}`, {
    blocked_message: "カードのお支払いが確認できませんでした。カード情報をご確認ください（ご利用は継続できます）。",
    updated_at: new Date().toISOString(),
  });
  return { action: "warned", company: row.company_name };
}

// ── 解約された: 止める ──
async function onSubscriptionDeleted(sub: any) {
  const row = await findByCustomer(String(sub?.customer || ""));
  if (!row) return { skipped: "対応する行が無い" };
  await sbPatch(`remote_licenses?id=eq.${encodeURIComponent(row.id)}`, {
    active: false,
    blocked_message: "ご契約が終了しています。再開をご希望の場合はご連絡ください。",
    updated_at: new Date().toISOString(),
  });
  return { action: "deactivated", company: row.company_name };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ★署名検証のため、パースする前の生の文字列を取る
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") || "";
  const v = await verifySignature(raw, sig);
  if (!v.ok) {
    console.error("[stripe-webhook] 署名NG:", v.why);
    return json({ error: "bad_signature" }, 400);
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const type = String(event?.type || "");
  const obj = event?.data?.object ?? {};
  try {
    let result: any;
    switch (type) {
      case "checkout.session.completed": result = await onCheckoutCompleted(obj); break;
      case "invoice.paid":               result = await onInvoicePaid(obj); break;
      case "invoice.payment_failed":     result = await onPaymentFailed(obj); break;
      case "customer.subscription.deleted": result = await onSubscriptionDeleted(obj); break;
      default: result = { ignored: type };
    }
    console.log(`[stripe-webhook] ${type}`, JSON.stringify(result));
    return json({ received: true, ...result });
  } catch (e) {
    // ★500を返すと Stripe が再送してくれる。取りこぼしを残さないため、
    //   こちらの落ち度（DB接続など）のときは素直に失敗を返す。
    console.error(`[stripe-webhook] ${type} 失敗:`, String(e));
    return json({ error: String(e) }, 500);
  }
});
