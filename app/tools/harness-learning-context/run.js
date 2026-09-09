// 学習コンテキスト・ハーネス — 「貯めた実績が、次の見積のプロンプトに本当に載るか」を測る
//
//   node app/tools/harness-learning-context/run.js
//   node app/tools/harness-learning-context/run.js --dump=1     … テナント1の生成物を全部見る
//   node app/tools/harness-learning-context/run.js --api        … 生成したブロックをAIに渡し、金額が自社の実額に寄るかまで見る
//
// 何を測るか:
//   本番と同じ関数（src/main/learning-context.ts の buildLearningContext）を、
//   使い捨てのSQLite（sql.js）に仕込んだ実績データに対して直接叩き、
//   「修正履歴・自社実績アンカー・OCR書類の実額・現場メモ・掛率のクセ・売価の偏り・
//     チャットで教わった好み」が、狙いどおりの文章になって出てくるかを確かめる。
//
//   ★プロンプトのコピーは持たない。本番の関数そのものを呼ぶので、本番を直せばここも追従する。
//     （harness-roof はプロンプトを複製して持っていたため本番と乖離した。同じ轍を踏まない）
//
// 何を測らないか:
//   AIが実際にその金額へ寄せるか（＝効き）は測らない。それは harness-learning（API使用）の役目。
//   ここは「材料がプロンプトに載っているか」だけを、API無しで一瞬で見る。
//
// なぜ要るか:
//   ここが長いこと壊れていた。
//     ・OCRを既存工事に紐づけても actual_* を書いておらず、実績が1件もプロンプトに載らなかった
//     ・自社実績アンカーが隔離テナントでしか出ず、通常テナントは何枚PDFを読ませても効かなかった
//   どちらも「AIが金額を外す」形でしか気づけなかった。ここで機械的に落とす。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '../..');
const DUMP = process.argv.find(a => a.startsWith('--dump='));
const API = process.argv.includes('--api');   // 実際にAIへ渡して金額が寄るかまで見る（有料・数十秒）
const MODEL = (process.argv.find(a => a.startsWith('--model=')) || '').split('=')[1] || 'claude-sonnet-4-6';

// ── 本番のTSを、その場でコンパイルして読み込む（コピーを持たないため）──
function compile() {
  // ★出力先は app/ の中。tmp に出すと node_modules を辿れず sql.js が見つからない。
  const out = path.join(APP, '.harness-build');
  // ★本番と同じ tsconfig を継いでコンパイルする。
  //   ファイルを直接コマンドラインに並べると tsconfig が読まれず、@types/node が効かずに
  //   「Cannot find name 'path'」で落ちる。設定ごと継ぐのが確実。
  const cfg = path.join(APP, '.tsconfig.harness.json');
  fs.writeFileSync(cfg, JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { outDir: out, noEmit: false },
    files: ['src/main/learning-context.ts'],
  }, null, 2), 'utf8');
  // .bin/tsc.cmd は Windows では spawn できない（EINVAL）。tsc本体のJSを node で直に叩く。
  const tsc = path.join(APP, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tsc, '-p', cfg], { cwd: APP, stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(cfg); } catch (_) {}
  }
  return out;
}

// ── 検証用の実績データを仕込む ──
// 3社ぶん入れる。金額が会社をまたいで混ざらないこと自体が、いちばん大事な検査項目。
function seed(db) {
  const { runSql } = db;

  // テナント1: ふつうの内装・塗装屋。実績あり・OCR書類あり・チャット学習あり
  runSql("INSERT OR REPLACE INTO tenants (id, name) VALUES (1, 'ふつう工務店')", []);
  // テナント2: 隔離学習（遮熱シート専門）。相場が存在しない商材
  runSql("INSERT OR REPLACE INTO tenants (id, name) VALUES (2, '遮熱シート専門')", []);
  runSql("UPDATE tenants SET isolated_learning = 1, industry_type = 'heatshield' WHERE id = 2", []);
  // テナント3: 入ったばかりで実績ゼロ。ここに他社の金額が漏れていないかを見る
  runSql("INSERT OR REPLACE INTO tenants (id, name) VALUES (3, '新規契約したばかりの会社')", []);

  runSql("INSERT INTO properties (id, name, tenant_id) VALUES (1, 'A様邸', 1)", []);

  // ── テナント1の確定実績（予実入力・OCR紐づけで actual_* が入った状態）──
  const cons = [
    [1, '内装改修工事', 1.30, '内装クロス張替', 1200000, 800000, 2600000],
    [2, '外壁塗装工事', 1.30, '外壁シリコン3回塗り', 600000, 400000, 1300000],
    [3, '屋根葺替工事', 1.30, '屋根カバー工法', 900000, 700000, 2080000],
  ];
  for (const [id, title, mk, note, mat, labor, sell] of cons) {
    runSql('INSERT INTO constructions (id, property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id, actual_material_cost, actual_labor_cost, actual_selling_price) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, 1, title, '2026-08-01', labor, mk, note, 1, mat, labor, sell]);
  }

  // ── テナント1の「AI見積 vs 実額」の対（修正履歴・売価の偏りの元）──
  // AIは毎回2割ほど安く出しており、人が上へ直している、という状況を作る。
  const logs = [
    [1, '内装改修工事', 1000000, 700000, 2210000, 1200000, 800000, 2600000],
    [2, '外壁塗装工事', 520000, 340000, 1120000, 600000, 400000, 1300000],
    [3, '屋根葺替工事', 750000, 600000, 1750000, 900000, 700000, 2080000],
  ];
  for (const [cid, wt, aiMat, aiLab, aiTot, acMat, acLab, acSell] of logs) {
    runSql('INSERT INTO estimate_log (tenant_id, construction_id, work_type, ai_material_cost, ai_labor_cost, ai_total, ai_markup_rate, actual_material_cost, actual_labor_cost, actual_selling_price, actual_markup_rate, ai_json, feedback_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [1, cid, wt, aiMat, aiLab, aiTot, 1.3, acMat, acLab, acSell, 1.3,
       JSON.stringify({ breakdown: [{ item: wt }] }), '2026-08-10 10:00:00', '2026-08-01 10:00:00']);
  }

  // ── テナント1がOCRで読み取った過去の見積書（＋現場メモ＝紐づけコメント）──
  runSql('INSERT INTO ocr_log (tenant_id, document_type, title, total, subtotal, ocr_json, comment, imported, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [1, '見積書', '内装改修 A様邸', 2600000, 2600000, JSON.stringify({
      subtotal: 2600000,
      items: [
        { name: 'クロス張替', quantity: 320, unit: 'm2', unitPrice: 980, amount: 313600 },
        { name: 'クッションフロア張替', quantity: 45, unit: 'm2', unitPrice: 3800, amount: 171000 },
      ],
    }), '足場が自社持ちなので他社より安く出せる', 1, '2026-08-05 09:00:00']);

  // ── テナント1がチャットで教えた好み ──
  runSql('INSERT INTO chat_learnings (tenant_id, category, key, value, source, confidence) VALUES (?,?,?,?,?,?)',
    [1, '単価', 'クロス張替（量産・材工共）', '980円/㎡（下地パテ処理込み・自社職人）', 'chat', 0.8]);

  // ── テナント2（隔離）の実績。テナント1に漏れてはいけない金額 ──
  runSql("INSERT INTO properties (id, name, tenant_id) VALUES (2, '森鉄筋 養老工場', 2)", []);
  runSql('INSERT INTO constructions (id, property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id, actual_material_cost, actual_labor_cost, actual_selling_price) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [10, 2, '遮熱シート スカイ工法', '2026-07-01', 480000, 1.25, 'スカイ工法 折板屋根', 2, 1900000, 480000, 3120000]);
  runSql('INSERT INTO ocr_log (tenant_id, document_type, title, total, subtotal, ocr_json, comment, imported, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [2, '見積書', '遮熱スカイ工法 森鉄筋様', 3120000, 3120000, JSON.stringify({
      subtotal: 3120000,
      items: [{ name: 'スカイ工法施工 折板屋根用', quantity: 480, unit: 'm2', unitPrice: 6500, amount: 3120000 }],
    }), '特許シート。相場は存在しない', 1, '2026-07-02 09:00:00']);
}

// ── 検査項目 ──
// [対象テナント, 名前, 判定関数, なぜ見るのか]
function checks(ctx1, ctx2, ctx3) {
  const all1 = ctx1.feedbackSummary + ctx1.ocrCommentSummary + ctx1.fitSummary;
  const all2 = ctx2.feedbackSummary + ctx2.ocrCommentSummary + ctx2.fitSummary;
  const all3 = ctx3.feedbackSummary + ctx3.ocrCommentSummary + ctx3.fitSummary;

  return [
    ['通常', '修正履歴が載る', () => all1.includes('修正履歴'),
      'AI見積を人がどう直したかが次の見積に効く土台'],
    ['通常', '修正履歴に実額が入る', () => all1.includes('1,200,000') && all1.includes('2,600,000'),
      '％だけでなく実際の金額が見えていること'],
    ['通常', '自社実績アンカーが載る', () => all1.includes('自社の確定実績の価格'),
      '★以前は隔離テナントしか出なかった。通常テナントの実績が死んでいた回帰の検査'],
    ['通常', 'アンカーの言い方が強すぎない', () => all1.includes('全国相場より優先する参考値') && !all1.includes('唯一の正解データ'),
      '相場も使える通常テナントで「実績が唯一の正解」と言うと逆に外れる'],
    ['通常', 'OCR書類の実額が載る', () => all1.includes('過去に読み取った自社書類') && all1.includes('980'),
      '★紐づけたPDFの単価が次の見積に効くこと'],
    ['通常', 'OCRの現場メモが載る', () => all1.includes('足場が自社持ちなので他社より安く出せる'),
      'コメント＝紐づけ情報。金額の理由はここにしか無い'],
    ['通常', '売価の偏りが出る', () => /売価の偏り】この会社は過去3件でAI見積を平均\+\d+%/.test(all1),
      '毎回いくら高め/低めに直すかの癖を次回に先回りさせる'],
    ['通常', '掛率のクセが出る', () => all1.includes('値付けのクセ') && all1.includes('130%'),
      '粗利率の一般ルールより自社の実掛率を優先させる'],
    ['通常', 'チャットの好みが載る', () => all1.includes('980円/㎡（下地パテ処理込み・自社職人）'),
      'チャットで教わった単価が使われること'],

    ['隔離', 'アンカーの言い方が強い', () => all2.includes('唯一の正解データ'),
      '相場が存在しない商材は自社実績が唯一の基準'],
    ['隔離', '自社の遮熱実績が載る', () => all2.includes('3,120,000'),
      '実額アンカーが発火していること'],

    ['隔離', '他社の金額が入らない', () => !all2.includes('2,600,000') && !all2.includes('1,200,000'),
      '★金額はテナント隔離。ふつう工務店の原価が遮熱テナントに漏れないこと'],
    ['新規', '実績ゼロなら空', () => all3.trim() === '',
      '何も無いのに文章だけ出ると、AIが幻の実績に合わせにいく'],
    ['新規', '他社の金額が1円も出ない', () => !all3.includes('2,600,000') && !all3.includes('3,120,000') && !all3.includes('980'),
      '★金額はテナント隔離。新規契約先に他社の実額が見えたら事故'],
  ];
}

function main() {
  console.log('\n学習コンテキスト・ハーネス — 貯めた実績がプロンプトに載るかを見る');
  console.log('（本番の buildLearningContext を直接呼ぶ。API不使用・無料）\n');

  const outDir = compile();
  const dbMod = require(path.join(outDir, 'database', 'database.js'));
  const lc = require(path.join(outDir, 'main', 'learning-context.js'));

  const dbFile = path.join(os.tmpdir(), `kb-harness-lc-${process.pid}.db`);
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

  return dbMod.initDatabase(dbFile).then(() => {
    seed(dbMod);

    const ctx1 = lc.buildLearningContext({ estTid: 1, isolated: false, heatshield: false });
    const ctx2 = lc.buildLearningContext({ estTid: 2, isolated: true, heatshield: true });
    const ctx3 = lc.buildLearningContext({ estTid: 3, isolated: false, heatshield: false });

    if (DUMP) {
      const tid = DUMP.split('=')[1];
      const c = tid === '2' ? ctx2 : tid === '3' ? ctx3 : ctx1;
      console.log('──── テナント' + tid + ' の生成物 ────');
      console.log(c.feedbackSummary + c.ocrCommentSummary + c.fitSummary);
      console.log('──────────────────────────\n');
    }

    let ok = 0, ng = 0;
    let group = '';
    for (const [g, name, fn, why] of checks(ctx1, ctx2, ctx3)) {
      if (g !== group) { console.log(`【${g}テナント】`); group = g; }
      let pass = false, err = '';
      try { pass = !!fn(); } catch (e) { err = e.message; }
      if (pass) { ok++; console.log(`  OK  ${name}`); }
      else { ng++; console.log(`  NG  ${name}${err ? ' (' + err + ')' : ''}`); console.log(`      なぜ見るか: ${why}`); }
    }

    console.log(`\n──────── まとめ ────────`);
    console.log(`合格: ${ok} / ${ok + ng}`);
    if (ng > 0) {
      console.log('\n★貯めた実績がプロンプトに載っていません。載らなければ学習は存在しないのと同じです。');
      console.log('  中身を見る: node app/tools/harness-learning-context/run.js --dump=1');
    }

    const cleanup = () => {
      try { fs.unlinkSync(dbFile); } catch (_) {}
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    };
    if (!API) { cleanup(); process.exit(ng > 0 ? 1 : 0); }
    // --api: ここまでで作った学習ブロックを、そのままAIに渡して金額が寄るかを見る
    return require('./effect').measure(ctx1, MODEL).then(r => {
      cleanup();
      process.exit(ng > 0 || !r.ok ? 1 : 0);
    }, e => {
      // API側で落ちても一時ビルドを残さない（残すと次回のコンパイル結果と混ざる）
      cleanup();
      throw e;
    });
  });
}

main().catch(e => { console.error(e); process.exit(1); });
