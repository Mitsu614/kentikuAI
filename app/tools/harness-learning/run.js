// 学習ハーネス — 実行器
//
// 使い方:
//   node run.js --dry              … 正解（自社単価×数量）の計算だけ。API不使用・無料
//   node run.js                    … 各シナリオを「学習なし」「学習あり」の2回AIに投げて誤差を比べる
//   node run.js --only=L1,L3       … 一部だけ
//   node run.js --conc=2           … 同時実行数（既定2。学習あり/なしの2本で1組なので実際は倍動く）
//   node run.js --model=claude-opus-4-8   … モデルを変える（既定はアプリと同じ claude-sonnet-4-6）
//
// 何を測るか:
//   「この会社の本当の数字を教えると、AIの見積がその会社の実額に寄るか」。
//   同じ依頼を、学習メモ**なし**と**あり**で2回見積らせ、正解（自社単価×数量）からの
//   ズレがどれだけ縮むかを見る。チャットで数字を聞き出す機能（AIから質問する仕組み）が
//   金額に効いているか、これで確かめられる。
//
// 何を測らないか:
//   自社単価そのものの当否は測らない（それは実案件の実績で決まる）。
//   ここで見るのは「教えた数字を、AIが素直に使えているか」だけ。
//
// 合否の考え方:
//   学習ありの誤差が ±8% 以内なら OK（教えた単価をそのまま使えている）。
//   学習なしより誤差が縮んでいなければ NG（学習が金額に効いていない＝回帰）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { SCENARIOS, truthTotal } = require('./scenarios');

// ── 引数 ──
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const conc = Number((args.find(a => a.startsWith('--conc=')) || '').split('=')[1]) || 2;
const model = (args.find(a => a.startsWith('--model=')) || '').split('=')[1] || 'claude-sonnet-4-6';
const onlyArg = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];
const only = onlyArg ? onlyArg.split(',') : null;
const targets = only ? SCENARIOS.filter(s => only.some(o => s.id.startsWith(o))) : SCENARIOS;

// ── APIキー（api-config.json から復号。アプリと同じ鍵の作り方）──
function apiKey() {
  const key = crypto.createHash('sha256').update(os.hostname() + os.userInfo().username + 'kentiku-salt').digest();
  const cfg = JSON.parse(fs.readFileSync(process.env.APPDATA + '/kenchiku-boost/api-config.json', 'utf8'));
  const d = cfg.anthropicKey;
  if (!d || !d.startsWith('enc:')) return d;
  const b = Buffer.from(d.slice(4), 'base64');
  const dc = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  dc.setAuthTag(b.subarray(12, 28));
  return dc.update(b.subarray(28)) + dc.final('utf8');
}

const fmt = n => '¥' + Math.round(n).toLocaleString();
const pct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';

// 諸経費・粗利の行は直接工事費から外す（正解は直接工事費で作っているため）
const OVERHEAD = ['仮設', '現場管理', '管理費', '福利厚生', '諸経費', '一般管理', '安全', '経費', '値引', '運搬', '産廃', '処分'];
function isOverhead(name) { return OVERHEAD.some(k => String(name || '').includes(k)); }
function directTotal(breakdown) {
  let direct = 0;
  for (const b of (breakdown || [])) {
    if (isOverhead(b.item)) continue;
    direct += Number(b.cost) || 0;
  }
  return direct;
}

// ── プロンプト（アプリのチャット見積と同じ考え方。学習ブロックだけを出し入れする）──
function buildPrompt(scn, withLearning) {
  const learningText = withLearning
    ? '\n## この会社について学習済み（★ここに載っている単価・歩掛を必ず使うこと）\n'
      + scn.learnings.map(l => `- [${l.category}] ${l.key}: ${l.value}`).join('\n')
      + '\n\n★上記はこの会社が実際に使っている数字です。全国相場より必ず優先してください。\n'
    : '';

  const system = `あなたは大阪の建築見積の専門家（実務経験20年以上）です。
依頼された工事の見積を作成してください。
${learningText}
## ルール
1. 依頼文に書かれた数量をそのまま使う（勝手に増減しない）。
2. breakdown の各行の note に「数量 × 単価 = 金額」の式を必ず書く。
3. 諸経費（現場管理費・一般管理費・運搬・処分費など）を入れる場合は、
   工事そのものの行とは別の行にし、名前に「現場管理費」「諸経費」等を含める。
4. 出力は次のJSONのみ。説明文は書かない。`;

  const user = `## 工事内容（依頼）
${scn.spec}

以下のJSONだけを返す:
\`\`\`json
{
  "workType": "${scn.workType}",
  "breakdown": [{"item": "項目名", "cost": 金額(数値), "note": "数量×単価=金額"}],
  "estimatedTotal": 総額(数値),
  "confidence": "高/中/低"
}
\`\`\``;
  return { system, user };
}

async function callAI(client, scn, withLearning) {
  const { system, user } = buildPrompt(scn, withLearning);
  const r = await client.messages.create({
    model,
    max_tokens: 2000,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = r.content.map(c => (c.type === 'text' ? c.text : '')).join('');
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/(\{[\s\S]*\})/);
  if (!m) throw new Error('no-json');
  return JSON.parse(m[1]);
}

async function main() {
  console.log(`\n学習ハーネス — 教えた数字が金額に効いているかを測る`);
  console.log(`モデル: ${model} / シナリオ: ${targets.length}件${DRY ? ' / --dry（API不使用）' : ''}\n`);

  // 正解の一覧（--dry はここまで）
  for (const scn of targets) {
    const t = truthTotal(scn);
    console.log(`[${scn.id}] ${scn.title}`);
    for (const row of scn.truth) {
      console.log(`    ${row.label}: ${row.qty}${row.unit} × ${fmt(row.unitPrice)} = ${fmt(row.qty * row.unitPrice)}`);
    }
    console.log(`    正解（直接工事費）= ${fmt(t)}\n`);
  }
  if (DRY) { console.log('--dry のためAIは呼びません。'); return; }

  const Anthropic = require(path.join('C:/Users/mitsu/OneDrive/Desktop/kentikuAI/app', 'node_modules/@anthropic-ai/sdk'));
  const client = new Anthropic({ apiKey: apiKey() });

  const results = [];
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(conc, queue.length) }, async () => {
    while (queue.length) {
      const scn = queue.shift();
      const truth = truthTotal(scn);
      const row = { id: scn.id, title: scn.title, truth };
      try {
        const [without, withL] = await Promise.all([callAI(client, scn, false), callAI(client, scn, true)]);
        row.without = directTotal(without.breakdown);
        row.with = directTotal(withL.breakdown);
        row.errWithout = (row.without - truth) / truth;
        row.errWith = (row.with - truth) / truth;
        row.improved = Math.abs(row.errWith) < Math.abs(row.errWithout);
        row.ok = Math.abs(row.errWith) <= 0.08 && row.improved;
        row.breakdownWith = withL.breakdown;
      } catch (e) {
        row.error = e.message;
      }
      results.push(row);
      console.log(row.error
        ? `[${row.id}] エラー: ${row.error}`
        : `[${row.id}] 学習なし ${fmt(row.without)}(${pct(row.errWithout)}) → 学習あり ${fmt(row.with)}(${pct(row.errWith)}) ${row.ok ? 'OK' : row.improved ? '改善したが誤差が残る' : 'NG（効いていない）'}`);
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => a.id.localeCompare(b.id));
  const done = results.filter(r => !r.error);
  const avg = arr => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
  const avgWithout = avg(done.map(r => Math.abs(r.errWithout)));
  const avgWith = avg(done.map(r => Math.abs(r.errWith)));

  console.log('\n──────── まとめ ────────');
  console.log(`平均誤差  学習なし ${(avgWithout * 100).toFixed(1)}%  →  学習あり ${(avgWith * 100).toFixed(1)}%`);
  console.log(`合格（誤差8%以内かつ改善）: ${done.filter(r => r.ok).length} / ${done.length}`);
  const bad = done.filter(r => !r.improved);
  if (bad.length) {
    console.log('\n★教えた数字が効いていないシナリオ:');
    for (const r of bad) console.log(`  - [${r.id}] ${r.title}（学習あり ${pct(r.errWith)}）`);
  }

  const out = path.join(__dirname, 'last-result.json');
  fs.writeFileSync(out, JSON.stringify({ model, at: new Date().toISOString(), avgWithout, avgWith, results }, null, 2), 'utf8');
  console.log(`\n結果を保存: ${out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
