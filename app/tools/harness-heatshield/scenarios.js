// 遮熱シート（山下さん）見積 正解シナリオ
// 実案件の生AI出力を "入力" とし、正規化後に "正解=約300万(税抜)" へ収束するかを測る。
// 正解の根拠: 山下さん本人の建て方 —
//   ・スカイ工法は材工共 5,500円/㎡（運搬・現場管理・養生・法定福利コミ、人件費は別立てしない）
//   ・展開後(谷折り)数量 = 屋根面積 × 1.4〜1.41
//   ・諸経費は現場固定10万（総額比例にしない）／安全・足場は現場固定
// 期待総額 = 展開数量 × 5,500 ＋ 安全 ＋ 足場 ＋ 諸経費10万 ≒ 300万台

// 山下さんの正解は「点(300万)」ではなく「式」: 屋根が大きければ増えるのが正しい。
//   正解 = 展開数量 × 5,500円/㎡（材工共）＋ 安全10万 ＋ 足場12万 ＋ 諸経費10万
//   ※足場は工場規模で動く。504㎡級は12万（本人談）。別規模のシナリオを足すときは ashiba を変える。
const UNIT_PRICE = 5500;
// 正解 = 積み上げ（材工共＋安全＋足場＋諸経費）を10万円単位で切り捨て（顧客提示の切りのいい額）。
// 例: 504㎡ → 3,092,000 → 3,000,000（税込330万ちょうど）。
function truth(quantityM2, ashiba = 120000, anzen = 100000, shokei = 100000) {
  const raw = quantityM2 * UNIT_PRICE + anzen + ashiba + shokei;
  return Math.floor(raw / 100000) * 100000;
}

const SCENARIOS = [
  {
    id: 'case-a-1825',
    label: '504㎡級 工場屋根・初回AI出力（匿名テストケース）',
    roofAreaM2: 360, quantityM2: 504, developFactor: 1.4,
    targetYen: truth(504),          // 504×5,500 ＋ 32万 ＝ 3,092,000（税抜）
    // AIが最初に出した生の内訳（諸経費4行を余計に積んで¥3,447,263になっていた）
    rawBreakdown: [
      { category: '材料',  item: 'サーモバリア本体（スカイ工法用遮熱シート）', cost: 655200 },
      { category: '施工費', item: 'スカイ工法施工費（シート敷設・固定・端部役物・棟軒納まり）', cost: 1862400 },
      { category: '材料',  item: '副資材（両面テープ・ジョイントテープ・気密テープ等）', cost: 174720 },
      { category: '仮設',  item: '安全対策費（親綱設置・安全管理）', cost: 100000 },
      { category: '仮設',  item: '昇降用足場（外部昇降用階段）', cost: 80000 },
      { category: '経費',  item: '資材運搬費', cost: 160000 },
      { category: '経費',  item: '諸経費', cost: 80000 },
      { category: '経費',  item: '現場管理費', cost: 167401 },
      { category: '経費',  item: '福利厚生費（法定福利費）', cost: 47542 },
      { category: '仮設',  item: '下部養生費', cost: 120000 },
    ],
  },
  {
    id: 'case-a-1855',
    label: '504㎡級 工場屋根・プロンプト強化後（匿名テストケース／諸経費が12%で高かった例）',
    roofAreaM2: 360, quantityM2: 508, developFactor: 1.41,
    targetYen: truth(508),          // 508×5,500 ＋ 32万 ＝ 3,114,000（税抜）
    // 4行は消えたが、材工共と施工費に分かれ人件費が別立て＋諸経費が12%(32万)で¥3,287,200
    rawBreakdown: [
      { category: '材料',  item: 'サーモバリア スカイ工法施工（折板屋根用・材工共）', cost: 2082800 },
      { category: '施工費', item: '施工費（葺き師・建築板金工 スカイ工法シート敷設・固定・端部板金納まり）', cost: 711400 },
      { category: '仮設',  item: '安全対策費（親綱設置・屋根上墜落防止）', cost: 65000 },
      { category: '仮設',  item: '昇降用足場（外部昇降階段）', cost: 104000 },
      { category: '経費',  item: '諸経費', cost: 324000 },
    ],
  },
  {
    id: 'case-a-1922',
    label: '504㎡級 工場屋根・3補正後（匿名テストケース／㎡単価が4,947で安すぎた例）',
    roofAreaM2: 360, quantityM2: 504, developFactor: 1.4,
    targetYen: truth(504),
    // 材工共まとめ・諸経費固定は効いたが、㎡単価4,947(本来5,500)・安全12.7万・足場15.2万でブレて¥2,872,504
    rawBreakdown: [
      { category: '材料', item: '遮熱シート スカイ工法（材工共）', cost: 2493504 },
      { category: '仮設', item: '安全対策費（親綱設置・墜落防止・フルハーネス対応）', cost: 127000 },
      { category: '仮設', item: '昇降用足場（外部昇降階段・高天井対応）', cost: 152000 },
      { category: '経費', item: '諸経費', cost: 100000 },
    ],
  },
];

// 合否判定の許容（正解±この割合）
const TOLERANCE = 0.05;   // ±5%（285万〜315万を合格とする）

// 普通の折板屋根は展開係数を1.4に統一（150mm=1.69/大波=1.1/平葺き=1.0はそのまま）→ 数量を確定
function effectiveQty(s) {
  let df = s.developFactor || 0;
  if (s.roofAreaM2 > 0 && df >= 1.35 && df <= 1.45) df = 1.4;
  return (s.roofAreaM2 > 0 && df >= 1) ? Math.round(s.roofAreaM2 * df) : (s.quantityM2 || 0);
}

module.exports = { SCENARIOS, TOLERANCE, truth, effectiveQty };
