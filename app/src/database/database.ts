import path from 'path';
import fs from 'fs';

let db: any;
let dbPath: string;
let currentTenantId = 1;

export function getCurrentTenant() { return currentTenantId; }
export function setCurrentTenant(id: number) { currentTenantId = id; }

export async function initDatabase(filePath: string) {
  dbPath = filePath;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  createTables();
  migrate();
  saveToFile();
}

export function getDatabase(): any { return db; }

export function saveToFile() {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

export function queryAll(sql: string, params?: any[]): any[] {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

export function queryOne(sql: string, params?: any[]): any | null {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

export function runSql(sql: string, params?: any[]): number {
  db.run(sql, params);
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const id = stmt.getAsObject().id as number;
  stmt.free();
  saveToFile();
  return id || 0;
}

// ── プラン定義 ──
export const PLANS: Record<string, { name: string; monthlyLimit: number; price: number; description: string }> = {
  demo:       { name: 'デモ',           monthlyLimit: 10,   price: 0,        description: '無料体験（月10単位まで）' },
  standard:   { name: 'スタンダード',   monthlyLimit: 50,   price: 1200000,  description: '個人〜15名規模の工務店（年間契約）' },
  pro:        { name: 'プロ',           monthlyLimit: 200,  price: 3000000,  description: '複数担当者・多案件（年間契約）' },
  enterprise: { name: '法人カスタム',   monthlyLimit: 9999, price: 5000000,   description: '多店舗・複数会社（年間契約）' },
};

// AI操作ごとのストック消費量
export const CREDIT_COSTS: Record<string, number> = {
  '写真+コメント見積': 2,
  'テキストのみ見積':  1,
  '写真のみ見積':      1,
  'OCR取込':          1,
  '画像生成':          3,
  'チャット見積':      1,
  'ビフォーアフター見積': 2,
  'PDF出力':          0,
  '一括登録':          0,
};

// ── クレジット管理（月次プラン制） ──
export function getMonthlyUsage(tenantId?: number): { used: number; limit: number; plan: string; remaining: number } {
  const tid = tenantId ?? currentTenantId;
  const tenant = queryOne('SELECT plan, plan_limit, credits FROM tenants WHERE id = ?', [tid]);
  const plan = tenant?.plan || 'standard';
  const planDef = PLANS[plan];
  const limit = tenant?.plan_limit || planDef?.monthlyLimit || 50;

  // creditsカラムが設定されている場合はそれを残量として使用（Supabase同期対応）
  if (tenant?.credits !== undefined && tenant?.credits !== null && tenant.credits >= 0) {
    const remaining = Math.max(0, tenant.credits);
    const used = Math.max(0, limit - remaining);
    return { used, limit, plan, remaining };
  }

  // フォールバック: 従来の月次計算
  let row;
  if (plan === 'trial' || plan === 'demo') {
    // デモ・トライアルは使い切り（月次リセットなし）
    row = queryOne(
      'SELECT COALESCE(SUM(ABS(amount)), 0) as used FROM credit_log WHERE tenant_id = ? AND amount < 0',
      [tid]
    );
  } else {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    row = queryOne(
      'SELECT COALESCE(SUM(ABS(amount)), 0) as used FROM credit_log WHERE tenant_id = ? AND amount < 0 AND created_at >= ?',
      [tid, monthStart]
    );
  }
  const used = row?.used || 0;
  return { used, limit, plan, remaining: Math.max(0, limit - used) };
}

export function getCredits(tenantId?: number): number {
  const { remaining } = getMonthlyUsage(tenantId);
  return remaining;
}

export function useCredits(amount: number, operation: string, tenantId?: number): { success: boolean; limitReached?: boolean } {
  const tid = tenantId ?? currentTenantId;
  // テナントID=1（管理者）は無制限
  if (tid === 1) return { success: true };
  // 消費0の操作は常に許可
  if (amount === 0) return { success: true };

  const usage = getMonthlyUsage(tid);
  if (usage.remaining < amount) {
    return { success: false, limitReached: true };
  }
  db.run('INSERT INTO credit_log (tenant_id, amount, operation) VALUES (?, ?, ?)', [tid, -amount, operation]);
  db.run('UPDATE tenants SET credits = MAX(0, credits - ?) WHERE id = ?', [amount, tid]);
  saveToFile();
  return { success: true };
}

export function addCredits(amount: number, reason: string, tenantId?: number) {
  const tid = tenantId ?? currentTenantId;
  db.run('INSERT INTO credit_log (tenant_id, amount, operation) VALUES (?, ?, ?)', [tid, amount, reason]);
  saveToFile();
}

export function getTenantPlan(tenantId?: number): { plan: string; planLimit: number; planStartedAt: string | null } {
  const tid = tenantId ?? currentTenantId;
  const row = queryOne('SELECT plan, plan_limit, plan_started_at FROM tenants WHERE id = ?', [tid]);
  return {
    plan: row?.plan || 'standard',
    planLimit: row?.plan_limit || PLANS['standard'].monthlyLimit,
    planStartedAt: row?.plan_started_at || null,
  };
}

export function setTenantPlan(plan: string, tenantId?: number) {
  const tid = tenantId ?? currentTenantId;
  const planDef = PLANS[plan];
  if (!planDef) return;
  const now = new Date().toISOString().split('T')[0];
  db.run('UPDATE tenants SET plan = ?, plan_limit = ?, plan_started_at = ? WHERE id = ?',
    [plan, planDef.monthlyLimit, now, tid]);
  saveToFile();
}

// ── プラン申請 ──
export function createPlanRequest(requestedPlan: string, tenantId?: number): number {
  const tid = tenantId ?? currentTenantId;
  const planDef = PLANS[requestedPlan];
  if (!planDef) return 0;
  const current = getTenantPlan(tid);
  const currentPlanDef = PLANS[current.plan];
  // アップグレード時は現プランとの差額を請求
  const currentPrice = currentPlanDef?.price || 0;
  const invoicePrice = Math.max(0, planDef.price - currentPrice);
  const invoiceNum = `PL-${Date.now()}`;
  const id = runSql(
    'INSERT INTO plan_requests (tenant_id, requested_plan, current_plan, price, invoice_number) VALUES (?, ?, ?, ?, ?)',
    [tid, requestedPlan, current.plan, invoicePrice, invoiceNum]
  );
  return id;
}

export function listPlanRequests(tenantId?: number) {
  const tid = tenantId ?? currentTenantId;
  return queryAll('SELECT * FROM plan_requests WHERE tenant_id = ? ORDER BY id DESC', [tid]);
}

export function listAllPlanRequests() {
  return queryAll('SELECT pr.*, t.name as tenant_name FROM plan_requests pr JOIN tenants t ON t.id = pr.tenant_id ORDER BY pr.id DESC');
}

export function approvePlanRequest(requestId: number) {
  const req = queryOne('SELECT * FROM plan_requests WHERE id = ?', [requestId]);
  if (!req || req.status !== 'pending') return false;
  const now = new Date().toISOString().split('T')[0];
  db.run('UPDATE plan_requests SET status = ?, paid_at = ? WHERE id = ?', ['approved', now, requestId]);
  // プランを有効化
  const planDef = PLANS[req.requested_plan];
  if (planDef) {
    db.run('UPDATE tenants SET plan = ?, plan_limit = ?, plan_started_at = ? WHERE id = ?',
      [req.requested_plan, planDef.monthlyLimit, now, req.tenant_id]);
  }
  saveToFile();
  return true;
}

export function rejectPlanRequest(requestId: number) {
  db.run('UPDATE plan_requests SET status = ? WHERE id = ?', ['rejected', requestId]);
  saveToFile();
}

export function cancelPlanRequest(requestId: number, tenantId?: number): boolean {
  const tid = tenantId ?? currentTenantId;
  const req = queryOne('SELECT * FROM plan_requests WHERE id = ? AND tenant_id = ?', [requestId, tid]);
  if (!req || req.status !== 'pending') return false;
  db.run('UPDATE plan_requests SET status = ? WHERE id = ?', ['cancelled', requestId]);
  saveToFile();
  return true;
}

// 監査ログ
export function logAudit(action: string, entity: string, entityId: number | null, detail: string) {
  try {
    db.run('INSERT INTO audit_log (tenant_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
      [currentTenantId, action, entity, entityId, detail]);
    saveToFile();
  } catch (_) {}
}

// ── フィードバック・改善要望 ──
export function listFeedbackRequests(tenantId?: number) {
  const tid = tenantId ?? currentTenantId;
  return queryAll('SELECT * FROM feedback_requests WHERE tenant_id = ? ORDER BY id DESC', [tid]);
}

export function listAllFeedbackRequests() {
  return queryAll('SELECT fr.*, t.name as tenant_name FROM feedback_requests fr JOIN tenants t ON t.id = fr.tenant_id ORDER BY fr.id DESC');
}

export function createFeedbackRequest(data: { category: string; title: string; description?: string; priority?: string }, tenantId?: number): number {
  const tid = tenantId ?? currentTenantId;
  return runSql(
    'INSERT INTO feedback_requests (tenant_id, category, title, description, priority) VALUES (?, ?, ?, ?, ?)',
    [tid, data.category, data.title, data.description || '', data.priority || 'normal']
  );
}

export function updateFeedbackStatus(id: number, status: string, adminReply?: string) {
  if (adminReply) {
    db.run('UPDATE feedback_requests SET status = ?, admin_reply = ? WHERE id = ?', [status, adminReply, id]);
  } else {
    db.run('UPDATE feedback_requests SET status = ? WHERE id = ?', [status, id]);
  }
  saveToFile();
}

// ── 受注/失注トラッキング ──
export function listEstimateOutcomes(tenantId?: number) {
  const tid = tenantId ?? currentTenantId;
  return queryAll(`
    SELECT eo.*, c.title as construction_title, el.work_type, el.ai_total
    FROM estimate_outcomes eo
    LEFT JOIN constructions c ON c.id = eo.construction_id
    LEFT JOIN estimate_log el ON el.id = eo.estimate_log_id
    WHERE eo.tenant_id = ?
    ORDER BY eo.id DESC
  `, [tid]);
}

export function createEstimateOutcome(data: {
  construction_id?: number;
  estimate_log_id?: number;
  outcome: string;
  actual_amount?: number;
  win_reason?: string;
  loss_reason?: string;
  competitor?: string;
  feedback_notes?: string;
}, tenantId?: number): number {
  const tid = tenantId ?? currentTenantId;
  return runSql(
    'INSERT INTO estimate_outcomes (tenant_id, construction_id, estimate_log_id, outcome, actual_amount, win_reason, loss_reason, competitor, feedback_notes, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tid, data.construction_id || null, data.estimate_log_id || null, data.outcome,
     data.actual_amount || null, data.win_reason || null, data.loss_reason || null,
     data.competitor || null, data.feedback_notes || null, new Date().toISOString()]
  );
}

export function updateEstimateOutcome(data: { id: number; outcome: string; actual_amount?: number; win_reason?: string; loss_reason?: string; competitor?: string; feedback_notes?: string }) {
  db.run(
    'UPDATE estimate_outcomes SET outcome = ?, actual_amount = ?, win_reason = ?, loss_reason = ?, competitor = ?, feedback_notes = ?, decided_at = ? WHERE id = ?',
    [data.outcome, data.actual_amount || null, data.win_reason || null, data.loss_reason || null,
     data.competitor || null, data.feedback_notes || null, new Date().toISOString(), data.id]
  );
  saveToFile();
}

export function deleteEstimateOutcome(id: number) {
  db.run('DELETE FROM estimate_outcomes WHERE id = ?', [id]);
  saveToFile();
}

export function getOutcomeStats(tenantId?: number) {
  const tid = tenantId ?? currentTenantId;
  const total = queryOne('SELECT COUNT(*) as cnt FROM estimate_outcomes WHERE tenant_id = ?', [tid])?.cnt || 0;
  const won = queryOne("SELECT COUNT(*) as cnt FROM estimate_outcomes WHERE tenant_id = ? AND outcome = 'won'", [tid])?.cnt || 0;
  const lost = queryOne("SELECT COUNT(*) as cnt FROM estimate_outcomes WHERE tenant_id = ? AND outcome = 'lost'", [tid])?.cnt || 0;
  const pending = queryOne("SELECT COUNT(*) as cnt FROM estimate_outcomes WHERE tenant_id = ? AND outcome = 'pending'", [tid])?.cnt || 0;
  const winRate = total > 0 ? Math.round((won / (won + lost || 1)) * 100) : 0;
  return { total, won, lost, pending, winRate };
}

export function getSimilarEstimates(workType: string, tenantId?: number) {
  const tid = tenantId ?? currentTenantId;
  return queryAll(`
    SELECT el.*, c.title as construction_title, eo.outcome, eo.actual_amount
    FROM estimate_log el
    LEFT JOIN constructions c ON c.id = el.construction_id
    LEFT JOIN estimate_outcomes eo ON eo.estimate_log_id = el.id
    WHERE el.tenant_id = ? AND el.work_type LIKE ?
    ORDER BY el.created_at DESC LIMIT 10
  `, [tid, `%${workType}%`]);
}

function createTables() {
  db.run(`CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    credits INTEGER DEFAULT 200,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS credit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    operation TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER DEFAULT 1,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER DEFAULT 1,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id INTEGER,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS plan_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    requested_plan TEXT NOT NULL,
    current_plan TEXT,
    price INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    invoice_number TEXT,
    paid_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS estimate_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER,
    work_type TEXT,
    ai_material_cost REAL,
    ai_labor_cost REAL,
    ai_total REAL,
    ai_markup_rate REAL,
    ai_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS construction_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    construction_id INTEGER NOT NULL,
    photo_data TEXT,
    label TEXT DEFAULT 'before',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, address TEXT, floor_plan_image TEXT, notes TEXT,
    tenant_id INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '未分類',
    unit TEXT NOT NULL DEFAULT '個', unit_price REAL NOT NULL DEFAULT 0, notes TEXT,
    tenant_id INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS constructions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER, title TEXT NOT NULL, construction_date TEXT,
    labor_cost REAL DEFAULT 0, markup_rate REAL DEFAULT 1.3, notes TEXT,
    tenant_id INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS construction_materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    construction_id INTEGER NOT NULL, material_id INTEGER NOT NULL,
    quantity REAL NOT NULL DEFAULT 1, unit_price REAL NOT NULL,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    name TEXT NOT NULL, daily_rate REAL DEFAULT 0, role TEXT DEFAULT '作業員', notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER, worker_id INTEGER NOT NULL, work_date TEXT NOT NULL,
    hours REAL DEFAULT 8, daily_rate REAL DEFAULT 0, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER, vendor_name TEXT NOT NULL DEFAULT '', vendor_address TEXT,
    vendor_type TEXT DEFAULT 'material', issue_date TEXT NOT NULL, delivery_date TEXT,
    amount REAL NOT NULL DEFAULT 0, tax_rate REAL DEFAULT 0.1, notes TEXT,
    status TEXT DEFAULT 'draft',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL, name TEXT NOT NULL,
    quantity REAL DEFAULT 1, unit TEXT DEFAULT '式', unit_price REAL DEFAULT 0, notes TEXT,
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
  )`);
  // 日報
  db.run(`CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER, report_date TEXT NOT NULL, weather TEXT DEFAULT '晴れ',
    temp_min REAL, temp_max REAL, progress INTEGER DEFAULT 0,
    work_content TEXT, safety_notes TEXT, tomorrow_plan TEXT, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL
  )`);
  // 工程表タスク
  db.run(`CREATE TABLE IF NOT EXISTS gantt_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER, task_name TEXT NOT NULL, assignee TEXT,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, progress INTEGER DEFAULT 0,
    color TEXT DEFAULT '#3498db', dependencies TEXT, sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL
  )`);
  // 安全書類: 作業員安全情報
  db.run(`CREATE TABLE IF NOT EXISTS safety_worker_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL UNIQUE, blood_type TEXT, emergency_contact TEXT,
    emergency_tel TEXT, health_check_date TEXT, insurance_type TEXT, certifications TEXT,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
  )`);
  // 安全書類: 新規入場者教育
  db.run(`CREATE TABLE IF NOT EXISTS safety_education (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER, worker_id INTEGER, education_date TEXT NOT NULL,
    instructor TEXT, content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL
  )`);
  // 安全書類: KY活動記録
  db.run(`CREATE TABLE IF NOT EXISTS ky_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER, activity_date TEXT NOT NULL, participants TEXT,
    hazard TEXT, countermeasures TEXT, leader TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL
  )`);
  // 見積比較
  db.run(`CREATE TABLE IF NOT EXISTS quote_comparisons (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER, title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS quote_vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comparison_id INTEGER NOT NULL, vendor_name TEXT NOT NULL, notes TEXT,
    FOREIGN KEY (comparison_id) REFERENCES quote_comparisons(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS quote_vendor_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL, name TEXT NOT NULL,
    quantity REAL DEFAULT 1, unit TEXT DEFAULT '式', unit_price REAL DEFAULT 0,
    FOREIGN KEY (vendor_id) REFERENCES quote_vendors(id) ON DELETE CASCADE
  )`);
  // 写真台帳
  db.run(`CREATE TABLE IF NOT EXISTS photo_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER NOT NULL, photo_data TEXT, category TEXT DEFAULT '施工中',
    work_type TEXT DEFAULT 'その他', location TEXT, photo_date TEXT, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE CASCADE
  )`);
  // チャット学習メモ（ユーザーの好み・修正傾向を記憶）
  db.run(`CREATE TABLE IF NOT EXISTS chat_learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER DEFAULT 1,
    category TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    source TEXT DEFAULT 'chat', confidence REAL DEFAULT 1.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, category, key)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    construction_id INTEGER, client_name TEXT NOT NULL, client_address TEXT,
    issue_date TEXT NOT NULL, due_date TEXT, amount REAL NOT NULL,
    tax_rate REAL DEFAULT 0.1, notes TEXT, status TEXT DEFAULT 'draft',
    tenant_id INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL
  )`);

  // フィードバック・改善要望
  db.run(`CREATE TABLE IF NOT EXISTS feedback_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER DEFAULT 1,
    category TEXT NOT NULL DEFAULT 'improvement',
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'new',
    admin_reply TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 受注/失注トラッキング
  db.run(`CREATE TABLE IF NOT EXISTS estimate_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER DEFAULT 1,
    construction_id INTEGER,
    estimate_log_id INTEGER,
    outcome TEXT NOT NULL DEFAULT 'pending',
    actual_amount REAL,
    win_reason TEXT,
    loss_reason TEXT,
    competitor TEXT,
    feedback_notes TEXT,
    decided_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (construction_id) REFERENCES constructions(id) ON DELETE SET NULL,
    FOREIGN KEY (estimate_log_id) REFERENCES estimate_log(id) ON DELETE SET NULL
  )`);
}

function migrate() {
  // tenant_id カラムを既存テーブルに追加（なければ）
  const tables = ['properties', 'materials', 'constructions', 'invoices'];
  for (const t of tables) {
    try {
      const cols = queryAll(`PRAGMA table_info(${t})`);
      if (!cols.find((c: any) => c.name === 'tenant_id')) {
        db.run(`ALTER TABLE ${t} ADD COLUMN tenant_id INTEGER DEFAULT 1`);
      }
    } catch (_) {}
  }
  // tenants に credits カラム追加
  try {
    const tenantCols = queryAll('PRAGMA table_info(tenants)');
    if (!tenantCols.find((c: any) => c.name === 'credits')) {
      db.run('ALTER TABLE tenants ADD COLUMN credits INTEGER DEFAULT 200');
    }
    if (!tenantCols.find((c: any) => c.name === 'plan')) {
      db.run("ALTER TABLE tenants ADD COLUMN plan TEXT DEFAULT 'standard'");
    }
    if (!tenantCols.find((c: any) => c.name === 'plan_limit')) {
      db.run('ALTER TABLE tenants ADD COLUMN plan_limit INTEGER DEFAULT 50');
    }
    if (!tenantCols.find((c: any) => c.name === 'plan_started_at')) {
      db.run('ALTER TABLE tenants ADD COLUMN plan_started_at TEXT');
    }
    if (!tenantCols.find((c: any) => c.name === 'limit_notified_month')) {
      db.run('ALTER TABLE tenants ADD COLUMN limit_notified_month TEXT');
    }
    if (!tenantCols.find((c: any) => c.name === 'contact_company')) {
      db.run('ALTER TABLE tenants ADD COLUMN contact_company TEXT');
    }
    if (!tenantCols.find((c: any) => c.name === 'contact_tel')) {
      db.run('ALTER TABLE tenants ADD COLUMN contact_tel TEXT');
    }
    if (!tenantCols.find((c: any) => c.name === 'contact_email')) {
      db.run('ALTER TABLE tenants ADD COLUMN contact_email TEXT');
    }
    if (!tenantCols.find((c: any) => c.name === 'month_notified')) {
      db.run('ALTER TABLE tenants ADD COLUMN month_notified INTEGER DEFAULT 0');
    }
    if (!tenantCols.find((c: any) => c.name === 'last_report_at')) {
      db.run('ALTER TABLE tenants ADD COLUMN last_report_at TEXT');
    }
  } catch (_) {}
  // estimate_log に generated_image カラム追加
  try {
    const elCols = queryAll('PRAGMA table_info(estimate_log)');
    if (!elCols.find((c: any) => c.name === 'generated_image')) {
      db.run('ALTER TABLE estimate_log ADD COLUMN generated_image TEXT');
    }
    if (!elCols.find((c: any) => c.name === 'uploaded_image')) {
      db.run('ALTER TABLE estimate_log ADD COLUMN uploaded_image TEXT');
    }
  } catch (_) {}
  // constructions にカラム追加
  try {
    const conCols = queryAll('PRAGMA table_info(constructions)');
    if (!conCols.find((c: any) => c.name === 'status')) {
      db.run("ALTER TABLE constructions ADD COLUMN status TEXT DEFAULT '完了'");
    }
    if (!conCols.find((c: any) => c.name === 'fixed_selling_price')) {
      db.run('ALTER TABLE constructions ADD COLUMN fixed_selling_price REAL');
    }
    if (!conCols.find((c: any) => c.name === 'actual_selling_price')) {
      db.run('ALTER TABLE constructions ADD COLUMN actual_selling_price REAL');
    }
    if (!conCols.find((c: any) => c.name === 'actual_labor_cost')) {
      db.run('ALTER TABLE constructions ADD COLUMN actual_labor_cost REAL');
    }
    if (!conCols.find((c: any) => c.name === 'actual_material_cost')) {
      db.run('ALTER TABLE constructions ADD COLUMN actual_material_cost REAL');
    }
  } catch (_) {}
  // estimate_log に実績フィードバックカラム追加（学習ループ用）
  try {
    const elCols2 = queryAll('PRAGMA table_info(estimate_log)');
    if (!elCols2.find((c: any) => c.name === 'actual_material_cost')) {
      db.run('ALTER TABLE estimate_log ADD COLUMN actual_material_cost REAL');
    }
    if (!elCols2.find((c: any) => c.name === 'actual_labor_cost')) {
      db.run('ALTER TABLE estimate_log ADD COLUMN actual_labor_cost REAL');
    }
    if (!elCols2.find((c: any) => c.name === 'actual_selling_price')) {
      db.run('ALTER TABLE estimate_log ADD COLUMN actual_selling_price REAL');
    }
    if (!elCols2.find((c: any) => c.name === 'actual_markup_rate')) {
      db.run('ALTER TABLE estimate_log ADD COLUMN actual_markup_rate REAL');
    }
    if (!elCols2.find((c: any) => c.name === 'feedback_at')) {
      db.run('ALTER TABLE estimate_log ADD COLUMN feedback_at DATETIME');
    }
  } catch (_) {}
  // マイナス単価の「諸経費」を「値引き」にリネーム
  try {
    db.run("UPDATE materials SET name = '値引き' WHERE name = '諸経費' AND unit_price < 0");
  } catch (_) {}
  // デフォルトテナント作成
  const tenants = queryAll('SELECT id FROM tenants');
  if (tenants.length === 0) {
    db.run("INSERT INTO tenants (name) VALUES ('デフォルト')");
  }
}
