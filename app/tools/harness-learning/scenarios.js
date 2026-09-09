// 学習ハーネス — テストシナリオ
//
// 何を測るためのデータか:
//   「その会社の本当の数字（チャットで教えてもらった単価・歩掛）を渡すと、
//     AIの見積がその会社の実額に寄るか」を測る。
//
//   truth  … その会社の実額（＝正解）。数量 × 自社単価 で機械計算する。
//   learnings … チャットで教えてもらった想定の内容。これを渡した回と渡さない回で比べる。
//   spec   … AIに渡す依頼文。数量は spec と truth で必ず一致させること（ズレると正解が狂う）。
//
// ★ 自社単価は、わざと全国相場から外している（安い側・高い側の両方）。
//   相場のまま出すAIと、学習を反映したAIの差が出るようにするため。

const SCENARIOS = [
  {
    id: 'L1-cloth-cheap',
    title: '内装クロス張替（自社は相場より安い）',
    workType: '内装仕上工事',
    spec: `事務所の内装改修。数量は確定しています。
- 量産クロス張替 320㎡（下地パテ処理込み）
- クッションフロア張替 45㎡
- 幅木交換 120m
場所は大阪市内。既存クロスの撤去処分を含む。`,
    learnings: [
      { category: '単価', key: 'クロス張替（量産・材工共）', value: '980円/㎡（下地パテ処理込み・自社職人）' },
      { category: '単価', key: 'クッションフロア張替（材工共）', value: '3,800円/㎡' },
      { category: '単価', key: '幅木交換（材工共）', value: '900円/m' },
      { category: '歩掛', key: 'クロス職人の1日あたり施工量', value: '1人1日 約55㎡（下地込み）' },
    ],
    truth: [
      { label: 'クロス張替', qty: 320, unit: 'm2', unitPrice: 980 },
      { label: 'クッションフロア張替', qty: 45, unit: 'm2', unitPrice: 3800 },
      { label: '幅木交換', qty: 120, unit: 'm', unitPrice: 900 },
    ],
  },
  {
    id: 'L2-rebar',
    title: '鉄筋工事（自社の加工組立単価）',
    workType: '鉄筋工事',
    spec: `RC造3階建ての鉄筋工事。数量は拾い出し済みです。
- 異形鉄筋 D13 4.2t
- 異形鉄筋 D16 2.8t
- 異形鉄筋 D19 1.5t
すべて材工共（材料・加工・組立）。場所は大阪府内。`,
    learnings: [
      { category: '単価', key: '鉄筋 D13 材工共', value: '128,000円/t（材料・加工・組立込み）' },
      { category: '単価', key: '鉄筋 D16 材工共', value: '122,000円/t' },
      { category: '単価', key: '鉄筋 D19 材工共', value: '118,000円/t' },
    ],
    truth: [
      { label: '鉄筋 D13', qty: 4.2, unit: 't', unitPrice: 128000 },
      { label: '鉄筋 D16', qty: 2.8, unit: 't', unitPrice: 122000 },
      { label: '鉄筋 D19', qty: 1.5, unit: 't', unitPrice: 118000 },
    ],
  },
  {
    id: 'L3-steel',
    title: '鉄骨工事（自社のトン単価・相場より高い）',
    workType: '鉄骨工事',
    spec: `平屋倉庫の鉄骨工事。重量は確定しています。
- 鉄骨本体（H形鋼・角形鋼管）18.5t（材料＋工場製作）
- 建方 18.5t分（レッカー50t・鳶3人）
- 高力ボルト F10T M20 620本
場所は大阪府内。錆止め工場塗装1回を含む。`,
    learnings: [
      { category: '単価', key: '鉄骨 材料＋工場製作 材工共', value: '245,000円/t（開先・仕口・錆止め込み。自社加工場）' },
      { category: '単価', key: '鉄骨建方（レッカー・鳶込み）', value: '38,000円/t' },
      { category: '単価', key: '高力ボルト本締め F10T M20', value: '420円/本（材工共）' },
    ],
    truth: [
      { label: '鉄骨 材料＋工場製作', qty: 18.5, unit: 't', unitPrice: 245000 },
      { label: '鉄骨建方', qty: 18.5, unit: 't', unitPrice: 38000 },
      { label: '高力ボルト本締め', qty: 620, unit: '本', unitPrice: 420 },
    ],
  },
  {
    id: 'L4-wood',
    title: '木造の構造材（自社の立米単価と大工の日当）',
    workType: '木造建築工事',
    spec: `木造2階建て住宅の構造材と建方。数量は拾い出し済みです。
- 構造材（スギ集成材）12.5m3（材料のみ・プレカット済み）
- 構造用合板 24mm 床 180㎡
- 建方 大工4人 × 3日
場所は大阪府内。`,
    learnings: [
      { category: '単価', key: '構造材（スギ集成材・プレカット込み）', value: '88,000円/m3' },
      { category: '単価', key: '構造用合板24mm 床（材工共）', value: '4,200円/㎡' },
      { category: '単価', key: '大工の日当（自社・レベル3）', value: '26,000円/人日' },
    ],
    truth: [
      { label: '構造材（スギ集成材）', qty: 12.5, unit: 'm3', unitPrice: 88000 },
      { label: '構造用合板24mm 床', qty: 180, unit: 'm2', unitPrice: 4200 },
      { label: '建方 大工', qty: 12, unit: '人日', unitPrice: 26000 },
    ],
  },
  {
    id: 'L5-painting',
    title: '外壁塗装（自社は相場より安く、足場は自社持ち）',
    workType: '塗装工事',
    spec: `木造2階建て住宅の外壁塗装。数量は実測済みです。
- 外壁塗装（シリコン・3回塗り）185㎡
- 付帯部塗装（軒天・破風・雨樋）42㎡
- 足場 260㎡（メッシュシート込み）
場所は大阪府内。高圧洗浄・養生は上記の塗装単価に含むため、別項目として計上しないこと。`,
    learnings: [
      { category: '単価', key: '外壁塗装 シリコン3回塗り（材工共）', value: '2,300円/㎡' },
      { category: '単価', key: '付帯部塗装（材工共）', value: '1,800円/㎡' },
      { category: '単価', key: '足場（自社所有・メッシュ込み）', value: '750円/㎡' },
      // ★以前ここが無かったため、AIが「高圧洗浄・養生 一式35,000円」を別行で立て、
      //   正解に無い1行ぶん必ず+5%ズレていた。学習の失敗ではなくシナリオの不備。
      { category: '単価', key: '高圧洗浄・養生', value: '外壁塗装単価（2,300円/㎡）に含む。別途計上しない' },
    ],
    truth: [
      { label: '外壁塗装', qty: 185, unit: 'm2', unitPrice: 2300 },
      { label: '付帯部塗装', qty: 42, unit: 'm2', unitPrice: 1800 },
      { label: '足場', qty: 260, unit: 'm2', unitPrice: 750 },
    ],
  },
];

// 正解（直接工事費）を計算する。諸経費・粗利は含まない。
function truthTotal(scn) {
  return scn.truth.reduce((s, t) => s + t.qty * t.unitPrice, 0);
}

module.exports = { SCENARIOS, truthTotal };
