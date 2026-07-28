// Supabase Edge Function: send-mail
// 役割: アプリからの通知メール送信をサーバー側で行う。
//       SMTPの資格情報と運営あての宛先アドレスは、この関数のシークレットだけが持つ。
//       → 配布アプリの中にも公開リポジトリにも、パスワードもアドレスも一切残らない。
//
// 経緯: 以前は main.ts に Gmail のアプリパスワードと運営アドレスを直書きし、
//       顧客のPCから直接SMTP送信していた。公開リポジトリからも配布アプリからも
//       資格情報が取り出せる状態だったため、送信をサーバー側へ移した。
//
// 呼び出し: POST JSON {
//   token: string       … ライセンストークン（端末 or 単独）。発信者の確認に使う
//   subject: string
//   text: string
//   toOwner?: boolean   … 既定 true。運営(OWNER_EMAIL)を宛先に含める
//   alsoTo?: string[]   … 顧客など追加の宛先（最大3件）
//   attachments?: [{ filename: string, contentBase64: string }]
// }
//
// シークレット（supabase secrets set で設定）:
//   SMTP_HOST      … 既定 smtp.gmail.com
//   SMTP_PORT      … 既定 465（SSL）
//   SMTP_USER      … 送信アカウント
//   SMTP_PASS      … アプリパスワード / SMTPパスワード
//   OWNER_EMAIL    … 運営あて通知の宛先。未設定なら SMTP_USER
//   MAIL_FROM      … 差出人アドレス。未設定なら SMTP_USER
//   MAIL_FROM_NAME … 差出人名。既定「建築ブースト」
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY … 自動

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SMTP_HOST = Deno.env.get("SMTP_HOST") || "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") || "465");
const SMTP_USER = Deno.env.get("SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("SMTP_PASS") || "";
const OWNER_EMAIL = Deno.env.get("OWNER_EMAIL") || SMTP_USER;
const MAIL_FROM = Deno.env.get("MAIL_FROM") || SMTP_USER;
const MAIL_FROM_NAME = Deno.env.get("MAIL_FROM_NAME") || "建築ブースト";

// 添付の総量。Edge の実行時間とメモリを守るための上限（超えた分は捨てて本文だけ送る）。
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;
const MAX_ALSO_TO = 3;

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

// トークン → ライセンス行。license 関数の resolveLicense と同じ解決順。
//   1) license_seats.device_token（マルチシートの端末トークン）→ 親ライセンス
//   2) 無ければ remote_licenses.license_token 直参照（単独利用の既存顧客）
async function resolveLicense(token: string): Promise<any | null> {
  const seats = await sbGet(
    `license_seats?device_token=eq.${encodeURIComponent(token)}&select=license_id`,
  ).catch(() => []);
  if (seats.length) {
    const lic = await sbGet(
      `remote_licenses?id=eq.${encodeURIComponent(seats[0].license_id)}&select=id,active`,
    ).catch(() => []);
    return lic[0] || null;
  }
  const lic = await sbGet(
    `remote_licenses?license_token=eq.${encodeURIComponent(token)}&select=id,active`,
  ).catch(() => []);
  return lic[0] || null;
}

function isEmail(s: unknown): boolean {
  return typeof s === "string" && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s.trim());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    if (!SMTP_USER || !SMTP_PASS) return json({ error: "smtp_not_configured" }, 500);

    const body = await req.json().catch(() => ({}));

    // ---- 発信者の確認 ----
    // 無関係な第三者に送信させないため、有効なライセンストークンを必須にする。
    // 万一トークンが漏れても、そのライセンスを止めれば送信も止まる（＝失効できる）。
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 401);
    const lic = await resolveLicense(token);
    if (!lic) return json({ error: "invalid_token" }, 401);

    const subject = String(body.subject || "").slice(0, 200);
    const text = String(body.text || "");
    if (!subject && !text) return json({ error: "empty_mail" }, 400);

    // ---- 宛先 ----
    // 運営あては OWNER_EMAIL（サーバー側のシークレット）。クライアントは指定できない。
    const to: string[] = [];
    if (body.toOwner !== false && isEmail(OWNER_EMAIL)) to.push(OWNER_EMAIL);
    if (Array.isArray(body.alsoTo)) {
      for (const addr of body.alsoTo.slice(0, MAX_ALSO_TO)) {
        if (isEmail(addr) && !to.includes(addr.trim())) to.push(addr.trim());
      }
    }
    if (!to.length) return json({ error: "no_recipient" }, 400);

    // ---- 添付 ----
    const attachments: any[] = [];
    let attachBytes = 0;
    let attachDropped = 0;
    if (Array.isArray(body.attachments)) {
      for (const a of body.attachments) {
        const content = String(a?.contentBase64 || "");
        const filename = String(a?.filename || "attachment");
        if (!content) continue;
        const size = Math.floor((content.length * 3) / 4);
        if (attachBytes + size > MAX_ATTACH_BYTES) { attachDropped++; continue; }
        attachBytes += size;
        attachments.push({ filename, encoding: "base64", content, contentType: "application/octet-stream" });
      }
    }

    // ---- 送信 ----
    const client = new SMTPClient({
      connection: {
        hostname: SMTP_HOST,
        port: SMTP_PORT,
        tls: SMTP_PORT === 465,
        auth: { username: SMTP_USER, password: SMTP_PASS },
      },
    });

    try {
      await client.send({
        from: `${MAIL_FROM_NAME} <${MAIL_FROM}>`,
        to,
        subject,
        content: text,
        attachments: attachments.length ? attachments : undefined,
      });
    } finally {
      // close に失敗しても送信自体は済んでいるので握りつぶす
      try { await client.close(); } catch (_) { /* noop */ }
    }

    return json({ ok: true, sent: to.length, attachments: attachments.length, attachDropped });
  } catch (e) {
    console.error("send-mail failed:", e);
    return json({ error: "send_failed", detail: String((e as Error)?.message || e) }, 500);
  }
});
