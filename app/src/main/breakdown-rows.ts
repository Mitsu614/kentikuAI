// ── 金額を持たない内訳行を落とす ──
//
// 0円の行には、原因のちがう2種類がある。落とすのは同じだが、お客様に出す説明を分ける。
//
// ① 出力切れ（2026-08-23に実際に発生）
//    max_tokens で切れると、最後の行が {"item":"…","category":"材料" のように cost を持たないまま
//    parseLenientJson の括弧補完で生き残る。→「出力が切れた。見積もり直して」と言う。
//
// ② AIが自分で 0円 と書いた行（原状回復リハーサル 2026-08-04 で発生）
//    例: [施工費] 施工費（CF床張り 38㎡） 1人工 @0円 = 0円
//    相場DBの内装単価（CF 3,000〜5,000円/㎡ 等）は材工共なので、AIが材料行に材工共単価を入れ、
//    「施工費は材料に含む」の意味で施工費行を 0円 で出していた。出力は切れていないので、
//    ①の「見積もり直して」は誤った案内になる。→ どの行が 0円 だったかを名指しで伝える。
//    ★金額は機械で作らない（[[推測で数量を作らない]]）。0円の行は見積の行として成立しないので
//      落とすだけ。総額は変わらない（0円の行は総額に何も足していない）。

export type DroppedRows = {
  /** cost が無い行（出力切れ） */
  truncated: number;
  /** AIが cost: 0 と明示した行の項目名 */
  zeroPriced: string[];
};

export function dropPricelessBreakdownRows(result: any): DroppedRows {
  const out: DroppedRows = { truncated: 0, zeroPriced: [] };
  if (!result || !Array.isArray(result.breakdown)) return out;
  result.breakdown = result.breakdown.filter((b: any) => {
    if (Number(b?.cost) > 0) return true;
    const hasCost = b && b.cost !== undefined && b.cost !== null && String(b.cost).trim() !== '';
    if (hasCost && Number(b.cost) === 0) out.zeroPriced.push(String(b?.item || '（項目名なし）'));
    else out.truncated++;
    return false;
  });
  if (out.truncated > 0) console.warn(`[analyze] 金額の無い内訳 ${out.truncated} 行を除外（出力が切れた可能性）`);
  if (out.zeroPriced.length > 0) console.warn(`[analyze] AIが0円で出した内訳を除外 → ${out.zeroPriced.join(' / ')}`);
  return out;
}

/** 落とした行について、画面に出す警告文。何も落としていなければ空配列 */
export function droppedRowWarnings(d: DroppedRows): string[] {
  const w: string[] = [];
  if (d.truncated > 0) {
    w.push(`AIの出力が途中で切れたため、金額が入っていない内訳 ${d.truncated} 行を除きました。総額が想定より小さいときは、もう一度見積もり直してください。`);
  }
  if (d.zeroPriced.length > 0) {
    w.push(`AIが 0円 で出した内訳を除きました: ${d.zeroPriced.join('、')}。`
      + `施工手間が材料の単価（材工共）や他の施工費の行に含まれている可能性があります。材料と施工費の内訳をご確認ください。金額は変更していません`);
  }
  return w;
}
