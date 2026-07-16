// 遮熱シート（山下さん）見積 正規化ハーネス — 実行器
// 使い方:
//   node run.js            … 全シナリオの生AI出力を正規化し、正解(約300万)への収束を検証（API不使用・無料）
//   node run.js --only=case-a-1855
//
// 何を測るか:
//   AIが出した生の内訳を、main.ts と同じ遮熱シート正規化（二重計上除去→材工共まとめ→諸経費固定）に
//   かけると、山下さんの正解（材工共5,500円/㎡＋固定諸経費 ≒ 300万）に収束するかを見る。
//   → 「300になるように」を機械で確認・回帰できる。実装の正規表現・上限は main.ts から読むので乖離しない。
// 何を測らないか:
//   AIが最初に出す生の金額そのものの当否は測らない（それはプロンプト側の仕事）。ここは後処理の収束のみ。

const { normalizeHeatshield, HEATSHIELD_MARKUP, loadImplConstants } = require('./cost-model');
const { SCENARIOS, TOLERANCE, truth, effectiveQty } = require('./scenarios');

const args = process.argv.slice(2);
const onlyArg = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];
const only = onlyArg ? onlyArg.split(',') : null;
const targets = only ? SCENARIOS.filter(s => only.includes(s.id)) : SCENARIOS;

const yen = n => '¥' + Math.round(n).toLocaleString();
const pct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';

function run() {
  const { bakedIn, overheadCap } = loadImplConstants();
  console.log('遮熱シート正規化ハーネス（正解＝約300万への収束を検証）');
  console.log(`実装から抽出: 除去パターン=/${bakedIn.source}/ ・ 諸経費上限=${yen(overheadCap)} ・ 掛率=${HEATSHIELD_MARKUP}`);
  console.log('許容: 正解 ±' + (TOLERANCE * 100) + '%\n');

  const results = [];
  for (const s of targets) {
    const before = s.rawBreakdown.reduce((a, b) => a + (+b.cost || 0), 0);
    const eq = effectiveQty(s);                 // 展開係数1.4統一で数量を確定
    const target = truth(eq);                    // 正解も確定数量で計算
    const { breakdown, total, steps } = normalizeHeatshield(s.rawBreakdown, eq);
    const dev = (total - target) / target;
    const pass = Math.abs(dev) <= TOLERANCE;
    results.push({ id: s.id, pass, total, target, dev });

    console.log(`■ ${s.id} — ${s.label}`);
    console.log(`  屋根 ${s.roofAreaM2}㎡ / 展開係数×${s.developFactor}→確定数量 ${eq}㎡`);
    console.log(`  正規化前(AI生): ${yen(before)}`);
    for (const st of steps) console.log(`    ${st.step}: ${st.detail}`);
    console.log('  正規化後の内訳:');
    for (const b of breakdown) console.log(`    ${(b.category || '?').padEnd(3)} | ${b.item} … ${yen(b.cost)}`);
    console.log(`  正規化後 総額: ${yen(total)}（税抜）`);
    console.log(`  正解(税抜): ${yen(target)}（税込${yen(Math.round(target * 1.1))}） / 乖離: ${pct(dev)} → ${pass ? '✅ PASS' : '❌ FAIL'}\n`);
  }

  const passed = results.filter(r => r.pass).length;
  console.log('─'.repeat(60));
  console.log(`結果: ${passed}/${results.length} PASS`);
  for (const r of results) console.log(`  ${r.pass ? '✅' : '❌'} ${r.id}: ${yen(r.total)}（正解${yen(r.target)}・${pct(r.dev)}）`);
  process.exit(passed === results.length ? 0 : 1);
}

run();
