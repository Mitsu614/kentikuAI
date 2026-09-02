// prompt.txt が main.ts の拾い出しプロンプトとズレていないかを検査する。
//
// なぜ要るか:
//   prompt.txt は main.ts takeoffDrawingCore のプロンプトを手でコピーしたもの。
//   「ここを直したら main.ts も直すこと」と書いてあるが、人間は忘れる。
//   ズレたまま回すと、本番と違うものを測っていることになり、計測の意味が無くなる。
//   （面積側で実際に起きた: harness-roof のプロンプトには図面判定が入っていない）
//
//   node app/tools/harness-takeoff/check-prompt-sync.js
//
// 実際にこの検査で、prompt.txt に紛れ込んだテンプレート構文の残骸
//   \n` : ''}\n` : ''}\n` : ''}
// を見つけた（そのままAIに渡っていた）。2026-09-02 に除去済み。

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const MAIN = path.resolve(DIR, "../../src/main/main.ts");
const PROMPT = path.join(DIR, "prompt.txt");
const MARK = "";   // 差し込み位置の目印（本文に出てこない文字を使う）

// 比較の前に揃えること:
//   - 改行コード（worktree は CRLF、本体は LF になりうる）と行末の空白
//   - テンプレートリテラルのエスケープ（main.ts では ``` が \` \` \` になっている）
//   - ${...} の差し込み。中身は実行時に決まるので比較対象から外す
function stripInterpolations(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") depth--;
        i++;
      }
      out += MARK;
      continue;
    }
    out += s[i++];
  }
  return out;
}

function norm(s) {
  const t = stripInterpolations(s.replace(/\r\n/g, "\n").replace(/\\`/g, "`"));
  return t
    .split("\n")
    .map(line => {
      const bare = line.split(MARK).join("").replace(/\s+$/, "");
      return bare.trim() === "" ? "" : bare;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// prompt.txt に紛れ込んだテンプレート構文の残骸（コピペ事故）
const JUNK = [/`\s*:\s*''\}/, /\$\{/];

function extractFromMain() {
  const src = fs.readFileSync(MAIN, "utf8");
  const head = "あなたは建築の積算士（拾い出し20年）です。";
  const s = src.indexOf(head);
  if (s < 0) return { ok: false, why: "main.ts に拾い出しプロンプトの冒頭が見つからない" };
  // テンプレートリテラルの終端 ` まで（${...} の中の } は数える）
  let i = s;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "$" && src[i + 1] === "{") { depth++; i++; continue; }
    if (c === "}" && depth > 0) { depth--; continue; }
    if (c === "`" && depth === 0) break;
  }
  return { ok: true, text: src.slice(s, i) };
}

function check() {
  if (!fs.existsSync(PROMPT)) return { ok: false, why: "prompt.txt が無い" };
  const got = extractFromMain();
  if (!got.ok) return got;

  const rawFile = fs.readFileSync(PROMPT, "utf8");
  const junkLines = rawFile.split(/\r?\n/).filter(l => JUNK.some(re => re.test(l)));

  const a = norm(got.text);
  const b = norm(rawFile);

  if (a === b && junkLines.length === 0) return { ok: true, why: "一致", chars: a.length };

  const la = a.split("\n");
  const lb = b.split("\n");
  const setA = new Set(la);
  const setB = new Set(lb);
  return {
    ok: false,
    why: a === b ? "本文は一致しているが、prompt.txt にテンプレート構文の残骸が混ざっている"
                 : "main.ts と prompt.txt がズレている",
    chars: [a.length, b.length],
    onlyMain: la.filter(l => !setB.has(l) && l.trim()),
    onlyFile: lb.filter(l => !setA.has(l) && l.trim()),
    junkLines,
  };
}

module.exports = { check };

if (require.main === module) {
  const C = { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[90m", x: "\x1b[0m" };
  const r = check();
  if (r.ok) {
    console.log(`${C.g}OK${C.x}  prompt.txt は main.ts と一致している（${r.chars}字）`);
    process.exit(0);
  }
  console.log(`${C.r}NG${C.x}  ${r.why}`);
  if (Array.isArray(r.chars)) console.log(`    main.ts ${r.chars[0]}字 / prompt.txt ${r.chars[1]}字`);
  if (r.onlyMain && r.onlyMain.length) {
    console.log(`\n  main.ts にだけある行（${r.onlyMain.length}）:`);
    r.onlyMain.slice(0, 12).forEach(l => console.log("    + " + l.slice(0, 100)));
  }
  if (r.onlyFile && r.onlyFile.length) {
    console.log(`\n  prompt.txt にだけある行（${r.onlyFile.length}）:`);
    r.onlyFile.slice(0, 12).forEach(l => console.log("    - " + l.slice(0, 100)));
  }
  if (r.junkLines && r.junkLines.length) {
    console.log(`\n  ${C.r}prompt.txt に残ったテンプレート構文（コピペ事故・${r.junkLines.length}行）:${C.x}`);
    r.junkLines.slice(0, 6).forEach(l => console.log("    ! " + l.trim().slice(0, 100)));
    console.log(`  ${C.d}この文字列がそのままAIに渡っている。消すこと。${C.x}`);
  }
  console.log(`\n  ${C.d}ズレたまま回すと、本番と違うものを測ることになる。`);
  console.log(`  main.ts を正として prompt.txt を更新するのが基本。${C.x}`);
  process.exit(1);
}
