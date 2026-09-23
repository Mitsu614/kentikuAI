// 電気設備 回帰ハーネス — 正解計算モデル
// cost-reference.ts の「★ 電気設備工事 相場データ」の単価レンジ（材工共）をコード化し、
// 仕様が明確なシナリオの "正しい直接工事費" を [min, mid, max] で確定させる。
// これが AI 見積を突き合わせる正解（ground truth）になる。外部データ不要で成立する。
//
// ★ここを cost-reference.ts と乖離させないこと。単価を変えたら両方直す。

// 各単価は材工共。[low, high] は相場表のレンジそのまま。mid はその中央。
const UNIT = {
  // 配線器具・コンセント・スイッチ（/箇所・/回路）
  outlet_new:      { label: 'コンセント新設', low: 5000, high: 12000 },
  outlet_replace:  { label: 'コンセント交換', low: 3000, high: 6000 },
  circuit_200v:    { label: '200V専用回路増設', low: 15000, high: 40000 },
  switch:          { label: 'スイッチ新設・交換', low: 3000, high: 10000 },
  info_outlet:     { label: '情報コンセント(LAN/TV)', low: 8000, high: 15000 },
  // 照明（/台）
  light_general:   { label: '照明器具取付(一般)', low: 5000, high: 10000 },
  downlight:       { label: 'ダウンライト新設', low: 15000, high: 25000 },
  led_office:      { label: '蛍光灯→LED交換(事務所)', low: 15000, high: 20000 },
  led_highbay:     { label: '水銀灯→高天井LED交換', low: 50000, high: 66000 },
  // 幹線・ケーブル・管（/m）
  vvf_m:           { label: 'VVFケーブル配線', low: 300, high: 800 },
  cvt22_m:         { label: 'CVT幹線(22sq級)', low: 2500, high: 5000 },
  cvt60_m:         { label: 'CVT幹線(60〜100sq)', low: 5000, high: 12000 },
  pf_conduit_m:    { label: 'PF/CD管配管', low: 800, high: 1800 },
  metal_conduit_m: { label: '金属管配管', low: 1500, high: 3500 },
  cable_rack_m:    { label: 'ケーブルラック敷設', low: 4000, high: 12000 },
  ground_work:     { label: '接地工事', low: 15000, high: 50000 },
  // 盤（/面）
  panel_house:     { label: '住宅用分電盤交換', low: 50000, high: 100000 },
  panel_elcb_new:  { label: '漏電遮断器付分電盤新設', low: 80000, high: 150000 },
  panel_power:     { label: '動力用分電盤新設', low: 200000, high: 500000 },
  // 弱電・通信・防犯
  lan_cat6:        { label: 'LAN配線CAT6', low: 15000, high: 25000 },
  lan_cat6a:       { label: 'LAN配線CAT6A', low: 30000, high: 40000 },
  lan_outlet:      { label: 'LANコンセント', low: 5000, high: 10000 },
  hub_router:      { label: 'HUB/ルーター設置', low: 3000, high: 10000 },
  camera:          { label: '防犯・監視カメラ設置', low: 50000, high: 100000 },
  fire_detector:   { label: '火災報知感知器', low: 8000, high: 20000 },
  intercom_lock:   { label: 'インターホン・電気錠', low: 30000, high: 100000 },
  // 太陽光・EV
  ev_charge_200v:  { label: 'EV普通充電(200V)', low: 40000, high: 150000 },
  ev_charge_6kw:   { label: 'EV普通充電器(6kW)', low: 300000, high: 800000 },
  // 受変電（総額）
  cubicle_100:     { label: 'キュービクル100kVA級', low: 3500000, high: 5000000 },
  cubicle_200:     { label: 'キュービクル200kVA級', low: 4500000, high: 10000000 },
  // 無線LAN（Wi-Fi）
  wifi_ap:         { label: '業務用AP本体', low: 20000, high: 80000 },
  wifi_ap_install: { label: 'AP設置・設定', low: 15000, high: 40000 },
  site_survey:     { label: 'サイトサーベイ(電波調査)', low: 50000, high: 110000 },
  // 変圧器（トランス）単体
  trans_500_body:  { label: '変圧器300〜500kVA本体(油入)', low: 1500000, high: 2500000 },
  trans_swap_work: { label: 'トランス交換工事(据付・結線・撤去・試験)', low: 500000, high: 1000000 },
  // 動力設備・機器電源（三相200V）
  power_circuit:   { label: '動力回路 新設(機器1台)', low: 30000, high: 80000 },
  power_outlet:    { label: '動力コンセント(防水3P)', low: 15000, high: 30000 },
  magnet_switch:   { label: '電磁開閉器 取付', low: 20000, high: 50000 },
  inverter:        { label: 'インバーター(3.7〜22kW)設置', low: 150000, high: 600000 },
  motor_test:      { label: 'モーター結線・試運転調整', low: 15000, high: 40000 },
  // 消防・防災設備
  fire_panel_p2:   { label: '自火報 受信機 P型2級', low: 150000, high: 350000 },
  fire_panel_p1:   { label: '自火報 受信機 P型1級', low: 400000, high: 900000 },
  fire_box:        { label: '総合盤(発信機・表示灯・地区音響)', low: 30000, high: 80000 },
  hp_cable_m:      { label: '耐熱電線 HP 配線', low: 800, high: 1800 },
  fp_cable_m:      { label: '耐火電線 FP-C 配線', low: 1500, high: 4000 },
  emergency_amp:   { label: '非常放送 アンプ', low: 300000, high: 800000 },
  emergency_sp:    { label: '非常放送 スピーカー', low: 15000, high: 30000 },
  exit_light:      { label: '誘導灯', low: 25000, high: 60000 },
  emergency_light: { label: '非常照明(電池内蔵型)', low: 20000, high: 45000 },
  fire_filing:     { label: '消防への届出(着工届・設置届・検査立会)', low: 50000, high: 200000 },
  // 幹線 追加サイズ
  cvt38_m:         { label: 'CVT幹線(38sq級)', low: 3500, high: 7000 },
  cvt150_m:        { label: 'CVT幹線(100〜150sq)', low: 8000, high: 18000 },
  busduct_m:       { label: 'バスダクト(600〜1,000A)', low: 30000, high: 60000 },
  // 照明制御
  sensor_switch:   { label: '人感センサースイッチ', low: 8000, high: 20000 },
  dimmer:          { label: '調光器(位相制御)', low: 10000, high: 30000 },
  // 撤去・仮設（改修工事）
  remove_light:    { label: '既設照明器具 撤去・処分', low: 1500, high: 4000 },
  remove_outlet:   { label: '既設コンセント・スイッチ 撤去', low: 1000, high: 3000 },
  remove_cable_m:  { label: '既設ケーブル 撤去', low: 300, high: 900 },
  remove_panel:    { label: '既設分電盤 撤去・処分', low: 20000, high: 60000 },
  temp_power:      { label: '工事用仮設電源(仮設分電盤＋引込)', low: 100000, high: 300000 },
  // 非常用電源・受電付帯・そのほか
  generator:       { label: '非常用発電機(20〜100kVA)', low: 4000000, high: 12000000 },
  generator_test:  { label: '発電機 負荷試験', low: 150000, high: 400000 },
  pas_ugs:         { label: '区分開閉器 PAS/UGS 設置', low: 600000, high: 1500000 },
  commissioning:   { label: '竣工試験(絶縁・接地抵抗・成績書)', low: 50000, high: 200000 },
  lightning_rod:   { label: '避雷針設備 一式', low: 800000, high: 3000000 },
  tv_common_unit:  { label: 'TV共聴設備(集合住宅・各戸)', low: 15000, high: 30000 },
  access_control:  { label: '入退室管理(カードリーダー・電気錠)', low: 150000, high: 400000 },
  // PCB廃棄物 処分（撤去時の別途費用）
  pcb_analysis:      { label: 'PCB含有分析', low: 20000, high: 30000 },
  pcb_disposal_trans:{ label: 'PCB処分費(変圧器)', low: 400000, high: 800000 },
  pcb_transport:     { label: 'PCB収集運搬', low: 50000, high: 100000 },
};

// シナリオ（items:[{type,qty}]）から正解の直接工事費レンジを計算
function computeReference(items) {
  let min = 0, max = 0, mid = 0;
  const rows = [];
  for (const it of items) {
    const u = UNIT[it.type];
    if (!u) throw new Error(`未定義の単価タイプ: ${it.type}`);
    const m = (u.low + u.high) / 2;
    min += u.low * it.qty;
    max += u.high * it.qty;
    mid += m * it.qty;
    rows.push({ type: it.type, label: u.label, qty: it.qty, low: u.low, high: u.high, mid: m, subtotalMid: m * it.qty });
  }
  return { min: Math.round(min), mid: Math.round(mid), max: Math.round(max), rows };
}

module.exports = { UNIT, computeReference };
