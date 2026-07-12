// 電気設備 回帰ハーネス — 実行器
// 使い方:
//   node run.js --dry            … 正解計算のみ（API不使用・無料）。相場モデルとシナリオの検算用
//   node run.js                  … 全シナリオをAIに見積らせ、直接工事費を正解レンジと突き合わせる
//   node run.js --only=e2,e5     … 一部だけ
//   node run.js --conc=3         … 同時実行数（既定3）
//
// 何を測るか:
//   相場DB（cost-reference.ts の電気セクション）を "正解" とし、AIが同じ単価で積めているかを見る。
//   外部の顧客データが要らないので今すぐ回る。「AIが相場を無視した/単価を取り違えた/桁を外した」を検出する。
// 何を測らないか:
//   相場そのものの当否（=市場との一致）は測れない。それは実案件の正解データが溜まってから（本物の①）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { computeReference } = require('./cost-model');
const { SCENARIOS } = require('./scenarios');

const APP = 'C:/Users/mitsu/OneDrive/Desktop/kentikuAI/app';

// ── 引数 ──
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const conc = Number((args.find(a => a.startsWith('--conc=')) || '').split('=')[1]) || 3;
const onlyArg = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];
const only = onlyArg ? onlyArg.split(',') : null;
const targets = only ? SCENARIOS.filter(s => only.includes(s.id)) : SCENARIOS;

// ── 相場DBの電気セクションを実ソースから抽出（実装とベンチを乖離させない）──
function electricRef() {
  const src = fs.readFileSync(path.join(APP, 'src/main/cost-reference.ts'), 'utf8');
  const i = src.indexOf('## ★ 電気設備工事 相場データ');
  if (i < 0) throw new Error('電気相場セクションが見つかりません');
  let j = src.indexOf('\n## ', i + 10);           // 次のトップ見出し or 末尾
  if (j < 0) j = src.lastIndexOf('`;');            // 末尾のテンプレ閉じ
  return src.slice(i, j).trim();
}

// ── APIキー（api-config.json から復号）──
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

// ── 明細を「直接工事費(電気)」と「諸経費(仮設/現場管理/福利厚生)」に振り分ける ──
const OVERHEAD = ['仮設', '現場管理', '管理費', '福利厚生', '諸経費', '一般管理', '安全管理', '経費', '値引'];
function isOverhead(name) { return OVERHEAD.some(k => (name || '').includes(k)); }
function sumDirect(breakdown) {
  let direct = 0, over = 0;
  for (const b of (breakdown || [])) {
    const c = Number(b.cost) || 0;
    if (isOverhead(b.item)) over += c; else direct += c;
  }
  return { direct, over };
}

function fmt(n) { return '¥' + Math.round(n).toLocaleString(); }

function buildPrompt(scn, refText) {
  const system = `あなたは大阪の電気工事の積算担当者です（実務20年）。以下の相場データベースを唯一の単価根拠として、依頼された電気設備工事の見積を作成してください。

${refText}

## 厳守ルール
1. 上記の相場データの単価レンジ内で積算する。器具・数量ベース（◯箇所/◯台/◯m/◯面）で、材工共で拾う。
2. breakdown の各行の note に必ず「数量 × 単価 = 金額」の式を書く。
3. 依頼された数量をそのまま使う（勝手に増減しない）。
4. 諸経費（現場管理費・福利厚生費）を入れる場合は、電気の直接工事費とは別の行にし、名前に「現場管理費」「福利厚生費」を含める（電気器具の行に混ぜない）。
5. 出力は次のJSONのみ。説明文は書かない。`;
  const user = `## 工事内容（依頼）
${scn.spec}

以下のJSONだけを返す:
\`\`\`json
{
  "workType": "電気設備工事",
  "breakdown": [{"item": "項目名", "cost": 金額(数値), "note": "数量×単価=金額"}],
  "estimatedMaterialCost": 材料費合計(数値),
  "estimatedLaborCost": 施工費合計(数値),
  "estimatedTotal": 総額(数値),
  "confidence": "高/中/低"
}
\`\`\``;
  return { system, user };
}

async function callAI(client, scn, refText) {
  const { system, user } = buildPrompt(scn, refText);
  const r = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = r.content.map(c => c.type === 'text' ? c.text : '').join('');
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/(\{[\s\S]*\})/);
  if (!m) throw new Error('no-json');
  return JSON.parse(m[1]);
}

// 判定: AI直接工事費が正解レンジ[min,max]（±15%の許容）に入れば OK
function judge(ref, direct) {
  const lo = ref.min * 0.85, hi = ref.max * 1.15;
  const inRange = direct >= lo && direct <= hi;
  const ratio = direct / ref.mid;   // 中央比（1.0が理想）
  return { inRange, ratio };
}

async function main() {
  const refText = electricRef();

  // ── まず正解を全件表示（DRYでもここは出る）──
  console.log('\n===== 電気設備 回帰ハーネス =====');
  console.log(`シナリオ ${targets.length}件 / モード: ${DRY ? 'DRY(正解計算のみ・無料)' : 'AI突き合わせ'}\n`);
  const refs = {};
  for (const s of targets) {
    const ref = computeReference(s.items);
    refs[s.id] = ref;
    console.log(`■ ${s.id}  ${s.title}`);
    for (const r of ref.rows) {
      console.log(`    ${r.label} ×${r.qty}  @${fmt(r.mid)}  = ${fmt(r.subtotalMid)}  (レンジ @${fmt(r.low)}〜@${fmt(r.high)})`);
    }
    console.log(`    正解 直接工事費: ${fmt(ref.min)} 〜 ${fmt(ref.max)}  （中央 ${fmt(ref.mid)}）\n`);
  }

  if (DRY) {
    console.log('DRY完了。正解モデルとシナリオの検算のみ（APIは呼んでいません）。');
    return;
  }

  // ── AI突き合わせ ──
  const Anthropic = require(path.join(APP, 'node_modules/@anthropic-ai/sdk'));
  const client = new Anthropic({ apiKey: apiKey() });

  const results = [];
  for (let i = 0; i < targets.length; i += conc) {
    const batch = targets.slice(i, i + conc);
    const settled = await Promise.all(batch.map(async s => {
      try {
        const est = await callAI(client, s, refText);
        const { direct, over } = sumDirect(est.breakdown);
        const j = judge(refs[s.id], direct);
        return { s, est, direct, over, ...j, ok: true };
      } catch (e) {
        return { s, ok: false, err: e.message };
      }
    }));
    results.push(...settled);
    process.stdout.write(`  進捗 ${Math.min(i + conc, targets.length)}/${targets.length}\r`);
  }

  // ── レポート ──
  console.log('\n\n===== 結果 =====');
  console.log('ID'.padEnd(20) + '正解中央'.padEnd(14) + 'AI直接'.padEnd(14) + '比'.padEnd(8) + '判定');
  let pass = 0; const ratios = [];
  for (const r of results.sort((a, b) => a.s.id.localeCompare(b.s.id))) {
    if (!r.ok) { console.log(r.s.id.padEnd(20) + 'ERROR: ' + r.err); continue; }
    ratios.push(r.ratio);
    if (r.inRange) pass++;
    const mark = r.inRange ? '✅' : (r.ratio < 1 ? '⚠️過小' : '⚠️過大');
    console.log(
      r.s.id.padEnd(20) +
      fmt(refs[r.s.id].mid).padEnd(14) +
      fmt(r.direct).padEnd(14) +
      ('×' + r.ratio.toFixed(2)).padEnd(8) +
      mark + (r.over ? `  (諸経費 ${fmt(r.over)}別)` : '')
    );
  }
  ratios.sort((a, b) => a - b);
  const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
  const okCount = results.filter(r => r.ok).length;
  console.log(`\n合格(レンジ内): ${pass}/${okCount}   中央比: ×${med.toFixed(2)}   ${med < 0.9 ? '→ 系統的に過小' : med > 1.1 ? '→ 系統的に過大' : '→ 偏りは小さい'}`);
  console.log('※「比」は AI直接工事費 ÷ 正解中央。1.00が理想。レンジ(min〜max)の±15%内で合格。');

  fs.writeFileSync(path.join(__dirname, 'last-result.json'),
    JSON.stringify(results.map(r => ({ id: r.s.id, ok: r.ok, direct: r.direct, over: r.over, ratio: r.ratio, inRange: r.inRange, ref: refs[r.s.id], est: r.est, err: r.err })), null, 2));
  console.log('詳細: last-result.json');
}

main().catch(e => { console.error(e); process.exit(1); });
