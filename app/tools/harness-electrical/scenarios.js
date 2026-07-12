// 電気設備 回帰ハーネス — テストシナリオ
// spec = AIに渡す自然文の工事内容（=見積依頼）。数量を明示し、写真に依存させない
//        （電気は隠蔽配線が写らないので、仕様＝文字で与えるのが実務に即している）。
// items = cost-model の単価タイプ×数量。正解の直接工事費レンジを機械計算するための対応表。
// ※ spec と items の数量は必ず一致させること（乖離すると正解がズレる）。

const SCENARIOS = [
  {
    id: 'e1-house-outlets',
    title: '住宅リフォームの小規模電気',
    spec: `木造戸建てのリフォームに伴う電気工事。
- コンセント新設 6箇所（既存回路から分岐、配線延長あり）
- コンセント交換 4箇所
- スイッチ交換 4箇所
- VVFケーブル配線 40m（隠蔽）
場所は大阪市内、既存住宅の改修。`,
    items: [
      { type: 'outlet_new', qty: 6 },
      { type: 'outlet_replace', qty: 4 },
      { type: 'switch', qty: 4 },
      { type: 'vvf_m', qty: 40 },
    ],
  },
  {
    id: 'e2-200v-ac-ih',
    title: 'エアコン・IH用の200V回路増設',
    spec: `戸建て住宅。オール電化に向けた電気工事。
- 200V専用回路増設 3回路（エアコン2・IH1、分電盤から各敷設）
- 住宅用分電盤 交換（既存30A→60A、漏電遮断器付、処分費込）1面
- VVFケーブル配線 30m`,
    items: [
      { type: 'circuit_200v', qty: 3 },
      { type: 'panel_house', qty: 1 },
      { type: 'vvf_m', qty: 30 },
    ],
  },
  {
    id: 'e3-office-led',
    title: '事務所の蛍光灯→LED更新',
    spec: `事務所（天井高2.7m、天井3.5m以下）の照明更新。
- 蛍光灯器具→LED器具 交換 40台（既設配線利用、32W級）
- スイッチ交換 8箇所`,
    items: [
      { type: 'led_office', qty: 40 },
      { type: 'switch', qty: 8 },
    ],
  },
  {
    id: 'e4-office-lan',
    title: 'オフィスのLAN配線',
    spec: `オフィス移転に伴う弱電・通信工事。
- LAN配線 CAT6 24本（端末処理込、一部既設配管あり）
- LANコンセント 設置 24箇所
- HUB/ルーター 設置 2台`,
    items: [
      { type: 'lan_cat6', qty: 24 },
      { type: 'lan_outlet', qty: 24 },
      { type: 'hub_router', qty: 2 },
    ],
  },
  {
    id: 'e5-factory-power',
    title: '工場の動力盤・幹線',
    spec: `中小工場の設備増設に伴う電気工事（三相200V動力）。
- 動力用分電盤 新設 1面
- CVT幹線敷設（60〜100sq）40m
- ケーブルラック敷設 30m
- 接地工事（D種）2箇所`,
    items: [
      { type: 'panel_power', qty: 1 },
      { type: 'cvt60_m', qty: 40 },
      { type: 'cable_rack_m', qty: 30 },
      { type: 'ground_work', qty: 2 },
    ],
  },
  {
    id: 'e6-security',
    title: '防犯カメラ＋弱電',
    spec: `店舗の防犯・通信工事。
- 防犯・監視カメラ 設置 8台（配線含む）
- LAN配線 CAT6 8本
- 漏電遮断器付分電盤 新設 1面`,
    items: [
      { type: 'camera', qty: 8 },
      { type: 'lan_cat6', qty: 8 },
      { type: 'panel_elcb_new', qty: 1 },
    ],
  },
  {
    id: 'e7-downlight-reno',
    title: '住宅の照明リノベ',
    spec: `戸建てのLDK改修に伴う照明工事。
- ダウンライト 新設 12台（天井開口・配線込）
- 照明器具 取付（一般）6台
- スイッチ新設 6箇所
- PF管配管 25m`,
    items: [
      { type: 'downlight', qty: 12 },
      { type: 'light_general', qty: 6 },
      { type: 'switch', qty: 6 },
      { type: 'pf_conduit_m', qty: 25 },
    ],
  },
  {
    id: 'e8-cubicle',
    title: '受変電（キュービクル）',
    spec: `中小工場の高圧受電設備の更新。
- キュービクル 100kVA級 1式（本体＋据付＋一次側接続＋試験）
- 動力用分電盤 新設 1面
- CVT幹線敷設（60〜100sq）30m
※ 基礎・搬入は別途とする`,
    items: [
      { type: 'cubicle_100', qty: 1 },
      { type: 'panel_power', qty: 1 },
      { type: 'cvt60_m', qty: 30 },
    ],
  },
];

module.exports = { SCENARIOS };
