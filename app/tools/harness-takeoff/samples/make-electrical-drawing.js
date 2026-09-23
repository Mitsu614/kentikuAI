// 検証用の「電気設備図」を作る。
//
// なぜ要るか: 拾い出しの電気対応（系統分け・単位・凡例の読み・回路表との突合・撤去）を
//   試すのに、手元に電気の実図面が無かった。実案件の図面が手に入るまでの**代用**として、
//   数量が設計どおり確定している図面をこちらで描く。
//
// ★これは「プロンプトが意図どおり動くか」を見るためのもの。実図面の難しさ
//   （手書き・かすれ・記号の揺れ・複数図面にまたがる情報）は再現していない。
//   実案件の図面が手に入ったら、必ずそちらで測り直すこと。
//
//   node make-electrical-drawing.js        … HTML を書き出す
//   node render-pdf.js                     … HTML を PDF にする（electron）
//
// 数量の正解はこのファイルの COUNTS がそのまま持つ（truth/electrical-office.json と一致させること）。

const fs = require('fs');
const path = require('path');

// ── 図面の寸法（mm）。縮尺 1/100 で描くので、SVG の 1 単位 = 紙の 1mm = 実寸 100mm ──
const S = 100;
const mm = (v) => v / S;

const X = [0, 7200, 14400, 21600].map(mm);      // 通り芯 X1〜X4
const Y = [0, 6000, 8400].map(mm);              // 通り芯 Y1〜Y3（Y2〜Y3 が廊下 2,400）
const OX = 28, OY = 34;                          // 用紙上の原点
const px = (i) => OX + X[i];
const py = (i) => OY + Y[i];

const out = [];
const add = (s) => out.push(s);

// ── 部品 ────────────────────────────────────────────────
const T = (x, y, s, size = 2.6, anchor = 'start', extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" ${extra}>${s}</text>`;

// ベースライト（40W形2灯）: 長方形
const baseLight = (x, y) =>
  `<g><rect x="${x - 3.5}" y="${y - 1.1}" width="7" height="2.2" fill="#fff" stroke="#000" stroke-width="0.25"/>` +
  `<line x1="${x - 3.5}" y1="${y}" x2="${x + 3.5}" y2="${y}" stroke="#000" stroke-width="0.2"/></g>`;

// ダウンライト: 二重丸
const downLight = (x, y) =>
  `<g><circle cx="${x}" cy="${y}" r="1.7" fill="#fff" stroke="#000" stroke-width="0.25"/>` +
  `<circle cx="${x}" cy="${y}" r="0.6" fill="#000"/></g>`;

// 非常照明: 丸の中に×
const emgLight = (x, y) =>
  `<g><circle cx="${x}" cy="${y}" r="2" fill="#fff" stroke="#000" stroke-width="0.3"/>` +
  `<line x1="${x - 1.4}" y1="${y - 1.4}" x2="${x + 1.4}" y2="${y + 1.4}" stroke="#000" stroke-width="0.3"/>` +
  `<line x1="${x + 1.4}" y1="${y - 1.4}" x2="${x - 1.4}" y2="${y + 1.4}" stroke="#000" stroke-width="0.3"/></g>`;

// 誘導灯: 長方形に EXIT
const exitLight = (x, y) =>
  `<g><rect x="${x - 3.2}" y="${y - 1.6}" width="6.4" height="3.2" fill="#fff" stroke="#000" stroke-width="0.3"/>` +
  T(x, y + 1.1, 'EXIT', 2, 'middle') + '</g>';

// コンセント: 半円 + 種別の添字（E=アース付 / WP=防水 / 200=200V）
const outlet = (x, y, sub = '') =>
  `<g><path d="M ${x - 2} ${y} A 2 2 0 0 1 ${x + 2} ${y} Z" fill="#fff" stroke="#000" stroke-width="0.3"/>` +
  `<line x1="${x - 2.6}" y1="${y}" x2="${x + 2.6}" y2="${y}" stroke="#000" stroke-width="0.3"/>` +
  (sub ? T(x + 2.8, y - 0.4, sub, 1.9) : '') + '</g>';

// スイッチ: 黒丸 + 棒（3=3路）
const sw = (x, y, sub = '') =>
  `<g><circle cx="${x}" cy="${y}" r="1.1" fill="#000"/>` +
  `<line x1="${x}" y1="${y}" x2="${x + 2.4}" y2="${y - 2}" stroke="#000" stroke-width="0.3"/>` +
  (sub ? T(x + 2.6, y - 2.2, sub, 1.9) : '') + '</g>';

// 情報コンセント（LAN）: ▽ + LAN
const lan = (x, y) =>
  `<g><path d="M ${x - 2} ${y - 1.8} L ${x + 2} ${y - 1.8} L ${x} ${y + 1.8} Z" fill="#fff" stroke="#000" stroke-width="0.3"/>` +
  T(x + 2.4, y + 0.6, 'LAN', 1.9) + '</g>';

// 煙感知器: 丸の中に S
const smoke = (x, y) =>
  `<g><circle cx="${x}" cy="${y}" r="2" fill="#fff" stroke="#000" stroke-width="0.3"/>` +
  T(x, y + 0.8, 'S', 2.2, 'middle') + '</g>';

// 総合盤: 四角に P
const fireBox = (x, y) =>
  `<g><rect x="${x - 2.4}" y="${y - 2.4}" width="4.8" height="4.8" fill="#fff" stroke="#000" stroke-width="0.4"/>` +
  T(x, y + 0.9, 'P', 2.4, 'middle') + '</g>';

// 分電盤: 塗りつぶし長方形
const panel = (x, y, label) =>
  `<g><rect x="${x - 5}" y="${y - 2.4}" width="10" height="4.8" fill="#333" stroke="#000" stroke-width="0.3"/>` +
  T(x, y + 0.9, label, 2.4, 'middle', 'fill="#fff"') + '</g>';

// 凡例に無い記号（★わざと入れた罠。unreadable に回るのが正解）
const unknownMark = (x, y) =>
  `<g><path d="M ${x} ${y - 2.2} L ${x + 2.2} ${y} L ${x} ${y + 2.2} L ${x - 2.2} ${y} Z" fill="#fff" stroke="#000" stroke-width="0.35"/></g>`;

// 等間隔に並べる
function row(x0, x1, n, y, draw, ...rest) {
  const step = (x1 - x0) / (n + 1);
  for (let i = 1; i <= n; i++) add(draw(x0 + step * i, y, ...rest));
}

// ── 図枠 ────────────────────────────────────────────────
add(`<rect x="6" y="6" width="408" height="285" fill="none" stroke="#000" stroke-width="0.8"/>`);

// ── 躯体（外壁・間仕切り）──────────────────────────────
const wall = (x1, y1, x2, y2, w = 0.9) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${w}"/>`;
add(`<rect x="${px(0)}" y="${py(0)}" width="${X[3]}" height="${Y[2]}" fill="none" stroke="#000" stroke-width="1.1"/>`);
add(wall(px(0), py(1), px(3), py(1)));                 // 廊下と居室の境
add(wall(px(2), py(0), px(2), py(1)));                 // 事務室A / 会議室
add(wall(px(2), py(1), px(2), py(2)));                 // 廊下 / 給湯室
add(wall(px(2) + X[1] / 2, py(1), px(2) + X[1] / 2, py(2)));  // 給湯室 / WC

// 通り芯と寸法線
for (let i = 0; i < 4; i++) {
  add(`<line x1="${px(i)}" y1="${py(0) - 9}" x2="${px(i)}" y2="${py(2) + 4}" stroke="#999" stroke-width="0.2" stroke-dasharray="4 1.5 0.8 1.5"/>`);
  add(`<circle cx="${px(i)}" cy="${py(0) - 12}" r="3" fill="#fff" stroke="#000" stroke-width="0.3"/>`);
  add(T(px(i), py(0) - 11.1, 'X' + (i + 1), 2.4, 'middle'));
}
for (let i = 0; i < 3; i++) {
  add(`<line x1="${px(0) - 9}" y1="${py(i)}" x2="${px(3) + 4}" y2="${py(i)}" stroke="#999" stroke-width="0.2" stroke-dasharray="4 1.5 0.8 1.5"/>`);
  add(`<circle cx="${px(0) - 12}" cy="${py(i)}" r="3" fill="#fff" stroke="#000" stroke-width="0.3"/>`);
  add(T(px(0) - 12, py(i) + 0.9, 'Y' + (i + 1), 2.4, 'middle'));
}
const dim = (x1, y1, x2, y2, label) =>
  `<g><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="0.25"/>` +
  T((x1 + x2) / 2, (y1 + y2) / 2 - 1.2, label, 2.4, 'middle') + '</g>';
for (let i = 0; i < 3; i++) add(dim(px(i), py(0) - 5, px(i + 1), py(0) - 5, '7,200'));
add(dim(px(0) - 5, py(0), px(0) - 5, py(1), '6,000'));
add(dim(px(0) - 5, py(1), px(0) - 5, py(2), '2,400'));

// 室名と床面積（面積は図面に印字。拾い出しはこれを使えるはず）
add(T(px(0) + 4, py(0) + 6, '事務室A', 3.6));
add(T(px(0) + 4, py(0) + 10, 'A：14.40×6.00＝86.40m²', 2.4));
add(T(px(2) + 4, py(0) + 6, '会議室', 3.6));
add(T(px(2) + 4, py(0) + 10, 'A：7.20×6.00＝43.20m²', 2.4));
add(T(px(0) + 2, py(1) + 4, '廊下  A：14.40×2.40＝34.56m²', 2.4));
add(T(px(2) + 2, py(1) + 4, '給湯室 A：8.64m²', 2.2));
add(T(px(2) + X[1] / 2 + 2, py(1) + 4, 'WC A：8.64m²', 2.2));
add(T(px(0), py(2) + 6, '当該階 延床面積 181.44m²（事務室A 86.40 ＋ 会議室 43.20 ＋ 廊下 34.56 ＋ 給湯室 8.64 ＋ WC 8.64）', 2.6));

// ── 器具の配置（数はここが正解）────────────────────────
const COUNTS = {
  baseLight: { 事務室A: 12, 会議室: 6, 廊下: 6, 給湯室: 1, WC: 1 },   // 計26台
  downLight: { 会議室: 4 },                                            // 計4台
  emgLight: { 事務室A: 1, 廊下: 2 },                                   // 計3台（防災）
  exitLight: { 廊下: 2 },                                              // 計2台（防災）
  outlet: { 事務室A: 10, 会議室: 4, 廊下: 2 },                         // 一般 計16箇所
  outletE: { 給湯室: 2 },                                              // アース付 計2
  outletWP: { WC: 1, 屋外: 1 },                                        // 防水 計2
  outlet200: { 事務室A: 2 },                                           // 200V 計2
  sw: { 事務室A: 2, 会議室: 2, 給湯室: 1, WC: 1 },                     // 片切 計6
  sw3: { 廊下: 2 },                                                    // 3路 計2
  lan: { 事務室A: 8, 会議室: 2 },                                      // 計10箇所
  smoke: { 事務室A: 4, 会議室: 2, 廊下: 3, 給湯室: 1, WC: 1 },         // 計11個（防災）
  fireBox: 1,
  panel: 1,
  removeLight: 18,     // 図面の注記「既設蛍光灯器具 撤去 18台」
  unknown: 2,          // 凡例に無い記号（罠）
};

// 事務室A（X1〜X3 / Y1〜Y2）
row(px(0), px(2), 4, py(0) + 16, baseLight);
row(px(0), px(2), 4, py(0) + 28, baseLight);
row(px(0), px(2), 4, py(0) + 40, baseLight);
add(emgLight(px(0) + 10, py(0) + 50));
row(px(0), px(2), 5, py(0) + 2.5, outlet);
row(px(0), px(2), 5, py(1) - 2.5, outlet);
add(outlet(px(0) + 8, py(0) + 34, '200'));
add(outlet(px(1) + 30, py(0) + 34, '200'));
row(px(0), px(2), 4, py(0) + 22, lan);
row(px(0), px(2), 4, py(0) + 46, lan);
add(sw(px(0) + 4, py(1) - 6));
add(sw(px(2) - 8, py(1) - 6));
row(px(0), px(2), 2, py(0) + 20, smoke);
row(px(0), px(2), 2, py(0) + 44, smoke);
add(unknownMark(px(1) + 20, py(0) + 12));

// 会議室（X3〜X4 / Y1〜Y2）
row(px(2), px(3), 3, py(0) + 18, baseLight);
row(px(2), px(3), 3, py(0) + 36, baseLight);
row(px(2), px(3), 4, py(0) + 48, downLight);
row(px(2), px(3), 2, py(0) + 3, outlet);
row(px(2), px(3), 2, py(1) - 3, outlet);
row(px(2), px(3), 2, py(0) + 28, lan);
add(sw(px(2) + 4, py(1) - 6));
add(sw(px(3) - 8, py(1) - 6));
row(px(2), px(3), 2, py(0) + 24, smoke);
add(unknownMark(px(2) + 12, py(0) + 44));

// 廊下（X1〜X3 / Y2〜Y3）… 帯が2,400しかないので、段を3つに分けて重ねない
add(sw(px(0) + 46, py(1) + 4, '3'));
add(sw(px(2) - 16, py(1) + 4, '3'));
add(outlet(px(0) + 62, py(1) + 4));
add(outlet(px(0) + 76, py(1) + 4));
add(fireBox(px(0) + 96, py(1) + 4));
add(panel(px(0) + 114, py(1) + 4, 'L-1'));
row(px(0), px(2), 6, py(1) + 11, baseLight);
add(exitLight(px(0) + 6, py(1) + 18));
add(smoke(px(0) + 25, py(1) + 18));
add(emgLight(px(0) + 45, py(1) + 18));
add(smoke(px(0) + 65, py(1) + 18));
add(emgLight(px(0) + 90, py(1) + 18));
add(smoke(px(0) + 110, py(1) + 18));
add(exitLight(px(0) + 135, py(1) + 18));

// 給湯室・WC
add(baseLight(px(2) + 18, py(1) + 11));
add(sw(px(2) + 4, py(1) + 17));
add(smoke(px(2) + 18, py(1) + 18));
add(outlet(px(2) + 8, py(2) - 3, 'E'));
add(outlet(px(2) + 28, py(2) - 3, 'E'));
add(baseLight(px(2) + X[1] / 2 + 18, py(1) + 11));
add(sw(px(2) + X[1] / 2 + 4, py(1) + 17));
add(smoke(px(2) + X[1] / 2 + 18, py(1) + 18));
add(outlet(px(2) + X[1] / 2 + 10, py(2) - 3, 'WP'));

// 屋外コンセント（外壁の外側）
add(outlet(px(3) + 6, py(1) + 12, 'WP'));
add(T(px(3) + 4, py(1) + 17, '屋外（防水）', 2.2));

// 幹線ルート（MDF〜L-1）
add(`<path d="M ${px(0) - 18} ${py(2) + 9} L ${px(0) + 114} ${py(2) + 9} L ${px(0) + 114} ${py(1) + 7}" fill="none" stroke="#000" stroke-width="0.9" stroke-dasharray="3 1.2"/>`);
add(T(px(0) - 20, py(2) + 14, '幹線 MDF〜L-1  CVT38sq×1条  平面ルート 28.5m（立上り 2箇所：階高3,000）', 2.6));

// 撤去の注記
add(T(px(0) - 20, py(2) + 20, '※既設蛍光灯器具は全て撤去（18台）。撤去・処分は本工事に含む。', 2.6));

// ── 右パネル: 凡例 ──────────────────────────────────────
const LX = 268;
let ly = 24;
add(`<rect x="${LX - 4}" y="${ly - 8}" width="146" height="112" fill="none" stroke="#000" stroke-width="0.5"/>`);
add(T(LX, ly - 2, '凡例（記号表）', 3.4));
ly += 6;
const legend = [
  [baseLight, 'ベースライト 40W形2灯（LED）'],
  [downLight, 'ダウンライト LED 100W形'],
  [emgLight, '非常照明（電池内蔵型）'],
  [exitLight, '誘導灯（避難口・C級）'],
  [(x, y) => outlet(x, y), 'コンセント 一般2口 100V'],
  [(x, y) => outlet(x, y, 'E'), 'コンセント アース付'],
  [(x, y) => outlet(x, y, 'WP'), 'コンセント 防水（屋外・WC）'],
  [(x, y) => outlet(x, y, '200'), 'コンセント 200V（空調用）'],
  [(x, y) => sw(x, y), 'スイッチ 片切'],
  [(x, y) => sw(x, y, '3'), 'スイッチ 3路'],
  [lan, '情報コンセント（LAN CAT6）'],
  [smoke, '煙感知器（自動火災報知設備）'],
  [fireBox, '総合盤（発信機・表示灯・地区音響）'],
  [(x, y) => panel(x, y, 'L-1'), '分電盤 L-1（電灯分電盤）'],
];
legend.forEach(([draw, label]) => {
  add(draw(LX + 8, ly));
  add(T(LX + 20, ly + 1, label, 2.6));
  ly += 7;
});

// ── 右パネル: 分電盤 L-1 回路表 ─────────────────────────
let cy = 146;
add(`<rect x="${LX - 4}" y="${cy - 8}" width="146" height="86" fill="none" stroke="#000" stroke-width="0.5"/>`);
add(T(LX, cy - 2, '分電盤 L-1 回路表（主幹 ELB 3P100A）', 3.2));
cy += 5;
add(T(LX, cy, '回路', 2.4)); add(T(LX + 14, cy, '用途', 2.4)); add(T(LX + 92, cy, '器具数', 2.4)); add(T(LX + 116, cy, '電線', 2.4));
add(`<line x1="${LX - 2}" y1="${cy + 1.4}" x2="${LX + 138}" y2="${cy + 1.4}" stroke="#000" stroke-width="0.3"/>`);
cy += 5;
const circuits = [
  ['1', '事務室A 照明', '12灯', 'VVF1.6-2C'],
  ['2', '会議室 照明・ダウンライト', '11灯', 'VVF1.6-2C'],   // ★図面は10灯。わざと食い違わせてある
  ['3', '廊下・給湯室・WC 照明', '8灯', 'VVF1.6-2C'],
  ['4', '事務室A コンセント', '6', 'VVF2.0-2C'],
  ['5', '事務室A コンセント', '4', 'VVF2.0-2C'],
  ['6', '会議室・廊下 コンセント', '6', 'VVF2.0-2C'],
  ['7', '給湯室 アース付コンセント', '2', 'VVF2.0-3C'],
  ['8', 'WC・屋外 防水コンセント', '2', 'VVF2.0-2C'],
  ['9', '事務室A 200V 空調', '2', 'VVF2.0-2C'],
  ['10', '予備', '—', '—'],
];
circuits.forEach((c) => {
  add(T(LX + 1, cy, c[0], 2.4));
  add(T(LX + 14, cy, c[1], 2.4));
  add(T(LX + 96, cy, c[2], 2.4));
  add(T(LX + 116, cy, c[3], 2.3));
  cy += 5.4;
});
add(T(LX, cy + 2, '※幹線・自火報の配線は別途（自火報は耐熱電線HPによる）', 2.3));

// ── 表題欄 ──────────────────────────────────────────────
add(`<rect x="${LX - 4}" y="246" width="146" height="40" fill="none" stroke="#000" stroke-width="0.6"/>`);
add(T(LX, 254, '○○商事 事務所ビル 改修工事', 3.6));
add(T(LX, 261, '1階 電気設備図（電灯・コンセント・弱電・自火報）', 2.8));
add(T(LX, 268, '縮尺 S=1/100　　階高 3,000　　天井高 2,700', 2.8));
add(T(LX, 275, '図面番号 E-01　　2026年9月', 2.8));
add(T(LX, 282, '※本図は拾い出し検証用に作成した架空の図面', 2.4, 'start', 'fill="#c00"'));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 297" width="420mm" height="297mm">
<rect width="420" height="297" fill="#fff"/>
<g font-family="'Yu Gothic UI','Meiryo',sans-serif" fill="#000">
${out.join('\n')}
</g></svg>`;

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>1階 電気設備図</title>
<style>@page{size:A3 landscape;margin:0}html,body{margin:0;padding:0}svg{display:block}</style>
</head><body>${svg}</body></html>`;

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'electrical-office.html'), html, 'utf8');

// 正解の集計を表示（truth と突き合わせるため）
const total = (o) => (typeof o === 'number' ? o : Object.values(o).reduce((a, b) => a + b, 0));
const summary = Object.fromEntries(Object.entries(COUNTS).map(([k, v]) => [k, total(v)]));
fs.writeFileSync(path.join(dir, 'electrical-office.counts.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log('書き出し: electrical-office.html');
console.log(summary);
