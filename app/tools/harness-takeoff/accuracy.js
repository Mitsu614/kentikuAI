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
//      exclude を書くと、その正規表現に当たる行を除ける。
//      ★unit は表示だけでなく**絞り込み**にも使う（単位の違う行は数えない）。
//        単位を問わず合算したいときだけ "anyUnit": true を付ける。
//      qty は「その項目の合計」。部屋ごとに分かれて出ても合算して比べる。
//
//   2) 回す
//      node app/tools/harness-takeoff/accuracy.js            … truth/ の全件
//      node app/tools/harness-takeoff/accuracy.js <名前>      … 1件だけ
//      node app/tools/harness-takeoff/accuracy.js <名前> 3    … 3回ずつ回して平均も見る
//      node app/tools/harness-takeoff/accuracy.js <名前> --regrade … APIを叩かず、前回の出力を採点し直す（無料）
//
// 判定: 誤差 ±5%以内=◎ / ±15%以内=○ / それ以外=×。拾えなかったら「未検出」。
// 結果は accuracy-result.json に残る。プロンプトを直したら回し直して、悪化していないか見る。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DIR = __dirname;
const TRUTH_DIR = path.join(DIR, 'truth');
// お客様から預かった図面の正解は、ここ（リポジトリの外）に置く。
//   ★このリポジトリは公開。預かった図面の数量・現場名を truth/ に入れると世界に出る。
//   秘密保持契約で預かったものは必ずこちら。AIの出力（raw-*.json）と結果もこちらに書く。
//   場所は環境変数 TAKEOFF_TRUTH_DIR で変えられる。
const PRIVATE_TRUTH_DIR = process.env.TAKEOFF_TRUTH_DIR
  || path.join(os.homedir(), 'OneDrive', 'Desktop', '会社資産', '拾い出し正解データ');

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
// --prompt=<ファイル> で別の指示文を回せる（直す前と後を同じ条件で比べるため）。既定は本番と同じ prompt.txt
const PROMPT_FILE = (process.argv.find((a) => a.startsWith('--prompt=')) || '').slice('--prompt='.length) || path.join(DIR, "prompt.txt");
const PROMPT = fs.readFileSync(PROMPT_FILE, "utf-8");
// --marks で使う「印を測る」関数は本番と同じ src/main/mark-measure.ts をその場でコンパイルして使う
const MARKS = process.argv.includes('--marks');
// --perroom: 部屋ごとに一周なぞった図面として渡す（本番の「部屋ごとに一周なぞった図面」チェックと同じ）
const PERROOM = process.argv.includes('--perroom');
const MARK = MARKS ? (() => {
  const { execFileSync } = require('child_process');
  const APP = path.resolve(DIR, '../..');
  const out = path.join(APP, '.harness-build');
  const cfg = path.join(APP, '.tsconfig.harness-marks.json');
  fs.writeFileSync(cfg, JSON.stringify({ extends: './tsconfig.json', compilerOptions: { outDir: out, noEmit: false }, files: ['src/main/mark-measure.ts'] }), 'utf8');
  try { execFileSync(process.execPath, [path.join(APP, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', cfg], { cwd: APP, stdio: 'inherit' }); }
  finally { try { fs.unlinkSync(cfg); } catch (_) {} }
  const hit = ['main/mark-measure.js', 'mark-measure.js'].map((x) => path.join(out, x)).find((x) => fs.existsSync(x));
  return require(hit);
})() : null;
const FASTPNG = MARKS ? require(path.join(DIR, '..', '..', 'node_modules', 'fast-png')) : null;
// --tag=<名前> で出力（raw-*.json・結果）を分けて残す。比べる2回が上書きし合わないように
const TAG = (process.argv.find((a) => a.startsWith('--tag=')) || '').slice('--tag='.length);
const tagged = (base) => (TAG ? `${base}-${TAG}` : base);
const { fillPrompt } = require(path.join(DIR, "context.js"));

function parseJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? (m[1] || m[0]) : text); } catch (_) { return null; }
}

// 単位の表記ゆれを揃える（㎡ / m2 / m² は同じ、台 / 個 / 箇所 は別物として扱う）
function normUnit(u) {
  return String(u || '').trim().normalize('NFKC').replace(/m2|m²/i, '㎡');
}

function sumMatching(items, pattern, exclude, unit) {
  const re = new RegExp(pattern, 'i');
  const ex = exclude ? new RegExp(exclude, 'i') : null;
  const want = normUnit(unit);
  const hit = (items || []).filter((it) => {
    // 名前の書き方は揺れるので、まず部位(part)と単位で絞る。名前は補助にしか使わない。
    const label = String(it.name || '') + ' ' + String(it.part || '') + ' ' + String(it.unit || '') + ' ' + String(it.room || '');
    if (!re.test(label)) return false;
    if (ex && ex.test(label)) return false;
    // ★単位が違う行は数えない。電気の実測で「コンセント 防水 2箇所」を探した正規表現が
    //   「VVF2.0-2C ― 分岐回路（コンセント・防水・200V系統）285m」に当たり、
    //   +14,000% という無意味な判定が出た。幅木(m)が床(㎡)に混ざる事故と同じ形。
    if (want && normUnit(it.unit) !== want) return false;
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
  // spec.files（複数）なら本番 main.ts と同じ「【資料1：名前】」の形で順に並べる。1枚なら従来どおり
  const list = Array.isArray(spec.files) && spec.files.length ? spec.files : [spec.file];
  const content = [];
  list.forEach((file, i) => {
    const buf = fs.readFileSync(file);
    const isPdf = path.extname(file).toLowerCase() === '.pdf';
    const b64 = buf.toString('base64');
    content.push({ type: 'text', text: list.length > 1 ? `【資料${i + 1}：${path.basename(file)}】` : `【資料：${path.basename(file)}】` });
    // ★中身（マジックバイト）で判定する。本番 main.ts の detectMediaType と同じ考え方。
    //   拡張子は嘘をつく（.jpg という名前のWebPが実際にあり、APIが400を返した）。
    const media = buf[0] === 0x89 ? 'image/png'
      : buf[0] === 0x47 ? 'image/gif'
      : (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') ? 'image/webp'
      : 'image/jpeg';
    content.push(isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: media, data: b64 } });
  });
  // --marks: 図面の色の印を機械で測り、その結果を指示文の前に差し込む（本番 main.ts と同じ関数・同じ位置）
  if (MARKS) {
    list.forEach((file, i) => {
      if (!/\.png$/i.test(file)) return;
      const png = FASTPNG.decode(fs.readFileSync(file));
      const m = MARK.measureMarks({ width: png.width, height: png.height, data: png.data, channels: png.channels });
      if (MARK.hasMarks(m)) content.push({ type: 'text', text: MARK.describeMarks(m, list.length > 1 ? `資料${i + 1}` : '', { perRoom: PERROOM }) });
    });
  }
  // 差し込む中身（面積セクション・対象・工事内容・縮尺）の組み立ては context.js に集約。
  // ここで書き写すと本番とズレる（実際にズレていた）。
  content.push({ type: "text", text: fillPrompt(PROMPT, spec) });

  return content;
}

// モデルと thinking は、試すときだけ差し替える（既定は本番と同じ opus-5-5・effort high。2026-10-08 から）。
//   --model=claude-opus-5   … モデルを変える
//   --thinking=8000         … 考える時間を与える（temperature は送れないので外す）
const MODEL = (process.argv.find((a) => a.startsWith('--model=')) || '').split('=')[1] || 'claude-opus-5-5';
const THINK = Number((process.argv.find((a) => a.startsWith('--thinking=')) || '').split('=')[1] || 0);
//   --effort=high           … Opus 5.5 などの新しいモデルで考える深さを指定（adaptive thinking）
const EFFORT = (process.argv.find((a) => a.startsWith('--effort=')) || '').split('=')[1] || (MODEL === 'claude-opus-5-5' ? 'high' : '');

async function runOnce(client, spec) {
  const content = buildContent(spec);
  const params = {
    model: MODEL, max_tokens: 64000,
    system: 'あなたは建築積算の拾い出し専門家です。図面の寸法数値を正確に読み、計算式を必ず添えて数量を出します。読めないものは推測せず「読めない」と報告します。金額は扱いません。',
    messages: [{ role: 'user', content }],
  };
  // Opus 5.5 など新しいモデルは考える量を budget ではなく effort で指定し、temperature は送れない（400になる）
  if (EFFORT) { params.thinking = { type: 'adaptive' }; params.output_config = { effort: EFFORT }; }
  else if (THINK > 0) params.thinking = { type: 'enabled', budget_tokens: THINK };
  else if (/sonnet-4-6|opus-4-6|sonnet-4-5|haiku-4-5/.test(MODEL)) params.temperature = 0;
  const res = await client.messages.stream(params).finalMessage();
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
  // 公開してよい見本（truth/）と、預かった図面（PRIVATE_TRUTH_DIR）の両方を回す。
  //   --private … 預かった図面だけ / --public … 見本だけ。先頭が _ のファイル（書き方の見本）は回さない
  const dirs = [];
  if (!process.argv.includes('--private')) dirs.push(TRUTH_DIR);
  if (!process.argv.includes('--public') && fs.existsSync(PRIVATE_TRUTH_DIR)) dirs.push(PRIVATE_TRUTH_DIR);
  const files = dirs.flatMap((d) => fs.readdirSync(d)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('accuracy-result') && !f.startsWith('raw-'))
    .filter((f) => !only || f.replace(/\.json$/, '') === only || f.startsWith(only + '-'))   // 物件名だけ渡せばその物件の全件
    .map((f) => ({ dir: d, f })));
  if (!files.length) { console.error('対象の正解ファイルがありません'); process.exit(1); }
  const outDir = (x) => (x.dir === TRUTH_DIR ? DIR : x.dir);   // 預かった図面の出力はリポジトリに書かない

  // --dry: API を叩かず、投げる文面だけ確かめる（課金なし）。
  //   本番とズレていないかを回す前に見るためのもの。check-prompt-sync.js と併せて使う。
  if (process.argv.includes("--dry")) {
    for (const x of files) {
      const f = x.f;
      const spec = JSON.parse(fs.readFileSync(path.join(x.dir, f), "utf-8"));
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

  // --regrade: APIを叩かず、前回保存した raw-*.json を採点し直す（無料）。
  //   正解の書き方（match / exclude / unit）を直したときに、同じ出力で採点だけやり直すため。
  const REGRADE = process.argv.includes('--regrade');
  const loadRaw = (x, i) => {
    const p = path.join(outDir(x), `raw-${tagged(x.f.replace(/\.json$/, ''))}-${i}.json`);
    if (!fs.existsSync(p)) throw new Error('前回の出力がありません: ' + p);
    return { json: JSON.parse(fs.readFileSync(p, 'utf-8')), truncated: false, len: 0 };
  };

  const Anthropic = REGRADE ? null : require(path.join(DIR, '..', '..', 'node_modules', '@anthropic-ai', 'sdk'));
  const client = REGRADE ? null : new Anthropic({ apiKey: loadKey() });

  const all = [];
  for (const x of files) {
    const f = x.f;
    const spec = JSON.parse(fs.readFileSync(path.join(x.dir, f), 'utf-8'));
    if (!fs.existsSync(spec.file)) { console.log(`${f}: 図面が見つかりません → ${spec.file}`); continue; }
    console.log(`\n=== ${f} （${times}回） ===`);

    const perRun = [];
    for (let i = 1; i <= times; i++) {
      process.stdout.write(`  run ${i}/${times} ... `);
      const { json, truncated, len } = REGRADE ? loadRaw(x, i) : await runOnce(client, spec);
      if (!json) { console.log(`JSON解析に失敗（${len}文字${truncated ? '・出力上限で切断' : ''}）`); perRun.push(null); continue; }
      const rows = spec.truth.map((t) => {
        // unit は表示用ではなく**絞り込み**にも使う（anyUnit: true で無効化できる）
        const got = sumMatching(json.items, t.match || t.name, t.exclude, t.anyUnit ? '' : t.unit);
        const g = grade(got && got.qty, t.qty);
        return { name: t.name, want: t.qty, unit: t.unit || '', got: got && got.qty, rows: got && got.rows, ...g };
      });
      try { fs.writeFileSync(path.join(outDir(x), `raw-${tagged(f.replace(/\.json$/, ''))}-${i}.json`), JSON.stringify(json, null, 1)); } catch (_) {}
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
    all.push({ file: f, private: x.dir !== TRUTH_DIR, spec: spec.truth, runs: perRun });
  }

  // 全体の合格率（1回目の結果で数える）。プロンプトを直す前後で、この1行を比べる。
  const tally = { pass: 0, total: 0, miss: 0 };
  for (const a of all) {
    const r = (a.runs || []).find(Boolean) || [];
    for (const row of r) { tally.total++; if (row.mark === '◎' || row.mark === '○') tally.pass++; if (row.got == null) tally.miss++; }
  }
  // 結果ファイルにも項目名が入るので、預かった図面を含む回は外のフォルダに書く
  const resultPath = path.join(all.some((a) => a.private) ? PRIVATE_TRUTH_DIR : DIR, tagged('accuracy-result') + '.json');
  fs.writeFileSync(resultPath, JSON.stringify(all, null, 1));
  console.log(`\n全体: 合格 ${tally.pass}/${tally.total}（${tally.total ? Math.round(tally.pass / tally.total * 100) : 0}%）・未検出 ${tally.miss}`);
  console.log('判定: ±5%以内=◎ / ±15%以内=○ / それ以外=×');
  console.log('詳細: ' + resultPath);
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
