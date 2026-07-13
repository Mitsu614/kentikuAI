// 面積推定ハーネス: 複数戦略 × 同一データセットで勝敗を測る
// 使い方: node run.js <dataset.json> [strategyId,...] [--conc=3]
//
// 評価指標の考え方:
//  ・正解は 48㎡〜4000㎡ と2桁またぐので、絶対誤差(㎡)では大きい屋根に支配される。
//    比(予測/正解)の対数で評価する。|log ratio| の中央値が小さいほど良い。
//  ・「1.25倍以内」「1.5倍以内」に入った件数を主指標にする（積算実務での許容感）。
//  ・過大/過小の偏りを必ず出す。今回の症状は「大きめに出る」だった。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP = 'C:/Users/mitsu/OneDrive/Desktop/kentikuAI/app';
const Anthropic = require(path.join(APP, 'node_modules/@anthropic-ai/sdk'));
const { strategies } = require('./strategies');

function apiKey() {
  const key = crypto.createHash('sha256').update(os.hostname() + os.userInfo().username + 'kentiku-salt').digest();
  const cfg = JSON.parse(fs.readFileSync(process.env.APPDATA + '/kenchiku-boost/api-config.json', 'utf8'));
  const d = cfg.anthropicKey;
  if (!d.startsWith('enc:')) return d;
  const b = Buffer.from(d.slice(4), 'base64');
  const dc = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  dc.setAuthTag(b.subarray(12, 28));
  return dc.update(b.subarray(28)) + dc.final('utf8');
}
const client = new Anthropic({ apiKey: apiKey() });
const SYSTEM = 'あなたは建築の積算担当者です。写真から工事対象の面積・数量だけを推定します。金額は一切出しません。';

// モデルを --model= で差し替え可能に。新世代(opus-4-7/4-8, sonnet-5, fable-5)は
// temperature を受け付けない(400)ので送らない。旧世代は従来どおり temperature を送る。
const MODEL = (process.argv.find(a => a.startsWith('--model=')) || '--model=claude-sonnet-4-6').split('=')[1];
const NEWGEN = /opus-4-[78]|sonnet-5|fable-5|mythos-5/.test(MODEL);
const THINK = process.argv.includes('--think'); // 新世代のみ: adaptive thinking を有効化

const GRID_DIR = path.join(__dirname, 'grid');
function gridImage(file) {
  if (!fs.existsSync(GRID_DIR)) fs.mkdirSync(GRID_DIR, { recursive: true });
  const out = path.join(GRID_DIR, path.basename(file).replace(/\.\w+$/, '.png'));
  if (fs.existsSync(out)) return out;
  execFileSync('python', [path.join(__dirname, 'grid.py'), file, out]);
  return out;
}

function mediaTypeOf(f) {
  const e = path.extname(f).toLowerCase();
  return e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : 'image/jpeg';
}

async function callOnce(strategy, item, file) {
  const buf = fs.readFileSync(file);
  const req = {
    model: MODEL,
    max_tokens: strategy.maxTokens,
    system: SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaTypeOf(file), data: buf.toString('base64') } },
      { type: 'text', text: strategy.prompt(item) },
    ]}],
  };
  if (!NEWGEN) req.temperature = strategy.temperature ?? 0;
  if (NEWGEN && THINK) { req.thinking = { type: 'adaptive' }; req.max_tokens = Math.max(req.max_tokens, 6000); }
  const r = await client.messages.create(req);
  const text = (r.content.find(b => b.type === 'text') || {}).text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no-json');
  let j = JSON.parse(m[0]);
  if (strategy.postprocess) j = strategy.postprocess(j);
  j._tokens = r.usage.input_tokens + r.usage.output_tokens;
  return j;
}

const CROP_DIR = path.join(__dirname, 'crop');
async function cropRoof(strategy, item) {
  if (!fs.existsSync(CROP_DIR)) fs.mkdirSync(CROP_DIR, { recursive: true });
  const out = path.join(CROP_DIR, `${strategy.id}_${item.id}.png`);
  if (fs.existsSync(out)) return out;
  const buf = fs.readFileSync(item.file);
  const r = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 300, temperature: 0,
    system: SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaTypeOf(item.file), data: buf.toString('base64') } },
      { type: 'text', text: strategy.locatePrompt() },
    ]}],
  });
  const m = (r.content[0]?.text || '').match(/\{[\s\S]*\}/);
  if (!m) return item.file;                       // ROIが取れなければ原画像で続行
  const b = JSON.parse(m[0]);
  execFileSync('python', [path.join(__dirname, 'crop.py'), item.file, out,
    String(b.x0), String(b.y0), String(b.x1), String(b.y1)]);
  return out;
}

async function runItem(strategy, item) {
  let file = item.file;
  if (strategy.needsGrid) file = gridImage(item.file);
  if (strategy.twoPass) file = await cropRoof(strategy, item);
  const n = strategy.samples || 1;
  const results = [];
  for (let i = 0; i < n; i++) results.push(await callOnce(strategy, item, file));
  let j = n > 1 && strategy.aggregate ? strategy.aggregate(results) : results[0];

  // S0 は quantityM2 を持たないので assumedArea から拾う
  let got = Number(j.quantityM2) || 0;
  if (!got) {
    const g = String(j.assumedArea || '').match(/([\d,.]+)\s*(?:㎡|m2|m²)/);
    if (g) got = parseFloat(g[1].replace(/,/g, ''));
  }
  const truth = item.statedAreaM2;
  const ratio = got > 0 && truth > 0 ? got / truth : null;
  const inRange = (j.rangeMinM2 != null && j.rangeMaxM2 != null)
    ? (truth >= j.rangeMinM2 && truth <= j.rangeMaxM2) : null;

  return {
    strategy: strategy.id, id: item.id, viewType: item.viewType, buildingType: item.buildingType,
    truth, got: got || null, ratio,
    logErr: ratio ? Math.abs(Math.log(ratio)) : null,
    inRange, confidence: j.confidence, scaleRef: (j.scaleRef || '').slice(0, 70),
    basis: (j.basis || '').slice(0, 110),
    tokens: results.reduce((s, r) => s + (r._tokens || 0), 0),
    spread: j._spread ? Math.round(j._spread * 100) / 100 : null,
  };
}

function summarize(rows, label) {
  const ok = rows.filter(r => r.ratio);
  if (!ok.length) { console.log(`\n=== ${label}: 有効0件 ===`); return null; }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const within = (f) => ok.filter(r => r.ratio >= 1 / f && r.ratio <= f).length;
  const over = ok.filter(r => r.ratio > 1).length;
  const geoMean = Math.exp(ok.reduce((s, r) => s + Math.log(r.ratio), 0) / ok.length);
  const ranged = ok.filter(r => r.inRange !== null);
  const s = {
    label, n: ok.length,
    within125: within(1.25), within150: within(1.5), within200: within(2.0),
    medLogErr: Math.round(med(ok.map(r => r.logErr)) * 1000) / 1000,
    medRatio: Math.round(med(ok.map(r => r.ratio)) * 100) / 100,
    geoMeanRatio: Math.round(geoMean * 100) / 100,
    overCount: over, underCount: ok.length - over,
    rangeHit: ranged.length ? `${ranged.filter(r => r.inRange).length}/${ranged.length}` : '-',
    tokens: rows.reduce((s2, r) => s2 + (r.tokens || 0), 0),
  };
  console.log(`\n=== ${label} (n=${s.n}) ===`);
  console.log(`  1.25倍以内 ${s.within125}件 / 1.5倍以内 ${s.within150}件 / 2倍以内 ${s.within200}件`);
  console.log(`  |log比| 中央値 ${s.medLogErr}   比の中央値 ${s.medRatio}   幾何平均比 ${s.geoMeanRatio} (1.0が無バイアス)`);
  console.log(`  過大 ${s.overCount}件 / 過小 ${s.underCount}件   レンジ命中 ${s.rangeHit}   総トークン ${s.tokens}`);
  return s;
}

(async () => {
  const dsPath = process.argv[2];
  const only = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3].split(',') : null;
  const conc = Number((process.argv.find(a => a.startsWith('--conc=')) || '--conc=3').split('=')[1]);

  const ds = JSON.parse(fs.readFileSync(dsPath, 'utf8')).filter(d => fs.existsSync(d.file));
  const list = strategies.filter(s => !only || only.includes(s.id));
  console.log(`モデル ${MODEL}${NEWGEN ? ' (新世代/temperature送らず)' : ''}`);
  console.log(`データ ${ds.length}件 × 戦略 ${list.length}個  (並列${conc})`);

  const all = [];
  for (const st of list) {
    console.log(`\n### ${st.id}: ${st.desc}`);
    const rows = [];
    for (let i = 0; i < ds.length; i += conc) {
      const batch = ds.slice(i, i + conc);
      const rs = await Promise.all(batch.map(it =>
        runItem(st, it).catch(e => ({ strategy: st.id, id: it.id, truth: it.statedAreaM2, error: String(e.message || e).slice(0, 60) }))));
      for (const r of rs) {
        if (r.error) { console.log(`  ${r.id.padEnd(22)} ERROR ${r.error}`); continue; }
        const mark = r.ratio >= 0.8 && r.ratio <= 1.25 ? 'OK' : r.ratio >= 0.67 && r.ratio <= 1.5 ? '△ ' : 'NG';
        console.log(`  ${r.id.padEnd(22)} ${mark} 正解${String(r.truth).padStart(5)} 予測${String(r.got ?? '-').padStart(7)} 比${(r.ratio ?? 0).toFixed(2).padStart(5)} ${r.viewType || ''} ${r.spread ? '(ばらつき×' + r.spread + ')' : ''}`);
      }
      rows.push(...rs.filter(r => !r.error));
    }
    summarize(rows, st.id);
    all.push(...rows);
  }

  console.log('\n\n########## 視点別（全戦略込み） ##########');
  for (const v of ['nadir', 'oblique', 'ground', 'onroof']) {
    const sub = all.filter(r => r.viewType === v);
    if (sub.length) summarize(sub, `viewType=${v}`);
  }
  console.log('\n########## 建物別 ##########');
  for (const b of ['戸建て住宅', '工場', '倉庫']) {
    const sub = all.filter(r => r.buildingType === b);
    if (sub.length) summarize(sub, b);
  }
  const outPath = dsPath.replace(/\.json$/, `.${MODEL}${THINK ? '-think' : ''}.harness.json`);
  fs.writeFileSync(outPath, JSON.stringify(all, null, 2));
  console.log(`\n結果を保存: ${outPath}`);
})();
