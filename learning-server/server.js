// 建築ブースト 学習ループ中央サーバー
// 各ユーザーから匿名統計を受信し、集約して配信する
// データはSupabaseに永続化（Render再起動でもデータ消失しない）
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3100;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// メモリキャッシュ（起動時にSupabaseから読み込み）
let allContributions = [];

// --- Supabase API helpers ---
function supabaseRequest(method, table, query, body) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) { resolve(null); return; }
    const url = new URL(SUPABASE_URL + '/rest/v1/' + table + (query || ''));
    const jsonBody = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname, path: url.pathname + url.search, method,
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
    };
    if (method === 'POST') options.headers['Prefer'] = 'resolution=merge-duplicates,return=minimal';
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : null);
        } else {
          console.error('Supabase error:', res.statusCode, data.substring(0, 200));
          resolve(null);
        }
      });
    });
    req.on('error', e => { console.error('Supabase request error:', e.message); resolve(null); });
    if (jsonBody) req.write(jsonBody);
    req.end();
  });
}

// Supabaseからデータを復元
async function loadFromSupabase() {
  try {
    const rows = await supabaseRequest('GET', 'learning_contributions', '?select=*&order=received_at.desc&limit=500');
    if (rows && Array.isArray(rows)) {
      allContributions = rows.map(r => ({
        id: r.id,
        received_at: r.received_at,
        stats: r.stats_data || [],
        feedback: r.feedback_data || [],
      }));
      console.log('Supabaseから ' + allContributions.length + ' 件のデータを復元');
    }
  } catch (e) {
    console.error('Supabase読み込みエラー:', e.message);
  }
}

// Supabaseに保存
async function saveToSupabase(data) {
  try {
    await supabaseRequest('POST', 'learning_contributions', '', {
      id: data.id,
      received_at: data.received_at,
      stats_data: data.stats || [],
      feedback_data: data.feedback || [],
    });
  } catch (e) {
    console.error('Supabase保存エラー:', e.message);
  }
}

// 古いデータをクリーンアップ（1日以上前かつ小規模データ）
async function cleanupOldData() {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  try {
    await supabaseRequest('DELETE', 'learning_contributions',
      '?received_at=lt.' + oneDayAgo + '&stats_count=lt.5');
  } catch (_) {}
}

function saveData() {
  // 後方互換: メモリのみ更新（永続化はsaveToSupabaseで行う）
}

// 全データを工事タイプ別に集約
function aggregate() {
  const byType = {};
  const fbByType = {};

  for (const contrib of allContributions) {
    // 施工統計
    for (const s of (contrib.stats || [])) {
      const key = (s.work_type || '').trim();
      if (!key) continue;
      if (!byType[key]) byType[key] = { cnt: 0, mat_sum: 0, labor_sum: 0, markup_sum: 0, selling_sum: 0, contributors: new Set() };
      byType[key].cnt += s.cnt || 0;
      byType[key].mat_sum += (s.avg_material || 0) * (s.cnt || 1);
      byType[key].labor_sum += (s.avg_labor || 0) * (s.cnt || 1);
      byType[key].markup_sum += (s.avg_markup || 0) * (s.cnt || 1);
      byType[key].selling_sum += (s.avg_selling || 0) * (s.cnt || 1);
      byType[key].contributors.add(contrib.id || 'unknown');
    }
    // フィードバック統計
    for (const f of (contrib.feedback || [])) {
      const key = (f.work_type || '').trim();
      if (!key) continue;
      if (!fbByType[key]) fbByType[key] = { cnt: 0, mat_diff_sum: 0, labor_diff_sum: 0, total_diff_sum: 0 };
      fbByType[key].cnt += f.cnt || 0;
      fbByType[key].mat_diff_sum += (f.avg_mat_diff_pct || 0) * (f.cnt || 1);
      fbByType[key].labor_diff_sum += (f.avg_labor_diff_pct || 0) * (f.cnt || 1);
      fbByType[key].total_diff_sum += (f.avg_total_diff_pct || 0) * (f.cnt || 1);
    }
  }

  const stats = Object.entries(byType)
    .map(([work_type, v]) => ({
      work_type,
      total_cnt: v.cnt,
      avg_material: v.cnt > 0 ? Math.round(v.mat_sum / v.cnt) : 0,
      avg_labor: v.cnt > 0 ? Math.round(v.labor_sum / v.cnt) : 0,
      avg_markup: v.cnt > 0 ? Math.round(v.markup_sum / v.cnt) : 0,
      avg_selling: v.cnt > 0 ? Math.round(v.selling_sum / v.cnt) : 0,
      contributor_count: v.contributors.size,
    }))
    .sort((a, b) => b.total_cnt - a.total_cnt)
    .slice(0, 30);

  const feedback = Object.entries(fbByType)
    .map(([work_type, v]) => ({
      work_type,
      cnt: v.cnt,
      avg_mat_diff_pct: v.cnt > 0 ? Math.round(v.mat_diff_sum / v.cnt) : 0,
      avg_labor_diff_pct: v.cnt > 0 ? Math.round(v.labor_diff_sum / v.cnt) : 0,
      avg_total_diff_pct: v.cnt > 0 ? Math.round(v.total_diff_sum / v.cnt) : 0,
    }))
    .filter(f => f.cnt >= 2)
    .slice(0, 20);

  return { stats, feedback, contributor_count: allContributions.length, updated_at: new Date().toISOString() };
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/api/stats' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        data.id = `anon_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        data.received_at = new Date().toISOString();
        // メモリキャッシュ更新（古いデータを除去）
        const oneDayAgo = Date.now() - 86400000;
        allContributions = allContributions.filter(c => new Date(c.received_at || 0).getTime() > oneDayAgo || (c.stats || []).length > 5);
        allContributions.push(data);
        // Supabaseに永続化
        await saveToSupabase(data);
        await cleanupOldData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, contributors: allContributions.length }));
        console.log(`受信: ${(data.stats || []).length}件の統計 / 合計${allContributions.length}社`);
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else if (req.url === '/api/stats' && req.method === 'GET') {
    const result = aggregate();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } else if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      supabase_configured: !!(SUPABASE_URL && SUPABASE_KEY),
      supabase_url: SUPABASE_URL ? SUPABASE_URL.substring(0, 30) + '...' : '(not set)',
      memory_contributions: allContributions.length,
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('建築ブースト 学習ループサーバー稼働中');
  }
});

// 起動時にSupabaseからデータを復元してからリッスン
loadFromSupabase().then(() => {
  server.listen(PORT, () => {
    console.log(`学習ループサーバー起動: http://localhost:${PORT}`);
    console.log(`蓄積データ: ${allContributions.length}件（Supabaseから復元）`);
  });
}).catch(e => {
  console.error('起動エラー:', e);
  server.listen(PORT, () => {
    console.log(`学習ループサーバー起動（Supabase接続なし）: http://localhost:${PORT}`);
  });
});
