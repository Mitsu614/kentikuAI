// Supabase Edge Function: license
// 役割: ライセンスの発行・確認・クレジット消費・移行(claim)・管理を、すべてサーバー側(service_role)で行う。
//       公開キーは remote_licenses に一切触れない。本人確認は「秘密トークン」で行う。
//
// 呼び出し: POST JSON { action: "verify"|"demo_start"|"demo_verify"|"register"|"consume"|"claim"|"admin", ... }
//
// シークレット:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY … 自動
//   - ADMIN_SECRET … admin アクション用（未設定なら admin は無効）

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") || "";

// プランごとの既定のAI利用単位。アプリの PLANS（app/src/database/database.ts）と揃えること。
// ★アプリの承認画面は credits を渡さずプラン名だけ送るので、ここが古いと
//   手動で承認したお客様だけ単位が合わなくなる。
//   2026-09-02の月額改定で demo30/pro200/その他50 から変更した。
const DEFAULT_CREDITS: Record<string, number> = {
  demo: 10,
  trial: 10,
  standard: 20,
  better: 50,
  pro: 100,
  enterprise: 9999,
};

// ── セルフサービスのデモ ──────────────────────────────────────────────
// 承認制をやめ、メールに届く番号を入れたらその場で始められるようにした。
// そのぶん「同じ会社が名前を変えて何度でも取る」をサーバーで止める必要がある。
const DEMO_DAYS = 30;                 // アプリの DEMO_PERIOD_DAYS と揃えること
const VERIFY_TTL_MIN = 30;            // 確認番号の有効時間
const VERIFY_MAX_ATTEMPTS = 5;        // 番号の入力ミス上限（総当り防止）

// フリーメールのドメイン。ここは「会社ドメインが同じ＝同じ会社」の判定から外す。
// （gmail同士を同じ会社と見なしたら、無関係な工務店が巻き添えで断られる）
const FREE_MAIL_DOMAINS = new Set([
"gmail.com", "googlemail.com", "yahoo.co.jp", "yahoo.com", "ymail.ne.jp",
"outlook.com", "outlook.jp", "hotmail.com", "hotmail.co.jp", "live.jp",
"icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
"docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp", "i.softbank.jp",
"nifty.com", "so-net.ne.jp", "ocn.ne.jp", "biglobe.ne.jp", "excite.co.jp",
"plala.or.jp", "jcom.home.ne.jp", "ybb.ne.jp", "msn.com", "zoho.com",
]);

const H = {
apikey: SERVICE_ROLE,
Authorization: `Bearer ${SERVICE_ROLE}`,
"Content-Type": "application/json",
};
const CORS = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Headers": "authorization, apikey, content-type",
"Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
return new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", ...CORS },
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
async function sbInsert(body: unknown, table = "remote_licenses"): Promise<any[]> {
const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
  method: "POST",
  headers: { ...H, Prefer: "return=representation" },
  body: JSON.stringify(body),
});
if (!res.ok) throw new Error(`insert ${res.status}: ${await res.text()}`);
return res.json();
}

async function sbRpc(fn: string, args: unknown): Promise<any> {
const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
  method: "POST",
  headers: { ...H },
  body: JSON.stringify(args),
});
if (!res.ok) throw new Error(`rpc ${res.status}: ${await res.text()}`);
return res.json();
}

// トークン生成（推測不可能・64桁hex）
function newToken(): string {
const b = new Uint8Array(32);
crypto.getRandomValues(b);
return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// 人が読める参加コード（8桁・紛らわしい 0/O/1/I を除外）。中野さんが会社へ伝える用。
function shortCode(): string {
const cs = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const b = new Uint8Array(8);
crypto.getRandomValues(b);
return Array.from(b).map((x) => cs[x % cs.length]).join("");
}

// トークン → ライセンス行を解決する。
//   1) license_seats.device_token（マルチシートの端末トークン）→ 親ライセンス
//   2) 無ければ remote_licenses.license_token 直参照（後方互換：単独利用の既存顧客）
async function resolveLicense(token: string): Promise<any | null> {
const seats = await sbGet(
  `license_seats?device_token=eq.${encodeURIComponent(token)}&select=license_id`,
).catch(() => []);
if (seats.length) {
  const lic = await sbGet(
    `remote_licenses?id=eq.${encodeURIComponent(seats[0].license_id)}&select=id,active,plan,credits,max_credits,blocked_message,license_token,expires_at`,
  );
  return lic[0] || null;
}
const lic = await sbGet(
  `remote_licenses?license_token=eq.${encodeURIComponent(token)}&select=id,active,plan,credits,max_credits,blocked_message,license_token,expires_at`,
);
return lic[0] || null;
}

// 会社名の正規化（前後空白除去＋連続空白を1つに）。重複行・表記ゆれの汚染を減らす。
function normalizeName(s: string): string {
return String(s || "").replace(/\s+/g, " ").trim();
}

// 同一性を見るための鍵。表示用の company_name とは別に持つ。
//   「株式会社中野工務店」「(株)中野工務店」「中野工務店　」を全部同じにする。
function companyKey(s: string): string {
return String(s || "")
  .normalize("NFKC")
  .replace(/[\s\u3000]/g, "")
  .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|\(株\)|\(有\)|\(同\)/g, "")
  .toLowerCase();
}

function isEmail(s: unknown): boolean {
return typeof s === "string" && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s.trim());
}

// メールの正規化。gmail のドットと ＋別名 は同じ受信箱に届くので、別人扱いしない。
//   n.a.k.a.no+demo2@gmail.com → nakano@gmail.com
function emailKey(s: string): string {
const e = String(s || "").trim().toLowerCase();
const m = /^([^@]+)@([^@]+)$/.exec(e);
if (!m) return "";
let local = m[1];
let domain = m[2];
if (domain === "googlemail.com") domain = "gmail.com";
local = local.split("+")[0];
if (domain === "gmail.com") local = local.replace(/\./g, "");
return local && domain ? `${local}@${domain}` : "";
}
function emailDomain(s: string): string {
const k = emailKey(s);
return k ? k.split("@")[1] : "";
}
// 画面に出す用に伏せる（ab***@example.com）。どのアドレスに送ったかは分かるが、全部は見せない。
function maskEmail(s: string): string {
const m = /^([^@]+)@(.+)$/.exec(String(s || ""));
if (!m) return "";
const head = m[1].slice(0, 2);
return `${head}${"*".repeat(Math.max(1, m[1].length - 2))}@${m[2]}`;
}

// 6桁の確認番号
function verifyCode(): string {
const b = new Uint8Array(4);
crypto.getRandomValues(b);
const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
return String(n % 1000000).padStart(6, "0");
}

// 期限切れか（デモのみ expires_at を持つ。有料は NULL）
function isExpired(lic: any): boolean {
return !!lic?.expires_at && new Date(lic.expires_at).getTime() < Date.now();
}

// 確認番号のメール。送信は send-mail 関数に任せる（SMTPの資格情報はあちらのシークレット）。
//   発信者確認のため token が要るので、いま作った（まだ本人に渡していない）行のトークンを使う。
async function sendVerifyMail(token: string, to: string, company: string, code: string, again: boolean) {
const subject = again
  ? "【建築ブースト】デモの再開に使う確認番号"
  : "【建築ブースト】デモ開始の確認番号";
const text = [
  `${company} 様`,
  "",
  again
    ? "デモのご利用を再開するための確認番号です。アプリの画面に入力してください。"
    : "デモを始めるための確認番号です。アプリの画面に入力してください。",
  "",
  `　　確認番号：${code}`,
  "",
  `※ この番号は ${VERIFY_TTL_MIN} 分で使えなくなります。`,
  "※ お心当たりが無い場合は、このメールは破棄してください。",
  "",
  "---",
  "建築ブースト",
].join("\n");
const res = await fetch(`${SUPABASE_URL}/functions/v1/send-mail`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ token, subject, text, toOwner: false, alsoTo: [to] }),
});
if (!res.ok) throw new Error(`send-mail ${res.status}: ${await res.text()}`);
}

// 運営あての通知（申込み・重複の検知）。失敗しても登録は止めない。
async function notifyOwner(token: string, subject: string, text: string) {
try {
  await fetch(`${SUPABASE_URL}/functions/v1/send-mail`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ token, subject, text }),
  });
} catch (_e) { /* 通知は落ちても本処理を止めない */ }
}

// 外向けにトークンを含めない安全な表現。
// ★期限切れのデモは active=false として返す。クレジットが残っていても使わせない
//   （期限をアプリのローカルDBだけで見ていると、入れ直しで日付が戻る）。
function publicView(lic: any) {
const expired = isExpired(lic);
return {
  active: !!lic.active && !expired,
  plan: lic.plan,
  credits: lic.credits,
  max_credits: lic.max_credits,
  expires_at: lic.expires_at ?? null,
  expired,
  blocked_message: expired
    ? (lic.blocked_message ?? `デモのご利用期間（${DEMO_DAYS}日）が終了しました。続けてお使いになる場合はご連絡ください。`)
    : (lic.blocked_message ?? null),
};
}

Deno.serve(async (req) => {
if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
try {
  const body = await req.json().catch(() => ({}));
  const action = body.action;

  // ---- verify: トークン(端末 or 単独)で契約状況を返す ----
  if (action === "verify") {
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const lic = await resolveLicense(token);
    if (!lic) return json({ error: "invalid_token" }, 404);
    return json(publicView(lic));
  }

  // ---- consume: サーバー側でクレジットを減算（原子更新）----
  // read-modify-write ではなく Postgres 関数(consume_credits)で行ロックしつつ減算する。
  // → 同一トークンの並行 consume でも二重消費(ロストアップデート)が起きない。
  if (action === "consume") {
    const token = String(body.token || "");
    const amount = Math.max(0, Math.floor(Number(body.amount) || 0));
    if (!token) return json({ error: "token required" }, 400);
    try {
      // 端末トークンでも単独トークンでも減算できる共有プールRPC（step4）。
      const rows = await sbRpc("consume_credits_seat", { p_token: token, p_amount: amount });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row || row.status === "invalid_token") return json({ error: "invalid_token" }, 404);
      if (row.status === "inactive") return json({ error: "inactive" }, 403);
      if (row.status === "expired") return json({ error: "expired", credits: row.credits ?? 0 }, 403);
      if (row.status === "insufficient") return json({ error: "insufficient", credits: row.credits ?? 0 }, 402);
      return json({ ok: true, credits: row.credits ?? 0 });
    } catch (_e) {
      // step4 RPC未適用時のフォールバック：resolve→非原子減算（親ライセンスの行を減らす）。
      // SQL(rls-step4-multiseat)を流せば自動で原子更新パスに切り替わる。
      const lic = await resolveLicense(token);
      if (!lic) return json({ error: "invalid_token" }, 404);
      if (!lic.active) return json({ error: "inactive" }, 403);
      if (isExpired(lic)) return json({ error: "expired" }, 403);
      if ((lic.credits ?? 0) < amount) return json({ error: "insufficient", credits: lic.credits ?? 0 }, 402);
      const updated = await sbPatch(
        `remote_licenses?id=eq.${encodeURIComponent(lic.id)}`,
        { credits: (lic.credits ?? 0) - amount, updated_at: new Date().toISOString() },
      );
      return json({ ok: true, credits: updated[0]?.credits ?? (lic.credits - amount) });
    }
  }

  // ---- join: 会社名＋参加コードで席を1つ取り、端末トークンを受け取る（マルチシート） ----
  // クレジットは親ライセンスの共有プール。max_seats を超えると seats_full。
  // 参加コードが本人確認代わり（承認不要）。コードは admin set_seats で発行し中野さんが会社へ渡す。
  if (action === "join") {
    const company = normalizeName(body.company_name);
    const code = String(body.join_code || "").trim();
    const label = String(body.device_label || "").slice(0, 60);
    if (!company || !code) return json({ error: "company_name and join_code required" }, 400);
    const lics = await sbGet(
      `remote_licenses?company_name=eq.${encodeURIComponent(company)}&active=eq.true&select=id,license_token,plan,credits,max_credits,blocked_message,max_seats,join_code`,
    );
    const lic = lics.find((l: any) => l.join_code && l.join_code === code);
    if (!lic) return json({ error: "invalid_company_or_code" }, 404);
    const seats = await sbGet(`license_seats?license_id=eq.${encodeURIComponent(lic.id)}&select=id`);
    if (seats.length >= (lic.max_seats || 1)) {
      return json({ error: "seats_full", max_seats: lic.max_seats || 1 }, 403);
    }
    const deviceToken = newToken();
    await sbInsert({
      id: "seat_" + newToken().slice(0, 12),
      license_id: lic.id,
      device_token: deviceToken,
      device_label: label || null,
      created_at: new Date().toISOString(),
    }, "license_seats");
    return json({ token: deviceToken, ...publicView(lic) });
  }

  // ---- demo_start: 承認なしでデモを始める（確認番号をメールで送るところまで） ----
  //
  // 承認制をやめた代わりに、ここで「1社1デモ」を担保する。
  //   ・端末指紋 / 正規化メール / 正規化会社名 のどれかが既存に当たったら、
  //     新しいデモは配らず既存のライセンスへ戻す（残クレジット・残り期間そのまま）。
  //     ＝アプリを入れ直しても単位は増えない。
  //   ・戻すときの確認番号は「登録済みのメール」へ送る。会社名を変えただけの
  //     他人はメールを受け取れないので通れない。
  //   ・会社ドメイン（フリーメール以外）が同じ2件目は断り、参加コードへ案内する。
  // トークンはこの時点では返さない（＝メールを受け取れた人だけが受け取れる）。
  if (action === "demo_start") {
    const company = normalizeName(body.company_name);
    const email = String(body.email || "").trim();
    const tel = String(body.tel || "").trim().slice(0, 40);
    const deviceHash = String(body.device_hash || "").trim().slice(0, 128);
    if (!company) return json({ error: "company_name required" }, 400);
    if (!isEmail(email)) return json({ error: "invalid_email" }, 400);
    if (!deviceHash) return json({ error: "device_hash required" }, 400);

    const eKey = emailKey(email);
    const cKey = companyKey(company);
    const domain = emailDomain(email);
    if (!eKey || !cKey) return json({ error: "invalid_input" }, 400);

    // レート制限：直近1分の新規作成が多すぎたら拒否
    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = await sbGet(`remote_licenses?created_at=gte.${encodeURIComponent(since)}&select=id`);
    if (recent.length >= 5) return json({ error: "rate_limited" }, 429);

    // 既存を探す（端末 → メール → 会社名の順。1つでも当たれば同じ相手とみなす）
    const q = (col: string, val: string) =>
      sbGet(`remote_licenses?${col}=eq.${encodeURIComponent(val)}&select=id,company_name,plan,active,credits,max_credits,expires_at,license_token,contact_email,email_key,device_hash,verify_attempts`)
        .catch(() => []);
    let existing =
      (await q("device_hash", deviceHash))[0] ||
      (await q("email_key", eKey))[0] ||
      (await q("company_key", cKey))[0] ||
      null;

    // 会社名そのままの既存行（承認制のころに作られた pending / 有料）も同じ相手として扱う
    if (!existing) {
      const byName = await sbGet(
        `remote_licenses?company_name=eq.${encodeURIComponent(company)}&select=id,company_name,plan,active,credits,max_credits,expires_at,license_token,contact_email,email_key,device_hash,verify_attempts`,
      ).catch(() => []);
      existing = byName[0] || null;
    }

    if (existing) {
      // 期限切れのデモは、番号を送らずここで断る。番号を送っても、確認したとたん
      // 「期間が終了しました」で止まるだけで、何が起きたのか分からない。
      if (existing.plan === "demo" && isExpired(existing)) {
        await notifyOwner(existing.license_token || "", `【デモ期間終了後の再申込み】${existing.company_name || company}`, [
          "デモ期間が終了した会社から、もう一度デモの開始が試みられました。",
          "",
          `■ 会社名: ${existing.company_name || company}`,
          `■ 登録メール: ${existing.contact_email || "-"}`,
          `■ 申込みメール: ${email}`,
          `■ 期限: ${existing.expires_at}`,
          `■ 残り単位: ${existing.credits}`,
        ].join("\n"));
        return json({
          error: "demo_expired",
          expires_at: existing.expires_at,
          message: `デモのご利用期間（${DEMO_DAYS}日）は終了しています。続けてお使いになる場合はお問い合わせください。`,
        }, 403);
      }
      // 送り先は「登録済みのメール」。無ければ今回のメール（承認制のころの行はメールを持っていない）
      const to = isEmail(existing.contact_email) ? existing.contact_email : email;
      let token = existing.license_token;
      const patch: any = {
        verify_code: verifyCode(),
        verify_expires_at: new Date(Date.now() + VERIFY_TTL_MIN * 60_000).toISOString(),
        verify_attempts: 0,
        updated_at: new Date().toISOString(),
      };
      if (!token) { token = newToken(); patch.license_token = token; }
      if (!existing.contact_email) { patch.contact_email = email; patch.email_key = eKey; patch.email_domain = domain; }
      if (!existing.contact_tel && tel) patch.contact_tel = tel;
      await sbPatch(`remote_licenses?id=eq.${encodeURIComponent(existing.id)}`, patch);
      await sendVerifyMail(token, to, existing.company_name || company, patch.verify_code, true);
      await notifyOwner(token, `【デモ再開の確認】${existing.company_name || company}`, [
        "既に登録のある会社から、もう一度デモの開始が試みられました。",
        "新しいデモは配らず、既存のライセンスへ戻すための確認番号を送っています。",
        "",
        `■ 会社名（申込み）: ${company}`,
        `■ 会社名（登録済み）: ${existing.company_name || "-"}`,
        `■ プラン: ${existing.plan} / 残り単位: ${existing.credits} / 期限: ${existing.expires_at || "なし"}`,
        `■ 送信先: ${to}`,
        `■ 申込みメール: ${email}`,
        `■ 端末: ${deviceHash.slice(0, 12)}…`,
      ].join("\n"));
      return json({
        status: "code_sent", existing: true, to: maskEmail(to), ticket: existing.id,
        plan: existing.plan, credits: existing.credits, expires_at: existing.expires_at ?? null,
      });
    }

    // 同じ会社ドメインの2件目は配らない（＝「同じ会社が人を変えて取り直す」を止める）。
    // フリーメールは会社の判定に使えないので対象外。
    if (domain && !FREE_MAIL_DOMAINS.has(domain)) {
      const sameDomain = await sbGet(
        `remote_licenses?email_domain=eq.${encodeURIComponent(domain)}&select=id,company_name,contact_email,plan,license_token`,
      ).catch(() => []);
      if (sameDomain.length) {
        const owner = sameDomain[0];
        // 運営には知らせる。断った先が「増員したい既存客」なら、そのまま商談になる。
        await notifyOwner(owner.license_token || "", `【同じ会社ドメインからのデモ申込み】${company}`, [
          "既にデモ／ご契約のある会社と同じメールドメインから、新しいデモの申込みがありました。",
          "追加のデモは配らず、参加コードでの参加をご案内しています。",
          "",
          `■ 申込み会社名: ${company}`,
          `■ 申込みメール: ${email}`,
          `■ 電話: ${tel || "未入力"}`,
          `■ 既存の登録: ${owner.company_name}（${owner.plan}）`,
          `■ ドメイン: ${domain}`,
        ].join("\n"));
        return json({
          error: "company_already_has_demo",
          company_name: owner.company_name,
          message: "同じ会社のメールアドレスで、すでにデモをご利用中です。追加の端末は「参加コードで参加」からお願いします（社内のご担当者にお尋ねください）。別の会社の場合はお問い合わせください。",
        }, 409);
      }
    }

    // ---- 新規のデモを作る（この時点では active=false。番号の確認で有効になる）----
    const token = newToken();
    const credits = DEFAULT_CREDITS.demo;
    const code = verifyCode();
    const id = "demo_" + newToken().slice(0, 12);
    await sbInsert({
      id,
      company_name: company,
      company_key: cKey,
      contact_email: email,
      email_key: eKey,
      email_domain: domain,
      contact_tel: tel || null,
      device_hash: deviceHash,
      plan: "demo",
      credits,
      max_credits: credits,
      active: false,
      blocked_message: "メールの確認番号を入力してください",
      license_token: token,
      expires_at: new Date(Date.now() + DEMO_DAYS * 86400_000).toISOString(),
      verify_code: code,
      verify_expires_at: new Date(Date.now() + VERIFY_TTL_MIN * 60_000).toISOString(),
      verify_attempts: 0,
      signup_source: "app",
      claimed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
    await sendVerifyMail(token, email, company, code, false);
    await notifyOwner(token, `【デモ申込み】${company}`, [
      "デモの申込みがありました（承認は不要です。確認番号の入力で開始されます）。",
      "",
      `■ 会社名: ${company}`,
      `■ メール: ${email}`,
      `■ 電話: ${tel || "未入力"}`,
      `■ 単位: ${credits} / 期間: ${DEMO_DAYS}日`,
      `■ 端末: ${deviceHash.slice(0, 12)}…`,
      `■ 日時: ${new Date().toLocaleString("ja-JP")}`,
    ].join("\n"));
    return json({ status: "code_sent", existing: false, to: maskEmail(email), ticket: id, plan: "demo", credits });
  }

  // ---- demo_verify: 確認番号を照合し、デモを有効化してトークンを渡す ----
  if (action === "demo_verify") {
    const email = String(body.email || "").trim();
    const deviceHash = String(body.device_hash || "").trim().slice(0, 128);
    const code = String(body.code || "").replace(/[^0-9]/g, "");
    const ticket = String(body.ticket || "").trim().slice(0, 64);
    if (!code) return json({ error: "code required" }, 400);

    const SEL = "id,company_name,plan,active,credits,max_credits,expires_at,license_token,verify_code,verify_expires_at,verify_attempts,device_hash";
    // ★まず ticket（demo_start が返した行のid）で引く。
    //   再開のときは「申込みに書いたメール」と「登録済みメール」が違うので、
    //   メールでは対象に辿り着けない。ticket だけでは何も出来ない（番号が要る・5回で打ち止め）。
    const eKey = emailKey(email);
    let rows: any[] = [];
    if (ticket) {
      rows = await sbGet(`remote_licenses?id=eq.${encodeURIComponent(ticket)}&select=${SEL}`).catch(() => []);
    }
    if (!rows.length && deviceHash) {
      rows = await sbGet(
        `remote_licenses?device_hash=eq.${encodeURIComponent(deviceHash)}&select=${SEL}`,
      ).catch(() => []);
    }
    if (!rows.length && eKey) {
      rows = await sbGet(
        `remote_licenses?email_key=eq.${encodeURIComponent(eKey)}&select=${SEL}`,
      ).catch(() => []);
    }
    const lic = rows[0];
    if (!lic) return json({ error: "not_found" }, 404);
    if (!lic.verify_code) return json({ error: "no_pending_code" }, 409);
    if ((lic.verify_attempts ?? 0) >= VERIFY_MAX_ATTEMPTS) return json({ error: "too_many_attempts" }, 429);
    if (lic.verify_expires_at && new Date(lic.verify_expires_at).getTime() < Date.now()) {
      return json({ error: "code_expired" }, 410);
    }
    if (String(lic.verify_code) !== code) {
      await sbPatch(`remote_licenses?id=eq.${encodeURIComponent(lic.id)}`, {
        verify_attempts: (lic.verify_attempts ?? 0) + 1, updated_at: new Date().toISOString(),
      });
      return json({ error: "wrong_code", attempts_left: VERIFY_MAX_ATTEMPTS - (lic.verify_attempts ?? 0) - 1 }, 401);
    }

    // 合致 → 有効化。番号は使い捨て。
    // ★expires_at は「無いときだけ」入れる。再開のときに期限を延ばさない（延ばせるなら入れ直し放題）。
    const patch: any = {
      active: true,
      verified_at: new Date().toISOString(),
      verify_code: null,
      verify_expires_at: null,
      verify_attempts: 0,
      blocked_message: null,
      updated_at: new Date().toISOString(),
    };
    if (!lic.device_hash && deviceHash) patch.device_hash = deviceHash;   // 端末に紐づける
    if (lic.plan === "demo" && !lic.expires_at) {
      patch.expires_at = new Date(Date.now() + DEMO_DAYS * 86400_000).toISOString();
    }
    let token = lic.license_token;
    if (!token) { token = newToken(); patch.license_token = token; patch.claimed_at = new Date().toISOString(); }
    const updated = (await sbPatch(`remote_licenses?id=eq.${encodeURIComponent(lic.id)}`, patch))[0] || { ...lic, ...patch };
    return json({
      token,
      company_name: lic.company_name,
      ...publicView({ ...lic, ...patch, credits: updated.credits ?? lic.credits }),
    });
  }

  // ---- register: 新規会社を「activeトライアル」で登録し、トークンを返す ----
  // クレジット等の値はサーバーが固定（呼び出し側が指定できない）＝偽造で高額プランは作れない。
  // 有料プランへの引き上げは admin approve（要シークレット）でのみ可能。
  if (action === "register") {
    const company = normalizeName(body.company_name);
    if (!company) return json({ error: "company_name required" }, 400);
    // レート制限：直近1分の新規作成が多すぎたら拒否（大量発行・行汚染の抑止）
    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = await sbGet(
      `remote_licenses?created_at=gte.${encodeURIComponent(since)}&select=id`,
    );
    if (recent.length >= 5) return json({ error: "rate_limited" }, 429);
    const existing = await sbGet(
      `remote_licenses?company_name=eq.${encodeURIComponent(company)}&select=id`,
    );
    if (existing.length) return json({ error: "already_exists" }, 409);
    const token = newToken();
    const TRIAL_CREDITS = 50;
    await sbInsert({
      id: "reg_" + newToken().slice(0, 12),
      company_name: company,
      plan: "trial",
      credits: TRIAL_CREDITS,
      max_credits: TRIAL_CREDITS,
      active: true,
      license_token: token,
      claimed_at: new Date().toISOString(), // register応答で本人に渡すのでclaim済み扱い
      created_at: new Date().toISOString(),  // レート制限の基準に必要（DB既定に依存しない）
    });
    return json({ token, status: "trial", plan: "trial", credits: TRIAL_CREDITS });
  }

  // ---- register_pending: 承認制の新規申請をサーバー側で作成（anon直INSERTの置換） ----
  //   既存アプリの「pendingで登録→管理者が承認」フローを維持したままEdge化する。
  //   トークンを発行して返し、顧客はそれで承認状況を verify できる（anon SELECT不要化）。
  if (action === "register_pending") {
    const company = normalizeName(body.company_name);
    if (!company) return json({ error: "company_name required" }, 400);
    // レート制限（register と同様に大量作成を抑止）
    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = await sbGet(
      `remote_licenses?created_at=gte.${encodeURIComponent(since)}&select=id`,
    );
    if (recent.length >= 5) return json({ error: "rate_limited" }, 429);
    // 同名の既存があれば、そのトークンを返す（重複pending行の乱立を防ぐ）
    const existing = await sbGet(
      `remote_licenses?company_name=eq.${encodeURIComponent(company)}&select=id,license_token,plan,active`,
    );
    if (existing.length) {
      let token = existing[0].license_token;
      if (!token) {
        token = newToken();
        await sbPatch(`remote_licenses?id=eq.${encodeURIComponent(existing[0].id)}`, { license_token: token, claimed_at: new Date().toISOString() });
      }
      return json({ token, status: existing[0].plan, active: existing[0].active });
    }
    const token = newToken();
    await sbInsert({
      id: "reg_" + newToken().slice(0, 12),
      company_name: company,
      plan: "pending",
      credits: 0,
      max_credits: 30,
      active: false,
      blocked_message: String(body.note || "承認待ち"),
      license_token: token,
      claimed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
    return json({ token, status: "pending", active: false });
  }

  // ---- claim: 既存ライセンス(会社名)のトークンを1回だけ受け取る（移行用） ----
  // 注意：これは移行期間限定の経路。会社名だけで本人確認できないため、
  //  ・移行完了後は CLAIM_ENABLED=false で恒久的に閉じる（横取り窓を消す）
  //  ・同名が複数ある場合は自動移行せず管理者対応にまわす（誤対象の防止）
  if (action === "claim") {
    if (Deno.env.get("CLAIM_ENABLED") === "false") return json({ error: "claim_disabled" }, 403);
    const company = String(body.company_name || "").trim();
    if (!company) return json({ error: "company_name required" }, 400);
    const rows = await sbGet(
      `remote_licenses?company_name=eq.${encodeURIComponent(company)}&claimed_at=is.null&select=id,license_token,plan,active,credits,max_credits`,
    );
    if (!rows.length) return json({ error: "not_found_or_already_claimed" }, 404);
    if (rows.length > 1) return json({ error: "ambiguous_contact_support" }, 409);
    const lic = rows[0];
    // トークンが未発行の行（pendingで作られたなど）は、claim時に必ず発行する。
    // これを怠ると顧客アプリが空トークンを受け取り、以後 consume が該当行に届かない（クレジットが減らない）。
    let token = lic.license_token;
    const patch: any = { claimed_at: new Date().toISOString() };
    if (!token) { token = newToken(); patch.license_token = token; }
    await sbPatch(`remote_licenses?id=eq.${encodeURIComponent(lic.id)}`, patch);
    return json({ token, ...publicView(lic) });
  }

  // ---- admin: 承認/却下/クレジット設定（管理者シークレット必須） ----
  if (action === "admin") {
    if (!ADMIN_SECRET || body.admin_secret !== ADMIN_SECRET) return json({ error: "forbidden" }, 403);
    const sub = body.sub;
    // list: 全登録の一覧（company指定不要）。管理ダッシュボード/承認画面用。
    // license_token は返さない（オーナー画面にも不要・漏洩面を最小化）。
    if (sub === "list") {
      const rows = await sbGet(
        `remote_licenses?select=id,company_name,plan,active,credits,max_credits,blocked_message,max_seats,join_code,claimed_at,created_at,updated_at,contact_email,contact_tel,email_domain,expires_at,verified_at,device_hash&order=created_at.desc`,
      );
      return json({ ok: true, rows });
    }
    const company = String(body.company_name || "").trim();
    if (!company) return json({ error: "company_name required" }, 400);
    // 対象を一意に特定（同名複数は誤爆を避けてエラーに）。以降の更新はすべて id 指定で行う。
    const targets = await sbGet(
      `remote_licenses?company_name=eq.${encodeURIComponent(company)}&select=id,license_token`,
    );
    if (!targets.length) return json({ error: "not_found" }, 404);
    if (targets.length > 1) return json({ error: "ambiguous", count: targets.length }, 409);
    const tid = encodeURIComponent(targets[0].id);
    if (sub === "approve") {
      const plan = String(body.plan || "standard");
      const credits = Number(body.credits ?? DEFAULT_CREDITS[plan] ?? 20);
      const patch: any = {
        plan, credits, max_credits: credits, active: true, blocked_message: null, updated_at: new Date().toISOString(),
        // ★デモから有料へ上げるときは期限を外す。残っていると、お金をいただいたのに
        //   30日で止まる（デモ行をそのまま昇格させる運用なので必ず消す）。
        expires_at: null,
      };
      // 承認時にマルチシートを有効化する場合：max_seats 指定があれば席数を設定し、参加コードを発行。
      if (body.max_seats != null) {
        patch.max_seats = Math.max(1, Math.floor(Number(body.max_seats)));
        patch.join_code = body.join_code ? String(body.join_code).trim() : shortCode();
      }
      // トークン欠落の行（pendingで作られてトークン未発行、または過去のバグで消えた行）は、
      // 承認/変更のタイミングで必ずトークンを発行し、claimed_atをリセットして顧客アプリが再取得できるようにする。
      // → これで「承認したのにクレジットが減らない」状態を復旧できる（正常な行のトークンには触れない）。
      if (!targets[0].license_token) {
        patch.license_token = newToken();
        patch.claimed_at = null;
      }
      await sbPatch(`remote_licenses?id=eq.${tid}`, patch);
      return json({ ok: true, max_seats: patch.max_seats, join_code: patch.join_code });
    }
    if (sub === "set_seats") {
      // 既存ライセンスをマルチシート化：席数を設定し参加コードを発行（指定が無ければ自動生成）。
      const max_seats = Math.max(1, Math.floor(Number(body.max_seats ?? 1)));
      const join_code = body.join_code ? String(body.join_code).trim() : shortCode();
      await sbPatch(`remote_licenses?id=eq.${tid}`, { max_seats, join_code, updated_at: new Date().toISOString() });
      return json({ ok: true, max_seats, join_code });
    }
    if (sub === "reject") {
      await sbPatch(`remote_licenses?id=eq.${tid}`, {
        active: false, blocked_message: String(body.message || "申請が却下されました"), updated_at: new Date().toISOString(),
      });
      return json({ ok: true });
    }
    if (sub === "set_credits") {
      const credits = Number(body.credits ?? 0);
      const patch: any = { credits, updated_at: new Date().toISOString() };
      // アプリの管理画面はクレジット変更時に上限(max_credits)も揃える。指定があれば反映。
      if (body.max_credits != null) patch.max_credits = Number(body.max_credits);
      await sbPatch(`remote_licenses?id=eq.${tid}`, patch);
      return json({ ok: true });
    }
    // set_active: 利用停止/再開（オーナーの管理画面用）。anon UPDATEを廃止するための移行先。
    if (sub === "set_active") {
      const active = !!body.active;
      await sbPatch(`remote_licenses?id=eq.${tid}`, {
        active, updated_at: new Date().toISOString(),
      });
      return json({ ok: true });
    }
    return json({ error: "unknown sub" }, 400);
  }

  return json({ error: "unknown action" }, 400);
} catch (e) {
  return json({ error: String(e) }, 500);
}
});
