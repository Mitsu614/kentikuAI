// 拾い出しソフト（建築の電卓 など）の書き出しExcelから、accuracy.js の正解ファイルを作る。
//
//   node tools/harness-takeoff/from-calc-export.js <Excelを置いたフォルダ> [--name=物件名]
//
// 何をするか:
//   ・フォルダ内の .xlsx を全部読み、シートごと（…_床 / …_壁 / …_天井）に正解ファイルを1つ作る
//   ・数字はアプリの取り込みと同じ関数（src/main/takeoff-answer.ts の parseAnswerGrid）で読む。手で打たない
//   ・シートに貼られた図面画像を、Excelの中のつながり（sheet → drawing → media）どおりに取り出して、
//     そのシートの図面として使う（画像の順番で決め打ちしない）
//   ・壁の高さは、壁のシートの「壁高」列からそのまま取る
//   ・正解ファイルと画像は、Excelと同じフォルダの外（＝拾い出し正解データ直下）と images/ に書く
//
// ★預かったExcel・画像・正解ファイルはリポジトリに入れない。必ず 会社資産\拾い出し正解データ の下で使う。
//
// 正解の中身:
//   ・「○F 壁 合計」など、シートの合計（採点の本命）
//   ・1行ごと（#1, #2…）。お客様が図に振った番号と同じ順。区間ごとの長さは図面に数字が無いことが多く、
//     ここは厳しめの目安として見る

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '../..');
const ExcelJS = require(path.join(APP, 'node_modules', 'exceljs'));
const JSZip = require(path.join(APP, 'node_modules', 'jszip'));

function loadParser() {
  const out = path.join(APP, '.harness-build');
  const cfg = path.join(APP, '.tsconfig.harness.json');
  fs.writeFileSync(cfg, JSON.stringify({
    extends: './tsconfig.json', compilerOptions: { outDir: out, noEmit: false }, files: ['src/main/takeoff-answer.ts'],
  }), 'utf8');
  try {
    execFileSync(process.execPath, [path.join(APP, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', cfg], { cwd: APP, stdio: 'inherit' });
  } finally { try { fs.unlinkSync(cfg); } catch (_) {} }
  const hit = ['main/takeoff-answer.js', 'takeoff-answer.js'].map((p) => path.join(out, p)).find((p) => fs.existsSync(p));
  return require(hit);
}

// xl/worksheets/sheetN.xml → xl/drawings/drawingM.xml → xl/media/imageK.png をたどる
async function sheetImages(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const read = async (p) => (zip.file(p) ? zip.file(p).async('string') : '');
  const wbXml = await read('xl/workbook.xml');
  const wbRels = await read('xl/_rels/workbook.xml.rels');
  const relTarget = (xml, id) => { const m = xml.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`)) || xml.match(new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`)); return m ? m[1] : null; };
  const sheets = [...wbXml.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: m[1], rid: m[2] }));
  const out = {};
  for (const s of sheets) {
    const target = relTarget(wbRels, s.rid); if (!target) continue;
    const sheetPath = 'xl/' + target.replace(/^\/?xl\//, '');
    const relsPath = sheetPath.replace(/worksheets\//, 'worksheets/_rels/') + '.rels';
    const rels = await read(relsPath);
    const dm = rels.match(/Target="([^"]*drawings\/drawing\d+\.xml)"/); if (!dm) continue;
    const drawingPath = 'xl/drawings/' + path.posix.basename(dm[1]);
    const drels = await read(drawingPath.replace('drawings/', 'drawings/_rels/') + '.rels');
    const mm = drels.match(/Target="([^"]*media\/[^"]+)"/); if (!mm) continue;
    const mediaPath = 'xl/media/' + path.posix.basename(mm[1]);
    out[s.name.replace(/&amp;/g, '&')] = { buf: await zip.file(mediaPath).async('nodebuffer'), ext: path.extname(mediaPath) };
  }
  return out;
}

(async () => {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) { console.error('使い方: node from-calc-export.js <Excelを置いたフォルダ> [--name=物件名]'); process.exit(1); }
  const name = (process.argv.find((a) => a.startsWith('--name=')) || '').split('=')[1] || path.basename(path.resolve(dir));
  const T = loadParser();
  const outDir = path.dirname(path.resolve(dir));
  const imgDir = path.join(dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const files = fs.readdirSync(dir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')).sort();
  let made = 0;
  const usedNames = new Set();
  for (const f of files) {
    // 階はシート名から（…（2）_床 / 2F / 5階）。無ければ（1枚だけのファイルなら）ファイル名、それも無ければシートの順番
    const floorOf = (sheetName, idx, sheetsInFile) => {
      const sn = String(sheetName).normalize('NFKC');
      const m = sn.match(/[（(](\d+)[)）]/) || sn.match(/(\d+)\s*F(?![A-Za-z])/i) || sn.match(/(\d+)\s*階/);
      if (m) return `${m[1]}F`;
      // ファイル名に階が1つだけ書いてあれば（「…1F.xlsx」）それを使う。「1F2F 3F」のように複数なら使わない
      const fms = [...f.normalize('NFKC').matchAll(/(\d+)\s*F(?![A-Za-z0-9])/gi)];
      if (fms.length === 1) return `${fms[0][1]}F`;
      return `s${idx + 1}`;
    };
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(dir, f));
    const imgs = await sheetImages(path.join(dir, f));
    // 壁の高さ（壁シートの「壁高」列の最頻値）
    let wallH = null;
    for (const ws of wb.worksheets) {
      const grid = [];
      ws.eachRow({ includeEmpty: true }, (row, rn) => { grid[rn - 1] = row.values.slice(1).map((v) => (v == null ? '' : typeof v === 'object' ? (v.result ?? v.text ?? '') : v)); });
      for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
      const isH = (c) => /^壁高(さ)?$/.test(String(c).trim());
      const hr = grid.findIndex((r) => (r || []).some(isH) && (r || []).some((c) => String(c).trim() === '壁名'));
      if (hr >= 0) {
        const col = grid[hr].findIndex(isH);
        const cnt = {};
        for (const r of grid.slice(hr + 1)) { const v = Number(r[col]); if (v > 0) cnt[v] = (cnt[v] || 0) + 1; }
        const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
        if (best) wallH = Number(best[0]);
      }
      ws._grid = grid;
    }
    for (const [wi, ws] of wb.worksheets.entries()) {
      const r = T.parseAnswerGrid(ws._grid, ws.name, ws.name);
      if (!r.rows.length) continue;
      const part = r.rows[0].part || T.partFromSheetName(ws.name) || 'その他';
      let floor = floorOf(ws.name, wi, wb.worksheets.length);
      while (usedNames.has(`${floor}-${part}`)) floor = floor + 'b';
      usedNames.add(`${floor}-${part}`);
      // 壁は「開口を引く前」の面積も残す（機械の計測を、開口の扱いと分けて確かめるため）
      let gross = null;
      if (part === '壁') {
        const hr = ws._grid.findIndex((row) => (row || []).some((c) => String(c).trim() === '壁面積'));
        if (hr >= 0) {
          const col = ws._grid[hr].findIndex((c) => String(c).trim() === '壁面積');
          let sum = 0;
          for (const row of ws._grid.slice(hr + 2)) {
            // 合計行（「合計」がどの列にあっても）と、その下の開口の表に入ったら止める
            if ((row || []).some((c) => ['合計', '#'].includes(String(c ?? '').trim()))) break;
            const v = Number(row[col]); if (v > 0) sum += v;
          }
          gross = Math.round(sum * 100) / 100;
        }
      }
      const im = imgs[ws.name];
      if (!im) { console.log(`${f}「${ws.name}」: 図面の画像が無いので飛ばします`); continue; }
      const imgPath = path.join(imgDir, `${floor}_${part}${im.ext}`);
      fs.writeFileSync(imgPath, im.buf);
      const total = Math.round(r.rows.reduce((s, x) => s + x.qty, 0) * 100) / 100;
      const NO = (n) => '#' + n + '(?![0-9])';
      const other = { 壁: '天井|床|巾木|幅木', 床: '壁|天井|巾木|幅木', 天井: '壁|床|巾木|幅木' }[part] || '';
      const prep = '下地|ボード|パテ|撤去|養生|ロス';
      const truth = [{ name: `${floor} ${part} 合計`, qty: total, unit: r.rows[0].unit, match: part, exclude: [other, prep].filter(Boolean).join('|') }];
      if (r.rows.length > 1) {
        r.rows.forEach((x, k) => truth.push({ name: `#${k + 1} ${x.name}`, qty: Math.round(x.qty * 100) / 100, unit: x.unit, match: NO(k + 1), exclude: [other, prep].filter(Boolean).join('|') }));
      }
      const spec = {
        customer: '',
        ...(gross ? { gross } : {}),
        file: imgPath.replace(/\\/g, '/'),
        industry: 'interior',
        comment: `${name} ${floor} 内装（${part}の仕上げ）。` + (part === '壁' && wallH ? `壁の高さは${wallH}mm。開口部（扉・開口）は差し引いた面積で。` : ''),
        targets: part === '壁'
          ? '図中に色の線と番号で示した壁だけを拾う。壁ごとに1行、壁の仕上げ面積（㎡）を出す。行の name の先頭に図の番号を「#1 」の形で付ける。part は「壁」。下地は不要。'
          : `図中に色の線と番号で囲った範囲だけを拾う。範囲ごとに1行、${part}の仕上げ面積（㎡）を出す。行の name の先頭に図の番号を「#1 」の形で付ける。part は「${part}」。下地は不要。`,
        truth,
      };
      const out = path.join(outDir, `${name}-${floor}-${part}.json`);
      fs.writeFileSync(out, JSON.stringify(spec, null, 2), 'utf8');
      made++;
      console.log(`${path.basename(out)}  ${truth.length}項目  合計 ${total}${r.rows[0].unit}  図面 ${path.basename(imgPath)}`);
    }
  }
  console.log(`\n${made}件の正解ファイルを作りました → ${outDir}`);
  console.log('回す: node tools/harness-takeoff/accuracy.js --private');
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
