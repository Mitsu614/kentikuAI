// main.ts から「業種ヒント」と「この会社の積算ルール（係数）」を取り出す。
//
// なぜ要るか:
//   拾い出しプロンプトの本文は prompt.txt に写してあるが、この2つは本文ではなく
//   ${...} の差し込み側（industrySection / factorsSection）にある。
//   そのためハーネスは長いあいだ、この2つを**丸ごと送らずに**精度・振れ幅を測っていた。
//   本番は業種ヒントも係数も必ず送るので、ハーネスの方が弱いプロンプトになっていた
//   （context.js の冒頭に書いてある「面積セクションの積み忘れ」と同じ種類の事故）。
//
//   手で書き写すと必ずズレるので、main.ts のソースから機械的に取り出して
//   factors-section.txt / industry-hints.json に落とす。
//   生成と照合は check-prompt-sync.js が受け持つ（--write で作り直し、引数なしで照合）。
//
// 係数は「未設定の会社（＝既定値）」として描画する。会社ごとの設定はアプリ側の話で、
// ハーネスで測りたいのは素の状態だから。

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const MAIN = path.resolve(DIR, '../../src/main/main.ts');
const FACTORS_FILE = path.join(DIR, 'factors-section.txt');
const HINTS_FILE = path.join(DIR, 'industry-hints.json');

const BACKTICK = String.fromCharCode(96);
const BACKSLASH = String.fromCharCode(92);

// テンプレートリテラルの中身を、${...} の入れ子と、その中の入れ子テンプレートまで含めて取り出す。
// i は開きバッククォートの位置。
function scanTemplate(src, i) {
  let out = '';
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === BACKSLASH) { out += c + src[i + 1]; i += 2; continue; }
    if (c === BACKTICK) return { text: out, end: i };
    if (c === '$' && src[i + 1] === '{') {
      let depth = 1;
      let chunk = '${';
      i += 2;
      while (i < src.length && depth > 0) {
        const d = src[i];
        if (d === BACKSLASH) { chunk += d + src[i + 1]; i += 2; continue; }
        if (d === BACKTICK) { const r = scanTemplate(src, i); chunk += BACKTICK + r.text + BACKTICK; i = r.end + 1; continue; }
        if (d === '{') depth++;
        else if (d === '}') { depth--; if (depth === 0) { chunk += '}'; i++; break; } }
        chunk += d; i++;
      }
      out += chunk;
      continue;
    }
    out += c; i++;
  }
  throw new Error('テンプレートリテラルが閉じていない');
}

// { ... } をそのまま取り出す（文字列・コメントの中の括弧は数えない）
function scanBraces(src, i) {
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === BACKTICK) {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === BACKSLASH) i++; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('オブジェクトリテラルが閉じていない');
}

function afterMarker(src, marker, what) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('main.ts に' + what + 'が見つからない（目印: ' + marker + '）');
  return i + marker.length;
}

// main.ts の既定値・業種ヒント・factorsSection を評価して、実際に送られる文面を作る。
function buildExtras() {
  const src = fs.readFileSync(MAIN, 'utf8');

  const defsSrc = scanBraces(src, src.indexOf('{', afterMarker(src, 'const TAKEOFF_FACTOR_DEFAULTS =', '係数の既定値')));
  const F = new Function('return ' + defsSrc)();

  const hintsSrc = scanBraces(src, src.indexOf('{', afterMarker(src, 'const TAKEOFF_INDUSTRY_HINT: Record<string, string> =', '業種ヒント')));
  const HINTS = new Function('return ' + hintsSrc)();

  const fi = src.indexOf(BACKTICK, afterMarker(src, 'const factorsSection =', '積算ルールの文面'));
  const factors = new Function('F', 'return ' + BACKTICK + scanTemplate(src, fi).text + BACKTICK)(F);

  const ii = src.indexOf(BACKTICK, afterMarker(src, 'const industrySection = TAKEOFF_INDUSTRY_HINT[takeoffIndustry]', '業種セクションの文面'));
  const renderIndustry = new Function(
    'TAKEOFF_INDUSTRY_HINT', 'takeoffIndustry',
    'return ' + BACKTICK + scanTemplate(src, ii).text + BACKTICK
  );

  const sections = {};
  for (const key of Object.keys(HINTS)) sections[key] = renderIndustry(HINTS, key);

  return { factors, sections, defaults: F };
}

module.exports = { buildExtras, FACTORS_FILE, HINTS_FILE };
