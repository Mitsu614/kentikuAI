// 建築ブースト 無料トライアル セットアップスクリプト
// 50クレジット付きのトライアル用データベースを初期化します
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const os = require('os');

async function main() {
  const userDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'kenchiku-boost');
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, 'kentiku.db');

  // 既存DBがあればバックアップ
  if (fs.existsSync(dbPath)) {
    const backupPath = dbPath + '.backup-' + Date.now();
    fs.copyFileSync(dbPath, backupPath);
    console.log(`既存データをバックアップしました: ${backupPath}`);
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run('PRAGMA foreign_keys = ON');

  // テーブル作成
  db.run(`CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, credits INTEGER DEFAULT 50, plan TEXT DEFAULT 'trial', plan_limit INTEGER DEFAULT 50, plan_started_at TEXT, limit_notified_month TEXT, contact_company TEXT, contact_tel TEXT, contact_email TEXT, month_notified INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS credit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, amount INTEGER NOT NULL, operation TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT DEFAULT 'user', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, action TEXT NOT NULL, entity TEXT, entity_id INTEGER, detail TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS plan_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, requested_plan TEXT NOT NULL, current_plan TEXT, price INTEGER NOT NULL, status TEXT DEFAULT 'pending', invoice_number TEXT, paid_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS estimate_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER, work_type TEXT, ai_material_cost REAL, ai_labor_cost REAL, ai_total REAL, ai_markup_rate REAL, ai_json TEXT, generated_image TEXT, uploaded_image TEXT, actual_material_cost REAL, actual_labor_cost REAL, actual_selling_price REAL, actual_markup_rate REAL, feedback_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS properties (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, name TEXT NOT NULL, address TEXT, floor_plan_image TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS materials (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '未分類', unit TEXT NOT NULL DEFAULT '個', unit_price REAL NOT NULL DEFAULT 0, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS constructions (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, property_id INTEGER, title TEXT NOT NULL, construction_date TEXT, labor_cost REAL DEFAULT 0, markup_rate REAL DEFAULT 1.3, fixed_selling_price REAL, actual_selling_price REAL, actual_labor_cost REAL, actual_material_cost REAL, status TEXT DEFAULT '見積中', notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS construction_materials (id INTEGER PRIMARY KEY AUTOINCREMENT, construction_id INTEGER NOT NULL, material_id INTEGER NOT NULL, quantity REAL NOT NULL DEFAULT 1, unit_price REAL NOT NULL, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE CASCADE, FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE)`);
  db.run(`CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER, client_name TEXT NOT NULL, client_address TEXT, issue_date TEXT NOT NULL, due_date TEXT, amount REAL NOT NULL, tax_rate REAL DEFAULT 0.1, notes TEXT, status TEXT DEFAULT 'draft', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS construction_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, construction_id INTEGER NOT NULL, photo_data TEXT, label TEXT DEFAULT 'before', notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE CASCADE)`);
  db.run(`CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, name TEXT NOT NULL, company TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // 作業者・出面管理
  db.run(`CREATE TABLE IF NOT EXISTS workers (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, name TEXT NOT NULL, daily_rate REAL DEFAULT 0, role TEXT DEFAULT '作業員', notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER, worker_id INTEGER NOT NULL, work_date TEXT NOT NULL, hours REAL DEFAULT 8, daily_rate REAL DEFAULT 0, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL, FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE)`);
  // 発注書
  db.run(`CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER, vendor_name TEXT NOT NULL DEFAULT '', vendor_address TEXT, vendor_type TEXT DEFAULT 'material', issue_date TEXT NOT NULL, delivery_date TEXT, amount REAL NOT NULL DEFAULT 0, tax_rate REAL DEFAULT 0.1, notes TEXT, status TEXT DEFAULT 'draft', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS purchase_order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_order_id INTEGER NOT NULL, name TEXT NOT NULL, quantity REAL DEFAULT 1, unit TEXT DEFAULT '式', unit_price REAL DEFAULT 0, notes TEXT, FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE)`);
  // 日報
  db.run(`CREATE TABLE IF NOT EXISTS daily_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER, report_date TEXT NOT NULL, weather TEXT DEFAULT '晴れ', temp_min REAL, temp_max REAL, progress INTEGER DEFAULT 0, work_content TEXT, safety_notes TEXT, tomorrow_plan TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL)`);
  // 工程表
  db.run(`CREATE TABLE IF NOT EXISTS gantt_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER, task_name TEXT NOT NULL, assignee TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL, progress INTEGER DEFAULT 0, color TEXT DEFAULT '#3498db', dependencies TEXT, sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL)`);
  // 安全書類
  db.run(`CREATE TABLE IF NOT EXISTS safety_worker_info (id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id INTEGER NOT NULL UNIQUE, blood_type TEXT, emergency_contact TEXT, emergency_tel TEXT, health_check_date TEXT, insurance_type TEXT, certifications TEXT, FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE)`);
  db.run(`CREATE TABLE IF NOT EXISTS safety_education (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER, worker_id INTEGER, education_date TEXT NOT NULL, instructor TEXT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL, FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS ky_records (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER, activity_date TEXT NOT NULL, participants TEXT, hazard TEXT, countermeasures TEXT, leader TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL)`);
  // 見積比較
  db.run(`CREATE TABLE IF NOT EXISTS quote_comparisons (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER, title TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS quote_vendors (id INTEGER PRIMARY KEY AUTOINCREMENT, comparison_id INTEGER NOT NULL, vendor_name TEXT NOT NULL, notes TEXT, FOREIGN KEY (comparison_id) REFERENCES quote_comparisons(id) ON DELETE CASCADE)`);
  db.run(`CREATE TABLE IF NOT EXISTS quote_vendor_items (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER NOT NULL, name TEXT NOT NULL, quantity REAL DEFAULT 1, unit TEXT DEFAULT '式', unit_price REAL DEFAULT 0, FOREIGN KEY (vendor_id) REFERENCES quote_vendors(id) ON DELETE CASCADE)`);
  // 写真台帳
  db.run(`CREATE TABLE IF NOT EXISTS photo_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1, construction_id INTEGER NOT NULL, photo_data TEXT, category TEXT DEFAULT '施工中', work_type TEXT DEFAULT 'その他', location TEXT, photo_date TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE CASCADE)`);

  // ── テナント作成 ──
  // ID=1: 管理者（システム用・無制限扱い）
  db.run("INSERT INTO tenants (name, credits, plan, plan_limit) VALUES ('管理者', 0, 'standard', 9999)");
  // ID=2: トライアル企業（無料トライアル・50回通算）
  const today = new Date().toISOString().split('T')[0];
  db.run("INSERT INTO tenants (name, credits, plan, plan_limit, plan_started_at) VALUES ('無料トライアル', 50, 'trial', 50, ?)", [today]);
  db.run("INSERT INTO credit_log (tenant_id, amount, operation) VALUES (2, 50, '無料トライアル開始')");

  // ── ユーザー（トライアルテナントに紐付け） ──
  const crypto = require('crypto');
  const passHash = crypto.createHash('sha256').update('trial2026').digest('hex');
  db.run("INSERT INTO users (tenant_id, username, password_hash, role) VALUES (2, 'admin', ?, 'admin')", [passHash]);

  // ── 材料マスタ（大阪エリア 2025-2026 相場ベース） ──
  const materials = [
    ['耐震金物（ホールダウン金物）', '耐震', '個', 2500, '柱と基礎の接合用'],
    ['耐震金物（筋交い金物）', '耐震', '個', 1800, '筋交いと柱の接合部補強用'],
    ['構造用合板（耐力壁用）24mm', '耐震', '枚', 3800, '910×2730mm'],
    ['筋交い（杉 45×90）', '耐震', '本', 1500, '3m'],
    ['制震ダンパー', '耐震', '個', 45000, '壁内設置型'],
    ['桧 柱材 105×105mm 3m', '木材', '本', 3500, '通し柱・管柱用'],
    ['杉 間柱 30×105mm 3m', '木材', '本', 600, '壁の下地材'],
    ['米松 梁材 105×240mm 4m', '木材', '本', 8000, '小梁用'],
    ['集成材 梁 120×300mm 4m', '木材', '本', 15000, '構造用集成材'],
    ['生コン（24-8-20）', '基礎', 'm³', 19500, '基礎用高強度'],
    ['鉄筋 D13', '基礎', 'kg', 130, '基礎主筋用'],
    ['型枠用合板', '基礎', '枚', 1600, '900×1800mm 12mm'],
    ['ガルバリウム鋼板屋根材', '屋根', 'm²', 5500, '立平葺き用'],
    ['陶器平板瓦', '屋根', '枚', 350, '和瓦'],
    ['窯業系サイディング 14mm', '外壁', 'm²', 4000, '金具留め工法用'],
    ['透湿防水シート', '外壁', 'm²', 250, 'タイベック等'],
    ['外壁用塗料（シリコン）', '外壁', '缶', 28000, '15kg缶'],
    ['石膏ボード 12.5mm', '内装', '枚', 550, '910×1820mm'],
    ['フローリング材（合板）', '内装', 'm²', 3500, '12mm厚 標準'],
    ['フローリング材（無垢 桧）', '内装', 'm²', 8000, '15mm厚 高級'],
    ['クロス（量産品 1000番台）', '内装', 'm²', 350, 'ビニールクロス'],
    ['グラスウール 16K 100mm', '断熱', 'm²', 800, '壁断熱用'],
    ['吹付け硬質ウレタンフォーム', '断熱', 'm²', 3000, '80mm厚'],
    ['システムキッチン（標準）', '設備', 'セット', 450000, 'I型 2550mm'],
    ['システムキッチン（中級）', '設備', 'セット', 750000, 'L型 食洗機付き'],
    ['ユニットバス 1616', '設備', 'セット', 350000, '1坪サイズ'],
    ['洗面化粧台 750mm', '設備', 'セット', 80000, '三面鏡付き'],
    ['トイレ（タンクレス）', '設備', 'セット', 180000, 'ウォシュレット一体型'],
    ['給湯器（エコジョーズ 24号）', '設備', 'セット', 150000, '都市ガス'],
    ['分電盤（20回路）', '電気', '個', 25000, '主幹60A'],
    ['LED照明（シーリング）', '電気', '個', 8000, '〜12畳用'],
    ['LED照明（ダウンライト）', '電気', '個', 2500, '100φ 電球色'],
    ['木造解体工事', '解体', '坪', 40000, '大阪市内相場'],
    ['RC造解体工事', '解体', '坪', 75000, '大阪市内相場'],
    ['産業廃棄物処分費（混合）', '解体', 'm³', 25000, '中間処分場'],
    ['仮設足場（くさび式）', '仮設', 'm²', 1000, '架払含む'],
    ['くさび式足場（設置+撤去）', '足場', 'm²', 1050, '養生ネット別。戸建て〜低層'],
    ['くさび式足場（養生込み）', '足場', 'm²', 1100, 'メッシュシート込み'],
    ['枠組足場（設置+撤去）', '足場', 'm²', 1300, '高層対応。マンション・ビル向け'],
    ['単管足場（設置+撤去）', '足場', 'm²', 600, '狭小地・補助足場向け'],
    ['足場機材レンタル料', '足場', 'm²', 200, '月額。延長時の追加'],
    ['昇降階段（アルミ一体式）', '足場', '基', 20000, '設置費別'],
    ['メッシュシート（養生ネット）', '養生', 'm²', 150, '飛散防止'],
    ['防音シート', '養生', 'm²', 3500, '住宅密集地向け'],
    ['防炎シート', '養生', 'm²', 3500, '溶断作業時'],
    ['仮囲い（安全鋼板H=2.0m）', '仮囲い', 'm', 4100, '亜鉛メッキ鋼板'],
    ['仮囲い（安全鋼板H=3.0m）', '仮囲い', 'm', 5700, '公共工事等'],
    ['ガードフェンス（1.8x1.8m）', '仮囲い', '日', 25, '8日目以降の日額'],
    ['仮設トイレ（簡易水洗・洋式）', '仮設リース', '月', 30000, '設置撤去費別途'],
    ['仮設トイレ（快適トイレ）', '仮設リース', '月', 40000, '国交省仕様'],
    ['仮設トイレ設置・撤去', '仮設リース', '回', 35000, '片道1回分'],
    ['汲み取り費用', '仮設リース', '回', 7000, '容量・現場により変動'],
    ['仮設事務所（4坪・エアコン付）', '仮設リース', '月', 28000, '基本管理費別途'],
    ['仮設事務所（10坪）', '仮設リース', '月', 43000, '基本管理費別途'],
    ['仮設休憩所（4坪・エアコン付）', '仮設リース', '月', 28000, ''],
    ['仮設電気引込み工事', '仮設リース', '式', 150000, '分電盤設置込み'],
    ['仮設水道（設置・撤去一式）', '仮設リース', '式', 100000, '配管引込み込み'],
    ['コンテナ倉庫（20ft）', '仮設リース', '月', 15000, '運搬設置費別途'],
    ['ミニバックホー（0.05m³）', '重機リース', '日', 8500, 'オペ別'],
    ['バックホー（0.2m³）', '重機リース', '日', 20000, 'オペ別'],
    ['高所作業車（10〜12m）', '重機リース', '日', 22500, '補償料別途'],
    ['高所作業車（14〜17m）', '重機リース', '日', 38000, ''],
    ['クレーン車（4.9t・オペ付）', '重機リース', '日', 40000, ''],
    ['クレーン車（13t・オペ付）', '重機リース', '日', 52500, '休祝日1.5日分'],
    ['クレーン車（25t・オペ付）', '重機リース', '日', 65000, '休祝日1.5日分'],
    ['発電機（小型0.9〜2.8kVA）', '重機リース', '日', 4000, ''],
    ['発電機（中型10〜25kVA）', '重機リース', '日', 14000, '防音型'],
    ['LED投光器（三脚式）', '重機リース', '日', 2300, '100W'],
    ['エアコンプレッサー（電動小型）', '重機リース', '日', 4000, ''],
    ['エンジン溶接機（150〜200A）', '重機リース', '日', 4000, ''],
    ['重機回送費（ミニ・〜20km）', '運搬', '回', 22500, '片道'],
    ['重機回送費（中型・〜20km）', '運搬', '回', 30000, '片道'],
    ['重機回送費（大型・〜20km）', '運搬', '回', 55000, '片道'],
    ['資材運搬（4tトラック・〜20km）', '運搬', '回', 18500, '片道。積込取卸し別'],
    ['資材運搬（10tトラック・〜20km）', '運搬', '回', 24000, '片道'],
    ['鳶工（足場組立・解体）', '運搬', '人日', 30000, '職長クラス35,000円'],
    ['ガードマン（資格なし）', '運搬', '人日', 18000, '平日昼間'],
    ['ガードマン（有資格者）', '運搬', '人日', 22500, '平日昼間'],
    ['産廃処理（木くず）', '産廃処理', 'm³', 5500, '分別済み'],
    ['産廃処理（コンクリートガラ）', '産廃処理', 'm³', 4500, '再生砕石化'],
    ['産廃処理（混合廃棄物A・可燃）', '産廃処理', 'm³', 15000, '分別不十分'],
    ['産廃処理（混合廃棄物B・不燃）', '産廃処理', 'm³', 21500, '泥・ガラス混じり'],
    ['産廃処理（石膏ボード）', '産廃処理', 'm³', 11500, 'リサイクル可否で変動'],
    ['とび工（レベル1・初級）', '技能者報酬', '人日', 22000, 'CCUSホワイト。経験5年未満'],
    ['とび工（レベル2・中堅）', '技能者報酬', '人日', 26000, 'CCUSブルー'],
    ['とび工（レベル3・職長）', '技能者報酬', '人日', 30780, 'CCUSシルバー。公共単価相当'],
    ['とび工（レベル4・登録基幹技能者）', '技能者報酬', '人日', 36000, 'CCUSゴールド'],
    ['大工（レベル3・職長）', '技能者報酬', '人日', 30400, 'CCUSシルバー。公共単価相当'],
    ['塗装工（レベル3・職長）', '技能者報酬', '人日', 28200, 'CCUSシルバー。公共単価相当'],
    ['電気工（レベル3・職長）', '技能者報酬', '人日', 29300, 'CCUSシルバー。公共単価相当'],
    ['配管工（レベル3・職長）', '技能者報酬', '人日', 29300, 'CCUSシルバー。公共単価相当'],
    ['1級建築施工管理技士', '技術者報酬', '人日', 47500, '現場代理人クラス'],
    ['2級建築施工管理技士', '技術者報酬', '人日', 35000, ''],
    ['監理技術者（1級+講習修了）', '技術者報酬', '人日', 52500, '特定建設業の義務'],
  ];

  for (const [name, category, unit, unitPrice, notes] of materials) {
    db.run('INSERT INTO materials (tenant_id, name, category, unit, unit_price, notes) VALUES (2, ?, ?, ?, ?, ?)',
      [name, category, unit, unitPrice, notes]);
  }
  console.log(`  材料マスタ: ${materials.length}件`);

  // ── サンプル物件 ──
  db.run("INSERT INTO properties (tenant_id, name, address, notes) VALUES (2, 'サンプル物件 - 田中邸 耐震補強', '大阪府大阪市住吉区帝塚山1-1-1', '築35年 木造2階建て。トライアル用サンプルデータ')");
  console.log('  サンプル物件: 1件');

  // DB保存
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  db.close();

  // api-config.json をリセット（前の利用者の情報を消す）
  const configPath = path.join(userDataPath, 'api-config.json');
  fs.writeFileSync(configPath, JSON.stringify({}, null, 2), 'utf-8');
  console.log('  設定ファイル: リセット済み');

  console.log('\n========================================');
  console.log('  建築ブースト 無料トライアル セットアップ完了！');
  console.log('========================================');
  console.log(`  プラン:       無料トライアル（50回）`);
  console.log(`  材料マスタ:   ${materials.length}品目（大阪相場）`);
  console.log(`  DB保存先:     ${dbPath}`);
  console.log('\n  【新機能】');
  console.log('  - 作業日報・工程表（ガントチャート）');
  console.log('  - 安全書類（作業員名簿・新規入場者教育・KY活動）');
  console.log('  - 見積比較表・写真台帳');
  console.log('  - AI見積もり→請求書・発注書の一括自動作成');
  console.log('  - 予実管理の実績編集→学習ループ連携');
  console.log('\n  次に「建築ブースト.exe」をダブルクリックして起動してください。');
  console.log('========================================\n');
}

main().catch(console.error);
