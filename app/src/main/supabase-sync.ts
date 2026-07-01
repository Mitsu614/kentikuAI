// Supabase 学習ループ同期モジュール
// - 実績データをSupabaseに送信（匿名化済み）
// - 最新の見積係数をSupabaseから取得
// - ライセンスはトークン認証でEdge Function経由（STEP3）

const SUPABASE_URL = 'https://slhgkedzlormaovwpadi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e';

// ── ライセンス用 Edge Function 呼び出し（STEP3） ──
// remote_licenses への直アクセスをやめ、すべて license 関数経由にする。
// 本人確認は会社名ではなく「秘密トークン」で行う。
function licenseRequest(payload: any, timeoutMs = 8000): Promise<any> {
  const https = require('https');
  const url = new URL(`${SUPABASE_URL}/functions/v1/license`);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    }, (res: any) => {
      let data = '';
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => { try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// 確認: トークンで契約状況を取得 { active, plan, credits, max_credits, blocked_message } | { error } | null
export function licenseVerify(token: string): Promise<any> {
  return licenseRequest({ action: 'verify', token });
}
// クレジット消費: サーバー側で減算 { ok, credits } | { error } | null
export function licenseConsume(token: string, amount: number): Promise<any> {
  return licenseRequest({ action: 'consume', token, amount });
}
// 移行: 既存ライセンスのトークンを会社名で1回だけ受け取る { token, ... } | { error } | null
export function licenseClaim(companyName: string): Promise<any> {
  return licenseRequest({ action: 'claim', company_name: companyName });
}
// 新規登録: pending でライセンス作成しトークンを受け取る { token, status } | { error } | null
export function licenseRegister(companyName: string): Promise<any> {
  return licenseRequest({ action: 'register', company_name: companyName });
}
// 管理: 承認/却下/クレジット設定（要 adminSecret）
export function licenseAdmin(adminSecret: string, sub: string, companyName: string, extra: any = {}): Promise<any> {
  return licenseRequest({ action: 'admin', admin_secret: adminSecret, sub, company_name: companyName, ...extra });
}

interface FeedbackData {
  work_type: string;
  region?: string;
  structure_type?: string;
  area_m2?: number;
  ai_material_cost?: number;
  ai_labor_cost?: number;
  ai_total?: number;
  ai_markup_rate?: number;
  actual_material_cost?: number;
  actual_labor_cost?: number;
  actual_selling_price?: number;
  actual_markup_rate?: number;
  accuracy_ratio?: number | null;
}

interface CostCoefficient {
  work_type: string;
  material_adjustment: number;
  labor_adjustment: number;
  confidence: number;
  sample_count: number;
  avg_accuracy: number | null;
  notes: string | null;
}

// Supabase REST API ヘルパー
async function supabaseRequest(table: string, method: string, body?: any, query?: string): Promise<any> {
  const https = require('https');
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}${query || ''}`);

  return new Promise((resolve, reject) => {
    const options: any = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=minimal' : '',
      },
      timeout: 15000,
    };

    const req = https.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : null); }
          catch { resolve(null); }
        } else {
          reject(new Error(`Supabase ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 実績データのバリデーション — 明らかにあり得ない修正値を弾く
function isReasonableFeedback(fb: FeedbackData): boolean {
  const aiTotal = fb.ai_total || 0;
  const actualTotal = fb.actual_selling_price || 0;

  // 実績値が0以下は無効
  if (actualTotal <= 0) return false;

  // AI見積もりが0の場合はバリデーション不能なので通す
  if (aiTotal <= 0) return true;

  // 乖離率チェック: AI見積もりの10倍以上 or 1/10以下は異常値として除外
  const ratio = actualTotal / aiTotal;
  if (ratio > 10 || ratio < 0.1) {
    console.warn(`学習ループ: 異常値を除外 (工種: ${fb.work_type}, AI: ${aiTotal}, 実績: ${actualTotal}, 乖離率: ${ratio.toFixed(2)})`);
    return false;
  }

  // 個別コスト: マイナス値は無効
  if ((fb.actual_material_cost ?? 0) < 0 || (fb.actual_labor_cost ?? 0) < 0) return false;

  return true;
}

// 実績データをSupabaseに送信（匿名化 - テナントIDや案件名は含まない）
export async function sendFeedbackToSupabase(feedbackList: FeedbackData[]): Promise<number> {
  if (!feedbackList || feedbackList.length === 0) return 0;

  // バリデーション: あり得ない値を除外
  const valid = feedbackList.filter(fb => isReasonableFeedback(fb));
  const skipped = feedbackList.length - valid.length;
  if (skipped > 0) {
    console.log(`学習ループ: ${skipped}件を異常値として除外`);
  }
  if (valid.length === 0) return 0;

  let sent = 0;
  for (const fb of valid) {
    try {
      await supabaseRequest('estimate_feedback', 'POST', fb);
      sent++;
    } catch (e) {
      console.error('Supabase送信エラー:', e);
    }
  }
  console.log(`学習ループ: ${sent}/${valid.length}件をSupabaseに送信`);
  return sent;
}

// 最新の見積係数をSupabaseから取得
export async function fetchCostCoefficients(): Promise<CostCoefficient[]> {
  try {
    const data = await supabaseRequest(
      'cost_coefficients',
      'GET',
      null,
      '?select=work_type,material_adjustment,labor_adjustment,confidence,sample_count,avg_accuracy,notes&order=confidence.desc'
    );
    if (Array.isArray(data) && data.length > 0) {
      console.log(`学習ループ: ${data.length}件の見積係数を取得`);
      return data;
    }
    return [];
  } catch (e) {
    console.error('係数取得エラー:', e);
    return [];
  }
}

// 実績1件でも即時分析 → 係数更新
// セキュリティ(STEP2): 実績の集計・Claude分析・係数の書き込みは Edge Function 側で行う。
// アプリは「再計算してほしい」という合図を送るだけ。入力データは渡さないため、
// 公開キーを持っていても係数を汚染できない（DBの実データからのみ算出される）。
// ※ 旧シグネチャ互換のため anthropicKey 引数は残すが未使用（キーはサーバー側のシークレット）。
export async function analyzeAndUpdateCoefficients(_anthropicKey?: string): Promise<void> {
  try {
    const https = require('https');
    const result: { updated?: number; feedback?: number; error?: string } = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: new URL(SUPABASE_URL).hostname,
        path: '/functions/v1/update-coefficients',
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }, (res: any) => {
        let data = '';
        res.on('data', (c: string) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
          } else {
            reject(new Error(`update-coefficients ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    if (result.error) {
      console.error('学習ループ即時(Edge): エラー', result.error);
    } else {
      console.log(`学習ループ即時(Edge): 実績${result.feedback ?? '?'}件から${result.updated ?? 0}工種の係数を更新`);
    }
  } catch (e) {
    console.error('学習ループ即時分析エラー:', e);
  }
}

// 係数をプロンプト用テキストに変換
export function coefficientsToPromptText(coefficients: CostCoefficient[]): string {
  if (!coefficients || coefficients.length === 0) return '';

  const lines = coefficients
    .filter(c => c.confidence >= 0.3) // 信頼度30%以上のみ使用
    .map(c => {
      const matAdj = c.material_adjustment !== 1.0
        ? `材料費${c.material_adjustment > 1 ? '+' : ''}${Math.round((c.material_adjustment - 1) * 100)}%補正`
        : '';
      const labAdj = c.labor_adjustment !== 1.0
        ? `労務費${c.labor_adjustment > 1 ? '+' : ''}${Math.round((c.labor_adjustment - 1) * 100)}%補正`
        : '';
      const adj = [matAdj, labAdj].filter(Boolean).join('、');
      return `- ${c.work_type}: ${adj || '補正なし'}（実績${c.sample_count}件、精度${Math.round((c.avg_accuracy || 1) * 100)}%）`;
    });

  if (lines.length === 0) return '';

  return `\n## 全ユーザー実績に基づく見積補正係数（${lines.length}工種）\n` +
    '以下は全国の工務店の実績データから学習した補正値です。該当する工事種別の場合、この補正を適用してください。\n' +
    lines.join('\n') + '\n';
}
