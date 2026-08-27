// ビル風診断のハーネス。
//
//   node app/tools/harness-birukaze/run.js              … 不変条件の検査＋感度分析
//   node app/tools/harness-birukaze/run.js --sens        … 感度分析だけ
//   node app/tools/harness-birukaze/run.js --json        … 結果を JSON で吐く
//
// 出荷している docs/birukaze/index.html のエンジンをそのまま読んで回す。
// 結果は harness-result.json に残る。係数を触ったら回し直して悪化を見る。

const fs = require("fs");
const path = require("path");
const { load, shippedTuning } = require("./model");
const { CONSTRAINTS, sweep, v } = require("./constraints");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const sensOnly = args.includes("--sens");

const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[90m", x: "\x1b[0m", b: "\x1b[1m" };
const say = (...a) => { if (!asJson) console.log(...a); };

function runConstraints(E) {
  const rows = [];
  for (const c of CONSTRAINTS) {
    let res;
    try { res = c.test(E); }
    catch (e) { res = { ok: false, detail: "例外: " + e.message }; }
    rows.push({ id: c.id, desc: c.desc, src: c.src, ok: res.ok, detail: res.detail || "" });
  }
  return rows;
}

// 基準ケースから各入力を ±20% 動かし、増加率と判定がどれだけ動くかを見る。
// 過敏なつまみ＝入力の誤差がそのまま結果の誤差になる箇所。
function sensitivity(E) {
  const base = v({});
  const d0 = E.diagnose(base, new Set());
  const out = [];

  const numeric = [["H", "高さ"], ["B", "見付け幅"], ["D", "奥行"], ["Hs", "周辺高さ"], ["bcr", "建蔽率"]];
  for (const [key, label] of numeric) {
    const lo = Object.assign({}, base, { [key]: base[key] * 0.8 });
    const hi = Object.assign({}, base, { [key]: base[key] * 1.2 });
    const dl = E.diagnose(lo, new Set()), dh = E.diagnose(hi, new Set());
    const dR = (dh.R - dl.R) / d0.R * 100;
    out.push({
      input: label, kind: "±20%",
      R: [dl.R, d0.R, dh.R],
      dRpct: dR,
      rank: [dl.after.murakami.rank, d0.after.murakami.rank, dh.after.murakami.rank],
      rankSpread: Math.max(dl.after.murakami.rank, d0.after.murakami.rank, dh.after.murakami.rank)
                - Math.min(dl.after.murakami.rank, d0.after.murakami.rank, dh.after.murakami.rank)
    });
  }

  for (const [key, label, vals] of [
    ["rough", "粗度区分", ["I", "II", "III", "IV"]],
    ["form", "足元の形", ["none", "pilotis", "through"]],
    ["region", "地域", E.REGIONS.map(r => r.id)]
  ]) {
    const rs = vals.map(x => E.diagnose(Object.assign({}, base, { [key]: x }), new Set()));
    out.push({
      input: label, kind: "全水準",
      R: rs.map(x => x.R),
      dRpct: (Math.max(...rs.map(x => x.R)) - Math.min(...rs.map(x => x.R))) / d0.R * 100,
      rank: rs.map(x => x.after.murakami.rank),
      rankSpread: Math.max(...rs.map(x => x.after.murakami.rank))
                - Math.min(...rs.map(x => x.after.murakami.rank))
    });
  }
  return { base: d0, rows: out };
}

// 掃いたケース全体で、村上ランクがどう分布するか。
// 全部ランク4なら判定として役に立っていない、という検査。
function distribution(E) {
  const cases = sweep();
  const rank = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const nen = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let rMin = Infinity, rMax = -Infinity, rSum = 0;
  for (const c of cases) {
    const d = E.diagnose(c, new Set());
    rank[d.after.murakami.rank]++;
    nen[d.after.nen.cls.c]++;
    rMin = Math.min(rMin, d.R); rMax = Math.max(rMax, d.R); rSum += d.R;
  }
  return { n: cases.length, rank, nen, rMin, rMax, rMean: rSum / cases.length };
}

// ── 実行 ──
const E = load();
const result = { tuning: shippedTuning(), at: new Date().toISOString() };

if (!sensOnly) {
  say(`\n${C.b}■ 不変条件の検査${C.x}  ${C.d}公表文献が報告している関係を満たすか${C.x}\n`);
  result.constraints = runConstraints(E);
  let ng = 0;
  for (const r of result.constraints) {
    const mark = r.ok ? `${C.g}OK  ${C.x}` : `${C.r}NG  ${C.x}`;
    if (!r.ok) ng++;
    say(`${mark} ${r.id}  ${r.desc}`);
    say(`     ${C.d}${r.src}${C.x}`);
    if (r.detail) say(`     ${r.ok ? C.d : C.r}${r.detail}${C.x}`);
  }
  result.ng = ng;
  say(`\n  ${ng === 0 ? C.g + "全 " + result.constraints.length + " 件パス" : C.r + ng + " 件 NG"}${C.x}`);

  const dist = distribution(E);
  result.distribution = dist;
  say(`\n${C.b}■ 掃いた ${dist.n} ケースの分布${C.x}  ${C.d}判定が偏っていないか${C.x}\n`);
  say(`  増加率  最小 ${dist.rMin.toFixed(2)} / 平均 ${dist.rMean.toFixed(2)} / 最大 ${dist.rMax.toFixed(2)}`);
  say(`  村上    ${[1, 2, 3, 4].map(k => `ランク${k}:${(dist.rank[k] / dist.n * 100).toFixed(0)}%`).join("  ")}`);
  say(`  NEN     ${Object.entries(dist.nen).map(([k, n]) => `${k}:${(n / dist.n * 100).toFixed(0)}%`).join("  ")}`);
}

const sens = sensitivity(E);
result.sensitivity = sens.rows;
say(`\n${C.b}■ 感度分析${C.x}  ${C.d}どの入力が結果を支配しているか（基準: 高さ60m 幅40m 奥行20m 周辺10m 市街地）${C.x}\n`);
// 増加率の振れだけを見ると、増加率を通さずに判定を動かす入力（建蔽率・地域）を
// 見落とす。それらは風速比と気象統計の側から効くため。判定の振れも併せて出す。
say(`  ${"入力".padEnd(12)} ${"条件".padEnd(8)} 増加率  村上ランク  内訳`);
for (const r of [...sens.rows].sort((a, b) => (b.rankSpread - a.rankSpread) || (Math.abs(b.dRpct) - Math.abs(a.dRpct)))) {
  const rs = r.R.map(x => x.toFixed(2)).join(" → ");
  const mag = Math.abs(r.dRpct);
  const bar = "█".repeat(Math.max(0, Math.min(20, Math.round(mag / 2))));
  const colR = mag > 25 ? C.r : mag > 12 ? C.y : C.g;
  const colK = r.rankSpread >= 2 ? C.r : r.rankSpread === 1 ? C.y : C.g;
  say(`  ${r.input.padEnd(12)} ${r.kind.padEnd(8)} ${colR}${r.dRpct.toFixed(1).padStart(6)}%${C.x}  ${colK}${String(r.rankSpread).padStart(2)}段階${C.x}  ${bar}`);
  say(`  ${"".padEnd(22)} ${C.d}${rs}   ランク ${r.rank.join("→")}${C.x}`);
}
const blind = sens.rows.filter(r => Math.abs(r.dRpct) < 1 && r.rankSpread >= 1);
if (blind.length) {
  say(`\n  ${C.y}※ ${blind.map(b => b.input).join("・")} は増加率をほとんど動かさないのに判定を動かす。${C.x}`);
  say(`  ${C.y}   増加率ではなく、風速比と気象統計の側から効いているため。${C.x}`);
}

const outPath = path.join(__dirname, "harness-result.json");
fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
if (asJson) console.log(JSON.stringify(result, null, 2));
else console.log(`\n${C.d}結果を ${path.relative(process.cwd(), outPath)} に保存しました${C.x}\n`);

process.exit(result.ng ? 1 : 0);
