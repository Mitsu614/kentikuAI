// Supabase Edge Function: license
// 役割: ライセンスの発行・確認・クレジット消費・移行(claim)・管理を、すべてサーバー側(service_role)で行う。
//       公開キーは remote_licenses に一切触れない。本人確認は「秘密トークン」で行う。
//
// 呼び出し: POST JSON { action: "verify"|"register"|"consume"|"claim"|"admin", ... }
//
// シークレット:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY … 自動
//   - ADMIN_SECRET … admin アクション用（未設定なら admin は無効）

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") || "";

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
      `remote_licenses?id=eq.${encodeURIComponent(seats[0].license_id)}&select=id,active,plan,credits,max_credits,blocked_message,license_token`,
    );
    return lic[0] || null;
  }
  const lic = await sbGet(
    `remote_licenses?license_token=eq.${encodeURIComponent(token)}&select=id,active,plan,credits,max_credits,blocked_message,license_token`,
  );
  return lic[0] || null;
}

// 会社名の正規化（前後空白除去＋連続空白を1つに）。重複行・表記ゆれの汚染を減らす。
function normalizeName(s: string): string {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// 外向けにトークンを含めない安全な表現
function publicView(lic: any) {
  return {
    active: !!lic.active,
    plan: lic.plan,
    credits: lic.credits,
    max_credits: lic.max_credits,
    blocked_message: lic.blocked_message ?? null,
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
        if (row.status === "insufficient") return json({ error: "insufficient", credits: row.credits ?? 0 }, 402);
        return json({ ok: true, credits: row.credits ?? 0 });
      } catch (_e) {
        // step4 RPC未適用時のフォールバック：resolve→非原子減算（親ライセンスの行を減らす）。
        // SQL(rls-step4-multiseat)を流せば自動で原子更新パスに切り替わる。
        const lic = await resolveLicense(token);
        if (!lic) return json({ error: "invalid_token" }, 404);
        if (!lic.active) return json({ error: "inactive" }, 403);
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
          `remote_licenses?select=id,company_name,plan,active,credits,max_credits,blocked_message,max_seats,join_code,claimed_at,created_at,updated_at&order=created_at.desc`,
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
        const credits = Number(body.credits ?? (plan === "demo" ? 30 : plan === "pro" ? 200 : 50));
        const patch: any = {
          plan, credits, max_credits: credits, active: true, blocked_message: null, updated_at: new Date().toISOString(),
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
