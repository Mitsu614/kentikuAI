// 出荷している docs/birukaze/index.html から計算エンジンだけを切り出して読み込む。
//
// なぜコピーを置かないのか:
//   エンジンをこちらに複製すると、本番を直したときに片方だけ古くなる。
//   harness-roof / harness-takeoff で「ハーネスは通るのに本番は直っていない」
//   を避けるため、常に出荷物そのものを読む。
//
// 切り出す範囲: `"use strict";` から「2. 会話フロー」の見出しの手前まで。
//   この範囲は DOM に一切触らないので Node でそのまま動く。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = path.resolve(__dirname, "../../../docs/birukaze/index.html");

function extractEngine() {
  const html = fs.readFileSync(HTML, "utf8");
  const start = html.indexOf('"use strict";');
  if (start < 0) throw new Error('エンジンの開始位置が見つからない ("use strict";)');
  const end = html.indexOf("2. 会話フロー", start);
  if (end < 0) throw new Error("エンジンの終了位置が見つからない (2. 会話フロー)");
  // 見出しのコメントブロックごと落とす
  const cut = html.lastIndexOf("/* ═", end);
  return html.slice(start, cut > start ? cut : end);
}

// エンジン内は const 宣言なので、vm のグローバルには生えてこない。
// 同じレキシカルスコープで受け渡す行を末尾に足して取り出す。
const EXPORTS = [
  "TUNING", "ROUGH", "REGIONS", "MEASURES", "GUSTS", "MURAKAMI", "NEN", "LAWSON",
  "clamp", "gammaFn", "weibullC", "pExceed", "quantile", "pDailyMax", "N_EFF",
  "baseRatio", "speedup", "applyMeasures", "murakami", "nen8100", "lawson",
  "feel", "adminHint", "diagnose", "rankBand"
];

// tuning を差し替えてエンジンを読み込む。差し替えなければ出荷時の値のまま。
function load(tuningOverride) {
  const src = extractEngine() +
    "\n;globalThis.__engine = { " + EXPORTS.join(", ") + " };\n";

  const sandbox = {
    console, Math, JSON, Number, String, Array, Object, isFinite, parseFloat,
    URLSearchParams,
    location: { search: "" },
    localStorage: { getItem: () => null, setItem: () => {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "birukaze-engine" });

  const engine = sandbox.__engine;
  if (!engine) throw new Error("エンジンの取り出しに失敗した");
  // TUNING は const だがオブジェクトの中身は書き換えられる。diagnose は呼び出し時に読む。
  if (tuningOverride) Object.assign(engine.TUNING, tuningOverride);
  return engine;
}

// 出荷時のつまみの値（較正の出発点）
function shippedTuning() {
  return JSON.parse(JSON.stringify(load().TUNING));
}

module.exports = { load, shippedTuning, HTML };
