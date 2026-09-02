// 図面拾い出し（takeoff）の「振れ幅」計測ハーネス。
//
// なぜ要るか: AI見積に図面を直接投げるルートは、図面に数値が書いていない数量
// （壁面積・幅木延長・窓の箇所数）を毎回ゼロから推定するため、実行のたびに数量が変わる。
// 実測では 壁1.4倍・幅木2.0倍・ブラインド2.7倍 の幅が出た。
// 一方 takeoff は「寸法数値が最優先／推測で数量を作るな／拾えないものは unreadable へ」を
// 課しているので、原理的には振れにくいはず。それを実際に回して確かめる。
//
// 使い方:
//   node app/tools/harness-takeoff/run.js "<図面ファイルのパス>" [試行回数]
//
// プロンプト・モデル・パラメータは main.ts の takeoffDrawingCore と同一にしてある
// （ここがズレると計測の意味が無い）。アプリのクレジットは消費しない（API直叩き）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── アプリの api-config.json から APIキーを取り出す（main.ts の decryptField と同じ） ──
function getEncKey() {
  return crypto.createHash('sha256').update(os.hostname() + os.userInfo().username + 'kentiku-salt').digest();
}
function decryptField(data) {
  if (!data || !data.startsWith('enc:')) return data;
  const key = getEncKey();
  const buf = Buffer.from(data.slice(4), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return decipher.update(buf.subarray(28)) + decipher.final('utf8');
}
function loadKey() {
  const p = path.join(os.homedir(), 'AppData', 'Roaming', 'kenchiku-boost', 'api-config.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const k = decryptField(raw.anthropicKey || '');
  if (!k) throw new Error('anthropicKey が取れませんでした: ' + p);
  return k;
}

// ── main.ts takeoffDrawingCore と同一のプロンプト ──
// ★本番(main.ts)と同一の文面を prompt.txt から読む。
//   以前はここに本文を直接貼っていたが、本番だけが更新されて46行の旧版のまま取り残されていた
//   （表の読み方・複数資料の突き合わせ・単価の扱いが丸ごと欠けた状態で振れ幅を測っていた）。
//   一致は check-prompt-sync.js が見張る。回す前に必ず走らせること。
const TAKEOFF_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.txt"), "utf-8");
const { fillPrompt } = require(path.join(__dirname, "context.js"));
const SYSTEM_PROMPT = "あなたは建築積算の拾い出し専門家です。図面の寸法数値を正確に読み、計算式を必ず添えて数量を出します。読めないものは推測せず「読めない」と報告します。金額は扱いません。";

const TARGETS = `内装仕上工事の数量。壁・天井のクロス面積、床の仕上げ面積（部屋別）、
軽量鉄骨下地(LGS)と石膏ボードの面積、幅木の延長、ブラインドの箇所数。`;
const COMMENT = `老人ホーム 新築工事の内装仕上工事。ゼネコン下請け。天井高2.6m想定。`;

function parseJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
  const raw = m ? (m[1] || m[0]) : text;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// 振れを見たい数量。名前のゆらぎを吸収して拾う
const PROBES = [
  ['壁クロス',   /(壁|内壁).*(クロス|仕上)|クロス.*(壁|内壁)/],
  ['天井クロス', /天井.*(クロス|仕上|ボード)/],
  ['床仕上げ',   /床/],
  ['LGS',        /LGS|軽量鉄骨|軽天/],
  ['石膏ボード', /石膏ボード|プラスターボード|PB/],
  ['幅木',       /幅木|巾木/],
  ['ブラインド', /ブラインド|カーテン/],
];

function probe(items) {
  const out = {};
  for (const [label, re] of PROBES) {
    const hit = (items || []).filter((it) => re.test(String(it.name || '') + String(it.part || '')));
    if (!hit.length) { out[label] = null; continue; }
    const total = hit.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    out[label] = { qty: Math.round(total * 10) / 10, unit: hit[0].unit || '', rows: hit.length };
  }
  return out;
}

(async () => {
  const file = process.argv[2];
  const runs = Number(process.argv[3] || 3);
  if (!file || !fs.existsSync(file)) {
    console.error('使い方: node app/tools/harness-takeoff/run.js "<図面ファイル>" [試行回数]');
    process.exit(1);
  }
  const Anthropic = require(path.join(__dirname, '..', '..', 'node_modules', '@anthropic-ai', 'sdk'));
  const client = new Anthropic({ apiKey: loadKey() });

  const buf = fs.readFileSync(file);
  const isPdf = path.extname(file).toLowerCase() === '.pdf';
  const b64 = buf.toString('base64');
  const media = isPdf ? null
    : (buf[0] === 0x89 ? 'image/png' : buf[0] === 0x47 ? 'image/gif' : 'image/jpeg');

  const content = [{ type: 'text', text: `【図面1：${path.basename(file)}】` }];
  content.push(isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: media, data: b64 } });
  content.push({
    type: 'text',
    text: fillPrompt(TAKEOFF_PROMPT, { targets: TARGETS, comment: COMMENT }),
  });

  const results = [];
  for (let i = 1; i <= runs; i++) {
    process.stdout.write(`run ${i}/${runs} ... `);
    const res = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 64000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }).finalMessage();
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    const j = parseJson(text);
    if (!j) {
      const dbg = path.join(__dirname, 'raw-fail-' + i + '.txt');
      fs.writeFileSync(dbg, text);
      console.log('JSON解析に失敗 stop=' + res.stop_reason + ' len=' + text.length + ' → ' + dbg);
      results.push(null); continue;
    }
    const p = probe(j.items);
    results.push({ probe: p, items: (j.items || []).length, unreadable: (j.unreadable || []).length,
      floor: j.building && j.building.totalFloorAreaM2, conf: j.overallConfidence, raw: j });
    console.log(`items=${(j.items || []).length} unreadable=${(j.unreadable || []).length} conf=${j.overallConfidence}`);
  }

  const outDir = __dirname;
  fs.writeFileSync(path.join(outDir, 'last-runs.json'), JSON.stringify(results, null, 1));

  // ── 振れ幅の集計 ──
  console.log('\n=== 振れ幅（最大値 ÷ 最小値。1.00 なら完全に一致）===');
  const ok = results.filter(Boolean);
  const rows = [];
  for (const [label] of PROBES) {
    const vals = ok.map((r) => r.probe[label] && r.probe[label].qty).filter((v) => typeof v === 'number' && v > 0);
    if (!vals.length) { rows.push([label, '—', '拾われず']); continue; }
    const min = Math.min(...vals), max = Math.max(...vals);
    const unit = (ok.find((r) => r.probe[label]) || {}).probe[label].unit || '';
    rows.push([label, vals.map((v) => v + unit).join(' / '), (max / min).toFixed(2) + '倍']);
  }
  const w = Math.max(...rows.map((r) => r[0].length)) + 2;
  for (const [a, b, c] of rows) console.log(a.padEnd(w, '　') + b.padEnd(40) + c);
  console.log('\n詳細: ' + path.join(outDir, 'last-runs.json'));
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
