// 拾い出しプロンプトの {{CONTEXT}} に差し込む部分を組み立てる。
//
// 本番では main.ts の takeoffDrawingCore がこう組んでいる:
//   ${takeoffAreaSection}${targets}${comment}${scaleHint}
// ハーネス（accuracy.js / run.js）が各自でこれを書き写していたため、
//   ・accuracy.js は面積セクションを組み立てながら使い忘れていた
//   ・run.js はそもそも面積セクションを持っていなかった
// という形で本番とズレ、本番より弱いプロンプトで精度・振れ幅を測っていた。
// 二度と起きないよう、組み立てはここ1か所だけにする。
//
// 文面そのもの（area-section.txt / prompt.txt）は main.ts から自動生成する。
// 生成と照合は check-prompt-sync.js が受け持つ。

const fs = require('fs');
const path = require('path');

const AREA_SECTION = fs.readFileSync(path.join(__dirname, 'area-section.txt'), 'utf-8');

// main.ts の extractAreasFromComment と同じ規則。
// 「〇〇面積 1,209.35㎡」「延床 120m2」「45坪」など、単位の直前の数値とその手前の見出し語を拾う。
function extractAreas(text) {
  const src = String(text || '').normalize('NFKC');
  if (!src) return [];
  const re = /(床面積|延床面積|延床|施工面積|対象面積|壁面積|天井面積|屋根面積|外壁面積|塗装面積|面積)?\s*[:：]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(㎡|m2|m²|平米|坪)/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const value = Number(String(m[2]).replace(/,/g, ''));
    if (!(value > 0) || value > 1000000) continue;   // 桁違いの誤検出は捨てる
    const unit = m[3] === '坪' ? '坪' : '㎡';
    // 見出しの無い数字や、ただ「面積」とだけ書かれたものは床面積とみなす（本番と同じ判断）
    const raw = m[1] || '';
    const label = (!raw || raw === '面積') ? '床面積' : raw;
    const key = label + ':' + value + unit;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value, unit });
  }
  return out;
}

// spec = { targets, comment, scaleHint }（truth/*.json の中身、または run.js の定数）
function buildContext(spec) {
  const areas = extractAreas([spec.comment, spec.targets].filter(Boolean).join(' '));
  const areaSection = areas.length
    ? AREA_SECTION.replace('{{AREAS}}', areas.map((a) => '- ' + a.label + ': ' + a.value.toLocaleString() + a.unit).join('\n'))
    : '';

  return [
    areaSection,
    spec.targets ? '\n## ★拾ってほしい対象（これを最優先）★\n' + spec.targets + '\n' : '',
    spec.comment ? '\n## 工事内容・条件\n' + spec.comment + '\n' : '',
    spec.scaleHint ? '\n## ★縮尺（ユーザー指定 — 図面の表記より優先）★\n' + spec.scaleHint + '\n' : '',
  ].join('');
}

// prompt.txt の目印を実際の中身に差し替える。目印が無ければ生成し直しが必要なので止める。
function fillPrompt(prompt, spec) {
  if (!prompt.includes('{{CONTEXT}}')) {
    throw new Error('prompt.txt に {{CONTEXT}} がありません。node check-prompt-sync.js --write で作り直してください');
  }
  return prompt.replace('{{CONTEXT}}', buildContext(spec));
}

module.exports = { extractAreas, buildContext, fillPrompt };
