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

// 差出人名。シークレットに U+FFFD（置換文字）を含む壊れた値が入っていると、
// 「建築ブース」＋文字化け3個 のまま全通知メールに乗り続ける。
// 壊れた値は捨てて既定値へ戻す。（設定時のコンソール文字コードで化けた実績あり）
const RAW_FROM_NAME = Deno.env.get("MAIL_FROM_NAME") || "建築ブースト";
const FROM_NAME_BROKEN = [...RAW_FROM_NAME].some((c) => c.codePointAt(0) === 0xFFFD);
const MAIL_FROM_NAME = FROM_NAME_BROKEN ? "建築ブースト" : RAW_FROM_NAME;

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

// ───────────────────────────────────────────────────────────────
// 件名（日本語）のヘッダーエンコード
//
// なぜ自前で組むのか:
//   denomailer@1.6.0 の quotedPrintableEncodeInline() は、件名を
//   =?utf-8?Q?...?= で包む前に「本文用」の quoted-printable エンコーダを通す。
//   そのエンコーダは74文字ごとにソフト改行 "=\r\n" を挿入するが、
//   RFC 2047 は encoded-word の内部に改行を置くことを禁じている。
//   さらに折り返しループの最終断片に offset が適用されておらず
//   （ret += encodedData.slice(lines * 74) ）、境界の "=" が1〜2文字欠落する。
//   結果、Gmail はデコードを諦めて "=e3=80=90..." を生のまま表示する。
//   （denomailer issue #90 / 同ライブラリは2023年以降ほぼ未メンテ）
//
// 回避のしかた:
//   こちらで RFC 2047 の Base64 encoded-word を組み立てて渡す。
//   ただし quotedPrintableEncodeInline() は「非ASCIIを含む」か
//   「"=?" で始まる」文字列を再エンコードしてしまうため、そのままでは二重になる。
//   → 先頭に半角空白を1つ置く。全体はASCIIのみ・"=?" 始まりでもなくなるので
//     素通しされ、writeCmd("Subject: ", subject) でそのまま書き出される。
//     ヘッダー値の先頭空白は RFC 5322 上フォールディング空白として無視される。
//
// 差出人名(From)はこの経路を通さない。54文字と短く74文字の折り返しに達しないため
// denomailer 側でも壊れず、化けの原因はシークレットの値そのものだった（上の FROM_NAME_BROKEN）。
// ───────────────────────────────────────────────────────────────

// encoded-word 1個は全体で75文字以内（RFC 2047 §2）。
// "=?UTF-8?B?"(10) + payload + "?="(2) = 12文字が固定なので payload は63文字まで。
// Base64は4文字単位なので60文字＝45バイトを1チャンクの上限にする。
const HEADER_CHUNK_BYTES = 45;

function base64OfBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function encodeHeaderWord(input: string): string {
  // ASCIIだけなら変換不要（denomailer もそのまま通す）
  const hasNonAscii = [...input].some((c) => (c.codePointAt(0) ?? 0) > 127);
  if (!hasNonAscii) return input;

  const enc = new TextEncoder();

  // マルチバイト文字を encoded-word の境界でまたがせない（RFC 2047 の要求）。
  // バイト長で切るのではなく、必ず文字単位で積む。
  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of input) {
    const n = enc.encode(ch).length;
    if (curBytes + n > HEADER_CHUNK_BYTES && cur) {
      chunks.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  if (cur) chunks.push(cur);

  const words = chunks.map((c) => `=?UTF-8?B?${base64OfBytes(enc.encode(c))}?=`);

  // 複数語は CRLF + 空白で折り返す（RFC 5322 のフォールディング）。
  // 先頭の空白は denomailer の再エンコード判定を外すためのもの。
  return " " + words.join("\r\n ");
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

    // 改行は必ず落とす。denomailer は件名をヘッダーへ素通しするため
    // （writeCmd("Subject: ", subject)）、改行を残すとヘッダー注入になる。
    const subject = String(body.subject || "").replace(/[\r\n]+/g, " ").slice(0, 200);
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
        // 日本語件名は自前で RFC 2047 encoded-word にする（encodeHeaderWord の説明を参照）。
        // denomailer のヘッダーエンコードは壊れており、Gmail がデコードできない。
        subject: encodeHeaderWord(subject),
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
