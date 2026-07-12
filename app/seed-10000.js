// 1万件の建築系リアルデータ生成
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function main() {
  const configPath = path.join(os.homedir(), 'AppData/Roaming/kentiku-estimate/api-config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch(_) {}
  const dbPath = config.dbPath || path.join(os.homedir(), 'AppData/Roaming/kentiku-estimate/kentiku.db');

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));

  function run(sql, params) { db.run(sql, params); }
  function lastId() { return db.exec('SELECT last_insert_rowid()')[0].values[0][0]; }

  const TENANT_ID = 1;

  // ── 大阪の地名 ──
  const areas = [
    '大阪市北区', '大阪市中央区', '大阪市西区', '大阪市天王寺区', '大阪市浪速区',
    '大阪市淀川区', '大阪市東淀川区', '大阪市城東区', '大阪市鶴見区', '大阪市住吉区',
    '大阪市住之江区', '大阪市平野区', '大阪市東住吉区', '大阪市阿倍野区', '大阪市生野区',
    '大阪市旭区', '大阪市都島区', '大阪市福島区', '大阪市港区', '大阪市大正区',
    '大阪市此花区', '大阪市西成区', '大阪市西淀川区', '大阪市東成区',
    '堺市堺区', '堺市北区', '堺市中区', '堺市東区', '堺市西区',
    '豊中市', '吹田市', '高槻市', '茨木市', '枚方市', '寝屋川市', '八尾市',
    '東大阪市', '岸和田市', '守口市', '門真市', '松原市', '大東市', '箕面市',
    '柏原市', '羽曳野市', '藤井寺市', '和泉市', '泉大津市', '池田市',
  ];

  const lastNames = ['田中', '山本', '鈴木', '佐藤', '高橋', '伊藤', '渡辺', '中村', '小林', '加藤',
    '吉田', '山田', '松本', '井上', '木村', '林', '清水', '斎藤', '山口', '阿部',
    '森', '池田', '橋本', '石川', '前田', '藤田', '岡田', '後藤', '長谷川', '村上',
    '近藤', '石井', '坂本', '遠藤', '青木', '西村', '福田', '太田', '三浦', '岡本',
    '松田', '中島', '原田', '小川', '藤井', '馬場', '金子', '野村', '竹内', '上田'];

  const companyTypes = ['建設', '工務店', '建築', 'ハウス', '住建', '不動産', 'リフォーム', '開発', '設計', 'ホーム'];
  const companyForms = ['株式会社', '有限会社', '合同会社', ''];

  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function pick(arr) { return arr[rand(0, arr.length - 1)]; }
  function randDate(yearFrom, yearTo) {
    const y = rand(yearFrom, yearTo);
    const m = String(rand(1, 12)).padStart(2, '0');
    const d = String(rand(1, 28)).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function clientName() {
    if (Math.random() < 0.4) return pick(lastNames) + pick(['太郎','一郎','次郎','健太','大輔','修','誠','隆','浩','正']);
    const form = pick(companyForms);
    const name = pick(lastNames) + pick(companyTypes);
    return form ? `${form}${name}` : name;
  }

  // ── 工事テンプレート ──
  const templates = [
    // 新築
    { type: '新築', titles: ['新築工事一式','木造新築工事','注文住宅新築'], matMin: 3000000, matMax: 15000000, laborMin: 1500000, laborMax: 5000000, markupMin: 1.18, markupMax: 1.35 },
    // リフォーム系
    { type: 'キッチンリフォーム', titles: ['キッチンリフォーム','キッチン入替工事','キッチン改修'], matMin: 200000, matMax: 1200000, laborMin: 100000, laborMax: 400000, markupMin: 1.25, markupMax: 1.43 },
    { type: '浴室リフォーム', titles: ['浴室リフォーム','ユニットバス入替','浴室改修工事'], matMin: 300000, matMax: 1500000, laborMin: 150000, laborMax: 500000, markupMin: 1.25, markupMax: 1.43 },
    { type: 'トイレリフォーム', titles: ['トイレリフォーム','トイレ交換工事','トイレ改修'], matMin: 30000, matMax: 400000, laborMin: 30000, laborMax: 150000, markupMin: 1.3, markupMax: 1.5 },
    { type: '外壁塗装', titles: ['外壁塗装工事','外壁リフォーム','外壁・屋根塗装'], matMin: 300000, matMax: 1200000, laborMin: 200000, laborMax: 600000, markupMin: 1.25, markupMax: 1.4 },
    { type: '屋根工事', titles: ['屋根葺き替え工事','屋根塗装工事','屋根カバー工事','屋根修繕'], matMin: 200000, matMax: 1500000, laborMin: 150000, laborMax: 500000, markupMin: 1.25, markupMax: 1.4 },
    { type: '内装リフォーム', titles: ['内装リフォーム','クロス・床張替え','内装改修工事','LDKリフォーム'], matMin: 100000, matMax: 800000, laborMin: 80000, laborMax: 300000, markupMin: 1.3, markupMax: 1.45 },
    { type: 'フルリフォーム', titles: ['フルリフォーム','全面改修工事','スケルトンリフォーム'], matMin: 2000000, matMax: 12000000, laborMin: 1000000, laborMax: 4000000, markupMin: 1.2, markupMax: 1.35 },
    { type: '耐震補強', titles: ['耐震補強工事','耐震改修工事','耐震リフォーム'], matMin: 300000, matMax: 2000000, laborMin: 200000, laborMax: 800000, markupMin: 1.25, markupMax: 1.4 },
    { type: 'マンションリノベ', titles: ['マンションリノベーション','マンション内装工事','マンション全面改修'], matMin: 3000000, matMax: 15000000, laborMin: 1000000, laborMax: 4000000, markupMin: 1.2, markupMax: 1.3 },
    // 解体
    { type: '木造解体', titles: ['木造解体工事','木造住宅解体','木造建物解体撤去'], matMin: 500000, matMax: 2000000, laborMin: 200000, laborMax: 600000, markupMin: 1.2, markupMax: 1.35 },
    { type: '鉄骨解体', titles: ['鉄骨造解体工事','鉄骨建物解体','S造解体工事'], matMin: 1000000, matMax: 5000000, laborMin: 400000, laborMax: 1500000, markupMin: 1.18, markupMax: 1.3 },
    { type: 'RC解体', titles: ['RC造解体工事','鉄筋コンクリート造解体','RC建物解体'], matMin: 2000000, matMax: 10000000, laborMin: 600000, laborMax: 2000000, markupMin: 1.15, markupMax: 1.25 },
    { type: '内装解体', titles: ['内装解体工事','スケルトン解体','店舗内装解体'], matMin: 200000, matMax: 1500000, laborMin: 100000, laborMax: 500000, markupMin: 1.25, markupMax: 1.4 },
    // 設備
    { type: '給排水工事', titles: ['給排水設備工事','水道工事','配管更新工事'], matMin: 150000, matMax: 800000, laborMin: 100000, laborMax: 400000, markupMin: 1.3, markupMax: 1.45 },
    { type: '電気工事', titles: ['電気設備工事','電気配線工事','分電盤交換工事'], matMin: 100000, matMax: 600000, laborMin: 80000, laborMax: 300000, markupMin: 1.3, markupMax: 1.45 },
    { type: '空調工事', titles: ['エアコン設置工事','空調設備工事','空調更新工事'], matMin: 200000, matMax: 2000000, laborMin: 100000, laborMax: 500000, markupMin: 1.25, markupMax: 1.4 },
    // 外構
    { type: '外構工事', titles: ['外構工事','駐車場工事','フェンス・塀工事','庭工事'], matMin: 300000, matMax: 3000000, laborMin: 200000, laborMax: 1000000, markupMin: 1.25, markupMax: 1.4 },
    // 防水
    { type: '防水工事', titles: ['防水工事','屋上防水工事','ベランダ防水工事'], matMin: 100000, matMax: 1000000, laborMin: 80000, laborMax: 400000, markupMin: 1.3, markupMax: 1.45 },
    // 塗装
    { type: '塗装工事', titles: ['塗装工事','室内塗装工事','鉄部塗装工事'], matMin: 50000, matMax: 500000, laborMin: 50000, laborMax: 250000, markupMin: 1.3, markupMax: 1.5 },
    // 店舗
    { type: '店舗内装', titles: ['店舗内装工事','店舗改装工事','テナント内装工事','飲食店内装工事'], matMin: 1000000, matMax: 8000000, laborMin: 500000, laborMax: 2500000, markupMin: 1.2, markupMax: 1.35 },
    // 事務所
    { type: '事務所改修', titles: ['事務所改修工事','オフィスリフォーム','事務所内装工事'], matMin: 500000, matMax: 5000000, laborMin: 300000, laborMax: 1500000, markupMin: 1.2, markupMax: 1.35 },
  ];

  const statuses = ['draft', 'sent', 'paid', 'paid', 'paid', 'overdue']; // paidが多め

  console.log('🔨 1万件のデータ生成開始...');
  const TOTAL = 10000;
  let propCount = 0, conCount = 0, invCount = 0;

  for (let i = 0; i < TOTAL; i++) {
    const tmpl = pick(templates);
    const area = pick(areas);
    const client = clientName();
    const date = randDate(2020, 2026);
    const dueDate = date.replace(/\d{2}$/, String(Math.min(28, parseInt(date.slice(-2)) + 30)).padStart(2, '0'));

    // 物件（70%の確率で作成、30%は既存物件なしで施工のみ）
    let propertyId = null;
    if (Math.random() < 0.7) {
      const propName = `${client}邸` + (Math.random() < 0.3 ? '' : ` ${tmpl.type}`);
      run('INSERT INTO properties (name, address, notes, tenant_id) VALUES (?,?,?,?)',
        [propName, `大阪府${area}${rand(1,9)}-${rand(1,20)}-${rand(1,30)}`, `${tmpl.type}`, TENANT_ID]);
      propertyId = lastId();
      propCount++;
    }

    // 材料費・人件費をランダム生成
    const matCost = rand(tmpl.matMin, tmpl.matMax);
    const laborCost = rand(tmpl.laborMin, tmpl.laborMax);
    const markupRate = Math.round((tmpl.markupMin + Math.random() * (tmpl.markupMax - tmpl.markupMin)) * 100) / 100;
    const totalCost = matCost + laborCost;
    const sellingPrice = Math.ceil(totalCost * markupRate);

    // 施工
    const title = pick(tmpl.titles);
    run('INSERT INTO constructions (property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id) VALUES (?,?,?,?,?,?,?)',
      [propertyId, `${client} ${title}`, date, laborCost, markupRate, `${tmpl.type} | ${area}`, TENANT_ID]);
    const conId = lastId();
    conCount++;

    // 材料明細（3〜8項目）
    const itemCount = rand(3, 8);
    let remaining = matCost;
    for (let j = 0; j < itemCount; j++) {
      const isLast = j === itemCount - 1;
      const itemCost = isLast ? remaining : Math.round(remaining * (0.1 + Math.random() * 0.3));
      remaining -= itemCost;
      if (itemCost <= 0) continue;

      // 材料名を工事タイプに応じて生成
      const matNames = {
        '新築': ['構造材','基礎コンクリート','屋根材','外壁材','断熱材','内装材','建具','設備機器'],
        'キッチンリフォーム': ['システムキッチン本体','給排水配管','換気扇','タイル','クロス','照明器具','諸材料'],
        '浴室リフォーム': ['ユニットバス本体','給排水配管','換気扇','防水処理','タイル','照明','諸材料'],
        'トイレリフォーム': ['便器本体','給排水配管','クロス','クッションフロア','照明','諸材料'],
        '外壁塗装': ['塗料（下塗り）','塗料（上塗り）','シーリング材','養生材','足場費','洗浄費','諸材料'],
        '屋根工事': ['屋根材','防水シート','棟板金','雨樋','足場費','諸材料'],
        '内装リフォーム': ['フローリング材','クロス','巾木','照明器具','スイッチ・コンセント','諸材料'],
        'フルリフォーム': ['構造補強材','キッチン','浴室','トイレ','内装材','外装材','電気設備','給排水設備'],
        '耐震補強': ['耐震金物','構造用合板','筋交い','基礎補強材','アンカー','諸材料'],
        'マンションリノベ': ['キッチン','浴室','トイレ','フローリング','クロス','建具','電気設備','給排水'],
        '木造解体': ['解体工事費','産廃処分費','足場・養生','重機回送','諸経費'],
        '鉄骨解体': ['解体工事費','産廃処分費','足場・養生','重機回送','鉄くず処分','諸経費'],
        'RC解体': ['解体工事費','コンガラ処分','産廃処分','足場・養生','重機回送','諸経費'],
        '内装解体': ['解体工事費','産廃処分費','養生費','運搬費','諸経費'],
        '給排水工事': ['配管材','水栓金具','排水トラップ','接続部材','諸材料'],
        '電気工事': ['ケーブル','分電盤','コンセント','スイッチ','照明器具','諸材料'],
        '空調工事': ['エアコン本体','配管材','室外機架台','ドレン配管','諸材料'],
        '外構工事': ['コンクリート','ブロック','フェンス','砂利','植栽','照明','諸材料'],
        '防水工事': ['防水材','プライマー','シーリング','メッシュ','保護塗料','諸材料'],
        '塗装工事': ['塗料','下地処理材','養生材','シーリング','諸材料'],
        '店舗内装': ['内装材','照明器具','空調設備','給排水設備','建具','カウンター','諸材料'],
        '事務所改修': ['パーティション','OAフロア','照明器具','空調','内装材','LAN配線','諸材料'],
      };
      const names = matNames[tmpl.type] || ['材料費','施工材料','諸材料','部材','消耗品'];
      const matName = names[j % names.length];

      // 材料マスタにINSERT（存在チェックせず追加、大量データ用）
      run('INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?,?,?,?,?,?)',
        [matName, tmpl.type, '式', itemCost, `${title}用`, TENANT_ID]);
      const matId = lastId();

      run('INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (?,?,?,?)',
        [conId, matId, 1, itemCost]);
    }

    // 請求書
    const status = pick(statuses);
    run('INSERT INTO invoices (construction_id, client_name, client_address, issue_date, due_date, amount, tax_rate, notes, status, tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [conId, client, `大阪府${area}`, date, dueDate, sellingPrice, Math.random() < 0.05 ? 0.08 : 0.1,
       `${tmpl.type}\n${title}`, status, TENANT_ID]);
    invCount++;

    if ((i + 1) % 1000 === 0) console.log(`  ${i + 1}/${TOTAL} 件完了...`);
  }

  // 保存
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();

  console.log(`\n✅ 完了！`);
  console.log(`  物件: ${propCount}件`);
  console.log(`  施工: ${conCount}件`);
  console.log(`  請求書: ${invCount}件`);
  console.log(`  DB: ${dbPath}`);
}

main().catch(console.error);
