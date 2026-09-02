// Supabase Edge Function: birukaze-lead
// 役割: 公開中のビル風診断（docs/birukaze/）で、診断結果を表示する前に
//       うかがった会社名・お名前・メールと、その方が入力した診断条件を
//       運営あてにメールで通知する。
//
// なぜ send-mail を使わないのか:
//   send-mail は先頭で必ずライセンストークンを解決し、無効なら 401 で弾く。
//   公開ページの訪問者はトークンを持たないため、そもそも通せない。
//   かといって send-mail にトークン不要の抜け道を足すと、有償顧客向けの
//   送信経路が誰でも叩ける口に変わってしまう。用途を分けて別関数にした。
//
// 呼び出し: POST JSON {
//   company: string   … 会社名（必須・120文字まで）
//   name:    string   … お名前（必須・80文字まで）
//   email:   string   … メール（必須・形式チェックあり）
//   note?:   string   … 自由記入（400文字まで）
//   summary?: string  … 診断条件と結果の要約（4000文字まで）。本文にそのまま載せる
//   website?: string  … ハニーポット。人間は触らないので、値が入っていたら黙って捨てる
// }
//
// デプロイ:
//   supabase functions deploy birukaze-lead --no-verify-jwt
//   ※ --no-verify-jwt が必須。付けないと anon キーを公開ページに置く羽目になる。
//
// シークレット: send-mail と同じものをそのまま使う（設定済みなら追加作業なし）
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / OWNER_EMAIL
//   MAIL_FROM / MAIL_FROM_NAME

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SMTP_HOST = Deno.env.get("SMTP_HOST") || "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") || "465");
const SMTP_USER = Deno.env.get("SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("SMTP_PASS") || "";
const OWNER_EMAIL = Deno.env.get("OWNER_EMAIL") || SMTP_USER;
const MAIL_FROM = Deno.env.get("MAIL_FROM") || SMTP_USER;

// 差出人名の壊れた値を捨てる処理は send-mail と同じ理由（設定時のコンソール文字コードで化けた実績あり）
const RAW_FROM_NAME = Deno.env.get("MAIL_FROM_NAME") || "建築ブースト";
const FROM_NAME_BROKEN = [...RAW_FROM_NAME].some((c) => c.codePointAt(0) === 0xFFFD);
const MAIL_FROM_NAME = FROM_NAME_BROKEN ? "建築ブースト" : RAW_FROM_NAME;

// 公開ページから呼ばれるので、出どころを絞る。
// 独自ドメインに移したら kentiku-boost.jp を足す。
const ALLOWED_ORIGINS = [
  "https://mitsu614.github.io",
  "https://kentiku-boost.jp",
  "https://www.kentiku-boost.jp",
];

function corsFor(origin: string | null) {
  const ok = origin && ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsFor(origin) },
  });
}

const isEmail = (s: unknown): boolean =>
  typeof s === "string" && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s.trim());

const clip = (v: unknown, max: number): string =>
  String(v ?? "").replace(/\r/g, "").trim().slice(0, max);

// ヘッダーに改行を入れられると別ヘッダーを注入できてしまうので、件名に混ぜる値からは必ず除く
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

// ───────────────────────────────────────────────────────────────
// 簡易レート制限
//
// Edge Function のインスタンスは使い回されるが永続はしないので、これは
// 「同じインスタンスに連続で当たった場合だけ効く」best effort。
// 本気の攻撃は止まらないが、フォームの連打とナイーブなbotはこれで落ちる。
// 恒久的に止めたくなったらテーブルに記録してIP単位で数えること。
// ───────────────────────────────────────────────────────────────
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function tooMany(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // メモリの上限だけ守る
  return false;
}

// ───────────────────────────────────────────────────────────────
// 日本語件名の RFC 2047 エンコード
// send-mail/index.ts と同じ実装。denomailer@1.6.0 のヘッダーエンコードは
// encoded-word の内部に改行を入れてしまい Gmail がデコードできないため、
// 自前で Base64 encoded-word を組み立てて先頭に半角空白を1つ置く。
// 詳しい経緯は send-mail/index.ts の該当箇所のコメントを参照。
// ───────────────────────────────────────────────────────────────
const HEADER_CHUNK_BYTES = 45;

function base64OfBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function encodeHeaderWord(input: string): string {
  const hasNonAscii = [...input].some((c) => (c.codePointAt(0) ?? 0) > 127);
  if (!hasNonAscii) return input;

  const enc = new TextEncoder();
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
  return " " + words.join("\r\n ");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

  try {
    if (!SMTP_USER || !SMTP_PASS) return json({ error: "smtp_not_configured" }, 500, origin);

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "origin_not_allowed" }, 403, origin);
    }

    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    if (tooMany(ip)) return json({ error: "too_many_requests" }, 429, origin);

    const body = await req.json().catch(() => ({}));

    // ハニーポット。人間には見えない項目なので、埋まっていれば bot。
    // 弾いたことを悟らせないため 200 を返して黙って捨てる。
    if (clip(body.website, 10)) return json({ ok: true, skipped: true }, 200, origin);

    const company = clip(body.company, 120);
    const name = clip(body.name, 80);
    const email = clip(body.email, 200);
    const note = clip(body.note, 400);
    const summary = clip(body.summary, 4000);

    if (!company || !name) return json({ error: "missing_fields" }, 400, origin);
    if (!isEmail(email)) return json({ error: "invalid_email" }, 400, origin);

    const subject = `【ビル風診断】${oneLine(company)} 様から利用登録`;

    const lines = [
      "ビル風診断のページから、利用登録がありました。",
      "",
      "──────────────────────",
      `会社名: ${company}`,
      `お名前: ${name}`,
      `メール: ${email}`,
      note ? `ご要望: ${note}` : "",
      "──────────────────────",
      "",
      summary ? "【この方が調べた内容】" : "",
      summary,
      "",
      "──────────────────────",
      `受信日時: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
      "送信元: https://mitsu614.github.io/kentikuAI/birukaze/",
    ].filter((l) => l !== "");

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
        to: [OWNER_EMAIL],
        // 返信すればそのまま見込み客に返せるようにしておく
        replyTo: `${name} <${email}>`,
        subject: encodeHeaderWord(subject),
        content: lines.join("\n"),
      });
    } finally {
      try { await client.close(); } catch (_) { /* noop */ }
    }

    return json({ ok: true }, 200, origin);
  } catch (e) {
    console.error("birukaze-lead failed:", e);
    return json({ error: "send_failed" }, 500, origin);
  }
});
