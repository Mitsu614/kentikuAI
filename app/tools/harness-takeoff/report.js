// 拾い出し精度レポート（お客様に渡す用）。
//
// 無料の簡易検証：お客様の図面と、御社の拾い出し数量をお預かりし、AIの拾い出しと比べた結果を
// 1枚の報告書にして渡す。accuracy.js を回したあとの accuracy-result.json から作る（AIは呼ばない＝無料）。
//
//   node tools/harness-takeoff/report.js                     … 預かった図面の結果を全部1冊に
//   node tools/harness-takeoff/report.js --customer=株式会社ＴＳＵＮＥ  … 正解ファイルの customer が一致するものだけ
//   node tools/harness-takeoff/report.js --pdf               … PDFも出す（Edge のヘッドレス印刷）
//
// ★出力は預かった図面のフォルダ（リポジトリの外）に書く。お客様名・現場名が入るため。
// ★数字は accuracy-result.json のまま。ここで丸め直したり、都合よく除いたりしない。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const PRIVATE_DIR = process.env.TAKEOFF_TRUTH_DIR
  || path.join(os.homedir(), 'OneDrive', 'Desktop', '会社資産', '拾い出し正解データ');
const RESULT = path.join(PRIVATE_DIR, 'accuracy-result.json');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const customer = arg('customer');
const TOL_OK = 0.15;   // accuracy.js の ○（±15%以内）と同じ線

if (!fs.existsSync(RESULT)) {
  console.error('結果がありません。先に accuracy.js --private を回してください: ' + RESULT);
  process.exit(1);
}
const all = JSON.parse(fs.readFileSync(RESULT, 'utf-8')).filter((a) => a.private);
const cases = all.map((a) => {
  const specPath = path.join(PRIVATE_DIR, a.file);
  const spec = fs.existsSync(specPath) ? JSON.parse(fs.readFileSync(specPath, 'utf-8')) : {};
  const run = (a.runs || []).find(Boolean) || [];
  return { file: a.file, spec, run };
}).filter((c) => !customer || String(c.spec.customer || '') === customer);
if (!cases.length) { console.error('対象がありません（--customer の名前と、正解ファイルの "customer" を確かめてください）'); process.exit(1); }

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) : '—');
const judge = (r) => r.got == null ? ['miss', '拾い漏れ'] : r.mark === '◎' ? ['ok', '◎ ±5%以内'] : r.mark === '○' ? ['ok', '○ ±15%以内'] : ['ng', '× ずれ大'];

let pass = 0, total = 0, exact = 0;
const sections = cases.map((c) => {
  const rows = c.run.map((r) => {
    total++; if (r.mark === '◎' || r.mark === '○') pass++; if (r.mark === '◎') exact++;
    const [k, label] = judge(r);
    const err = typeof r.err === 'number' ? `${r.err >= 0 ? '+' : ''}${(r.err * 100).toFixed(1)}%` : '—';
    return `<tr class="${k}"><td>${esc(r.name)}</td><td class="n">${fmt(r.want)} ${esc(r.unit)}</td><td class="n">${fmt(r.got)} ${r.got == null ? '' : esc(r.unit)}</td><td class="n">${err}</td><td><span class="pill ${k}">${label}</span></td></tr>`;
  }).join('');
  const ok = c.run.filter((r) => r.mark === '◎' || r.mark === '○').length;
  return `<section><h3>${esc(c.spec.comment || c.file)}</h3>
    <div class="meta">図面：${esc(path.basename(c.spec.file || ''))}　／　合格 ${ok} / ${c.run.length} 項目</div>
    <table><thead><tr><th>項目</th><th class="n">御社の数量</th><th class="n">AIの数量</th><th class="n">ずれ</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}).join('');

const rate = total ? Math.round(pass / total * 100) : 0;
const who = customer || (cases[0].spec.customer || '');
const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>拾い出し精度レポート</title><style>
@page{size:A4;margin:14mm}
body{font-family:'Yu Gothic','Meiryo',sans-serif;color:#1d2733;font-size:10.5pt;line-height:1.7;margin:0;padding:24px;background:#fff}
h1{font-size:18pt;margin:0;color:#16324f}.sub{color:#5d6b7a;font-size:9.5pt;margin-top:4px}
.big{display:flex;gap:24px;align-items:center;background:#f2f7fc;border:1px solid #d3e3f3;border-radius:8px;padding:14px 18px;margin:18px 0}
.big .v{font-size:30pt;font-weight:800;color:#16324f;font-family:monospace}.big .l{font-size:9.5pt;color:#5d6b7a}
h3{font-size:11.5pt;margin:18px 0 2px;color:#16324f}.meta{font-size:9pt;color:#5d6b7a;margin-bottom:6px}
table{width:100%;border-collapse:collapse;font-size:9.8pt}th{background:#e9eef3;text-align:left;padding:5px 8px;font-size:9pt;color:#5d6b7a}
td{padding:5px 8px;border-bottom:1px solid #e3e8ee}.n{text-align:right;font-family:monospace;white-space:nowrap}
.pill{font-size:8.8pt;font-weight:bold;border-radius:4px;padding:0 7px;white-space:nowrap}
.pill.ok{background:#e5f4ea;color:#1f7a45}.pill.ng{background:#fdf1dc;color:#a15c00}.pill.miss{background:#fbe5e3;color:#b3261e}
.note{font-size:9pt;color:#5d6b7a;margin-top:18px;border-top:1px dashed #ccd3da;padding-top:10px}
section{break-inside:avoid}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
</style></head><body>
<h1>拾い出し精度レポート</h1>
<div class="sub">${who ? esc(who) + ' 様　／　' : ''}${today}　／　建築ブースト（有限会社中野工務店）</div>
<div class="big"><div><div class="l">±15%以内に入った項目</div><div class="v">${pass} / ${total}</div></div>
<div><div class="l">一致率</div><div class="v">${rate}%</div></div>
<div><div class="l">うち ±5%以内</div><div class="v">${exact}</div></div></div>
<p style="margin:0">お預かりした図面${cases.length}件について、御社で拾われた数量を正解として、AIの拾い出しと項目ごとに比べました。</p>
${sections}
<div class="note">
・判定：◎＝±5%以内、○＝±15%以内、×＝それより大きいずれ、拾い漏れ＝AIがその項目を拾えなかったもの。<br>
・AIの数量は、図面をそのまま読ませた1回目の結果です。人の手直しは入れていません。<br>
・お預かりした図面は秘密保持契約に基づいて扱い、この検証以外には使いません。
</div></body></html>`;

const base = `拾い出し精度レポート_${(who || '全件').replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().slice(0, 10)}`;
const htmlPath = path.join(PRIVATE_DIR, base + '.html');
fs.writeFileSync(htmlPath, html, 'utf-8');
console.log(`一致率 ${rate}%（${pass}/${total}）`);
console.log('HTML: ' + htmlPath);

if (process.argv.includes('--pdf')) {
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    .find((p) => fs.existsSync(p));
  if (!edge) { console.error('Edge が見つからないため、PDFは出せませんでした（HTMLを印刷してください）'); process.exit(0); }
  const pdfPath = path.join(PRIVATE_DIR, base + '.pdf');
  try {
    execFileSync(edge, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, 'file:///' + htmlPath.replace(/\\/g, '/')], { stdio: 'ignore', timeout: 60000 });
  } catch (_) { /* Edge は成功しても終了コードを返すことがある。ファイルの有無で判断する */ }
  console.log(fs.existsSync(pdfPath) ? 'PDF: ' + pdfPath : 'PDFの作成に失敗しました（HTMLを印刷してください）');
}
