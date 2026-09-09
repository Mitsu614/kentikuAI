// OCR取り込みハーネス — 「読み取った書類が、実績としてちゃんとDBに入るか」を測る
//
//   node app/tools/harness-ocr-import/run.js
//
// 何を測るか:
//   本番と同じ関数（src/main/ocr-import.ts の importOcrResultCore）を、使い捨てのSQLiteに対して
//   直接叩き、取り込んだ結果がDBのどこに何と書かれたかを検査する。さらに、その状態で
//   buildLearningContext を呼び、書いた実績がそのまま次の見積プロンプトに載るところまで通しで見る。
//
// なぜ要るか:
//   ここは「実績が確定する瞬間」で、学習ループの入口。長いあいだ、
//   **既存工事に紐づけたときだけ actual_* と feedback_at を書いていなかった**。
//   その結果、お客様が何枚PDFを紐づけても、実績価格アンカーにも修正履歴にも一件も入らず、
//   AIは相場のまま見積を出し続けていた。取り込みは画面から手で試すしかなかったので、
//   誰も気づけなかった。それを機械で落とす。
//
// 何を測らないか:
//   PDFの読み取り精度（AI-OCRそのもの）は測らない。ここは読み取った後の話。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '../..');

function compile() {
  const out = path.join(APP, '.harness-build');
  const cfg = path.join(APP, '.tsconfig.harness.json');
  fs.writeFileSync(cfg, JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { outDir: out, noEmit: false },
    files: ['src/main/ocr-import.ts', 'src/main/learning-context.ts'],
  }, null, 2), 'utf8');
  const tsc = path.join(APP, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tsc, '-p', cfg], { cwd: APP, stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(cfg); } catch (_) {}
  }
  return out;
}

// 読み取った見積書（AI-OCRの出力の形）
function ocrDocument() {
  return {
    documentType: '見積書',
    title: '内装改修工事 B様邸',
    issuerName: 'ふつう工務店',
    clientName: 'B様',
    issueDate: '2026-09-01',
    subtotal: 1000000,
    total: 1100000,
    taxRate: 0.1,
    items: [
      { name: 'クロス張替', category: '内装材', unit: '㎡', quantity: 400, unitPrice: 980, amount: 392000 },
      { name: 'クッションフロア張替', category: '床材', unit: '㎡', quantity: 50, unitPrice: 3800, amount: 190000 },
      { name: '施工費', category: '労務', unit: '式', quantity: 1, unitPrice: 418000, amount: 418000 },
    ],
    _comment: '足場が自社持ちなので安く出せた案件',
  };
}

function main() {
  console.log('\nOCR取り込みハーネス — 読み取った書類が実績としてDBに入るかを見る');
  console.log('（本番の importOcrResultCore を直接呼ぶ。API不使用・無料）\n');

  const outDir = compile();
  const dbMod = require(path.join(outDir, 'database', 'database.js'));
  const ocr = require(path.join(outDir, 'main', 'ocr-import.js'));
  const lc = require(path.join(outDir, 'main', 'learning-context.js'));
  const { queryOne, runSql } = dbMod;

  const dbFile = path.join(os.tmpdir(), `kb-harness-ocr-${process.pid}.db`);
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

  return dbMod.initDatabase(dbFile).then(() => {
    const results = [];
    const check = (name, fn, why) => {
      let pass = false, err = '';
      try { pass = !!fn(); } catch (e) { err = e.message; }
      results.push({ name, pass, err, why });
    };

    const NOW = '2026-09-09 12:00:00';

    // ══ ケースA: 既存のAI見積に、あとから実物の見積書を紐づける ══
    // これが今まで壊れていた経路。AI見積 90万 → 実際は 100万だった、という答え合わせ。
    runSql("INSERT OR REPLACE INTO tenants (id, name) VALUES (1, 'ふつう工務店')", []);
    runSql("INSERT INTO properties (id, name, tenant_id) VALUES (1, 'B様邸', 1)", []);
    runSql("INSERT INTO constructions (id, property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id) VALUES (1, 1, '内装改修工事', '2026-08-01', 350000, 1.3, 'AI自動作成', 1)", []);
    runSql("INSERT INTO materials (id, name, category, unit, unit_price, tenant_id) VALUES (1, 'クロス張替', '内装材', '㎡', 1200, 1)", []);
    runSql('INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (1, 1, 400, 1200)', []);
    // AI見積は 材料480,000（クロス400㎡×1,200）＋人件費350,000 = 830,000。
    // ★ai_total は施工に入っている材料・人件費と必ず一致させること。
    //   実装は紐づけ時にAI側の金額を施工から計算し直すので、ここがズレると検査が嘘になる。
    runSql("INSERT INTO estimate_log (id, tenant_id, construction_id, work_type, ai_material_cost, ai_labor_cost, ai_total, ai_markup_rate, ai_json, created_at) VALUES (1, 1, 1, '内装改修工事', 480000, 350000, 830000, 1.3, '{}', '2026-08-01 10:00:00')", []);

    let reported = null;
    const linkedResult = ocr.importOcrResultCore(
      { ...ocrDocument(), _linkConstructionId: 1, _ocrLogId: null },
      { tenantId: 1, now: () => NOW, reportActuals: fb => { reported = fb; } }
    );

    const con = queryOne('SELECT * FROM constructions WHERE id = 1');
    const log = queryOne('SELECT * FROM estimate_log WHERE id = 1');

    check('紐づけ: 施工の確定実績(actual_*)が入る',
      () => con.actual_material_cost === 582000 && con.actual_labor_cost === 418000 && con.actual_selling_price === 1000000,
      '★ここが空だと実績価格アンカーに一件も載らない。長く壊れていた箇所');
    check('紐づけ: AI見積のログに実額が書き戻る',
      () => log.actual_material_cost === 582000 && log.actual_selling_price === 1000000,
      'AI見積と実額の対がそろって初めて「修正履歴」になる');
    check('紐づけ: feedback_at が立つ',
      () => log.feedback_at === NOW,
      '★修正履歴の抽出条件が feedback_at IS NOT NULL。ここが null だと永久に拾われない');
    check('紐づけ: AI側の金額は書き換えない',
      () => log.ai_material_cost === 480000 && log.ai_total === 830000,
      'AIの原案は答え合わせの基準。上書きすると差分が消える');
    check('紐づけ: 新しい工事を作らない',
      () => linkedResult.constructionId === 1 && queryOne('SELECT COUNT(*) c FROM constructions').c === 1,
      '紐づけたのに別案件が増えると、同じ工事が二重に実績化される');
    check('紐づけ: 実績が確定したと報告される',
      () => reported && reported.actual_selling_price === 1000000 && reported.ai_total === 830000,
      '学習完了メール・（方針次第で）クラウド送信の起点');

    // ══ ケースB: 紐づけ先が無い新規案件として取り込む ══
    reported = null;
    let savedImages = 0;
    const newResult = ocr.importOcrResultCore(
      { ...ocrDocument(), title: '外壁塗装工事 C様邸', _siteImages: ['x'.repeat(200)] },
      { tenantId: 1, now: () => NOW, reportActuals: fb => { reported = fb; }, saveSiteImages: imgs => { savedImages = imgs.length; } }
    );
    const newCon = queryOne('SELECT * FROM constructions WHERE id = ?', [newResult.constructionId]);
    const newLog = queryOne('SELECT * FROM estimate_log WHERE construction_id = ?', [newResult.constructionId]);

    check('新規: 確定実績(actual_*)が入る',
      () => newCon.actual_selling_price === 1000000 && newCon.actual_material_cost === 582000,
      '新規取込は書類の金額がそのまま実額');
    check('新規: 現場写真の保存が呼ばれる',
      () => savedImages === 1,
      '写真の無い新規案件はどの建物か分からなくなり実績として使えない');
    check('新規: feedback_at は立てない',
      () => !newLog.feedback_at,
      'AI見積が存在しない＝差0%。ここを実績の対として数えると売価の偏りの平均が薄まる');
    check('新規: 明細が材料として登録される',
      () => queryOne('SELECT COUNT(*) c FROM construction_materials WHERE construction_id = ?', [newResult.constructionId]).c === 2,
      '人件費・施工費の行は労務へ回すので、材料は2行が正しい');

    // ══ ガード: 写真も紐づけも無い取り込みは弾く ══
    check('写真も紐づけも無ければ弾く',
      () => {
        try { ocr.importOcrResultCore({ ...ocrDocument() }, { tenantId: 1 }); return false; }
        catch (e) { return String(e.message).includes('現場写真'); }
      },
      'どの建物の金額か分からない実績が入ると、学習が丸ごと汚れる');

    // ══ 通し: 取り込んだ実績が、次の見積プロンプトに載るか ══
    const ctx = lc.buildLearningContext({ estTid: 1, isolated: false, heatshield: false });
    const all = ctx.feedbackSummary + ctx.ocrCommentSummary + ctx.fitSummary;
    check('通し: 実績価格アンカーに載る',
      () => all.includes('1,000,000'),
      '★取り込みから見積プロンプトまでが一本につながっていること');
    check('通し: 修正履歴に載る',
      () => all.includes('修正履歴') && all.includes('830,000'),
      'AI83万→実際100万（+20%）が次の見積に効く');

    let ok = 0, ng = 0;
    for (const r of results) {
      if (r.pass) { ok++; console.log(`  OK  ${r.name}`); }
      else { ng++; console.log(`  NG  ${r.name}${r.err ? ' (' + r.err + ')' : ''}`); console.log(`      なぜ見るか: ${r.why}`); }
    }
    console.log(`\n──────── まとめ ────────`);
    console.log(`合格: ${ok} / ${ok + ng}`);

    try { fs.unlinkSync(dbFile); } catch (_) {}
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(ng > 0 ? 1 : 0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
