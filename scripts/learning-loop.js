const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function supabaseGet(table, query) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1/' + table + (query || ''));
    https.get({
      hostname: url.hostname, path: url.pathname + url.search,
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(res.statusCode + ': ' + data));
      });
    }).on('error', reject);
  });
}

function supabasePost(table, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1/' + table);
    const jsonBody = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST',
      headers: Object.assign({
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      }, extraHeaders || {}),
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data ? JSON.parse(data) : null);
        else reject(new Error(res.statusCode + ': ' + data));
      });
    });
    req.on('error', reject);
    req.write(jsonBody);
    req.end();
  });
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const parsed = JSON.parse(data);
          resolve(parsed.content[0].text);
        } else reject(new Error('Claude ' + res.statusCode + ': ' + data));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== learning loop start ===');

  const feedback = await supabaseGet('estimate_feedback', '?select=*&order=created_at.desc&limit=1000');
  console.log('feedback count: ' + feedback.length);

  if (feedback.length < 3) {
    console.log('not enough data (< 3), skipping');
    await supabasePost('learning_runs', {
      feedback_count: feedback.length,
      coefficients_updated: 0,
      summary: 'skipped: not enough data',
      status: 'skipped',
    });
    return;
  }

  const byType = {};
  for (const fb of feedback) {
    const wt = fb.work_type || 'unknown';
    if (!byType[wt]) byType[wt] = [];
    byType[wt].push(fb);
  }

  const summary = Object.entries(byType).map(function(entry) {
    const wt = entry[0];
    const list = entry[1];
    const avgAiTotal = list.reduce(function(s, f) { return s + (f.ai_total || 0); }, 0) / list.length;
    const avgActual = list.reduce(function(s, f) { return s + (f.actual_selling_price || f.ai_total || 0); }, 0) / list.length;
    const avgAiMat = list.reduce(function(s, f) { return s + (f.ai_material_cost || 0); }, 0) / list.length;
    const avgActMat = list.reduce(function(s, f) { return s + (f.actual_material_cost || f.ai_material_cost || 0); }, 0) / list.length;
    const avgAiLab = list.reduce(function(s, f) { return s + (f.ai_labor_cost || 0); }, 0) / list.length;
    const avgActLab = list.reduce(function(s, f) { return s + (f.actual_labor_cost || f.ai_labor_cost || 0); }, 0) / list.length;
    return wt + ' (' + list.length + '件): AI材料費' + Math.round(avgAiMat) + '円→実績' + Math.round(avgActMat) + '円, AI労務費' + Math.round(avgAiLab) + '円→実績' + Math.round(avgActLab) + '円, AI合計' + Math.round(avgAiTotal) + '円→実績売価' + Math.round(avgActual) + '円';
  }).join('\n');

  var prompt = 'あなたは建築見積AIの精度改善を担当するデータサイエンティストです。\n\n';
  prompt += '以下は建築見積AIの予測と実際の施工費用の比較データです。各工事種別の見積補正係数を算出してください。\n\n';
  prompt += '## 実績データ\n' + summary + '\n\n';
  prompt += '## 出力形式\nJSON配列のみ返してください。\n';
  prompt += '[{"work_type":"工事種別名","material_adjustment":1.0,"labor_adjustment":1.0,"confidence":0.0,"avg_accuracy":1.0,"notes":"分析メモ"}]\n\n';
  prompt += 'ルール:\n- データ2件未満はconfidence=0.1以下\n- 乖離5%未満は補正1.0\n- 外れ値は除外\n- notesに根拠を書く';

  console.log('calling Claude API...');
  var response = await callClaude(prompt);

  var jsonMatch = response.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) {
    console.error('failed to extract JSON:', response.substring(0, 500));
    await supabasePost('learning_runs', {
      feedback_count: feedback.length,
      coefficients_updated: 0,
      summary: 'JSON parse failed',
      status: 'error',
    });
    return;
  }

  var coefficients = JSON.parse(jsonMatch[0]);
  console.log('coefficients calculated: ' + coefficients.length);

  for (var i = 0; i < coefficients.length; i++) {
    var coeff = coefficients[i];
    await supabasePost('cost_coefficients', {
      work_type: coeff.work_type,
      material_adjustment: coeff.material_adjustment,
      labor_adjustment: coeff.labor_adjustment,
      confidence: coeff.confidence,
      sample_count: (byType[coeff.work_type] || []).length,
      avg_accuracy: coeff.avg_accuracy,
      notes: coeff.notes,
      updated_at: new Date().toISOString(),
    });
  }

  console.log(coefficients.length + ' coefficients updated');

  await supabasePost('learning_runs', {
    feedback_count: feedback.length,
    coefficients_updated: coefficients.length,
    summary: Object.keys(byType).length + ' types analyzed, ' + coefficients.length + ' updated',
    status: 'success',
  });

  console.log('=== learning loop complete ===');
}

main().catch(function(e) { console.error(e); process.exit(1); });
