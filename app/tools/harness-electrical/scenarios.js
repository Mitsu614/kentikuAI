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
  {
    id: 'e9-wifi-office',
    title: 'オフィスの無線LAN新規工事',
    spec: `オフィス（1フロア）の無線LAN(Wi-Fi)新規構築。
- 業務用アクセスポイント(AP) 4台（本体＋設置・設定、PoE給電）
- AP用LAN配線 CAT6 4本（天井裏配線）
- サイトサーベイ（電波調査）1式
※既設スイッチにPoEポートあり。設定は標準（VPN連携なし）。`,
    items: [
      { type: 'wifi_ap', qty: 4 },
      { type: 'wifi_ap_install', qty: 4 },
      { type: 'lan_cat6', qty: 4 },
      { type: 'site_survey', qty: 1 },
    ],
  },
  {
    id: 'e10-trans-swap',
    title: '変圧器（トランス）単体交換',
    spec: `キュービクル内の変圧器を更新（6,600V→三相210V）。
- 油入変圧器 500kVA級 本体交換 1台（PCB非含有を確認済み）
- 交換工事一式（据付・一次/二次結線・旧機撤去・受電試験・停電作業半日）
※高圧盤・幹線側の改修は無し。基礎はそのまま流用。`,
    items: [
      { type: 'trans_500_body', qty: 1 },
      { type: 'trans_swap_work', qty: 1 },
    ],
  },
  {
    id: 'e11-trans-pcb',
    title: '変圧器交換（既設がPCB含有）',
    spec: `キュービクル内の変圧器を更新（6,600V→三相210V）。
- 油入変圧器 500kVA級 本体交換 1台
- 交換工事一式（据付・一次/二次結線・旧機撤去・受電試験・停電作業）
- ★既設変圧器は1975年製で、PCB含有が判明している。
  含有分析・PCB処分費・収集運搬を別途計上すること。`,
    items: [
      { type: 'trans_500_body', qty: 1 },
      { type: 'trans_swap_work', qty: 1 },
      { type: 'pcb_analysis', qty: 1 },
      { type: 'pcb_disposal_trans', qty: 1 },
      { type: 'pcb_transport', qty: 1 },
    ],
  },
  {
    id: 'e12-factory-highbay',
    title: '工場の水銀灯→高天井LED更新',
    spec: `鉄骨造の工場（天井高8m）の照明更新。
- 水銀灯→高天井LED器具 交換 24台（87〜129W級）
- 金属管配管 60m（露出・既設ルート流用不可の区間）
- CVT幹線 22sq級 45m（分電盤〜照明幹線の張替え）
場所は大阪府内、稼働中の工場のため夜間作業。
※高所作業車・ローリングタワーのリース費は別途手配のため、この見積には含めない。`,
    items: [
      { type: 'led_highbay', qty: 24 },
      { type: 'metal_conduit_m', qty: 60 },
      { type: 'cvt22_m', qty: 45 },
    ],
  },
  {
    id: 'e13-apartment-weak',
    title: '賃貸マンションの弱電・防災更新',
    spec: `賃貸マンション（12戸）の弱電設備更新。
- 情報コンセント（LAN・TV）24箇所
- LAN配線 CAT6A 12本（各戸1本・端末処理込）
- インターホン・電気錠 12台（親機・子機・電気錠連動）
- 火災報知感知器 30個（住戸内・共用部）`,
    items: [
      { type: 'info_outlet', qty: 24 },
      { type: 'lan_cat6a', qty: 12 },
      { type: 'intercom_lock', qty: 12 },
      { type: 'fire_detector', qty: 30 },
    ],
  },
  {
    id: 'e14-ev-charger',
    title: 'EV充電設備の設置',
    spec: `月極駐車場（10台分）へのEV充電設備の新設。
- EV普通充電コンセント（200V）8基
- EV普通充電器（6kW・スタンド型）2基
- 動力用分電盤 新設 1面
- CVT幹線 22sq級 80m（受電盤〜駐車場）
- PF/CD管配管 80m`,
    items: [
      { type: 'ev_charge_200v', qty: 8 },
      { type: 'ev_charge_6kw', qty: 2 },
      { type: 'panel_power', qty: 1 },
      { type: 'cvt22_m', qty: 80 },
      { type: 'pf_conduit_m', qty: 80 },
    ],
  },
  {
    id: 'e15-cubicle-200',
    title: 'キュービクル200kVA級の更新',
    spec: `既設キュービクルの更新（高圧受電・契約電力150kW級）。
- キュービクル 200kVA級 1基（本体・据付・結線・受電試験込）
- 接地工事 1式
- CVT幹線 60〜100sq 35m（キュービクル〜主分電盤）
- ケーブルラック敷設 35m
※既設キュービクルの撤去・処分は別途。PCBは非含有を確認済み。`,
    items: [
      { type: 'cubicle_200', qty: 1 },
      { type: 'ground_work', qty: 1 },
      { type: 'cvt60_m', qty: 35 },
      { type: 'cable_rack_m', qty: 35 },
    ],
  },
  {
    id: 'e16-factory-motor',
    title: '工場の動力増設（三相200V）',
    spec: `稼働中の工場に生産設備を増設するのに伴う動力工事（三相200V）。
- 動力回路 新設 4台分（動力盤から各機器へ。1台あたり20m程度）
- 電磁開閉器 取付 4台
- インバーター（11kW）設置 2台
- モーター結線・試運転調整 4台
- CVT幹線 38sq級 35m（受電盤〜動力盤）
- 接地工事（D種）2箇所
※建築・機械の据付は別業者。電気工事のみの見積。`,
    items: [
      { type: 'power_circuit', qty: 4 },
      { type: 'magnet_switch', qty: 4 },
      { type: 'inverter', qty: 2 },
      { type: 'motor_test', qty: 4 },
      { type: 'cvt38_m', qty: 35 },
      { type: 'ground_work', qty: 2 },
    ],
  },
  {
    id: 'e17-fire-alarm',
    title: '自動火災報知設備の更新（消防）',
    spec: `事務所ビル（延床1,200㎡・4階）の自動火災報知設備の更新。
- 自火報 受信機 P型1級（16回線）1台
- 感知器（煙・熱）48個
- 総合盤（発信機・表示灯・地区音響）8組
- 耐熱電線 HP 1.2-2C 配線 420m
- 消防への届出（着工届・設置届・検査立会）1式
※★配線は耐熱電線。一般のVVFでは不可。`,
    items: [
      { type: 'fire_panel_p1', qty: 1 },
      { type: 'fire_detector', qty: 48 },
      { type: 'fire_box', qty: 8 },
      { type: 'hp_cable_m', qty: 420 },
      { type: 'fire_filing', qty: 1 },
    ],
  },
  {
    id: 'e18-emergency-light',
    title: '誘導灯・非常照明・非常放送の更新（防災）',
    spec: `店舗（延床800㎡）の防災設備更新。
- 誘導灯（避難口・通路）14台
- 非常照明（電池内蔵型）22台
- 非常放送 アンプ 1台
- 非常放送 スピーカー 16個
- 耐火電線 FP-C 配線 180m（防災電源回路）
- 消防への届出 1式`,
    items: [
      { type: 'exit_light', qty: 14 },
      { type: 'emergency_light', qty: 22 },
      { type: 'emergency_amp', qty: 1 },
      { type: 'emergency_sp', qty: 16 },
      { type: 'fp_cable_m', qty: 180 },
      { type: 'fire_filing', qty: 1 },
    ],
  },
  {
    id: 'e19-office-renovation',
    title: '事務所改修（撤去＋仮設＋新設）',
    spec: `稼働中の事務所（1フロア 300㎡）のレイアウト変更に伴う電気改修。
【撤去】
- 既設照明器具 撤去・処分 36台
- 既設コンセント・スイッチ 撤去 28箇所
- 既設ケーブル 撤去 260m
- 既設分電盤 撤去・処分 1面
【仮設】
- 工事用仮設電源（仮設分電盤＋引込）1式
【新設】
- 照明器具 取付（一般・LED）40台
- 人感センサースイッチ 6箇所
- コンセント新設 30箇所
- VVFケーブル配線 380m
- 漏電遮断器付分電盤 新設 1面
- 竣工試験（絶縁抵抗・接地抵抗・成績書）1式
※★撤去と仮設を必ず別項目で計上すること。`,
    items: [
      { type: 'remove_light', qty: 36 },
      { type: 'remove_outlet', qty: 28 },
      { type: 'remove_cable_m', qty: 260 },
      { type: 'remove_panel', qty: 1 },
      { type: 'temp_power', qty: 1 },
      { type: 'light_general', qty: 40 },
      { type: 'sensor_switch', qty: 6 },
      { type: 'outlet_new', qty: 30 },
      { type: 'vvf_m', qty: 380 },
      { type: 'panel_elcb_new', qty: 1 },
      { type: 'commissioning', qty: 1 },
    ],
  },
  {
    id: 'e20-highvoltage-extras',
    title: '高圧受電の付帯（PAS・非常用発電機・竣工試験）',
    spec: `工場の受電設備更新に伴う付帯工事。
- 区分開閉器 PAS/UGS 設置 1台（SOG制御装置込）
- 非常用発電機（ディーゼル 75kVA・屋外キュービクル型）1基（本体・基礎・据付・接続）
- 発電機 負荷試験（疑似負荷装置）1回
- CVT幹線 100〜150sq 45m（発電機〜受電盤）
- 竣工試験 1式
※キュービクル本体（受変電）はこの見積に含めない。燃料タンクの消防届出は別途。`,
    items: [
      { type: 'pas_ugs', qty: 1 },
      { type: 'generator', qty: 1 },
      { type: 'generator_test', qty: 1 },
      { type: 'cvt150_m', qty: 45 },
      { type: 'commissioning', qty: 1 },
    ],
  },
];

module.exports = { SCENARIOS };
