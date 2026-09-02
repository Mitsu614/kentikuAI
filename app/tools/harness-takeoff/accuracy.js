// 数量拾いの「当たっているか」を測るハーネス。
//
// harness-takeoff/run.js は同じ図面をN回回して**振れ幅**（再現性）を見るもの。
// こちらは正解を用意して**正確さ**を見る。振れなくても外れていたら意味がないため。
// harness-roof（屋根面積）と同じ流儀で、正解ファイルを置いて回す。
//
// 使い方:
//   1) 正解を書く（1図面につき1ファイル）
//      app/tools/harness-takeoff/truth/<好きな名前>.json
//      {
//        "file": "C:/.../図面.pdf",              // 図面 or 材料一覧表
//        "targets": "内装仕上工事の数量。床・壁・天井のクロス、幅木",  // 任意
//        "comment": "老人ホーム 新築 内装仕上工事",                  // 任意
//        "truth": [
//          { "name": "床面積",     "qty": 1209.35, "unit": "㎡", "match": "床" },
//          { "name": "幅木",       "qty": 1100,    "unit": "m",  "match": "幅木|巾木" }
//        ]
//      }
//      match は省略可（省略時は name を正規表現として使う）。
//      qty は「その項目の合計」。部屋ごとに分かれて出ても合算して比べる。
//
//   2) 回す
//      node app/tools/harness-takeoff/accuracy.js            … truth/ の全件
//      node app/tools/harness-takeoff/accuracy.js <名前>      … 1件だけ
//      node app/tools/harness-takeoff/accuracy.js <名前> 3    … 3回ずつ回して平均も見る
//
// 判定: 誤差 ±5%以内=◎ / ±15%以内=○ / それ以外=×。拾えなかったら「未検出」。
// 結果は accuracy-result.json に残る。プロンプトを直したら回し直して、悪化していないか見る。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DIR = __dirname;
const TRUTH_DIR = path.join(DIR, 'truth');

// ── APIキー（main.ts の decryptField と同じ） ──
function getEncKey() {
  return crypto.createHash('sha256').update(os.hostname() + os.userInfo().username + 'kentiku-salt').digest();
}
function decryptField(data) {
  if (!data || !data.startsWith('enc:')) return data;
  const buf = Buffer.from(data.slice(4), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', getEncKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return d.update(buf.subarray(28)) + d.final('utf8');
}
function loadKey() {
  const p = path.join(os.homedir(), 'AppData', 'Roaming', 'kenchiku-boost', 'api-config.json');
  const k = decryptField(JSON.parse(fs.readFileSync(p, 'utf-8')).anthropicKey || '');
  if (!k) throw new Error('anthropicKey が取れませんでした: ' + p);
  return k;
}

// ── main.ts takeoffDrawingCore と同一のプロンプト本体 ──
// ★本番(main.ts)と同一。check-prompt-sync.js が両方の一致を見張っている。
//   ズレたまま測ると『本番ではない別物』の精度を測ることになるので、回す前に必ず照合すること。
const PROMPT = fs.readFileSync(path.join(DIR, "prompt.txt"), "utf-8");
const { fillPrompt } = require(path.join(DIR, "context.js"));

function parseJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? (m[1] || m[0]) : text); } catch (_) { return null; }
}

function sumMatching(items, pattern, exclude) {
  const re = new RegExp(pattern, 'i');
  const ex = exclude ? new RegExp(exclude, 'i') : null;
  const hit = (items || []).filter((it) => {
    // 名前の書き方は揺れるので、まず部位(part)と単位で絞る。名前は補助にしか使わない。
    const label = String(it.name || '') + ' ' + String(it.part || '') + ' ' + String(it.unit || '');
    if (!re.test(label)) return false;
    if (ex && ex.test(label)) return false;
    return Number(it.quantity) > 0;              // 数量が空の行は数えない
  });
  if (!hit.length) return null;
  return {
    qty: Math.round(hit.reduce((s, it) => s + (Number(it.quantity) || 0), 0) * 100) / 100,
    rows: hit.length,
    unit: hit[0].unit || '',
  };
}

function grade(got, want) {
  if (got == null) return { mark: '未検出', err: null };
  const err = (got - want) / want;
  const a = Math.abs(err);
  return { mark: a <= 0.05 ? '◎' : a <= 0.15 ? '○' : '×', err };
}

// 投げる文面を組む。API は叩かない（--dry から呼んで目視できるようにするため）。
function buildContent(spec) {
  const buf = fs.readFileSync(spec.file);
  const isPdf = path.extname(spec.file).toLowerCase() === '.pdf';
  const b64 = buf.toString('base64');
  const content = [{ type: 'text', text: `【資料：${path.basename(spec.file)}】` }];
  content.push(isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: buf[0] === 0x89 ? 'image/png' : 'image/jpeg', data: b64 } });
  // 差し込む中身（面積セクション・対象・工事内容・縮尺）の組み立ては context.js に集約。
  // ここで書き写すと本番とズレる（実際にズレていた）。
  content.push({ type: "text", text: fillPrompt(PROMPT, spec) });

  return content;
}

async function runOnce(client, spec) {
  const content = buildContent(spec);
  const res = await client.messages.stream({
    model: 'claude-sonnet-4-6', max_tokens: 64000, temperature: 0,
    system: 'あなたは建築積算の拾い出し専門家です。図面の寸法数値を正確に読み、計算式を必ず添えて数量を出します。読めないものは推測せず「読めない」と報告します。金額は扱いません。',
    messages: [{ role: 'user', content }],
  }).finalMessage();
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  return { json: parseJson(text), truncated: res.stop_reason === 'max_tokens', len: text.length };
}

(async () => {
  if (!fs.existsSync(TRUTH_DIR)) {
    console.error('正解フォルダがありません: ' + TRUTH_DIR);
    console.error('truth/<名前>.json を1つ作ってから回してください（書き方はこのファイルの先頭コメント参照）');
    process.exit(1);
  }
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const only = argv[0];
  const times = Number(argv[1] || 1);
  const files = fs.readdirSync(TRUTH_DIR).filter((f) => f.endsWith('.json'))
    .filter((f) => !only || f.replace(/\.json$/, '') === only);
  if (!files.length) { console.error('対象の正解ファイルがありません'); process.exit(1); }

  // --dry: API を叩かず、投げる文面だけ確かめる（課金なし）。
  //   本番とズレていないかを回す前に見るためのもの。check-prompt-sync.js と併せて使う。
  if (process.argv.includes("--dry")) {
    for (const f of files) {
      const spec = JSON.parse(fs.readFileSync(path.join(TRUTH_DIR, f), "utf-8"));
      if (!fs.existsSync(spec.file)) { console.log(f + ": 図面が見つかりません → " + spec.file); continue; }
      const text = buildContent(spec).filter((c) => c.type === "text").map((c) => c.text).join(String.fromCharCode(10));
      console.log("=== " + f + " ===");
      console.log("  資料           : " + path.basename(spec.file));
      console.log("  文面           : " + text.length + "文字");
      console.log("  面積セクション : " + (text.includes("依頼文で指定された面積") ? "あり" : "なし（依頼文に面積の記載が無いため。本番も同じ挙動）"));
      console.log("  未展開の目印   : " + (text.includes("{{") ? "★残っている（バグ）" : "なし"));
    }
    process.exit(0);
  }

  const Anthropic = require(path.join(DIR, '..', '..', 'node_modules', '@anthropic-ai', 'sdk'));
  const client = new Anthropic({ apiKey: loadKey() });

  const all = [];
  for (const f of files) {
    const spec = JSON.parse(fs.readFileSync(path.join(TRUTH_DIR, f), 'utf-8'));
    if (!fs.existsSync(spec.file)) { console.log(`${f}: 図面が見つかりません → ${spec.file}`); continue; }
    console.log(`\n=== ${f} （${times}回） ===`);

    const perRun = [];
    for (let i = 1; i <= times; i++) {
      process.stdout.write(`  run ${i}/${times} ... `);
      const { json, truncated, len } = await runOnce(client, spec);
      if (!json) { console.log(`JSON解析に失敗（${len}文字${truncated ? '・出力上限で切断' : ''}）`); perRun.push(null); continue; }
      const rows = spec.truth.map((t) => {
        const got = sumMatching(json.items, t.match || t.name, t.exclude);
        const g = grade(got && got.qty, t.qty);
        return { name: t.name, want: t.qty, unit: t.unit || '', got: got && got.qty, rows: got && got.rows, ...g };
      });
      try { fs.writeFileSync(path.join(DIR, `raw-${f.replace(/\.json$/, '')}-${i}.json`), JSON.stringify(json, null, 1)); } catch (_) {}
      perRun.push(rows);
      const ok = rows.filter((r) => r.mark === '◎' || r.mark === '○').length;
      console.log(`items=${(json.items || []).length} 合格 ${ok}/${rows.length}${truncated ? ' ※切断' : ''}`);
    }

    // 項目ごとにまとめる
    const valid = perRun.filter(Boolean);
    console.log('  ' + '-'.repeat(66));
    console.log('  ' + '項目'.padEnd(14) + '正解'.padStart(11) + '出た値'.padStart(13) + '  誤差    判定');
    for (let k = 0; k < spec.truth.length; k++) {
      const t = spec.truth[k];
      const gots = valid.map((r) => r[k].got).filter((v) => typeof v === 'number');
      if (!gots.length) { console.log('  ' + String(t.name).padEnd(14) + String(t.qty).padStart(11) + '未検出'.padStart(13)); continue; }
      const avg = gots.reduce((a, b) => a + b, 0) / gots.length;
      const g = grade(avg, t.qty);
      const spread = gots.length > 1 ? `  振れ${(Math.max(...gots) / Math.min(...gots)).toFixed(2)}倍` : '';
      console.log('  ' + String(t.name).padEnd(14)
        + `${t.qty}${t.unit}`.padStart(11)
        + `${Math.round(avg * 100) / 100}${t.unit}`.padStart(13)
        + `  ${(g.err * 100 >= 0 ? '+' : '')}${(g.err * 100).toFixed(1)}%`.padEnd(9)
        + g.mark + spread);
    }
    all.push({ file: f, spec: spec.truth, runs: perRun });
  }

  fs.writeFileSync(path.join(DIR, 'accuracy-result.json'), JSON.stringify(all, null, 1));
  console.log('\n判定: ±5%以内=◎ / ±15%以内=○ / それ以外=×');
  console.log('詳細: ' + path.join(DIR, 'accuracy-result.json'));
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
