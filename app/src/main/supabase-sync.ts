// Supabase 学習ループ同期モジュール
// - 実績データをSupabaseに送信（匿名化済み）
// - 最新の見積係数をSupabaseから取得

const SUPABASE_URL = 'https://slhgkedzlormaovwpadi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e';

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
  accuracy_ratio?: number;
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

// 実績データをSupabaseに送信（匿名化 - テナントIDや案件名は含まない）
export async function sendFeedbackToSupabase(feedbackList: FeedbackData[]): Promise<number> {
  if (!feedbackList || feedbackList.length === 0) return 0;

  let sent = 0;
  for (const fb of feedbackList) {
    try {
      await supabaseRequest('estimate_feedback', 'POST', fb);
      sent++;
    } catch (e) {
      console.error('Supabase送信エラー:', e);
    }
  }
  console.log(`学習ループ: ${sent}/${feedbackList.length}件をSupabaseに送信`);
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
export async function analyzeAndUpdateCoefficients(anthropicKey: string): Promise<void> {
  try {
    // 1. Supabaseから全実績を取得
    const feedback = await supabaseRequest(
      'estimate_feedback', 'GET', null,
      '?select=*&order=created_at.desc&limit=1000'
    );
    if (!Array.isArray(feedback) || feedback.length === 0) {
      console.log('学習ループ即時: 実績データなし、スキップ');
      return;
    }

    // 2. 工事種別ごとに集計
    const byType: Record<string, any[]> = {};
    for (const fb of feedback) {
      const wt = fb.work_type || '不明';
      if (!byType[wt]) byType[wt] = [];
      byType[wt].push(fb);
    }

    const summary = Object.entries(byType).map(([wt, list]) => {
      const avgAiMat = list.reduce((s, f) => s + (f.ai_material_cost || 0), 0) / list.length;
      const avgActMat = list.reduce((s, f) => s + (f.actual_material_cost || f.ai_material_cost || 0), 0) / list.length;
      const avgAiLab = list.reduce((s, f) => s + (f.ai_labor_cost || 0), 0) / list.length;
      const avgActLab = list.reduce((s, f) => s + (f.actual_labor_cost || f.ai_labor_cost || 0), 0) / list.length;
      const avgAiTotal = list.reduce((s, f) => s + (f.ai_total || 0), 0) / list.length;
      const avgActual = list.reduce((s, f) => s + (f.actual_selling_price || f.ai_total || 0), 0) / list.length;
      return `${wt}(${list.length}件): AI材料費${Math.round(avgAiMat)}円→実績${Math.round(avgActMat)}円, AI労務費${Math.round(avgAiLab)}円→実績${Math.round(avgActLab)}円, AI合計${Math.round(avgAiTotal)}円→実績売価${Math.round(avgActual)}円`;
    }).join('\n');

    // 3. Claude APIで分析
    const https = require('https');
    const prompt = `建築見積AIの精度改善データです。補正係数をJSON配列で返してください。\n\n${summary}\n\n出力: [{"work_type":"名前","material_adjustment":1.0,"labor_adjustment":1.0,"confidence":0.0,"avg_accuracy":1.0,"notes":"メモ"}]\nルール: 乖離5%未満は1.0、データ1件はconfidence=0.1`;

    const claudeResponse: string = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      });
      const req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }, (res: any) => {
        let data = '';
        res.on('data', (c: string) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const parsed = JSON.parse(data);
            resolve(parsed.content[0].text);
          } else reject(new Error(`Claude ${res.statusCode}: ${data}`));
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // 4. JSONを抽出してSupabaseに書き込み
    const jsonMatch = claudeResponse.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      console.error('学習ループ即時: JSON抽出失敗');
      return;
    }

    const coefficients = JSON.parse(jsonMatch[0]);
    for (const coeff of coefficients) {
      await supabaseRequest('cost_coefficients', 'POST', {
        work_type: coeff.work_type,
        material_adjustment: coeff.material_adjustment,
        labor_adjustment: coeff.labor_adjustment,
        confidence: coeff.confidence,
        sample_count: (byType[coeff.work_type] || []).length,
        avg_accuracy: coeff.avg_accuracy,
        notes: coeff.notes,
        updated_at: new Date().toISOString(),
      }, '?on_conflict=work_type');
    }

    console.log(`学習ループ即時: ${feedback.length}件の実績から${coefficients.length}工種の係数を更新`);
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
