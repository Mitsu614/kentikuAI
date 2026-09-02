// 出荷している main.ts から「面積事前確認」のプロンプトと後処理を取り出す。
//
// なぜコピーを置かないのか:
//   harness-roof/strategies.js はプロンプトを複製して持っている。本番を直しても
//   ハーネスは古いプロンプトのまま回るので、「ハーネスは通るのに本番は直っていない」
//   （あるいはその逆）が起きる。実際いま、本番には図面/写真の判定が入ったが
//   harness-roof のプロンプトには入っていない。
//   ここでは main.ts を正として、必要な塊を切り出して使う。
//
// 取り出すもの:
//   - AREA_SCALE_GUIDE / WALL_SCALE_GUIDE / FLOOR_SCALE_GUIDE（target別の手順）
//   - ユーザーメッセージのテンプレート（`この写真の工事対象について〜` から JSON 仕様の末尾まで）
//   - モデル指定・system プロンプト
//   - 後処理の定数（較正の適用条件・レンジの倍率）

const fs = require("fs");
const path = require("path");

const MAIN = path.resolve(__dirname, "../../src/main/main.ts");

function read() {
  return fs.readFileSync(MAIN, "utf8");
}

// `const NAME = \`....\`;` を取り出す（中に ${...} を含んでいてよい）
function grabTemplate(src, name) {
  const start = src.indexOf(`const ${name} = \``);
  if (start < 0) throw new Error(`${name} が main.ts に見つからない`);
  let i = src.indexOf("`", start + `const ${name} = `.length) + 1;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "$" && src[i + 1] === "{") { depth++; i++; continue; }
    if (c === "}" && depth > 0) { depth--; continue; }
    if (c === "`" && depth === 0) break;
  }
  const open = src.indexOf("`", start) + 1;
  return src.slice(open, i);
}

/** target別の手順書 */
function guides() {
  const src = read();
  return {
    roof: grabTemplate(src, "AREA_SCALE_GUIDE"),
    wall: grabTemplate(src, "WALL_SCALE_GUIDE"),
    floor: grabTemplate(src, "FLOOR_SCALE_GUIDE"),
  };
}

/** 利用者に投げるテキスト本体。main.ts のテンプレートをそのまま使い、guide だけ差し込む */
function userPrompt(comment) {
  const src = read();
  const anchor = "この写真の工事対象について、**寸法だけ**を答えてください";
  const s = src.indexOf(anchor);
  if (s < 0) throw new Error("プロンプト本体が見つからない（main.ts の文言が変わった？）");
  // テンプレートリテラルの終端 ` まで
  let i = s, depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "$" && src[i + 1] === "{") { depth++; i++; continue; }
    if (c === "}" && depth > 0) { depth--; continue; }
    if (c === "`" && depth === 0) break;
  }
  let body = src.slice(s, i);
  const g = guides();
  body = body
    .replace("${AREA_SCALE_GUIDE}", g.roof)
    .replace("${WALL_SCALE_GUIDE}", g.wall)
    .replace("${FLOOR_SCALE_GUIDE}", g.floor)
    .replace(/\$\{data\?\.comment \? `依頼内容: \$\{data\.comment\}\\n\\n` : ''\}/, comment ? `依頼内容: ${comment}\n\n` : "");
  if (/\$\{/.test(body)) {
    const left = body.match(/\$\{[^}]*\}/g) || [];
    throw new Error("差し込み漏れ: " + left.slice(0, 3).join(" / "));
  }
  return body;
}

/** 本番が使っているモデルと system。main.ts から読む */
function modelConfig() {
  const src = read();
  const s = src.indexOf("const response = await client.messages.create({", src.indexOf("面積の事前確認には写真が必要"));
  const blk = src.slice(s, s + 700);
  const model = (blk.match(/model: '([^']+)'/) || [])[1];
  const think = /thinking: \{ type: 'adaptive' \}/.test(blk);
  const system = (blk.match(/system: '([^']+)'/) || [])[1];
  if (!model || !system) throw new Error("モデル指定を読み取れない");
  return { model, think, system };
}

/** 後処理の定数（レンジの倍率）。本番を直したらハーネスも自動で追従する */
function postConstants() {
  const src = read();
  const roof = src.match(/target === 'roof'\) \{\s*\n\s*result\.rangeMinM2 = Math\.round\(result\.quantityM2 \* ([\d.]+)\);\s*\n\s*result\.rangeMaxM2 = Math\.round\(result\.quantityM2 \* ([\d.]+)\)/);
  const other = src.match(/\} else \{\s*\n\s*result\.rangeMinM2 = Math\.round\(result\.quantityM2 \* ([\d.]+)\);\s*\n\s*result\.rangeMaxM2 = Math\.round\(result\.quantityM2 \* ([\d.]+)\)/);
  if (!roof || !other) throw new Error("レンジの倍率を読み取れない（main.ts の書き方が変わった？）");
  return {
    range: {
      roof: [Number(roof[1]), Number(roof[2])],
      wall: [Number(other[1]), Number(other[2])],
      floor: [Number(other[1]), Number(other[2])],
    },
  };
}

module.exports = { MAIN, guides, userPrompt, modelConfig, postConstants };
