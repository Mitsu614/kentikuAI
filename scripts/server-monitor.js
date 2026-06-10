// 建築ブースト サーバー監視スクリプト
// Supabase・learning-server(Render)の状態を定期チェックし、異常時にメール通知

const https = require('https');
const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LEARNING_SERVER_URL = 'https://kenchiku-boost-learning.onrender.com';
const GMAIL_USER = process.env.GMAIL_USER || 'mitsuakinakano0215@gmail.com';
const GMAIL_PASS = process.env.GMAIL_PASS;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'mitsuakinakano0215@gmail.com';

// HTTP GETリクエスト
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { ...headers },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// メール送信
async function sendAlert(subject, body) {
  if (!GMAIL_PASS) {
    console.error('GMAIL_PASS未設定。メール送信スキップ');
    console.log(`[ALERT] ${subject}\n${body}`);
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `建築ブースト監視 <${GMAIL_USER}>`,
    to: NOTIFY_EMAIL,
    subject: `【建築ブースト監視】${subject}`,
    text: body + '\n\n---\n建築ブースト サーバー監視 自動通知\n' + new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
  });
  console.log(`メール送信完了: ${subject}`);
}

async function main() {
  const alerts = [];
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`=== サーバー監視開始: ${now} ===\n`);

  // ──────────────────────────────────────
  // 1. Supabase ヘルスチェック
  // ──────────────────────────────────────
  console.log('1. Supabase チェック...');
  try {
    // DB接続テスト: estimate_feedbackの件数を取得
    const fbRes = await httpGet(
      `${SUPABASE_URL}/rest/v1/estimate_feedback?select=id&limit=1`,
      {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      }
    );
    if (fbRes.status !== 200) {
      alerts.push(`Supabase接続エラー: HTTP ${fbRes.status}`);
      console.log(`  ❌ 接続エラー: HTTP ${fbRes.status}`);
    } else {
      console.log('  ✅ Supabase接続OK');
    }

    // 実績データ件数チェック
    const countRes = await httpGet(
      `${SUPABASE_URL}/rest/v1/estimate_feedback?select=id`,
      {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'count=exact',
        'Range': '0-0',
      }
    );
    // content-rangeヘッダーから総件数を取得
    const countMatch = (countRes.data || '').match(/"id"/g);
    console.log(`  📊 estimate_feedback: レスポンスOK`);

    // Supabase Free plan: DB 500MB, ストレージ 1GB
    // Pro plan: DB 8GB, ストレージ 100GB
    // 件数が多すぎる場合に警告
    const allFbRes = await httpGet(
      `${SUPABASE_URL}/rest/v1/estimate_feedback?select=id&order=id.desc&limit=1`,
      {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      }
    );
    if (allFbRes.status === 200) {
      const lastItems = JSON.parse(allFbRes.data || '[]');
      const lastId = lastItems[0]?.id || 0;
      console.log(`  📊 最新ID: ${lastId}`);
      if (lastId > 50000) {
        alerts.push(`Supabase estimate_feedback が ${lastId} 件を超えました。DBサイズ拡大の可能性あり。プランアップグレードを検討してください。`);
      }
      if (lastId > 80000) {
        alerts.push(`⚠️ 緊急: Supabase estimate_feedback が ${lastId} 件！Free planの500MB上限に近づいている可能性があります。`);
      }
    }

    // cost_coefficients チェック
    const coefRes = await httpGet(
      `${SUPABASE_URL}/rest/v1/cost_coefficients?select=id&order=id.desc&limit=1`,
      {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      }
    );
    if (coefRes.status === 200) {
      console.log('  ✅ cost_coefficients テーブルOK');
    }

    // learning_runs チェック（最終実行日を確認）
    const runRes = await httpGet(
      `${SUPABASE_URL}/rest/v1/learning_runs?select=run_at,status&order=run_at.desc&limit=1`,
      {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      }
    );
    if (runRes.status === 200) {
      const runs = JSON.parse(runRes.data || '[]');
      if (runs.length > 0) {
        const lastRun = new Date(runs[0].run_at);
        const daysSinceLastRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60 * 24);
        console.log(`  📊 最終学習実行: ${runs[0].run_at} (${Math.round(daysSinceLastRun)}日前) status=${runs[0].status}`);
        if (daysSinceLastRun > 14) {
          alerts.push(`学習ループが${Math.round(daysSinceLastRun)}日間実行されていません。GitHub Actionsを確認してください。`);
        }
        if (runs[0].status !== 'success') {
          alerts.push(`最終学習ループのステータスが「${runs[0].status}」です。エラーを確認してください。`);
        }
      }
    }

  } catch (e) {
    alerts.push(`Supabase接続失敗: ${e.message}`);
    console.log(`  ❌ Supabase接続失敗: ${e.message}`);
  }

  // ──────────────────────────────────────
  // 2. Learning Server (Render) ヘルスチェック
  // ──────────────────────────────────────
  console.log('\n2. Learning Server (Render) チェック...');
  try {
    const lsRes = await httpGet(LEARNING_SERVER_URL);
    if (lsRes.status === 200) {
      console.log('  ✅ Learning Server稼働中');
    } else {
      alerts.push(`Learning Server異常: HTTP ${lsRes.status}`);
      console.log(`  ❌ HTTP ${lsRes.status}`);
    }

    // 統計APIチェック
    const statsRes = await httpGet(`${LEARNING_SERVER_URL}/api/stats`);
    if (statsRes.status === 200) {
      const stats = JSON.parse(statsRes.data || '{}');
      const contributorCount = stats.contributor_count || 0;
      const statsCount = (stats.stats || []).length;
      console.log(`  📊 統計: ${contributorCount}社 / ${statsCount}カテゴリ`);
      console.log(`  📊 最終更新: ${stats.updated_at || '不明'}`);

      // Render Free: 512MB RAM, ディスク非永続
      // データが消えてたら警告
      if (contributorCount === 0 && statsCount === 0) {
        alerts.push('Learning Serverのデータが空です。Renderの再起動でデータが消失した可能性があります。');
      }
    }
  } catch (e) {
    alerts.push(`Learning Server接続失敗: ${e.message}。Renderがスリープまたはダウンしている可能性があります。`);
    console.log(`  ❌ 接続失敗: ${e.message}`);
  }

  // ──────────────────────────────────────
  // 3. GitHub Actions（学習ループ）チェック
  // ──────────────────────────────────────
  console.log('\n3. GitHub Actions チェック...');
  // ※GitHub APIはトークンが必要なので、Supabaseのlearning_runs経由で間接チェック済み

  // ──────────────────────────────────────
  // 結果通知
  // ──────────────────────────────────────
  console.log(`\n=== 監視結果: アラート ${alerts.length} 件 ===`);

  if (alerts.length > 0) {
    const body = [
      'サーバー監視で以下の異常を検知しました。',
      '',
      ...alerts.map((a, i) => `${i + 1}. ${a}`),
      '',
      '【対応方法】',
      '- Supabaseプランアップグレード: https://supabase.com/dashboard',
      '- Renderダッシュボード: https://dashboard.render.com/',
      '- GitHub Actions: https://github.com/Mitsu614/kentikuAI/actions',
    ].join('\n');

    await sendAlert(`異常検知 ${alerts.length}件`, body);
    alerts.forEach(a => console.log(`  ⚠️ ${a}`));
  } else {
    console.log('  ✅ 全サーバー正常');
    // 毎日の正常報告は不要（異常時のみ通知）
  }
}

main().catch(e => {
  console.error('監視スクリプトエラー:', e);
  // スクリプト自体のエラーも通知
  sendAlert('監視スクリプトエラー', `スクリプト実行中にエラーが発生しました。\n\n${e.message}\n${e.stack}`).catch(() => {});
  process.exit(1);
});
