// 面積推定の戦略群。すべて同じ入力・同じ出力スキーマで戦わせる。
// 出力は必ず { quantityM2, roofAreaM2, planAreaM2, confidence, basis, ... } を含む。

const fs = require('fs');
const path = require('path');

const APP = 'C:/Users/mitsu/OneDrive/Desktop/kentikuAI/app';

// 実装中のガイドをソースから直接読む。実装とベンチが乖離しないようにするため。
function liveGuide() {
  const src = fs.readFileSync(path.join(APP, 'src/main/main.ts'), 'utf8');
  const m = src.match(/const AREA_SCALE_GUIDE = `([\s\S]*?)`;/);
  if (!m) throw new Error('AREA_SCALE_GUIDE を main.ts から抽出できません');
  return m[1];
}

const OUT_SCHEMA = `
以下のJSONのみを返してください（説明文は不要）:
{
  "coversWholeRoof": true/false,
  "scaleRef": "基準にした物とその実寸",
  "widthM": 数値, "lengthM": 数値,
  "planAreaM2": 数値, "slopeFactor": 数値,
  "roofAreaM2": 数値, "developFactor": 数値, "quantityM2": 数値,
  "rangeMinM2": 数値かnull, "rangeMaxM2": 数値かnull,
  "assumedArea": "短い表記", "basis": "根拠", "confidence": "高/中/低"
}`;

// ── S0: 現行実装（v3.3.13 のまま）──────────────────────
const S0_baseline = {
  id: 'S0-baseline',
  desc: '現行実装。スケール表なし・手順なし・300トークン',
  maxTokens: 300,
  samples: 1,
  prompt: (item) => `${item.comment ? `依頼内容: ${item.comment}\n\n` : ''}この写真の工事対象について、見積の前提になる主要な面積・数量を1つだけ推定してください。
- 屋根工事なら屋根面積、外壁なら外壁面積、内装なら床面積、というように金額を最も左右する数量を1つ選ぶ
- 写真から寸法の手がかり（人・車・ブロック・折板の山ピッチ・サッシ等）を探し、根拠に必ず書く
- 手がかりが乏しければ confidence を「低」にする。無理に断定しない

以下のJSONのみを返してください（説明文は不要）:
{"assumedArea": "屋根 48㎡ のような短い表記", "basis": "推定の根拠を1文で", "confidence": "高/中/低"}`,
};

// ── S1: 現在のガイド（スケール表＋手順＋展開係数）──────
const S1_guide = {
  id: 'S1-guide',
  desc: 'main.ts の AREA_SCALE_GUIDE をそのまま使う',
  maxTokens: 1500,
  samples: 1,
  prompt: (item) => `${item.comment ? `依頼内容: ${item.comment}\n\n` : ''}この写真の工事対象について、見積の前提になる面積を推定してください。
${liveGuide()}
${OUT_SCHEMA}`,
};

// ── S2: 面積を直接聞かず、寸法だけ聞いて掛け算はコード側でやる ──
// VLM は面積(2次元量)より長さ(1次元量)のほうが当たる、という仮説の検証。
const S2_dims_only = {
  id: 'S2-dims-only',
  desc: '寸法だけ答えさせ、面積の掛け算はコードで行う',
  maxTokens: 1500,
  samples: 1,
  prompt: (item) => `${item.comment ? `依頼内容: ${item.comment}\n\n` : ''}この屋根の**寸法だけ**を答えてください。面積は計算しないでください（こちらで計算します）。
${liveGuide()}

答えるのは次の値だけです。掛け算はしないこと。
${OUT_SCHEMA}
※ planAreaM2 / roofAreaM2 / quantityM2 は 0 を入れてよい。widthM・lengthM・slopeFactor・developFactor を正確に。`,
  // コード側で面積を組み立てる
  postprocess: (j) => {
    const w = Number(j.widthM) || 0, l = Number(j.lengthM) || 0;
    const sf = Number(j.slopeFactor) || 1, df = Number(j.developFactor) || 1;
    const plan = w * l;
    j.planAreaM2 = Math.round(plan * 10) / 10;
    j.roofAreaM2 = Math.round(plan * sf * 10) / 10;
    j.quantityM2 = Math.round(plan * sf * df * 10) / 10;
    return j;
  },
};

// ── S3: 複数回サンプリングして中央値をとる（temperature 1.0）──
const S3_median = {
  id: 'S3-median5',
  desc: 'temperature 1.0 で5回サンプルし、quantityM2 の中央値を採る',
  maxTokens: 1500,
  samples: 5,
  temperature: 1.0,
  prompt: S1_guide.prompt,
  aggregate: (results) => {
    const vals = results.map(r => Number(r.quantityM2)).filter(v => v > 0).sort((a, b) => a - b);
    if (!vals.length) return results[0];
    const mid = vals[Math.floor(vals.length / 2)];
    const base = results.find(r => Number(r.quantityM2) === mid) || results[0];
    return { ...base, quantityM2: mid, _samples: vals, _spread: vals[vals.length - 1] / vals[0] };
  },
};

// ── S4: グリッドを重ねた画像を渡す（数えやすくする）──
// 画像側で 10x10 のグリッドを描き、マス目を数えさせる。
const S4_grid = {
  id: 'S4-grid',
  desc: '10×10グリッドを重畳し、屋根が占めるマス数を数えさせる',
  maxTokens: 1500,
  samples: 1,
  needsGrid: true,
  prompt: (item) => `${item.comment ? `依頼内容: ${item.comment}\n\n` : ''}この写真の屋根の面積を推定してください。
画像には10×10のグリッド（各マスに座標ラベル）を重ねてあります。

手順:
1. 屋根が占めるマスの数を数える（一部だけ掛かるマスは0.5として数える）。何マスか必ず書く。
2. 基準スケールから「1マスが実寸で何m×何mか」を求める。
3. 面積 = マス数 × 1マスの面積。
${liveGuide()}
${OUT_SCHEMA}`,
};

// ── S5: 屋根伏図（平面図）を先に言語化させてから面積を出す ──
const S5_plan_first = {
  id: 'S5-plan-first',
  desc: '屋根伏図を先に言語で描かせ、面の分割から面積を積む',
  maxTokens: 2000,
  samples: 1,
  prompt: (item) => `${item.comment ? `依頼内容: ${item.comment}\n\n` : ''}この屋根の面積を、屋根伏図（真上から見た平面図）を組み立てる手順で求めてください。

手順:
1. 屋根の形状を判定する（切妻/寄棟/片流れ/入母屋/陸屋根/複合）。
2. 屋根を平面（面）に分解し、各面の形（長方形/台形/三角形）と寸法を書き出す。
   basis に「面A: 長方形 6.0m×4.0m」のように列挙すること。
3. 各面の水平投影面積を足して planAreaM2 とする。
4. 勾配補正・展開係数を掛ける。
${liveGuide()}
${OUT_SCHEMA}`,
};

// ── S6: Crop & Zoom（2パス）────────────────────────────
// 文献で最も効果が確認された介入。まず屋根のROIを座標で答えさせ、切り出して拡大してから測る。
// V*/SEAL: 55.0% → 75.4%（arXiv:2312.14135）。小対象で最大46%の劣化をROIクロップで回復。
const S6_crop_zoom = {
  id: 'S6-crop-zoom',
  desc: '屋根ROIを特定→切り出して拡大→そのうえで面積推定（2パス）',
  maxTokens: 1500,
  samples: 1,
  twoPass: true,
  locatePrompt: () => `この写真に写っている建物の屋根だけを囲む最小の矩形を答えてください。
画像の左上を(0,0)、右下を(1,1)とする相対座標で答えます。
複数棟あるときは、最も大きく写っている主たる建物の屋根に限ります。

JSONのみ: {"x0":0.0,"y0":0.0,"x1":1.0,"y1":1.0,"note":"どの建物か一文で"}`,
  prompt: (item) => `${item.comment ? `依頼内容: ${item.comment}\n\n` : ''}この画像は屋根の部分を切り出して拡大したものです。この屋根の面積を推定してください。
${liveGuide()}
${OUT_SCHEMA}`,
};

// ── S7: 合成ベット（crop + 中央値5回）──────────────────
// 文献の推奨: 戦略1(crop) + 戦略2(self-consistency) + 戦略3(参照アンカー=ガイドに内蔵)
const S7_combo = {
  id: 'S7-combo',
  desc: 'Crop&Zoom + 5回サンプルの中央値（文献推奨の合成）',
  maxTokens: 1500,
  samples: 5,
  temperature: 1.0,
  twoPass: true,
  locatePrompt: S6_crop_zoom.locatePrompt,
  prompt: S6_crop_zoom.prompt,
  aggregate: S3_median.aggregate,
};


// ── S8: 本命（寸法のみ + 5回中央値 + 較正）────────────────
// LOO検証で S2-dims-only が最良（1.25倍以内 8/11、最悪1.81倍）。
// これに Self-Consistency(ICLR2023, +11〜18%) を重ね、系統的な過小バイアスを較正で消す。
// 較正係数 1.30 は 11件の幾何平均比 0.77 の逆数。LOOで過学習でないことを確認済み。
const S8_champion = {
  id: 'S8-champion',
  desc: '寸法のみ回答 + 5回サンプル中央値 + 較正係数1.30',
  maxTokens: 1500,
  samples: 5,
  temperature: 1.0,
  prompt: S2_dims_only.prompt,
  postprocess: S2_dims_only.postprocess,
  aggregate: (results) => {
    const pick = (key) => {
      const v = results.map(r => Number(r[key])).filter(x => x > 0).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : 0;
    };
    // 寸法ごとに中央値をとってから掛ける（面積の中央値より外れ値に強い）
    const w = pick('widthM'), l = pick('lengthM');
    const sf = pick('slopeFactor') || 1, df = pick('developFactor') || 1;
    const CAL = 1.30;
    const plan = w * l * CAL;
    const base = results[0];
    const q = plan * sf * df;
    const vals = results.map(r => Number(r.quantityM2)).filter(v => v > 0).sort((a, b) => a - b);
    return {
      ...base, widthM: w, lengthM: l, slopeFactor: sf, developFactor: df,
      planAreaM2: Math.round(plan * 10) / 10,
      roofAreaM2: Math.round(plan * sf * 10) / 10,
      quantityM2: Math.round(q * 10) / 10,
      rangeMinM2: Math.round(q * 0.75), rangeMaxM2: Math.round(q * 1.35),
      _spread: vals.length > 1 ? vals[vals.length - 1] / vals[0] : null,
    };
  },
};

module.exports = {
  liveGuide, OUT_SCHEMA,
  strategies: [S0_baseline, S1_guide, S2_dims_only, S3_median, S4_grid, S5_plan_first, S6_crop_zoom, S7_combo, S8_champion],
};
