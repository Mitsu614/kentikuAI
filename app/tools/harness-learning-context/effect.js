// 「効き」の測定 — 生成した学習ブロックを実際にAIへ渡し、金額がその会社の実額へ寄るかを見る。
//
// run.js から --api で呼ばれる。単体では使わない。
//
// 何を測るか:
//   run.js が仕込んだテナント1の実績（OCRで読み取った過去の見積書に クロス張替 980円/㎡、
//   クッションフロア 3,800円/㎡ がある）から、本番と同じ関数が組み立てた学習ブロックを
//   そのままAIに渡し、同じ工事の見積が自社単価で積まれるかを見る。
//
//   ★harness-learning との違い:
//     あちらは「[単価] クロス張替: 980円/㎡」という整形済みメモを渡す＝いちばん易しい形。
//     こちらは本番が実際に渡している形（過去の書類の実額・修正履歴の差分・売価の偏り）のまま渡す。
//     現場で効いているかを見るなら、こちらが本物。
//
// 合否:
//   学習ありの誤差が ±8% 以内、かつ 学習なしより誤差が縮んでいること。

const path = require('path');
const { apiKey } = require('../lib/api-key');

const APP = path.resolve(__dirname, '../..');

// 諸経費・粗利の行は直接工事費から外す（正解は直接工事費で作っているため）
const OVERHEAD = ['仮設', '現場管理', '管理費', '福利厚生', '諸経費', '一般管理', '安全', '経費', '値引', '運搬', '産廃', '処分'];
const isOverhead = name => OVERHEAD.some(k => String(name || '').includes(k));
const directTotal = breakdown => (breakdown || [])
  .filter(b => !isOverhead(b.item))
  .reduce((s, b) => s + (Number(b.cost) || 0), 0);

const fmt = n => '¥' + Math.round(n).toLocaleString();
const pct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';

// 正解 = テナント1が過去の見積書で実際に使っている単価 × 今回の数量
const TRUTH = [
  { label: 'クロス張替', qty: 500, unit: '㎡', unitPrice: 980 },
  { label: 'クッションフロア張替', qty: 60, unit: '㎡', unitPrice: 3800 },
];
const truth = TRUTH.reduce((s, t) => s + t.qty * t.unitPrice, 0);

const SPEC = `事務所の内装改修。数量は確定しています。
- 量産クロス張替 500㎡（下地パテ処理込み）
- クッションフロア張替 60㎡
場所は大阪市内。既存クロスの撤去処分を含む。`;

function buildSystem(learningText) {
  return `あなたは大阪の建築見積の専門家（実務経験20年以上）です。
依頼された工事の見積を作成してください。
${learningText}
## ルール
1. 依頼文に書かれた数量をそのまま使う（勝手に増減しない）。
2. breakdown の各行の note に「数量 × 単価 = 金額」の式を必ず書く。
3. 諸経費（現場管理費・一般管理費・運搬・処分費など）を入れる場合は、
   工事そのものの行とは別の行にし、名前に「現場管理費」「諸経費」等を含める。
4. 出力は次のJSONのみ。説明文は書かない。`;
}

const USER = `## 工事内容（依頼）
${SPEC}

以下のJSONだけを返す:
\`\`\`json
{
  "workType": "内装仕上工事",
  "breakdown": [{"item": "項目名", "cost": 金額(数値), "note": "数量×単価=金額"}],
  "estimatedTotal": 総額(数値),
  "confidence": "高/中/低"
}
\`\`\``;

async function call(client, model, learningText) {
  const r = await client.messages.create({
    model,
    max_tokens: 2000,
    temperature: 0,
    system: buildSystem(learningText),
    messages: [{ role: 'user', content: USER }],
  });
  const text = r.content.map(c => (c.type === 'text' ? c.text : '')).join('');
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/(\{[\s\S]*\})/);
  if (!m) throw new Error('no-json');
  return JSON.parse(m[1]);
}

async function measure(ctx, model) {
  console.log('\n──── 効きの測定（本番と同じ学習ブロックをAIに渡す）────');
  for (const t of TRUTH) {
    console.log(`    ${t.label}: ${t.qty}${t.unit} × ${fmt(t.unitPrice)} = ${fmt(t.qty * t.unitPrice)}`);
  }
  console.log(`    正解（直接工事費）= ${fmt(truth)}`);

  // ★本番が渡しているものと同じ。整形し直さない。
  const learningText = ctx.feedbackSummary + ctx.ocrCommentSummary + ctx.fitSummary;
  console.log(`    学習ブロック: ${learningText.length}文字\n`);

  const Anthropic = require(path.join(APP, 'node_modules/@anthropic-ai/sdk'));
  const client = new Anthropic({ apiKey: apiKey() });

  const [without, withL] = await Promise.all([call(client, model, ''), call(client, model, learningText)]);
  const a = directTotal(without.breakdown);
  const b = directTotal(withL.breakdown);
  const errA = (a - truth) / truth;
  const errB = (b - truth) / truth;
  const improved = Math.abs(errB) < Math.abs(errA);
  const ok = Math.abs(errB) <= 0.08 && improved;

  console.log(`  学習なし ${fmt(a)} (${pct(errA)})  →  学習あり ${fmt(b)} (${pct(errB)})`);
  console.log(`  ${ok ? 'OK  自社の実額で積めている' : improved ? '△  寄ったが誤差が残る' : 'NG  自社の実額が効いていない'}`);
  if (!ok) {
    console.log('\n  学習ありの内訳:');
    for (const r of (withL.breakdown || [])) console.log(`    ${fmt(r.cost)}  ${r.item}  |  ${r.note || ''}`);
  }
  return { ok, improved, errA, errB, without: a, with: b, truth };
}

module.exports = { measure };
