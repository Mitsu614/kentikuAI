// 内訳の 0円行ハーネス — 「CF施工費 0円」の再発を見張る（API不使用・無料）
//
//   node app/tools/harness-estimate-rows/run.js
//
// 経緯（原状回復リハーサル 2026-08-04）:
//   [施工費] 施工費（CF床張り 38㎡） 1人工 @0円 = 0円 が見積に出た。
//   原因はプロンプトの矛盾。ルール8は「材工共の行を作るな・人件費は施工費行へ」と言いながら、
//   出力例は「クッションフロア張替 CF 材工共 4,500円/㎡」を1行で出していた。相場DBの内装単価も材工共。
//   AIは材料行に材工共単価を入れ、ルール8を守るために「施工費は含む」の意味で 0円 の施工費行を立てていた。
//
// ここで見ること:
//   ① 本番の dropPricelessBreakdownRows が、AIの 0円行を「出力切れ」と取り違えないこと
//   ② プロンプトの出力例に、材工共の1行（CF・クロス）が戻っていないこと
//   ③ プロンプトに「0円の行を出すな」「材工共は材料と手間に割れ」が残っていること

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..', '..');

function compile() {
  const out = path.join(APP, '.harness-build');
  const cfg = path.join(APP, '.tsconfig.harness-rows.json');
  fs.writeFileSync(cfg, JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { outDir: out, noEmit: false },
    files: ['src/main/breakdown-rows.ts'],
  }, null, 2), 'utf8');
  const tsc = path.join(APP, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tsc, '-p', cfg], { cwd: APP, stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(cfg); } catch (_) {}
  }
  const js = [path.join(out, 'breakdown-rows.js'), path.join(out, 'main', 'breakdown-rows.js')].find(p => fs.existsSync(p));
  return require(js);
}

function main() {
  const rows = compile();
  const mainSrc = fs.readFileSync(path.join(APP, 'src', 'main', 'main.ts'), 'utf8');

  // リハーサルで出た内訳の再現（CF施工費が 0円）
  const rehearsal = () => ({
    breakdown: [
      { item: 'クロス張替', category: '材料', quantity: 130, unit: 'm2', unitPrice: 1000, cost: 130000 },
      { item: 'クッションフロア張替', category: '材料', quantity: 38, unit: 'm2', unitPrice: 4000, cost: 152000 },
      { item: '施工費（クロス張り）', category: '施工費', quantity: 5, unit: '人工', unitPrice: 19700, cost: 98500 },
      { item: '施工費（CF床張り 38㎡）', category: '施工費', quantity: 1, unit: '人工', unitPrice: 0, cost: 0 },
    ],
  });
  // 出力切れ（最後の行に金額が無い）
  const truncated = () => ({
    breakdown: [
      { item: 'クロス張替', category: '材料', quantity: 130, unit: 'm2', unitPrice: 1000, cost: 130000 },
      { item: '諸経費', category: '経費' },
    ],
  });

  const r1 = rehearsal(); const d1 = rows.dropPricelessBreakdownRows(r1); const w1 = rows.droppedRowWarnings(d1);
  const r2 = truncated(); const d2 = rows.dropPricelessBreakdownRows(r2); const w2 = rows.droppedRowWarnings(d2);
  const sum = r => r.breakdown.reduce((s, b) => s + b.cost, 0);

  // 分析用プロンプトの出力例ブロック
  const exStart = mainSrc.indexOf('## 出力例（キッチンリフォームの場合）');
  const exBlock = exStart >= 0 ? mainSrc.slice(exStart, mainSrc.indexOf('manDaysBreakdownの書き方例', exStart)) : '';

  const checks = [
    ['0円の施工費行は落ちる', () => !r1.breakdown.some(b => b.cost === 0)],
    ['0円行を落としても総額は変わらない', () => sum(r1) === 380500],
    ['0円行を「出力切れ」と言わない', () => d1.truncated === 0 && !w1.some(w => w.includes('途中で切れた'))],
    ['0円だった行を名指しする', () => w1.some(w => w.includes('施工費（CF床張り 38㎡）'))],
    ['0円行の警告は「直していない」印つき', () => w1.some(w => w.includes('金額は変更していません'))],
    ['出力切れはこれまでどおり出力切れと言う', () => d2.truncated === 1 && d2.zeroPriced.length === 0 && w2.some(w => w.includes('途中で切れた'))],
    ['出力例が見つかる', () => exBlock.length > 0],
    ['出力例に材工共の1行（CF・クロス）が無い', () => !/材工共\s*[\d,]+円/.test(exBlock)],
    ['出力例のCFは材料と施工費に分かれている', () => /"クッションフロア", "category": "材料"/.test(exBlock) && /施工費（[^"]*CF[^"]*）", "category": "施工費"/.test(exBlock)],
    ['ルール: 0円の行を出すな', () => mainSrc.includes('金額0円の行を出すな')],
    ['ルール: 相場の内装単価は材工共なので割れ', () => mainSrc.includes('相場データの内装単価')],
  ];

  let ng = 0;
  console.log('\n内訳の 0円行ハーネス（API不使用）\n');
  for (const [name, fn] of checks) {
    let ok = false; try { ok = !!fn(); } catch (_) {}
    if (!ok) ng++;
    console.log(`  ${ok ? 'OK' : 'NG'}  ${name}`);
  }
  console.log(`\n${checks.length - ng}/${checks.length} OK`);
  process.exit(ng ? 1 : 0);
}

main();
