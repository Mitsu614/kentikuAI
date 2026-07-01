// Supabase Edge Function: update-coefficients
// 役割: 実績(estimate_feedback)をサーバー側(service_role)で集計し、Claudeで補正係数を算出して
//       cost_coefficients に upsert する。
// セキュリティ: 係数の「計算」と「書き込み」をサーバー側に閉じ込める。呼び出し側(アプリ)は
//       入力データを渡さない＝公開キーを持っていても係数を汚染できない（DBの実データからのみ算出）。
//
// 必要なシークレット（supabase secrets set で設定）:
//   - ANTHROPIC_API_KEY : Claude APIキー（サーバー側のみで使用）
//   - FUNCTION_SECRET    : 任意。設定するとアプリからの x-function-secret ヘッダ一致を要求（乱用抑止）
// 自動で渡る環境変数:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const FUNCTION_SECRET = Deno.env.get("FUNCTION_SECRET") || "";

const sbHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

async function sbGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`sbGet ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbUpsert(table: string, body: unknown, onConflict: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbUpsert ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  try {
    // CORS / preflight
    if (req.method === "OPTIONS") {
      return new Response("ok", {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-function-secret",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
      });
    }

    // 任意の共有シークレット検証（設定されている場合のみ）
    if (FUNCTION_SECRET && req.headers.get("x-function-secret") !== FUNCTION_SECRET) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }

    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), { status: 500 });
    }

    // 1. 全実績を取得（service_role）
    const feedback: any[] = await sbGet(
      "estimate_feedback?select=*&order=created_at.desc&limit=1000",
    );
    if (!Array.isArray(feedback) || feedback.length === 0) {
      return new Response(JSON.stringify({ updated: 0, reason: "no feedback" }), { status: 200 });
    }

    // 2. 工種ごとに集計
    const byType: Record<string, any[]> = {};
    for (const fb of feedback) {
      const wt = fb.work_type || "不明";
      (byType[wt] ||= []).push(fb);
    }
    const summary = Object.entries(byType).map(([wt, list]) => {
      const avg = (f: (x: any) => number) => list.reduce((s, x) => s + (f(x) || 0), 0) / list.length;
      const avgAiMat = avg((f) => f.ai_material_cost);
      const avgActMat = avg((f) => f.actual_material_cost ?? f.ai_material_cost);
      const avgAiLab = avg((f) => f.ai_labor_cost);
      const avgActLab = avg((f) => f.actual_labor_cost ?? f.ai_labor_cost);
      const avgAiTotal = avg((f) => f.ai_total);
      const avgActual = avg((f) => f.actual_selling_price ?? f.ai_total);
      return `${wt}(${list.length}件): AI材料費${Math.round(avgAiMat)}円→実績${Math.round(avgActMat)}円, ` +
        `AI労務費${Math.round(avgAiLab)}円→実績${Math.round(avgActLab)}円, ` +
        `AI合計${Math.round(avgAiTotal)}円→実績売価${Math.round(avgActual)}円`;
    }).join("\n");

    // 3. Claudeで分析
    const prompt = `建築見積AIの精度改善データです。補正係数をJSON配列で返してください。\n\n${summary}\n\n` +
      `出力: [{"work_type":"名前","material_adjustment":1.0,"labor_adjustment":1.0,"confidence":0.0,"avg_accuracy":1.0,"notes":"メモ"}]\n` +
      `ルール: 乖離5%未満は1.0、データ1件はconfidence=0.1`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!claudeRes.ok) {
      return new Response(JSON.stringify({ error: `claude ${claudeRes.status}: ${await claudeRes.text()}` }), { status: 502 });
    }
    const claudeJson = await claudeRes.json();
    const text: string = claudeJson?.content?.[0]?.text ?? "";

    // 4. JSON抽出 → upsert
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) {
      return new Response(JSON.stringify({ error: "no json from claude" }), { status: 502 });
    }
    const coefficients = JSON.parse(match[0]);
    for (const c of coefficients) {
      await sbUpsert("cost_coefficients", {
        work_type: c.work_type,
        material_adjustment: c.material_adjustment,
        labor_adjustment: c.labor_adjustment,
        confidence: c.confidence,
        sample_count: (byType[c.work_type] || []).length,
        avg_accuracy: c.avg_accuracy,
        notes: c.notes,
        updated_at: new Date().toISOString(),
      }, "work_type");
    }

    return new Response(
      JSON.stringify({ updated: coefficients.length, feedback: feedback.length }),
      { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
