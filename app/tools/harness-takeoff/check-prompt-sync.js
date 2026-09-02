// ハーネスが本番（main.ts）と同じ文面を投げているかを見張る。
//
// なぜ要るか: ハーネスは「本番と同じプロンプトを投げる」前提で精度を測っている。
// ここがズレると、測っているのは本番ではない別物になり、計測の意味が消える。
// 実際 2026-08-27 に次の2つのズレが見つかった。どちらも人の目では気づけない。
//   ① prompt.txt の34行目（本番では ${takeoffAreaSection} 等が展開される行）が
//      テンプレートリテラルのまま貼られて壊れていた。
//   ② 依頼文の面積セクションを accuracy.js が独自に短く書き直しており、
//      本番にある「数量をこの面積にぴったり合わせろ」の指示が丸ごと抜けていた。
//      これが抜けると部屋の拾い落としに気づけない（本番の実測で床が正解の62%だった箇所）。
//
// 使い方:
//   node app/tools/harness-takeoff/check-prompt-sync.js          … 照合するだけ（ズレていたら終了コード1）
//   node app/tools/harness-takeoff/check-prompt-sync.js --write  … 本番に合わせて上書き
//
// リリース前に回すこと。

const fs = require('fs');
const path = require('path');

const BT = String.fromCharCode(96);   // バッククォート
const BS = String.fromCharCode(92);   // バックスラッシュ
const DIR = __dirname;
const MAIN = path.join(DIR, '..', '..', 'src', 'main', 'main.ts');

const src = fs.readFileSync(MAIN, 'utf8').replace(/\r\n/g, '\n').split('\n');

function unescapeBackticks(s) {
  return s.split(BS + BT).join(BT);
}

// ── ① 拾い出しプロンプト本体（takeoffDrawingCore の中） ──
// 本番で ${...} が展開される行は、ハーネス側では目印にして持つ。
// accuracy.js / run.js が、ここに面積セクション・対象・工事内容を差し込む。
function extractPrompt() {
  const fnAt = src.findIndex((l) => l.includes('const takeoffDrawingCore'));
  if (fnAt < 0) throw new Error('main.ts に takeoffDrawingCore が見つかりません');

  const openMark = "content.push({ type: 'text', text: " + BT;
  // 同じ関数内に 【資料N】 を積む content.push も居るので、本文の書き出しで特定する
  const startAt = src.findIndex((l, i) => i > fnAt && l.includes(openMark) && l.includes('あなたは建築の積算士'));
  if (startAt < 0) throw new Error('takeoffDrawingCore の中にプロンプト本体が見つかりません');

  const closeMark = BT + ' });';
  let endAt = -1;
  for (let i = startAt; i < src.length; i++) {
    if (i > startAt && src[i].endsWith(closeMark) && !src[i].endsWith(BS + closeMark)) { endAt = i; break; }
  }
  if (endAt < 0) throw new Error('プロンプトの終わり（' + closeMark + '）が見つかりません');

  const lines = src.slice(startAt, endAt + 1);
  lines[0] = lines[0].slice(lines[0].indexOf(openMark) + openMark.length);
  lines[lines.length - 1] = lines[lines.length - 1].slice(0, -closeMark.length);

  return unescapeBackticks(
    lines.map((l) => (l.startsWith('${takeoffAreaSection}') ? '{{CONTEXT}}' : l)).join('\n')
  ).replace(/\n$/, '');
}

// ── ② 依頼文で指定された面積のセクション（formatCommentAreasForPrompt の返り値） ──
// 面積の一覧そのものは呼び出しごとに変わるので {{AREAS}} にして持つ。
function extractAreaSection() {
  const fnAt = src.findIndex((l) => l.includes('function formatCommentAreasForPrompt'));
  if (fnAt < 0) throw new Error('main.ts に formatCommentAreasForPrompt が見つかりません');

  const startAt = src.findIndex((l, i) => i > fnAt && l.trim().startsWith('return ' + BT));
  if (startAt < 0) throw new Error('面積セクションの本文が見つかりません');

  let endAt = -1;
  for (let i = startAt + 1; i < src.length; i++) {
    if (src[i].trim() === BT + ';') { endAt = i; break; }
  }
  if (endAt < 0) throw new Error('面積セクションの終わりが見つかりません');

  const lines = src.slice(startAt, endAt);
  lines[0] = lines[0].slice(lines[0].indexOf('return ' + BT) + ('return ' + BT).length);

  return unescapeBackticks(
    lines.map((l) => (l.trim() === '${lines}' ? '{{AREAS}}' : l)).join('\n')
  );
}

const TARGETS = [
  { file: 'prompt.txt', label: '拾い出しプロンプト本体', want: extractPrompt() },
  { file: 'area-section.txt', label: '依頼文の面積セクション', want: extractAreaSection() },
];

const write = process.argv.includes('--write');
let ng = 0;

for (const t of TARGETS) {
  const p = path.join(DIR, t.file);

  if (write) {
    fs.writeFileSync(p, t.want + '\n', 'utf8');
    console.log('更新: ' + t.file + '（' + t.want.split('\n').length + '行 / ' + t.label + '）');
    continue;
  }

  const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '') : null;
  if (have === null) { console.error('無い: ' + t.file); ng++; continue; }

  if (have === t.want) {
    console.log('OK: ' + t.file + ' は main.ts と一致（' + t.want.split('\n').length + '行 / ' + t.label + '）');
    continue;
  }

  ng++;
  const A = t.want.split(String.fromCharCode(10)), B = have.split(String.fromCharCode(10));
  const diffs = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) diffs.push(i);
  console.error('ズレ: ' + t.file + '（' + t.label + '） 本番 ' + A.length + '行 / ハーネス ' + B.length + '行、差分 ' + diffs.length + '行');
  diffs.slice(0, 8).forEach((i) => {
    console.error('  --- ' + (i + 1) + '行目 ---');
    console.error('    main.ts : ' + (A[i] === undefined ? '(無し)' : A[i].slice(0, 120)));
    console.error('    harness : ' + (B[i] === undefined ? '(無し)' : B[i].slice(0, 120)));
  });
  if (diffs.length > 8) console.error('  …ほか ' + (diffs.length - 8) + '行');
}

if (write) process.exit(0);
if (ng) {
  console.error('\n本番に合わせるなら: node app/tools/harness-takeoff/check-prompt-sync.js --write');
  console.error('（本番側を直したつもりが無いのにズレているなら、ハーネスを直す前に main.ts の変更を疑うこと）');
  process.exit(1);
}
console.log('すべて一致しています。');
