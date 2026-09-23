// 歩掛（ぶがかり）＝「その数量をこなすのに何人工かかるか」の目安。
//
// なぜ要るか:
//   人件費は「人工 × 日額」で決まる。日額は公的単価があるので間違えようがないが、
//   **人工そのものをAIが少なく見積もる**事故が起きている（山下さんの案件で約200万円の過少）。
//   いまの検算は「人件費 ＝ Σ(人工×日額) か」を見るだけなので、
//   AIが人工のほうも辻褄を合わせて小さく書くと、そのまま通ってしまう。
//   （main.ts の checkLaborAgainstManDays のコメントに、その限界が書いてある）
//
//   そこで「数量から見て、その人工は妥当か」を機械が当てる。
//   ★ここでやるのも**指摘だけ**。人工や金額を機械が書き換えることはしない。
//     歩掛は現場条件（高所・狭所・夜間・既存撤去の有無）で普通に1.5倍変わるので、
//     レンジから外れたことを伝えて、人に判断してもらう。
//
// 出典: 公共建築工事標準歩掛・各職種の実務標準値。幅があるものは実務でよく使う範囲。

export type YieldRule = {
  /** 内訳の品名がこれに当たれば、この歩掛を使う */
  match: RegExp;
  /** この単位の行だけを見る */
  unit: '㎡' | 'm' | '箇所' | '台' | '個' | 'm3' | '坪';
  /** 1人工でこなせる数量の範囲（多いほど早い）。例: クロス 25〜35㎡/人日 */
  perManDayLow: number;
  perManDayHigh: number;
  label: string;
  /** この行は除外する（別工種の紛れ込み対策） */
  exclude?: RegExp;
};

export const LABOR_YIELDS: YieldRule[] = [
  // ── 内装 ──
  { match: /クロス|壁紙|ｸﾛｽ/, unit: '㎡', perManDayLow: 25, perManDayHigh: 35, label: 'クロス張替', exclude: /下地|パテのみ/ },
  { match: /石膏ボード|プラスターボード|PB張|ボード張/, unit: '㎡', perManDayLow: 25, perManDayHigh: 35, label: '石膏ボード張り' },
  { match: /LGS|軽量鉄骨|軽天/, unit: '㎡', perManDayLow: 25, perManDayHigh: 35, label: '軽天下地' },
  { match: /フローリング|フロア材/, unit: '㎡', perManDayLow: 15, perManDayHigh: 20, label: 'フローリング張り' },
  { match: /クッションフロア|CF|長尺シート|塩ビシート/, unit: '㎡', perManDayLow: 25, perManDayHigh: 35, label: '長尺・CF張り' },
  { match: /タイルカーペット|カーペット/, unit: '㎡', perManDayLow: 40, perManDayHigh: 60, label: 'カーペット敷き' },
  { match: /幅木|巾木/, unit: 'm', perManDayLow: 80, perManDayHigh: 120, label: '幅木取付' },
  { match: /天井.*(張|仕上|ボード)|(張|仕上).*天井/, unit: '㎡', perManDayLow: 20, perManDayHigh: 30, label: '天井仕上げ' },

  // ── 塗装 ──
  { match: /外壁塗装|外壁.*塗/, unit: '㎡', perManDayLow: 40, perManDayHigh: 60, label: '外壁塗装', exclude: /下地補修|シーリング/ },
  { match: /屋根塗装|屋根.*塗/, unit: '㎡', perManDayLow: 50, perManDayHigh: 70, label: '屋根塗装' },
  { match: /シーリング|コーキング/, unit: 'm', perManDayLow: 60, perManDayHigh: 100, label: 'シーリング' },

  // ── 仮設・解体 ──
  { match: /足場/, unit: '㎡', perManDayLow: 60, perManDayHigh: 100, label: '足場組立・解体', exclude: /リース|賃料|運搬/ },
  { match: /解体/, unit: '㎡', perManDayLow: 5, perManDayHigh: 8, label: '解体（延床あたり）', exclude: /処分|運搬|産廃/ },

  // ── 躯体・外構 ──
  { match: /土間コン|コンクリート打設|生コン/, unit: '㎡', perManDayLow: 30, perManDayHigh: 50, label: '土間コン打設' },
  { match: /型枠/, unit: '㎡', perManDayLow: 8, perManDayHigh: 12, label: '型枠' },
  { match: /鉄筋/, unit: 'm3', perManDayLow: 0.8, perManDayHigh: 1.2, label: '鉄筋（t/人日の目安）' },
  { match: /ブロック積|CB積/, unit: '㎡', perManDayLow: 8, perManDayHigh: 12, label: 'ブロック積み' },

  // ── 電気（今日 cost-reference に足した歩掛と同じ値）──
  { match: /コンセント|スイッチ/, unit: '箇所', perManDayLow: 2, perManDayHigh: 3.3, label: '配線器具取付' },
  { match: /照明|ダウンライト|ベースライト/, unit: '台', perManDayLow: 2, perManDayHigh: 3.3, label: '照明器具取付', exclude: /撤去/ },
  { match: /VVF|ケーブル配線|電線/, unit: 'm', perManDayLow: 20, perManDayHigh: 33, label: 'ケーブル配線', exclude: /幹線|CVT|撤去/ },
  { match: /PF管|CD管|電線管|配管.*電/, unit: 'm', perManDayLow: 10, perManDayHigh: 16, label: '電線管配管' },
  { match: /幹線|CVT/, unit: 'm', perManDayLow: 3.3, perManDayHigh: 6.6, label: '幹線敷設' },
  { match: /感知器|警報器/, unit: '個', perManDayLow: 2, perManDayHigh: 3.3, label: '感知器取付' },
];

export type LaborCheck = {
  /** 歩掛から出した必要人工の下限・上限 */
  low: number;
  high: number;
  /** 突き合わせに使えた行 */
  rows: { name: string; quantity: number; unit: string; low: number; high: number; label: string }[];
  /** 歩掛が無くて見られなかった行の数 */
  skipped: number;
};

/**
 * 内訳（breakdown）から、必要な人工の目安レンジを出す。
 * 歩掛が分かる行だけを足すので、**これは下限の目安**（全部は見られない）。
 */
export function estimateManDaysFromBreakdown(breakdown: any[]): LaborCheck {
  const rows: LaborCheck['rows'] = [];
  let low = 0, high = 0, skipped = 0;

  for (const b of Array.isArray(breakdown) ? breakdown : []) {
    const name = String(b?.item || b?.name || '');
    const qty = Number(b?.quantity) || 0;
    const unit = String(b?.unit || '').trim().replace(/m2|m²/i, '㎡');
    if (!name || !(qty > 0) || !unit) { skipped++; continue; }

    const rule = LABOR_YIELDS.find((r) =>
      r.unit === unit && r.match.test(name) && !(r.exclude && r.exclude.test(name)));
    if (!rule) { skipped++; continue; }

    // 早い側の歩掛（perManDayHigh）で割ると人工は少なくなる＝下限
    const lo = qty / rule.perManDayHigh;
    const hi = qty / rule.perManDayLow;
    low += lo; high += hi;
    rows.push({ name, quantity: qty, unit, low: Math.round(lo * 10) / 10, high: Math.round(hi * 10) / 10, label: rule.label });
  }

  return { low: Math.round(low * 10) / 10, high: Math.round(high * 10) / 10, rows, skipped };
}
