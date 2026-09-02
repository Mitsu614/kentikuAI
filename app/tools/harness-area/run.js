// 面積事前確認のハーネス（屋根・外壁・内装）
//
//   node app/tools/harness-area/run.js                 … truth/ の全件
//   node app/tools/harness-area/run.js --target=wall   … 外壁だけ
//   node app/tools/harness-area/run.js --dry           … APIを叩かず、正解データと設定だけ確認
//   node app/tools/harness-area/run.js --n=3           … 1件につき3回回して振れ幅も見る
//
// harness-roof との違い:
//   harness-roof はプロンプトを strategies.js に複製して持っている。本番を直しても
//   ハーネスは古いまま回るため、乖離する。こちらは main.ts から**出荷しているプロンプト・
//   モデル指定・レンジ倍率**をそのまま読む（shipped.js）。本番を直せばここも追従する。
//
// 測るもの:
//   1) 誤差（較正後の推定 ÷ 正解）。大小2桁またぐので比で見る
//   2) ★レンジの被覆率 … 画面に出している「想定レンジ」が正解を含んでいた割合。
//      旧レンジ ×0.75〜1.35 は 39% しか含んでおらず、幅として機能していなかった。
//      ここが下がったら、幅の主張が嘘になっているということ。
//   3) 撮り方(viewType)別の内訳。屋根では onroof が oblique の1/3の誤差だった

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const shipped = require("./shipped");

const DIR = __dirname;
const TRUTH_DIR = path.join(DIR, "truth");
const APP = path.resolve(DIR, "../..");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const REPEAT = Number((args.find(a => a.startsWith("--n=")) || "--n=1").split("=")[1]) || 1;
const ONLY = (args.find(a => a.startsWith("--target=")) || "").split("=")[1] || null;
const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[90m", x: "\x1b[0m", b: "\x1b[1m" };

// ── 正解データ ─────────────────────────────────────────────
// truth/<名前>.json:
// {
//   "target": "roof" | "wall" | "floor",
//   "truthM2": 126,                     ← 実測値。これが正解
//   "file": "C:/.../写真.jpg",
//   "comment": "戸建て住宅の屋根カバー工法",   ← 依頼文（本番と同じ条件で回すため）
//   "viewType": "oblique" | "onroof" | "ground" | "drawing",
//   "coversWhole": true,                ← 対象の輪郭が写真に収まっているか（任意）
//   "note": "どう実測したか"              ← 任意。あとで自分が見て分かるように
// }
function loadTruth() {
  if (!fs.existsSync(TRUTH_DIR)) return [];
  return fs.readdirSync(TRUTH_DIR).filter(f => f.endsWith(".json")).map(f => {
    const t = JSON.parse(fs.readFileSync(path.join(TRUTH_DIR, f), "utf8"));
    t.id = t.id || f.replace(/\.json$/, "");
    return t;
  }).filter(t => !ONLY || t.target === ONLY);
}

function apiKey() {
  const key = crypto.createHash("sha256").update(os.hostname() + os.userInfo().username + "kentiku-salt").digest();
  const cfg = JSON.parse(fs.readFileSync(process.env.APPDATA + "/kenchiku-boost/api-config.json", "utf8"));
  const d = cfg.anthropicKey;
  if (!d.startsWith("enc:")) return d;
  const b = Buffer.from(d.slice(4), "base64");
  const dc = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  dc.setAuthTag(b.subarray(12, 28));
  return dc.update(b.subarray(28)) + dc.final("utf8");
}

const MEDIA = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

async function askOnce(client, cfg, t) {
  const ext = path.extname(t.file).toLowerCase();
  const b64 = fs.readFileSync(t.file).toString("base64");
  const res = await client.messages.create({
    model: cfg.model,
    max_tokens: 6000,
    ...(cfg.think ? { thinking: { type: "adaptive" } } : {}),
    system: cfg.system,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: MEDIA[ext] || "image/jpeg", data: b64 } },
        { type: "text", text: shipped.userPrompt(t.comment) },
      ],
    }],
  });
  const text = res.content.filter(c => c.type === "text").map(c => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSONが返らなかった");
  return JSON.parse(m[0]);
}

// main.ts と同じ後処理（較正は掛けない＝生の推定を見る。較正係数はテナントごとに変わるため）
function toArea(r) {
  const stated = Number(r.statedAreaM2) || 0;
  if (stated > 0) return { m2: stated, fromStated: true };
  const w = Number(r.widthM) || 0, l = Number(r.lengthM) || 0;
  const slope = Number(r.slopeFactor) > 0 ? Number(r.slopeFactor) : 1;
  const dev = Number(r.developFactor) > 0 ? Number(r.developFactor) : 1;
  const open = Number(r.openingFactor) > 0 ? Number(r.openingFactor) : 1;
  const h = Number(r.heightM) || 0;
  const base = r.target === "wall" ? (w + l) * 2 * h * open : w * l;
  return { m2: base * slope * dev, fromStated: false };
}

(async () => {
  const truths = loadTruth();
  const cfg = shipped.modelConfig();
  const post = shipped.postConstants();

  console.log(`\n${C.b}■ 設定（すべて main.ts から読んでいる）${C.x}`);
  console.log(`  モデル      ${cfg.model}${cfg.think ? " + adaptive thinking" : ""}`);
  console.log(`  レンジ      屋根 ×${post.range.roof.join("〜×")}  /  外壁・内装 ×${post.range.wall.join("〜×")}`);
  console.log(`  プロンプト   ${shipped.userPrompt("").length}字`);

  const byTarget = {};
  truths.forEach(t => { (byTarget[t.target] = byTarget[t.target] || []).push(t); });
  console.log(`\n${C.b}■ 正解データ ${truths.length}件${C.x}`);
  for (const k of ["roof", "wall", "floor"]) {
    const n = (byTarget[k] || []).length;
    const label = { roof: "屋根", wall: "外壁", floor: "内装" }[k];
    console.log(`  ${label}  ${String(n).padStart(3)}件  ${n === 0 ? C.r + "← 未収集。較正もレンジも未検証のまま出荷している" + C.x : n < 10 ? C.y + "← 少ない。10件以上ほしい" + C.x : C.g + "OK" + C.x}`);
  }
  const missing = truths.filter(t => !fs.existsSync(t.file));
  if (missing.length) {
    console.log(`\n  ${C.r}画像が見つからない: ${missing.map(t => t.id).join(", ")}${C.x}`);
  }
  if (DRY || truths.length === 0) {
    if (truths.length === 0) console.log(`\n  ${C.y}正解データがありません。truth/ に置いてください（形式は README.md）。${C.x}\n`);
    else console.log(`\n  ${C.d}--dry のためAPIは叩いていません。${C.x}\n`);
    return;
  }

  // node_modules は worktree には無い（本体の checkout にしか入っていない）。
  // 実行場所に関係なく動くよう、候補を順に探す。
  const sdkPath = (() => {
    const cands = [path.join(APP, "node_modules/@anthropic-ai/sdk")];
    // <repo>/.claude/worktrees/<name>/app/tools/harness-area → 上へ辿って <repo>/app を探す
    let d = DIR;
    for (let i = 0; i < 8; i++) {
      d = path.dirname(d);
      cands.push(path.join(d, "app/node_modules/@anthropic-ai/sdk"));
    }
    const hit = cands.find(p => fs.existsSync(p));
    if (!hit) throw new Error("@anthropic-ai/sdk が見つかりません。本体で npm install を済ませてください。\n探した場所:\n  " + cands.join("\n  "));
    return hit;
  })();
  const Anthropic = require(sdkPath);
  const client = new Anthropic({ apiKey: apiKey() });

  const rows = [];
  for (const t of truths.filter(t => fs.existsSync(t.file))) {
    for (let i = 0; i < REPEAT; i++) {
      try {
        const r = await askOnce(client, cfg, t);
        const { m2, fromStated } = toArea(r);
        rows.push({ ...t, got: m2, fromStated, sourceKind: r.sourceKind, confidence: r.confidence, basis: r.basis });
        const e = (m2 / t.truthM2 - 1) * 100;
        console.log(`  ${t.id.padEnd(28)} ${String(t.target).padEnd(6)} 正解${String(t.truthM2).padStart(6)}㎡ 推定${m2.toFixed(0).padStart(6)}㎡ ` +
          `${(e >= 0 ? "+" : "") + e.toFixed(0)}%${fromStated ? " (記載値)" : ""}`);
      } catch (e) {
        console.log(`  ${C.r}${t.id.padEnd(28)} 失敗: ${e.message}${C.x}`);
      }
    }
  }

  // ── 集計 ──
  // 画面に出るのは較正後の値なので、較正を掛けてから測る（掛けないと本番と違うものを見ることになる）
  console.log(`\n${C.b}■ 結果${C.x}  ${C.d}較正を掛けた後＝画面に出る値で測っている${C.x}`);
  console.log(`  ${"対象".padEnd(8)} n   較正  平均誤差  中央値  ±15%  ${C.b}レンジ被覆${C.x}`);
  for (const k of ["roof", "wall", "floor"]) {
    const rs = rows.filter(r => r.target === k);
    if (!rs.length) continue;
    const cal = post.calibration[k];
    const est = r => (r.fromStated ? r.got : r.got * cal);
    const err = rs.map(r => Math.abs(est(r) / r.truthM2 - 1)).sort((a, b) => a - b);
    const [lo, hi] = post.range[k];
    const cov = rs.filter(r => r.truthM2 >= est(r) * lo && r.truthM2 <= est(r) * hi).length / rs.length * 100;
    const label = { roof: "屋根", wall: "外壁", floor: "内装" }[k];
    console.log(`  ${label.padEnd(8)} ${String(rs.length).padStart(2)}  ×${cal.toFixed(2)}  ` +
      `${(err.reduce((a, b) => a + b, 0) / err.length * 100).toFixed(1).padStart(6)}%  ` +
      `${(err[Math.floor(err.length / 2)] * 100).toFixed(1).padStart(6)}%  ` +
      `${(err.filter(e => e <= .15).length / err.length * 100).toFixed(0).padStart(3)}%  ` +
      `${cov >= 85 ? C.g : C.r}${cov.toFixed(0).padStart(6)}%${C.x}  ${cov < 85 ? C.r + "← 幅が正解を捕まえていない" + C.x : ""}`);

    // ★較正の基準値が、いまのプロンプトに合っているか。
    //   プロンプトを直すとAIの出し方の偏りが変わるので、旧プロンプト時代の係数が
    //   そのまま残っていると過補正・過少補正になる。ここが一番見落としやすい。
    const ratios = rs.filter(r => !r.fromStated).map(r => r.truthM2 / r.got);
    if (ratios.length >= 3) {
      const geo = Math.exp(ratios.reduce((s, x) => s + Math.log(x), 0) / ratios.length);
      const gap = Math.abs(geo / cal - 1) * 100;
      console.log(`  ${"".padEnd(10)}${gap > 20 ? C.r : gap > 10 ? C.y : C.g}較正の当たり: いまの生推定に最も合う係数は ×${geo.toFixed(2)}` +
        `（設定は ×${cal.toFixed(2)}／ずれ ${gap.toFixed(0)}%）${C.x}` +
        `${gap > 20 ? C.r + "  ← AREA_CALIBRATION_BASE を見直すこと" + C.x : ""}`);
    }
  }

  // ★実行ごとのばらつき。同じ画像を複数回回したときに、答えがどれだけ動くか。
  //   ここが大きいと、1回の結果でプロンプトの良し悪しを判定できない。
  //   実測: 同じ画像・同じプロンプト・同じモデルで 11件中3件が1.5倍以上ずれた（2026-09-02）。
  const byId = {};
  rows.forEach(r => { (byId[r.id] = byId[r.id] || []).push(r.got); });
  const repeated = Object.entries(byId).filter(([, v]) => v.length > 1);
  if (repeated.length) {
    const spreads = repeated.map(([id, v]) => ({ id, lo: Math.min(...v), hi: Math.max(...v), ratio: Math.max(...v) / Math.min(...v) }));
    spreads.sort((a, b) => b.ratio - a.ratio);
    const big = spreads.filter(s => s.ratio >= 1.5).length;
    console.log(`\n${C.b}■ 実行ごとのばらつき${C.x}  ${C.d}同じ画像を${REPEAT}回ずつ${C.x}`);
    console.log(`  1.5倍以上ずれた物件: ${big >= 1 ? C.r : C.g}${big}/${spreads.length}件${C.x}`);
    spreads.slice(0, 5).forEach(s => console.log(`    ${s.id.padEnd(28)} ${s.lo.toFixed(0)}〜${s.hi.toFixed(0)}㎡  ${s.ratio.toFixed(2)}倍${s.ratio >= 1.5 ? C.r + "  ★" + C.x : ""}`));
    if (big >= 1) {
      console.log(`  ${C.r}→ 1回の結果でプロンプトの良し悪しを判定しないこと。ノイズを見て決めることになる。${C.x}`);
    }
  } else {
    console.log(`\n  ${C.y}※ --n=1 で回した。写真からの推定は再現しない（同条件2回で11件中3件が1.5倍以上ずれた実績）。`);
    console.log(`     プロンプトを比べるときは --n=3 以上で回すこと。${C.x}`);
  }

  const views = [...new Set(rows.map(r => r.viewType).filter(Boolean))];
  if (views.length > 1) {
    console.log(`\n  ${"撮り方".padEnd(10)} n   平均誤差`);
    for (const v of views) {
      const rs = rows.filter(r => r.viewType === v);
      const e = rs.map(r => Math.abs(r.got / r.truthM2 - 1));
      console.log(`  ${v.padEnd(10)} ${String(rs.length).padStart(2)}  ${(e.reduce((a, b) => a + b, 0) / e.length * 100).toFixed(1).padStart(6)}%`);
    }
  }

  const out = path.join(DIR, "result.json");
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), model: cfg.model, range: post.range, rows }, null, 2), "utf8");
  console.log(`\n${C.d}結果を ${path.relative(process.cwd(), out)} に保存しました${C.x}\n`);
})();
