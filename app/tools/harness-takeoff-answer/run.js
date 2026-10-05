// 答え合わせの「正解の取り込み・ひも付け」ハーネス
//
//   node app/tools/harness-takeoff-answer/run.js
//
// 本番と同じ関数（src/main/takeoff-answer.ts）を直接叩き、次を確かめる。AIは呼ばない（無料）。
//   ・Excel・CSVの表から、見出しの行を見つけて正解の行を取り出せるか（小計行・空行・結合セルの部位）
//   ・AIの書き写し（JSON）から、小計や数量の無い行を捨てられるか
//   ・正解の行を、AIの拾い出しの正しい材料に結べるか。単位違い・名前違いを勝手に結ばないか
//   ・部屋ごとの行が合計されるか

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '../..');

function compile() {
  const out = path.join(APP, '.harness-build');
  const cfg = path.join(APP, '.tsconfig.harness.json');
  fs.writeFileSync(cfg, JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { outDir: out, noEmit: false },
    files: ['src/main/takeoff-answer.ts'],
  }, null, 2), 'utf8');
  const tsc = path.join(APP, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tsc, '-p', cfg], { cwd: APP, stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(cfg); } catch (_) {}
  }
  const hit = ['main/takeoff-answer.js', 'takeoff-answer.js'].map(p => path.join(out, p)).find(p => fs.existsSync(p));
  return require(hit);
}

const T = compile();
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`); }
}

// ── 1. Excelの表（見出しが3行目・部位は結合セルで1行目だけ・小計行あり）
console.log('1. Excel・CSVの表を読む');
const grid = [
  ['○○邸 内装 数量拾い出し表'],
  ['', '', '', '2026/09/30'],
  ['部位', '室名', '名称', '規格', '数量', '単位'],
  ['壁', 'LDK', 'ビニルクロス', '量産品', '52.4', '㎡'],
  ['', '洋室1', 'ビニルクロス', '量産品', '38.1', '㎡'],
  ['', '', '小計', '', '90.5', '㎡'],
  ['天井', 'LDK', 'ビニルクロス', '量産品', '20.5', 'm2'],
  ['床', 'LDK', 'ソフト巾木', 'H60', '28.0', 'm'],
  ['', '', '', '', '', ''],
  ['床', '洋室1', 'クッションフロア', '', '1,234.5', '㎡'],
  ['床', '洋室1', '備考のみの行', '', '', ''],
];
const g1 = T.parseAnswerGrid(grid, 'Sheet1');
check('エラー無しで読める', !g1.error, g1.error);
check('数量のある5行だけ取る（小計・空行・数量無しは捨てる）', g1.rows.length === 5, JSON.stringify(g1.rows.map(r => r.name)));
check('結合セルの部位を上から引き継ぐ（洋室1のクロス＝壁）', g1.rows[1] && g1.rows[1].part === '壁', JSON.stringify(g1.rows[1]));
check('規格を名前に続ける', g1.rows[0] && g1.rows[0].name === 'ビニルクロス 量産品', g1.rows[0] && g1.rows[0].name);
check('カンマ付きの数量を数に直す', g1.rows[4] && g1.rows[4].qty === 1234.5, g1.rows[4] && g1.rows[4].qty);
check('どこから読んだかを残す', g1.rows[0] && g1.rows[0].src === 'Sheet1 4行目', g1.rows[0] && g1.rows[0].src);
const g2 = T.parseAnswerGrid([['a', 'b'], ['1', '2']]);
check('見出しが無い表はエラーで返す（推測で読まない）', g2.rows.length === 0 && !!g2.error);
const g3 = T.parseAnswerGrid([['工種', '名称', '数量', '単位'], ['内装', '石膏ボード', '10', '枚']]);
check('「工種」と「名称」が両方あれば、名称を名前・工種を部位にする', g3.rows[0] && g3.rows[0].name === '石膏ボード' && g3.rows[0].part === '内装', JSON.stringify(g3.rows[0]));

// ── 2. AIの書き写し
console.log('2. AIの書き写し（JSON）を読む');
const j = T.parseAnswerJson('```json\n{"rows":[{"part":"壁","room":"LDK","name":"ビニルクロス","unit":"㎡","quantity":52.4,"page":1},{"name":"小計","unit":"㎡","quantity":90,"page":1},{"name":"読めない","unit":"㎡","quantity":null},{"name":"巾木","unit":"m","quantity":"28","page":2}]}\n```');
check('小計・数量無しを捨てて2行', j.length === 2, JSON.stringify(j));
check('文字の数量も数に直す', j[1] && j[1].qty === 28);
check('ページを残す', j[0] && j[0].src === '1ページ');
check('壊れたJSONは空で返す', T.parseAnswerJson('すみません読めません').length === 0);

// ── 3. ひも付け
console.log('3. 正解をAIの拾い出しにひも付ける');
const items = [
  { part: '壁', room: 'LDK', name: 'ビニルクロス', unit: '㎡', quantity: 55, aiQuantity: 50 },
  { part: '壁', room: '洋室1', name: 'ビニルクロス', unit: '㎡', quantity: 40, aiQuantity: 40 },
  { part: '天井', room: 'LDK', name: 'ビニルクロス', unit: '㎡', quantity: 21 },
  { part: '床', room: null, name: 'ソフト巾木', unit: 'm', quantity: 27 },
  { part: '天井', room: null, name: '軽量鉄骨天井下地', unit: '㎡', quantity: 60 },
  { part: '床', room: null, name: 'クッションフロア', unit: '㎡', quantity: 30 },
];
const groups = T.groupTakeoffItems(items);
const wallKey = groups.find(g => g.part === '壁').key;
const ceilKey = groups.find(g => g.part === '天井' && g.name === 'ビニルクロス').key;
check('部屋ごとの行を合計する（壁クロス 50+40=90）', groups.find(g => g.key === wallKey).ai === 90);
check('AIの数量は拾い出し直後の値（aiQuantity）を使う', groups.find(g => g.key === wallKey).idxs.length === 2);
const answers = [
  { part: '壁', name: 'ビニルクロス 量産品', unit: '㎡', qty: 52.4 },  // 0 → 壁クロス
  { name: '天井クロス', unit: 'm2', qty: 20.5 },                       // 1 → 天井クロス（部位を名前に含む・単位表記違い）
  { name: 'ソフト巾木 H60', unit: 'ｍ', qty: 28 },                      // 2 → 巾木
  { name: 'ソフト巾木', unit: '㎡', qty: 3 },                            // 3 → 単位違い：結ばず候補
  { name: 'LGS天井下地', unit: '㎡', qty: 58 },                          // 4 → 似ているだけ：結ぶが「要確認」
  { name: '見切り縁', unit: 'm', qty: 12 },                              // 5 → 該当なし＝拾い漏れ
  { name: 'CF', unit: '㎡', qty: 31 },                                   // 6 → 略称は結ばない
  { name: '石膏ボード', unit: '㎡', qty: 80 },                           // 7 → 関係ない材料には結ばない
];
const m = T.matchAnswers(groups, answers);
check('壁のクロス → 壁ビニルクロス', m[0].key === wallKey, JSON.stringify(m[0]));
check('「天井クロス」(m2) → 天井ビニルクロス(㎡)', m[1].key === ceilKey, JSON.stringify(m[1]));
check('ソフト巾木 H60 (ｍ) → ソフト巾木 (m)', m[2].key && m[2].key.includes('巾木'), JSON.stringify(m[2]));
check('単位違いは結ばず、候補だけ出して要確認', m[3].key === null && !!m[3].suggestKey && m[3].needsCheck, JSON.stringify(m[3]));
check('似ているだけのもの（LGS天井下地→軽量鉄骨天井下地）は結んでも「要確認」を立てる', m[4].needsCheck === true, JSON.stringify(m[4]));
check('該当なしは拾い漏れ扱い（key=null）', m[5].key === null && !m[5].suggestKey, JSON.stringify(m[5]));
check('略称(CF)を推測で結ばない', m[6].key === null, JSON.stringify(m[6]));
check('関係ない材料（石膏ボード）には結ばない', m[7].key === null, JSON.stringify(m[7]));
check('名前も単位も一致するものは要確認にしない', !m[0].needsCheck && !m[2].needsCheck, JSON.stringify([m[0], m[2]]));
check('単位の書き方を揃える（m2=平米=㎡、ｍ=m、ヶ所=箇所）',
  T.normUnit('m2') === '㎡' && T.normUnit('平米') === '㎡' && T.normUnit('ｍ') === 'm' && T.normUnit('ヶ所') === '箇所');

// ── 4. 拾い出しソフト（建築の電卓 など）の書き出し。数字は作り物
console.log('4. 拾い出しソフトの書き出し（「数量」列が無い表）を読む');
const calcWall = [
  ['建築の電卓 見本'],
  ['見本物件_現状図_壁', ''],
  ['#', '壁名', '色', '壁長', '壁高', '壁面積', '開口数', '開口面積', '梁立面積', '減算後面積', 'ブラインド', '枠'],
  ['(mm)', '(mm)', '(m²)', '(m²)', '(m²)', '(m²)', '(mm)', '(m)', '(mm)', '(mm)'],
  [1, '会議室', '', 10000, 2400, 24, 0, 0, 0, 24, 0, 10000],
  [2, '会議室アクセント', '', 5000, 2400, 12, 0, 0, 0, 12, 0, 5000],
  [3, '廊下', '', 20000, 2400, 48, 2, 3.78, 0, 44.22, 0, 20000],
  ['合計', 35000, 84, 2, 3.78, 0, 80.22, 0, 0, 35000, 35000],
  ['#', '壁名', '開口名', '開口種類', '幅/直径', '高さ', '面積', '個数', '枠', '枠合計', '面積減算', '減算面積'],
  ['(mm)', '(mm)', '(m²)', '(m)', '(m)', '(m²)'],
  [1, '廊下', 'シングル扉', '片開きドア', 900, 2100, 1.89, 2, 5.1, 10.2, 'する', 3.78],
];
const cw = T.parseAnswerGrid(calcWall, '見本_壁', '見本物件_現状図_壁');
check('「部屋名・壁名＋面積」の見出しを見つける', !cw.error && cw.rows.length === 3, JSON.stringify(cw));
check('壁は開口を引いた後の面積（減算後面積）を使う', cw.rows[2] && cw.rows[2].qty === 44.22, cw.rows[2] && cw.rows[2].qty);
check('合計行の下の開口一覧は読まない', cw.rows.every((r) => r.name !== 'シングル扉' && r.qty !== 1.89));
check('シート名の末尾「_壁」から部位＝壁', cw.rows.every((r) => r.part === '壁' && r.unit === '㎡' && r.byRoom));
const calcFloor = [
  ['見本物件_現状図_床'],
  ['#', '部屋名', '色', '部屋面積', '部屋外周', '壁高', '壁面積'],
  ['(m²)', '(mm)', '(mm)', '(m²)'],
  [1, '部屋1', '', 50.5, 30000, 0, 0],
  [2, '部屋2', '', 4.25, 8200, 0, 0],
  ['合計', 54.75, 38200, 0],
];
const cf = T.parseAnswerGrid(calcFloor, '見本_床', '見本物件_現状図（2）_床');
check('床は部屋面積を使い、部位＝床', cf.rows.length === 2 && cf.rows[0].qty === 50.5 && cf.rows[0].part === '床', JSON.stringify(cf.rows));
check('空のシート（見出しだけ）はエラーで返す', !!T.parseAnswerGrid([['見本_巾木等'], ['']], 'x', '見本_巾木等').error);
check('シート名から部位（天井・巾木）', T.partFromSheetName('見本_天井') === '天井' && T.partFromSheetName('見本_巾木等') === '巾木');

console.log('5. 部位×部屋の行を、部位でAIの行にひも付ける');
const gc = T.groupTakeoffItems([
  { part: '壁', room: '会議室', name: 'ビニルクロス', unit: '㎡', quantity: 30 },
  { part: '壁', room: '廊下', name: 'ビニルクロス', unit: '㎡', quantity: 40 },
  { part: '壁', room: '会議室', name: 'アクセントクロス', unit: '㎡', quantity: 10 },
  { part: '壁', room: null, name: '石膏ボード下地', unit: '㎡', quantity: 200 },
  { part: '床', room: null, name: 'タイルカーペット', unit: '㎡', quantity: 50 },
]);
const mc = T.matchAnswers(gc, cw.rows);
const cloth = gc.find((g) => g.name === 'ビニルクロス').key;
const accent = gc.find((g) => g.name === 'アクセントクロス').key;
check('「会議室」の壁 → ビニルクロス（下地・数量最大のボードではなく仕上げ）', mc[0].key === cloth, JSON.stringify(mc[0]));
check('候補が複数のときは「要確認」', mc[0].needsCheck === true);
check('「会議室アクセント」→ アクセントクロス（名前の手がかり）', mc[1].key === accent && !mc[1].needsCheck, JSON.stringify(mc[1]));
check('手がかりの無い行をアクセントクロスに結ばない', mc[2].key === cloth, JSON.stringify(mc[2]));
const mf = T.matchAnswers(gc, cf.rows);
check('床の行は床の唯一の行に結び、要確認にしない', mf[0].key === gc.find((g) => g.part === '床').key && !mf[0].needsCheck, JSON.stringify(mf[0]));
const mn = T.matchAnswers(gc, [{ name: '部屋1', unit: '㎡', qty: 20, part: '天井', room: '部屋1', byRoom: true }]);
check('AIに無い部位（天井）は拾い漏れ扱い', mn[0].key === null, JSON.stringify(mn[0]));

console.log(`\n全体: 合格 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
