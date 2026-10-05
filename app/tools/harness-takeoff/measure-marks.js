// 図面の「色の印」を画素で測った値が、お客様の拾い出しとどれだけ合うかを見るハーネス。AIは呼ばない（無料）。
//
//   node tools/harness-takeoff/measure-marks.js [物件名] [--sheet=A3] [--scale=200]
//
// 使うもの:
//   ・正解ファイル（会社資産\拾い出し正解データ\<物件>-<階>-<部位>.json。from-calc-export.js で作ったもの）
//   ・その file の図面画像（用紙ごと書き出したもの。縮尺は 用紙の長辺mm × 縮尺 ÷ 画像の長辺px で出す）
// 壁   = 印の線の長さ × 壁の高さ（comment の「壁の高さは◯mm」）
// 床・天井 = 印の囲みの内側の面積（線の太さの半分を足す＝線の芯まで）
// ★開口の控除はしない（印からは分からない）。お客様の正解が開口を引いた後の面積なら、その分だけ多く出る。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '../..');
const PRIVATE = process.env.TAKEOFF_TRUTH_DIR || path.join(os.homedir(), 'OneDrive', 'Desktop', '会社資産', '拾い出し正解データ');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const SHEET = arg('sheet', 'A3');
const SCALE = Number(arg('scale', 200));
// --net: 線の上の開口の四角（お客様が引くと決めた開口）の幅×2.1m を引く
const NET = process.argv.includes('--net');
const GROSS = process.argv.includes('--gross');
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));

function load() {
  const out = path.join(APP, '.harness-build');
  const cfg = path.join(APP, '.tsconfig.harness.json');
  fs.writeFileSync(cfg, JSON.stringify({ extends: './tsconfig.json', compilerOptions: { outDir: out, noEmit: false }, files: ['src/main/mark-measure.ts'] }), 'utf8');
  try { execFileSync(process.execPath, [path.join(APP, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', cfg], { cwd: APP, stdio: 'inherit' }); }
  finally { try { fs.unlinkSync(cfg); } catch (_) {} }
  const hit = ['main/mark-measure.js', 'mark-measure.js'].map((p) => path.join(out, p)).find((p) => fs.existsSync(p));
  return require(hit);
}

const M = load();
const { decode } = require(path.join(APP, 'node_modules', 'fast-png'));

const SCALES = (() => { try { return JSON.parse(fs.readFileSync(path.join(PRIVATE, 'scales.json'), 'utf-8')); } catch (_) { return {}; } })();
const files = fs.readdirSync(PRIVATE)
  .filter((f) => /^[^_].*-[^-]+-(壁|床|天井)\.json$/.test(f) && !/pair|crop/.test(f))
  .filter((f) => !only || f.startsWith(only + '-'))
  .sort();

const rows = [];
for (const f of files) {
  const ex = (SCALES._除外 || {})[f.replace('.json', '')];
  if (ex) { console.log(`${f.replace('.json', '').padEnd(16)} 除外：${ex}`); continue; }
  const spec = JSON.parse(fs.readFileSync(path.join(PRIVATE, f), 'utf-8'));
  const part = f.match(/-(壁|床|天井)\.json$/)[1];
  const png = decode(fs.readFileSync(spec.file));
  const img = { width: png.width, height: png.height, data: png.data, channels: png.channels };
  // 物件ごとの用紙・縮尺（scales.json）。null は縮尺が分からず測れない図面なので飛ばす
  const proj = f.replace(/-[^-]+-(壁|床|天井)\.json$/, '');
  const sc = Object.prototype.hasOwnProperty.call(SCALES, proj) ? SCALES[proj] : { sheet: SHEET, scale: SCALE };
  if (!sc) { console.log(`${f.replace('.json', '').padEnd(16)} 縮尺が分からないので飛ばす（scales.json）`); continue; }
  const mm = sc.mmPerPx || M.mmPerPixelFromSheet(Math.max(png.width, png.height), sc.sheet, sc.scale);
  const LF = arg('linefrac', '');
  const r = M.measureMarks(img, { ...(LF ? { lineFrac: Number(LF) } : {}), ...(process.argv.includes('--no-both') ? { bothFaces: false } : {}), ...(arg('roombridge', '') ? { roomBridge: Number(arg('roombridge', '')) } : {}) });
  // --gross: 壁を「開口を引く前」の面積と比べる（機械の長さの計測だけを確かめる）
  const want = GROSS && part === '壁' && spec.gross ? spec.gross : spec.truth[0].qty;
  let got, how;
  if (part === '壁') {
    const h = Number((spec.comment.match(/壁の高さは(\d+)mm/) || [])[1] || 0) / 1000;
    const lenM = r.totalLengthPx * mm / 1000;
    const openM2 = r.pieces.reduce((s, p) => s + p.openingWidthsPx.reduce((t, w) => t + w * mm / 1000 * 2.1, 0), 0);
    got = lenM * h - (NET ? openM2 : 0);
    how = `線 ${lenM.toFixed(1)}m × 高さ${h}m・開口の印${r.pieces.reduce((s, p) => s + p.openings, 0)}・両面${Math.round(r.pieces.reduce((s, p) => s + p.bothFacesPx, 0) * mm / 1000)}m`;
  } else {
    const px = r.totalEnclosedPx;   // 線の芯までを含めた面積（mark-measure.ts 側で足している）
    got = px * mm * mm / 1e6;
    how = `囲み ${r.pieces.filter((p) => p.enclosedPx > 0).length}個`;
  }
  const err = (got - want) / want;
  const mark = Math.abs(err) <= 0.05 ? '◎' : Math.abs(err) <= 0.15 ? '○' : '×';
  rows.push({ f, want, got, err, mark });
  console.log(`${f.replace('.json', '').padEnd(16)} 正解 ${String(want).padStart(8)}㎡  印から ${got.toFixed(2).padStart(8)}㎡  ${(err >= 0 ? '+' : '') + (err * 100).toFixed(1)}% ${mark}   (${how}・1px=${mm.toFixed(1)}mm・塊${r.pieces.length})`);
}
const pass = rows.filter((r) => r.mark !== '×').length;
const pass5 = rows.filter((r) => r.mark === '◎').length;
console.log(`\n全体: ±5%以内 ${pass5}/${rows.length}・±15%以内 ${pass}/${rows.length}`);
