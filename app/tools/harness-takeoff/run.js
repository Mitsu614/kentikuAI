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
const TAKEOFF_PROMPT = `あなたは建築の積算士（拾い出し20年）です。上の図面から**材料・工種ごとの数量**を拾い出してください。
金額・単価は絶対に出さないでください（ここは数量だけの工程です）。

## 拾い出しの鉄則（違反したら拾い出しとして失格）
1. **寸法数値が最優先**。図面に寸法線の数値（例 8,190）があれば必ずそれを使え。縮尺からの目測は、寸法数値が無い部位でだけ使い、その行の confidence を「低」にしろ。
2. **縮尺の確定**: ①図面内の縮尺表記（S=1/100 等）→ ②既知寸法からの逆算 の順で決めろ。どちらも取れない図面から、目測で数量を作るな。
3. **単位はmm表記が基本**。8,190 は 8.19m。桁を間違えるな（拾い出しで一番多い事故）。
4. **すべての行に formula（計算式）を数字で書け**。人が電卓で追える式でなければ、その行は出すな。
   例: "8.19×6.37=52.17"、"(8.19+6.37)×2×2.8=81.5"、"1F 12箇所+2F 8箇所=20"
5. **推測で数量を作るな**。図面に写っていない・寸法が無い・別図が要る場合は items に入れず、必ず unreadable に
   「何が読めないか」と「どの図面があれば拾えるか」をセットで書け（例: "屋根勾配が断面図に無い。矩計図があれば実面積を出せます"）。
6. **二重計上の禁止**。同じ部位を平面図と立面図の両方から拾って2行にするな。1部位1行にまとめ、source に両方書け。
7. **開口部の控除**: 外壁・内壁・天井の面積は、原則1箇所あたり1㎡以上の開口（窓・出入口）を控除しろ。控除したかどうかを
   必ず deduction に書け（例: "サッシ6箇所 計9.8㎡を控除"、"1㎡未満のため控除せず"）。
8. **ロス率**: 実務標準の割増だけを掛けろ（板もの5%／クロス・シート10%／長尺材5%）。掛けたら lossRate と
   quantityWithLoss に必ず反映し、掛けない項目は lossRate を 0 にしろ。折板屋根に張る材料の展開係数（×1.41等）は
   ロスではなく数量そのものなので formula の中に書け。
9. **図面種別で拾える範囲が違う**。平面図＝床面積・内壁長さ・建具数・設備位置／立面図＝外壁面積・開口／屋根伏図＝屋根面積・軒樋長さ／
   断面図・矩計図＝階高・勾配／建具表＝建具の数量と寸法。無い図面から拾ったことにするな。
10. 行ごとに confidence（高/中/低）を必ず付けろ。「高」は図示寸法から直接計算した行だけだ。

## 出力形式（必ずこのJSONだけを返す）
\`\`\`json
{
  "title": "図面から読み取った工事名・物件名（無ければnull）",
  "drawingTypes": ["読み取った図面の種類"],
  "scale": "確定した縮尺（例: '1/100'）。取れなければnull",
  "scaleSource": "縮尺をどう確定したか",
  "building": { "structure": "構造", "floors": "階数", "totalFloorAreaM2": 延床面積（数値、㎡）, "note": "補足" },
  "items": [
    {
      "part": "部位", "name": "材料・工種名", "method": "面積 / 長さ / 個数 / 体積 / 質量",
      "dimensions": "拾いに使った寸法", "formula": "計算式（数字で）",
      "quantity": 数量, "unit": "単位", "deduction": "控除の有無と内容",
      "lossRate": ロス率, "quantityWithLoss": 発注数量,
      "source": "出典", "confidence": "高/中/低", "assumption": "仮定した点"
    }
  ],
  "summary": [{"label": "主要数量の名前", "value": "値と単位"}],
  "unreadable": ["拾えなかった項目と、拾うために必要な図面・情報（必ずセットで）"],
  "warnings": ["図面の矛盾・注意点"],
  "overallConfidence": "高/中/低"
}
\`\`\`

items は拾えた分だけでよい（無理に埋めるな）。読めない図面なら items を空配列にし、unreadable に理由を書け。`;

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
    text: TAKEOFF_PROMPT.replace(
      '## 拾い出しの鉄則',
      `\n## ★拾ってほしい対象（これを最優先）★\n${TARGETS}\n\n## 工事内容・条件\n${COMMENT}\n\n## 拾い出しの鉄則`
    ),
  });

  const results = [];
  for (let i = 1; i <= runs; i++) {
    process.stdout.write(`run ${i}/${runs} ... `);
    const res = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 64000,
      temperature: 0,
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
