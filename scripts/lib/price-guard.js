// 相場の自動更新のガードレール。
//
// これは何か:
//   AIが「この単価をこう変えたい」と出してきた変更案を、1件ずつ機械的に検査して、
//   通ったものだけを本文に適用する。通らなかったものは保留にして人に知らせる。
//
// なぜ要るか:
//   相場は全お客様の見積金額に直結する。とくに自社実績がまだ無い新規のお客様は、
//   ここの数字がそのまま見積になる。AIが桁を間違えたり、根拠なく倍にしたりしたら
//   気づかないまま全員の金額が狂う。週1回・無人で走る以上、人の目の代わりが要る。
//
// 考え方:
//   ・全文を書き直させない。「この文字列をこの文字列に置き換えたい」という差分だけ受け取る。
//   ・置換元が本文にちょうど1回だけ出てくることを確かめる（＝別の場所を巻き込まない）。
//   ・数字の個数が変わらないこと、1つずつが ±15% 以内であること。
//   ・根拠のURLが無い変更は入れない。
//   ・1回で変えられる件数と、本文全体の長さの変化にも上限を置く。
//
// ここを緩めると、緩めた分だけ事故の余地が増える。数字を動かすときは harness を回すこと。

const DEFAULTS = {
  maxPct: 0.15,        // 1つの数字が動いてよい幅
  maxEdits: 40,        // 1回の更新で適用してよい件数
  maxLengthDrift: 0.05, // 本文全体の長さが変わってよい幅（全文書き換えの検出）
};

/** 文字列から数値をすべて取り出す（1,234.5 のような桁区切りも拾う） */
function numbersIn(s) {
  const m = String(s).match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || [];
  return m.map(x => parseFloat(x.replace(/,/g, '')));
}

function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\/\S+$/.test(s.trim());
}

/**
 * 変更案を検査して、通ったものだけを本文へ適用する。
 * @param {string} currentText 今の相場本文
 * @param {Array}  edits       [{ old, new, item?, reason?, source? }]
 * @param {object} opts        DEFAULTS を上書きする値
 * @returns {{ text, applied, held }}
 */
function applyEdits(currentText, edits, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const applied = [];
  const held = [];
  let text = currentText;
  const usedOld = new Set();

  const hold = (edit, reason) => held.push({ edit, reason });

  for (const edit of Array.isArray(edits) ? edits : []) {
    const oldStr = edit && typeof edit.old === 'string' ? edit.old : '';
    const newStr = edit && typeof edit.new === 'string' ? edit.new : '';

    if (!oldStr || !newStr) { hold(edit, '置換元か置換先が空'); continue; }
    if (oldStr === newStr) { hold(edit, '変更になっていない'); continue; }
    if (applied.length >= cfg.maxEdits) { hold(edit, `1回の上限${cfg.maxEdits}件を超えた`); continue; }
    if (!isHttpUrl(edit.source)) { hold(edit, '根拠URLが無い'); continue; }
    if (usedOld.has(oldStr)) { hold(edit, '同じ箇所を二重に変えようとしている'); continue; }

    // 置換元が本文にちょうど1回だけ出てくること。0回＝存在しない箇所、2回以上＝別の場所を巻き込む。
    const hits = text.split(oldStr).length - 1;
    if (hits === 0) { hold(edit, '置換元が本文に無い'); continue; }
    if (hits > 1) { hold(edit, `置換元が本文に${hits}箇所ある（どれか特定できない）`); continue; }

    const a = numbersIn(oldStr);
    const b = numbersIn(newStr);
    if (a.length === 0) { hold(edit, '置換元に数字が無い（文章の書き換えは受け付けない）'); continue; }
    if (a.length !== b.length) { hold(edit, `数字の個数が変わる（${a.length}→${b.length}）`); continue; }

    let bad = null;
    for (let i = 0; i < a.length; i++) {
      if (!(b[i] > 0)) { bad = `${b[i]} は0以下`; break; }
      if (!(a[i] > 0)) { bad = `元の値 ${a[i]} が0以下`; break; }
      const pct = Math.abs(b[i] - a[i]) / a[i];
      if (pct > cfg.maxPct) {
        bad = `${a[i]} → ${b[i]} は ${(pct * 100).toFixed(1)}%（上限${(cfg.maxPct * 100).toFixed(0)}%）`;
        break;
      }
    }
    if (bad) { hold(edit, bad); continue; }

    text = text.replace(oldStr, newStr);
    usedOld.add(oldStr);
    applied.push(edit);
  }

  // 全文の長さが大きく動いていたら、差分のふりをした書き換えを疑う
  const drift = Math.abs(text.length - currentText.length) / Math.max(1, currentText.length);
  if (drift > cfg.maxLengthDrift) {
    return {
      text: currentText,
      applied: [],
      held: [...held, ...applied.map(e => ({ edit: e, reason: `本文の長さが${(drift * 100).toFixed(1)}%動いたため一括で取り消した` }))],
    };
  }

  return { text, applied, held };
}

module.exports = { applyEdits, numbersIn, DEFAULTS };
