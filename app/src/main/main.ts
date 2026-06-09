import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { initDatabase, queryAll, queryOne, runSql, logAudit, setCurrentTenant, getCurrentTenant, getCredits, useCredits, addCredits, getMonthlyUsage, getTenantPlan, setTenantPlan, PLANS, CREDIT_COSTS, createPlanRequest, listPlanRequests, listAllPlanRequests, approvePlanRequest, rejectPlanRequest, cancelPlanRequest } from '../database/database';
import { startServer, getServerUrl, setConfigLoader } from './server';
import { COST_REFERENCE } from './cost-reference';
import { sendFeedbackToSupabase, fetchCostCoefficients, coefficientsToPromptText, analyzeAndUpdateCoefficients } from './supabase-sync';

// ── トライアル用埋め込みキー ──
const TRIAL_KEYS = {
  anthropic: '1XxV7iNDIgb3faeGwY+dxGeJZULfY9TzgkR2MAiM6QnhZeMJlk8u3cUVgeWXYxb87AvRBNqjghfgJdNEuhPWFdtDWhNPeCWVUf1mHO45Gi1xUfFOAZtI9GJ111Dl5QQXvhL9RhRaVydvlF8Jv8ZdbQ//YKz+AS9YDDicsw==',
  openai: 'uDjG9t5A1oJT5Lb114UTYmeJZVPDeJO/l0J3bELM7W34U6sB5mYs1/tIxd+GUTXAwRXrIMymvxfIfK5dv3SUTOpeMwcoXm6sNYsdJINtYDZje/d9OJYDwWpvyQTZyCchrxGeR2VaQi1Lh2Uqv7pybyTods38AQ9NNC24u10fW/FvlMIkrJE8WpbHltiFw8eUSKWZpgSIqgmnKhgOn2mkr12WDrC+zcpY80ZdLITc1+VW20Ro',
};
function decryptTrialKey(encoded: string): string {
  if (!encoded || encoded.startsWith('PASTE_')) return '';
  try {
    const SEED = 'kenchiku-boost-2026-trial';
    const derived = crypto.createHash('sha256').update(SEED).digest();
    const iv = crypto.createHash('md5').update(SEED + '-iv').digest().subarray(0, 12);
    const buf = Buffer.from(encoded, 'base64');
    const tag = buf.subarray(0, 16);
    const encrypted = buf.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', derived, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch (_) { return ''; }
}

// ── API キー暗号化 ──
const SENSITIVE_FIELDS = ['anthropicKey', 'openaiKey', 'serverPassword'];
function getEncKey() {
  const os = require('os');
  return crypto.createHash('sha256').update(os.hostname() + os.userInfo().username + 'kentiku-salt').digest();
}
function encryptField(text: string): string {
  if (!text) return '';
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
}
function decryptField(data: string): string {
  if (!data || !data.startsWith('enc:')) return data; // 平文ならそのまま
  try {
    const key = getEncKey();
    const buf = Buffer.from(data.slice(4), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch (_) { return ''; }
}

function getConfigPath() { return path.join(app.getPath('userData'), 'api-config.json'); }
function loadApiConfig(): any {
  let config: any = { anthropicKey: '', openaiKey: '' };
  try {
    if (fs.existsSync(getConfigPath())) {
      const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
      for (const f of SENSITIVE_FIELDS) { if (raw[f]) raw[f] = decryptField(raw[f]); }
      config = raw;
    }
  } catch (_) {}
  // 埋め込みトライアルキーをフォールバック
  if (!config.anthropicKey) config.anthropicKey = decryptTrialKey(TRIAL_KEYS.anthropic);
  if (!config.openaiKey) config.openaiKey = decryptTrialKey(TRIAL_KEYS.openai);
  // プラン請求書の振込先（固定・変更不可）
  config.bankName = 'シティ銀行';
  config.bankBranch = '011';
  config.bankType = '普通';
  config.bankNumber = '0402025';
  config.bankHolder = 'ユ）ナカノコウムテン';
  return config;
}
function saveApiConfig(config: any) {
  const toSave = { ...config };
  // 暗号化
  for (const f of SENSITIVE_FIELDS) { if (toSave[f]) toSave[f] = encryptField(toSave[f]); }
  fs.writeFileSync(getConfigPath(), JSON.stringify(toSave, null, 2), 'utf-8');
}

// ── HTMLエスケープ（XSS対策）──
function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let mainWindow: BrowserWindow | null = null;

// ── 学習ループ: 匿名統計の中央サーバー送受信 ──
const LEARNING_API_URL = 'https://kenchiku-boost-learning.onrender.com/api/stats';

// ローカル実績を匿名化して収集
function collectAnonymousStats(): any {
  try {
    const stats = queryAll(`
      SELECT
        SUBSTR(c.notes, 1, INSTR(c.notes || CHAR(10), CHAR(10)) - 1) as work_type,
        COUNT(*) as cnt,
        ROUND(AVG(COALESCE(cm_total, 0))) as avg_material,
        ROUND(AVG(c.labor_cost)) as avg_labor,
        ROUND(AVG(c.markup_rate * 100)) as avg_markup,
        ROUND(AVG(c.fixed_selling_price)) as avg_selling
      FROM constructions c
      LEFT JOIN (SELECT construction_id, SUM(quantity * unit_price) as cm_total FROM construction_materials GROUP BY construction_id) cm ON cm.construction_id = c.id
      WHERE c.fixed_selling_price > 0
      GROUP BY work_type
      HAVING cnt >= 2
      ORDER BY cnt DESC
      LIMIT 30
    `);

    // フィードバック精度（AI予測 vs 実績の乖離）
    const feedback = queryAll(`
      SELECT work_type,
        COUNT(*) as cnt,
        ROUND(AVG(CASE WHEN ai_material_cost > 0 THEN ((actual_material_cost - ai_material_cost) / ai_material_cost) * 100 END)) as avg_mat_diff_pct,
        ROUND(AVG(CASE WHEN ai_labor_cost > 0 THEN ((actual_labor_cost - ai_labor_cost) / ai_labor_cost) * 100 END)) as avg_labor_diff_pct,
        ROUND(AVG(CASE WHEN ai_total > 0 THEN ((actual_selling_price - ai_total) / ai_total) * 100 END)) as avg_total_diff_pct
      FROM estimate_log
      WHERE actual_material_cost IS NOT NULL AND feedback_at IS NOT NULL
      GROUP BY work_type
      HAVING cnt >= 2
    `);

    return { stats, feedback, ts: new Date().toISOString(), version: '1.0' };
  } catch (_) { return null; }
}

// 中央サーバーに匿名統計を送信
async function sendStatsToServer() {
  try {
    const data = collectAnonymousStats();
    if (!data || !data.stats || data.stats.length === 0) return;
    const https = require('https');
    const http = require('http');
    const url = new URL(LEARNING_API_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(data);
    const req = mod.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res: any) => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
    console.log(`学習ループ: ${data.stats.length}件の匿名統計を送信`);
  } catch (_) {}
}

// Supabaseに実績データを送信（匿名化済み）
async function sendStatsToSupabase() {
  try {
    const feedback = queryAll(`
      SELECT work_type, ai_material_cost, ai_labor_cost, ai_total, ai_markup_rate,
        actual_material_cost, actual_labor_cost, actual_selling_price, actual_markup_rate, feedback_at
      FROM estimate_log
      WHERE actual_material_cost IS NOT NULL AND feedback_at IS NOT NULL
    `);
    if (!feedback || feedback.length === 0) {
      // 実績フィードバックがなくても施工データから送信
      const stats = collectAnonymousStats();
      if (stats && stats.stats && stats.stats.length > 0) {
        const feedbackList = stats.stats.map((s: any) => ({
          work_type: s.work_type || '不明',
          ai_material_cost: s.avg_material,
          ai_labor_cost: s.avg_labor,
          ai_total: (s.avg_material || 0) + (s.avg_labor || 0),
          actual_material_cost: s.avg_material,
          actual_labor_cost: s.avg_labor,
          actual_selling_price: s.avg_selling,
          accuracy_ratio: s.avg_selling && s.avg_material ? s.avg_selling / ((s.avg_material || 0) + (s.avg_labor || 0)) : null,
        }));
        await sendFeedbackToSupabase(feedbackList);
      }
      return;
    }
    const feedbackList = feedback.map((f: any) => ({
      work_type: f.work_type || '不明',
      ai_material_cost: f.ai_material_cost,
      ai_labor_cost: f.ai_labor_cost,
      ai_total: f.ai_total,
      ai_markup_rate: f.ai_markup_rate,
      actual_material_cost: f.actual_material_cost,
      actual_labor_cost: f.actual_labor_cost,
      actual_selling_price: f.actual_selling_price,
      actual_markup_rate: f.actual_markup_rate,
      accuracy_ratio: f.ai_total > 0 ? f.actual_selling_price / f.ai_total : null,
    }));
    await sendFeedbackToSupabase(feedbackList);
  } catch (e) {
    console.error('Supabase送信エラー:', e);
  }
  // 旧サーバーにも送信（互換性維持）
  try { sendStatsToServer(); } catch (_) {}
}

// 中央サーバーから集約統計を取得
async function fetchAggregatedStats(): Promise<string> {
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const http = require('http');
      const url = new URL(LEARNING_API_URL);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.get({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, timeout: 5000 }, (res: any) => {
        let body = '';
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (!data.stats || data.stats.length === 0) { resolve(''); return; }
            const lines = data.stats.map((s: any) =>
              `- ${s.work_type}: ${s.total_cnt}社の実績 | 材料費 平均${Math.round(s.avg_material||0).toLocaleString()}円 | 人件費 平均${Math.round(s.avg_labor||0).toLocaleString()}円 | 掛率平均${s.avg_markup||130}%`
            );
            const fbLines = (data.feedback || []).map((f: any) =>
              `- ${f.work_type}: AI予測との乖離 材料費${f.avg_mat_diff_pct>0?'+':''}${f.avg_mat_diff_pct||0}% / 人件費${f.avg_labor_diff_pct>0?'+':''}${f.avg_labor_diff_pct||0}% / 売価${f.avg_total_diff_pct>0?'+':''}${f.avg_total_diff_pct||0}%`
            );
            let result = `\n## 全ユーザー集約実績（${data.contributor_count || '複数'}社のデータ）\n${lines.join('\n')}`;
            if (fbLines.length > 0) result += `\n\n## 全ユーザーのAI予測精度フィードバック\n${fbLines.join('\n')}`;
            resolve(result);
          } catch (_) { resolve(''); }
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    } catch (_) { resolve(''); }
  });
}

// ── 月間上限到達時のメール通知 ──
async function sendLimitNotification(operation: string) {
  try {
    const tid = getCurrentTenant();
    const tenant = queryOne('SELECT name, limit_notified_month, contact_company, contact_tel, contact_email FROM tenants WHERE id = ?', [tid]);
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // 同じ月に既に通知済みならスキップ
    if (tenant?.limit_notified_month === currentMonth) return;

    const usage = getMonthlyUsage(tid);
    const planDef = PLANS[usage.plan];

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: 'mitsuakinakano0215@gmail.com', pass: 'cmlz usad gycg sbem' },
    });

    await transporter.sendMail({
      from: '建築ブースト <mitsuakinakano0215@gmail.com>',
      to: 'mitsuakinakano0215@gmail.com',
      subject: `【建築ブースト】AIストック上限到達 - ${tenant?.name || 'テナント' + tid}`,
      text: [
        `テナント「${tenant?.name || 'ID:' + tid}」が今月のAIストック上限に達しました。`,
        '',
        '【お客様情報】',
        `■ 会社名: ${tenant?.contact_company || tenant?.name || '未登録'}`,
        `■ 電話番号: ${tenant?.contact_tel || '未登録'}`,
        `■ メールアドレス: ${tenant?.contact_email || '未登録'}`,
        '',
        '【利用状況】',
        `■ プラン: ${planDef?.name || usage.plan}`,
        `■ 月間上限: ${usage.limit}回`,
        `■ 今月の使用量: ${usage.used}回`,
        `■ 上限到達時の操作: ${operation}`,
        `■ 日時: ${now.toLocaleString('ja-JP')}`,
        '',
        '追加ストックの対応が必要な場合は、お客様にご連絡ください。',
        '',
        '---',
        '建築ブースト 自動通知',
      ].join('\n'),
    });

    // 通知済みフラグを更新
    runSql('UPDATE tenants SET limit_notified_month = ? WHERE id = ?', [currentMonth, tid]);
  } catch (e: any) {
    console.error('Limit notification email failed:', e?.message || e);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: '建築ブースト',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      sandbox: true,
    },
  });

  // CSP（Content Security Policy）設定
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"],
      },
    });
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 自動バックアップ ──
function runBackup(dbFilePath: string): string | null {
  try {
    if (!fs.existsSync(dbFilePath)) return null;
    const dir = path.join(path.dirname(dbFilePath), 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const dest = path.join(dir, `kentiku_${ts}.db`);
    fs.copyFileSync(dbFilePath, dest);
    // 古いバックアップ削除（10世代まで）
    const files = fs.readdirSync(dir).filter((f: string) => f.startsWith('kentiku_') && f.endsWith('.db')).sort().reverse();
    files.slice(10).forEach((f: string) => { try { fs.unlinkSync(path.join(dir, f)); } catch(_) {} });
    return dest;
  } catch(e) { console.error('Backup failed:', e); return null; }
}

// ── 画像ファイル保存 ──
function getImagesDir(dbFilePath: string) {
  const dir = path.join(path.dirname(dbFilePath), 'images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

app.whenReady().then(async () => {
  // ── 改ざん検知（dist/main.js のハッシュチェック）──
  const isOwner = require('os').hostname() === 'DESKTOP-MRETEV6' && require('os').userInfo().username === 'mitsu';
  if (!isOwner) {
    try {
      const mainJsPath = path.join(__dirname, 'main.js');
      const mainJsHash = crypto.createHash('sha256').update(fs.readFileSync(mainJsPath)).digest('hex');
      const hashFile = path.join(app.getPath('userData'), '.integrity');
      if (fs.existsSync(hashFile)) {
        const savedHash = fs.readFileSync(hashFile, 'utf-8').trim();
        if (savedHash && savedHash !== mainJsHash) {
          // メールで通知
          try {
            const nodemailer = require('nodemailer');
            const transporter = nodemailer.createTransport({
              service: 'gmail',
              auth: { user: 'mitsuakinakano0215@gmail.com', pass: 'cmlz usad gycg sbem' },
            });
            transporter.sendMail({
              from: '建築ブースト <mitsuakinakano0215@gmail.com>',
              to: 'mitsuakinakano0215@gmail.com',
              subject: '【警告】建築ブースト 改ざん検知',
              text: `改ざんが検知されました。\n\nマシン: ${require('os').hostname()}\nユーザー: ${require('os').userInfo().username}\n日時: ${new Date().toLocaleString('ja-JP')}\n\n保存ハッシュ: ${savedHash}\n現在ハッシュ: ${mainJsHash}`,
            }).catch(() => {});
          } catch (_) {}
          dialog.showErrorBox('セキュリティエラー', 'アプリケーションファイルが改ざんされた可能性があります。\n正規の建築ブーストを再インストールしてください。');
          app.quit();
          return;
        }
      }
      fs.writeFileSync(hashFile, mainJsHash, 'utf-8');
    } catch (_) {}
  }

  // ── CSP: API通信先を隠蔽（connect-srcからドメイン名を削除）──
  // → session.defaultSession で動的にヘッダーを設定

  // DB パスを設定から取得（共有フォルダ対応）
  const config = loadApiConfig();
  const dbPath = config.dbPath || path.join(app.getPath('userData'), 'kentiku.db');
  await initDatabase(dbPath);

  // テナントID=1以外があれば自動切替（トライアル版対応）
  const allTenants = queryAll('SELECT id FROM tenants WHERE id > 1 ORDER BY id ASC');
  if (allTenants.length > 0) {
    setCurrentTenant(allTenants[0].id);
  }

  createWindow();

  // 起動時バックアップ + 30分ごと
  runBackup(dbPath);
  setInterval(() => runBackup(dbPath), 30 * 60 * 1000);

  // 学習ループ: 起動時に匿名統計をSupabaseへ送信
  setTimeout(() => sendStatsToSupabase(), 8000);

  // 提供から1ヶ月経過チェック
  setTimeout(async () => {
    try {
      const tenants = queryAll('SELECT * FROM tenants WHERE id > 1 AND month_notified = 0 AND plan_started_at IS NOT NULL');
      for (const t of tenants) {
        const started = new Date(t.plan_started_at);
        const now = new Date();
        const diffDays = Math.floor((now.getTime() - started.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays >= 30) {
          const usage = getMonthlyUsage(t.id);
          const planDef = PLANS[t.plan] || {};
          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: 'mitsuakinakano0215@gmail.com', pass: 'cmlz usad gycg sbem' },
          });
          await transporter.sendMail({
            from: '建築ブースト <mitsuakinakano0215@gmail.com>',
            to: 'mitsuakinakano0215@gmail.com',
            subject: `【建築ブースト】提供から1ヶ月経過 - ${t.contact_company || t.name}`,
            text: [
              `テナント「${t.contact_company || t.name}」の利用開始から1ヶ月が経過しました。`,
              '',
              '【お客様情報】',
              `■ 会社名: ${t.contact_company || t.name}`,
              `■ 電話番号: ${t.contact_tel || '未登録'}`,
              `■ メールアドレス: ${t.contact_email || '未登録'}`,
              '',
              '【利用状況】',
              `■ プラン: ${(planDef as any).name || t.plan}`,
              `■ 利用開始日: ${t.plan_started_at}`,
              `■ 今月の使用量: ${usage.used} / ${usage.limit}回`,
              '',
              'フォローアップのご連絡をご検討ください。',
              '',
              '---',
              '建築ブースト 自動通知',
            ].join('\n'),
          });
          runSql('UPDATE tenants SET month_notified = 1 WHERE id = ?', [t.id]);
          console.log(`1ヶ月通知送信: ${t.contact_company || t.name}`);
        }
      }
    } catch (e: any) {
      console.error('Month check failed:', e?.message || e);
    }
  }, 5000);

  // スマホ用Webサーバー起動
  try {
    setConfigLoader(loadApiConfig);
    const distPath = path.join(__dirname);
    startServer(distPath);
    setTimeout(() => {
      const url = getServerUrl();
      if (url) console.log(`\n📱 スマホからアクセス: ${url}\n`);
    }, 1000);
  } catch (e) {
    console.error('Web server start failed:', e);
  }

  // ── 物件 CRUD ──
  ipcMain.handle('properties:list', () => {
    return queryAll('SELECT * FROM properties WHERE tenant_id = ? ORDER BY created_at DESC', [getCurrentTenant()]);
  });

  ipcMain.handle('properties:create', (_e, data: any) => {
    const id = runSql(
      'INSERT INTO properties (name, address, floor_plan_image, notes, tenant_id) VALUES (?, ?, ?, ?, ?)',
      [data.name, data.address, data.floorPlanImage || null, data.notes || null, getCurrentTenant()]
    );
    logAudit('create', 'property', id, data.name);
    return id;
  });

  ipcMain.handle('properties:update', (_e, data: any) => {
    runSql(
      'UPDATE properties SET name=?, address=?, floor_plan_image=?, notes=? WHERE id=?',
      [data.name, data.address, data.floorPlanImage || null, data.notes || null, data.id]
    );
  });

  ipcMain.handle('properties:delete', (_e, id: number) => {
    runSql('DELETE FROM properties WHERE id=?', [id]);
  });

  // ── 材料マスタ CRUD ──
  ipcMain.handle('materials:list', () => {
    return queryAll('SELECT * FROM materials WHERE tenant_id = ? ORDER BY category, name', [getCurrentTenant()]);
  });

  ipcMain.handle('materials:create', (_e, data: any) => {
    return runSql(
      'INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
      [data.name, data.category, data.unit, data.unitPrice, data.notes || null, getCurrentTenant()]
    );
  });

  ipcMain.handle('materials:update', (_e, data: any) => {
    runSql(
      'UPDATE materials SET name=?, category=?, unit=?, unit_price=?, notes=? WHERE id=?',
      [data.name, data.category, data.unit, data.unitPrice, data.notes || null, data.id]
    );
  });

  ipcMain.handle('materials:delete', (_e, id: number) => {
    runSql('DELETE FROM materials WHERE id=?', [id]);
  });

  // ── 施工履歴 CRUD（経費・売上付き）──
  ipcMain.handle('constructions:list', () => {
    const rows = queryAll(`
      SELECT c.*, p.name as property_name,
        (SELECT COALESCE(SUM(cm.quantity * cm.unit_price), 0) FROM construction_materials cm WHERE cm.construction_id = c.id) as material_cost
      FROM constructions c
      LEFT JOIN properties p ON c.property_id = p.id
      WHERE c.tenant_id = ?
      ORDER BY c.construction_date DESC
    `, [getCurrentTenant()]);
    return rows.map((r: any) => {
      const matCost = r.material_cost || 0;
      const laborCost = r.labor_cost || 0;
      const totalCost = matCost + laborCost;
      const selling = r.fixed_selling_price || Math.ceil(totalCost * (r.markup_rate || 1.3));
      const profit = selling - totalCost;
      return { ...r, total_cost: totalCost, selling_price: selling, gross_profit: profit };
    });
  });

  ipcMain.handle('constructions:create', (_e, data: any) => {
    const id = runSql(
      'INSERT INTO constructions (property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [data.propertyId, data.title, data.constructionDate, data.laborCost, data.markupRate || 1.3, data.notes || null, getCurrentTenant()]
    );
    logAudit('create', 'construction', id, data.title);
    return id;
  });

  ipcMain.handle('constructions:update', (_e, data: any) => {
    runSql(
      'UPDATE constructions SET property_id=?, title=?, construction_date=?, labor_cost=?, markup_rate=?, notes=?, status=? WHERE id=?',
      [data.propertyId, data.title, data.constructionDate, data.laborCost, data.markupRate, data.notes || null, data.status || '見積中', data.id]
    );
    recalcConstruction(data.id);
  });

  ipcMain.handle('constructions:delete', (_e, id: number) => {
    runSql('DELETE FROM construction_materials WHERE construction_id=?', [id]);
    runSql('DELETE FROM constructions WHERE id=?', [id]);
  });

  // 施工の売価・請求書を自動更新 + 学習ループのフィードバック自動蓄積
  function recalcConstruction(constructionId: number) {
    const c = queryOne('SELECT * FROM constructions WHERE id = ?', [constructionId]);
    if (!c) return;
    const mat = queryOne('SELECT SUM(quantity * unit_price) as total FROM construction_materials WHERE construction_id = ?', [constructionId]);
    const matCost = mat?.total || 0;
    const laborCost = c.labor_cost || 0;
    const totalCost = matCost + laborCost;
    const markupRate = c.markup_rate || 1.3;
    const sellingPrice = Math.ceil(totalCost * markupRate);
    // fixed_selling_priceを更新
    runSql('UPDATE constructions SET fixed_selling_price = ? WHERE id = ?', [sellingPrice, constructionId]);
    // 紐づく請求書のamountも更新
    runSql('UPDATE invoices SET amount = ? WHERE construction_id = ?', [sellingPrice, constructionId]);

    // ── 学習ループ: estimate_logに実績値を自動フィードバック ──
    try {
      const log = queryOne('SELECT id, ai_material_cost, ai_labor_cost, ai_total, work_type FROM estimate_log WHERE construction_id = ?', [constructionId]);
      if (log) {
        const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
        runSql(
          'UPDATE estimate_log SET actual_material_cost=?, actual_labor_cost=?, actual_selling_price=?, actual_markup_rate=?, feedback_at=? WHERE id=?',
          [matCost, laborCost, sellingPrice, markupRate, now, log.id]
        );

        // ── 即時学習: Supabaseに送信 → 全実績から係数を即更新 ──
        const config = loadApiConfig();
        sendFeedbackToSupabase([{
          work_type: log.work_type || '不明',
          ai_material_cost: log.ai_material_cost,
          ai_labor_cost: log.ai_labor_cost,
          ai_total: log.ai_total,
          actual_material_cost: matCost,
          actual_labor_cost: laborCost,
          actual_selling_price: sellingPrice,
          actual_markup_rate: markupRate,
          accuracy_ratio: log.ai_total > 0 ? sellingPrice / log.ai_total : null,
        }]).then(() => {
          // 送信完了後、即座にClaude APIで全実績を分析して係数更新
          return analyzeAndUpdateCoefficients(config.anthropicKey);
        }).then(() => {
          console.log('学習ループ即時: 係数更新完了 — 次回見積から反映されます');
        }).catch((e: any) => {
          console.error('学習ループ即時エラー:', e);
        });
      }
    } catch (_) {}
  }

  // ── 施工材料明細 ──
  ipcMain.handle('constructionMaterials:list', (_e, constructionId: number) => {
    return queryAll(`
      SELECT cm.*, m.name as material_name, m.unit, m.unit_price as master_unit_price, m.category
      FROM construction_materials cm
      LEFT JOIN materials m ON cm.material_id = m.id
      WHERE cm.construction_id = ?
      ORDER BY cm.id
    `, [constructionId]);
  });

  ipcMain.handle('constructionMaterials:add', (_e, data: any) => {
    const id = runSql(
      'INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
      [data.constructionId, data.materialId, data.quantity, data.unitPrice]
    );
    recalcConstruction(data.constructionId);
    return id;
  });

  ipcMain.handle('constructionMaterials:update', (_e, data: any) => {
    // 材料マスタ側も更新
    if (data.materialId) {
      runSql('UPDATE materials SET name=?, unit=? WHERE id=?', [data.name || '', data.unit || '式', data.materialId]);
    }
    // 明細の数量・単価を更新
    runSql('UPDATE construction_materials SET quantity=?, unit_price=? WHERE id=?', [data.quantity || 1, data.unitPrice || 0, data.id]);
    // constructionIdを取得して再計算
    const cm = queryOne('SELECT construction_id FROM construction_materials WHERE id = ?', [data.id]);
    if (cm) recalcConstruction(cm.construction_id);
  });

  ipcMain.handle('constructionMaterials:remove', (_e, id: number) => {
    const cm = queryOne('SELECT construction_id FROM construction_materials WHERE id = ?', [id]);
    runSql('DELETE FROM construction_materials WHERE id=?', [id]);
    if (cm) recalcConstruction(cm.construction_id);
  });

  // ── 見積もり計算 ──
  ipcMain.handle('constructions:calculate', (_e, constructionId: number) => {
    const construction = queryOne('SELECT * FROM constructions WHERE id=?', [constructionId]);
    const materials = queryOne(
      'SELECT SUM(quantity * unit_price) as total FROM construction_materials WHERE construction_id=?',
      [constructionId]
    );

    const materialCost = materials?.total || 0;
    const laborCost = construction?.labor_cost || 0;
    const totalCost = materialCost + laborCost;
    const markupRate = construction?.markup_rate || 1.3;
    const sellingPrice = construction?.fixed_selling_price || Math.ceil(totalCost * markupRate);
    const grossProfit = sellingPrice - totalCost;
    const profitRate = totalCost > 0 ? (grossProfit / sellingPrice) * 100 : 0;

    return { materialCost, laborCost, totalCost, markupRate, sellingPrice, grossProfit, profitRate: Math.round(profitRate * 10) / 10 };
  });

  // ── 請求書 CRUD ──
  ipcMain.handle('invoices:list', () => {
    const rows = queryAll(`
      SELECT i.*, c.title as construction_title, c.labor_cost, c.markup_rate, c.fixed_selling_price,
        p.name as property_name,
        (SELECT COALESCE(SUM(cm.quantity * cm.unit_price), 0) FROM construction_materials cm WHERE cm.construction_id = c.id) as material_cost
      FROM invoices i
      LEFT JOIN constructions c ON i.construction_id = c.id
      LEFT JOIN properties p ON c.property_id = p.id
      WHERE i.tenant_id = ?
      ORDER BY i.issue_date DESC
    `, [getCurrentTenant()]);
    return rows.map((r: any) => {
      const matCost = r.material_cost || 0;
      const laborCost = r.labor_cost || 0;
      const totalCost = matCost + laborCost;
      const selling = r.amount || Math.ceil(totalCost * (r.markup_rate || 1.3));
      const profit = selling - totalCost;
      return { ...r, total_cost: totalCost, selling_price: selling, gross_profit: profit };
    });
  });

  ipcMain.handle('invoices:create', (_e, data: any) => {
    const id = runSql(
      'INSERT INTO invoices (construction_id, client_name, client_address, issue_date, due_date, amount, tax_rate, notes, status, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [data.constructionId || null, data.clientName, data.clientAddress || null, data.issueDate, data.dueDate || null, data.amount || 0, data.taxRate != null ? data.taxRate : 0.1, data.notes || null, data.status || 'draft', getCurrentTenant()]
    );
    logAudit('create', 'invoice', id, data.clientName);
    return id;
  });

  ipcMain.handle('invoices:update', (_e, data: any) => {
    runSql(
      'UPDATE invoices SET client_name=?, client_address=?, issue_date=?, due_date=?, amount=?, tax_rate=?, notes=?, status=? WHERE id=?',
      [data.clientName, data.clientAddress || null, data.issueDate, data.dueDate || null, data.amount || 0, data.taxRate != null ? data.taxRate : 0.1, data.notes || null, data.status || 'draft', data.id]
    );
  });

  ipcMain.handle('invoices:delete', (_e, id: number) => {
    runSql('DELETE FROM invoices WHERE id=?', [id]);
  });

  ipcMain.handle('invoices:getDetail', (_e, invoiceId: number) => {
    const invoice = queryOne(`
      SELECT i.*, c.title as construction_title, c.labor_cost, c.markup_rate,
             p.name as property_name, p.address as property_address
      FROM invoices i
      LEFT JOIN constructions c ON i.construction_id = c.id
      LEFT JOIN properties p ON c.property_id = p.id
      WHERE i.id = ?
    `, [invoiceId]);

    const materials = (invoice && invoice.construction_id) ? queryAll(`
      SELECT cm.*, m.name as material_name, m.unit, m.category
      FROM construction_materials cm
      LEFT JOIN materials m ON cm.material_id = m.id
      WHERE cm.construction_id = ?
      ORDER BY m.category, m.name
    `, [invoice.construction_id]) : [];

    return { invoice, materials };
  });

  // ── 請求書PDF生成（HTML→printToPDF）──
  ipcMain.handle('invoices:generatePDF', async (_e, data: any) => {
    const { invoice, materials } = data;
    const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

    // ── 金額を明細から積み上げて計算（DBの値と一致させる）──
    let materialTotal = 0;
    let materialRows = '';
    let rowNum = 1;

    if (materials && materials.length > 0) {
      materials.forEach((m: any) => {
        const name = escapeHtml(m.material_name || m.name || '（項目名なし）');
        const unit = escapeHtml(m.unit || '式');
        const qty = m.quantity || 1;
        const price = m.unit_price || 0;
        const subtotal = Math.round(qty * price);
        materialTotal += subtotal;
        materialRows += `<tr>
          <td style="text-align:center;color:#888;width:30px">${rowNum++}</td>
          <td>${name}</td>
          <td style="text-align:center">${qty}</td>
          <td style="text-align:center">${unit}</td>
          <td style="text-align:right">${fmt(price)}</td>
          <td style="text-align:right">${fmt(subtotal)}</td>
        </tr>`;
      });
    }

    // 人件費（施工費）
    const laborCost = invoice.labor_cost || 0;
    if (laborCost > 0) {
      materialRows += `<tr style="border-top:2px solid #ccc">
        <td style="text-align:center;color:#888">${rowNum++}</td>
        <td><strong>施工費</strong></td>
        <td style="text-align:center">1</td>
        <td style="text-align:center">式</td>
        <td style="text-align:right">${fmt(laborCost)}</td>
        <td style="text-align:right">${fmt(laborCost)}</td>
      </tr>`;
    }

    // 原価 = 材料 + 人件費
    const costTotal = materialTotal + laborCost;
    // 売価 = invoice.amount
    const taxExcluded = invoice.amount || 0;
    // マージン = 売価 - 原価 → 「設計・工事管理費」として明細に入れる
    const managementFee = taxExcluded - costTotal;
    if (managementFee > 0) {
      materialRows += `<tr>
        <td style="text-align:center;color:#888">${rowNum++}</td>
        <td><strong>設計・工事管理費</strong></td>
        <td style="text-align:center">1</td>
        <td style="text-align:center">式</td>
        <td style="text-align:right">${fmt(managementFee)}</td>
        <td style="text-align:right">${fmt(managementFee)}</td>
      </tr>`;
    }

    // 小計 = 材料 + 施工費 + 設計管理費 = 売価（税抜）→ 完全一致
    const taxRate = invoice.tax_rate || 0.1;
    const taxAmount = Math.round(taxExcluded * taxRate);
    const totalWithTax = taxExcluded + taxAmount;

    const title = escapeHtml(invoice.construction_title || invoice.notes?.match(/工事種別: (.+)/)?.[1] || '（未設定）');
    const cfg = loadApiConfig();
    const companyName = escapeHtml(cfg.companyName || '');
    const companyAddress = escapeHtml(cfg.companyAddress || '');
    const companyTel = escapeHtml(cfg.companyTel || '');
    const companyBank = escapeHtml(cfg.companyBank || '');
    const companySeal = cfg.companySeal || '';
    const companyLogo = cfg.companyLogo || '';
    const bankFormatted = cfg.myBankName ? `${escapeHtml(cfg.myBankName)} ${escapeHtml(cfg.myBankBranch || '')} ${escapeHtml(cfg.myBankType || '普通')} ${escapeHtml(cfg.myBankNumber || '')}\n口座名義: ${escapeHtml(cfg.myBankHolder || '')}` : companyBank;
    const invoiceRegNum = escapeHtml(cfg.invoiceNumber || '');
    const taxLabel = taxRate === 0.08 ? '8%（軽減税率）' : `${Math.round(taxRate * 100)}%`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Yu Gothic', 'Meiryo', 'MS PGothic', sans-serif; padding: 40px 35px; color: #333; font-size: 11px; }
  h1 { text-align:center; font-size:26px; letter-spacing:10px; margin-bottom:24px; }
  .header { display:flex; justify-content:space-between; margin-bottom:16px; }
  .client { font-size:16px; font-weight:bold; border-bottom:2px solid #333; padding-bottom:4px; }
  .meta { text-align:right; font-size:10px; line-height:1.8; }
  .subject { margin:12px 0; font-size:12px; }
  .total-box { background:#f0f0f0; padding:14px 20px; display:flex; justify-content:space-between; align-items:center; margin:16px 0; border-radius:4px; }
  .total-box .label { font-size:13px; }
  .total-box .amount { font-size:22px; font-weight:bold; }
  table { width:100%; border-collapse:collapse; margin:12px 0; }
  th { background:#323250; color:#fff; padding:6px 8px; text-align:left; font-size:10px; }
  td { padding:5px 8px; border-bottom:1px solid #eee; font-size:10px; }
  .summary { margin-top:8px; width:300px; margin-left:auto; }
  .summary-row { display:flex; justify-content:space-between; padding:3px 8px; font-size:11px; }
  .summary-row.sub { border-top:1px solid #ccc; padding-top:6px; margin-top:4px; }
  .summary-row.total { border-top:2px solid #333; font-size:14px; font-weight:bold; padding-top:6px; margin-top:4px; }
  .notes { margin-top:20px; padding:10px; background:#fafafa; border:1px solid #ddd; border-radius:4px; font-size:10px; white-space:pre-wrap; }
  .notes-label { font-weight:bold; margin-bottom:3px; }
</style>
</head><body>
  <h1>請 求 書</h1>
  <div class="header">
    <div>
      <div class="client">${escapeHtml(invoice.client_name)} 御中</div>
      ${invoice.client_address ? `<div style="margin-top:3px;font-size:10px">${escapeHtml(invoice.client_address)}</div>` : ''}
    </div>
    <div class="meta">
      No. INV-${String(invoice.id).padStart(4, '0')}<br>
      発行日: ${invoice.issue_date}<br>
      ${invoice.due_date ? `支払期限: ${invoice.due_date}` : ''}
      ${companyName ? `<div style="margin-top:10px;border-top:1px solid #ccc;padding-top:6px">
        <div style="display:flex;align-items:flex-start;gap:8px">
          <div style="flex:1">
            ${companyLogo ? `<img src="${companyLogo}" style="max-width:80px;max-height:30px;margin-bottom:4px" />` : ''}
            <strong>${companyName}</strong><br>
            ${companyAddress ? '<span style="font-size:9px">' + companyAddress + '</span><br>' : ''}
            ${companyTel ? '<span style="font-size:9px">TEL: ' + companyTel + '</span><br>' : ''}
            ${invoiceRegNum ? '<span style="font-size:9px">登録番号: ' + invoiceRegNum + '</span>' : ''}
          </div>
          ${companySeal ? `<img src="${companySeal}" style="width:60px;height:60px;object-fit:contain;opacity:0.85" />` : ''}
        </div>
      </div>` : ''}
    </div>
  </div>

  <div class="subject">
    件名: ${title}
    ${invoice.property_name ? ` / ${invoice.property_name}` : ''}
  </div>

  <div class="total-box">
    <span class="label">ご請求金額（税込）</span>
    <span class="amount">${fmt(totalWithTax)}</span>
  </div>

  <table>
    <thead><tr>
      <th style="text-align:center;width:30px">No</th>
      <th>項目</th>
      <th style="text-align:center;width:50px">数量</th>
      <th style="text-align:center;width:40px">単位</th>
      <th style="text-align:right;width:80px">単価</th>
      <th style="text-align:right;width:90px">金額</th>
    </tr></thead>
    <tbody>${materialRows}</tbody>
  </table>

  <div class="summary">
    <div class="summary-row sub"><span>小計（税抜）</span><span>${fmt(taxExcluded)}</span></div>
    <div class="summary-row"><span>対象金額（${taxLabel}対象）</span><span>${fmt(taxExcluded)}</span></div>
    <div class="summary-row"><span>消費税（${taxLabel}）</span><span>${fmt(taxAmount)}</span></div>
    <div class="summary-row total"><span>ご請求金額（税込）</span><span>${fmt(totalWithTax)}</span></div>
  </div>

  ${bankFormatted ? `<div class="notes"><div class="notes-label">お振込先</div><span style="white-space:pre-wrap">${bankFormatted}</span></div>` : ''}
  ${invoice.notes ? `<div class="notes"><div class="notes-label">備考</div>${escapeHtml(invoice.notes)}</div>` : ''}
  ${invoiceRegNum ? `<div style="margin-top:10px;font-size:9px;color:#888;text-align:right">適格請求書発行事業者登録番号: ${invoiceRegNum}</div>` : ''}
</body></html>`;

    // UTF-8 BOM付きで一時HTMLファイルに書き出す
    const tmpDir = app.getPath('temp');
    const tmpHtml = path.join(tmpDir, `invoice_${Date.now()}.html`);
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const content = Buffer.from(html, 'utf-8');
    fs.writeFileSync(tmpHtml, Buffer.concat([bom, content]));

    const pdfWindow = new BrowserWindow({
      show: false,
      width: 794,
      height: 1123,
      webPreferences: { defaultEncoding: 'utf-8' },
    });
    await pdfWindow.loadURL(`file:///${tmpHtml.replace(/\\/g, '/')}`);

    // レンダリング完了を待つ
    await new Promise<void>(resolve => setTimeout(resolve, 1000));

    const pdfData = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
    });
    pdfWindow.close();

    // 一時ファイル削除
    try { fs.unlinkSync(tmpHtml); } catch(_) {}

    const fileName = `請求書_${invoice.client_name}_${invoice.issue_date}.pdf`;
    const savePath = await dialog.showSaveDialog({
      defaultPath: fileName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });

    if (!savePath.canceled && savePath.filePath) {
      fs.writeFileSync(savePath.filePath, pdfData);
      shell.openPath(savePath.filePath);
    }
  });

  // ── ダッシュボード集計 ──
  ipcMain.handle('dashboard:summary', () => {
    const constructions = queryAll('SELECT id, labor_cost, markup_rate, fixed_selling_price FROM constructions WHERE tenant_id = ?', [getCurrentTenant()]);
    let totalMaterialCost = 0;
    let totalLaborCost = 0;
    let totalSelling = 0;
    let totalGrossProfit = 0;

    for (const c of constructions) {
      const mat = queryOne(
        'SELECT SUM(quantity * unit_price) as total FROM construction_materials WHERE construction_id=?',
        [c.id]
      );
      const matCost = mat?.total || 0;
      const laborCost = c.labor_cost || 0;
      const cost = matCost + laborCost;
      const selling = c.fixed_selling_price || Math.ceil(cost * (c.markup_rate || 1.3));
      const profit = selling - cost;

      totalMaterialCost += matCost;
      totalLaborCost += laborCost;
      totalSelling += selling;
      totalGrossProfit += profit;
    }

    return {
      totalMaterialCost,
      totalLaborCost,
      totalSelling,
      totalGrossProfit,
      profitRate: totalSelling > 0 ? Math.round((totalGrossProfit / totalSelling) * 1000) / 10 : 0,
    };
  });

  // ── テナント管理 ──
  ipcMain.handle('tenants:list', () => queryAll('SELECT * FROM tenants ORDER BY id'));
  ipcMain.handle('tenants:create', (_e, name: string) => {
    const id = runSql('INSERT INTO tenants (name) VALUES (?)', [name]);
    // デフォルトテナントの材料マスタをコピー
    const defaultMats = queryAll('SELECT name, category, unit, unit_price, notes FROM materials WHERE tenant_id = 1');
    for (const m of defaultMats) {
      runSql('INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
        [m.name, m.category, m.unit, m.unit_price, m.notes, id]);
    }
    logAudit('create', 'tenant', id, `${name}（材料${defaultMats.length}件コピー）`);
    return id;
  });
  ipcMain.handle('tenants:switch', (_e, id: number) => { setCurrentTenant(id); });
  ipcMain.handle('tenants:current', () => getCurrentTenant());
  ipcMain.handle('tenants:delete', (_e, id: number) => {
    // テナントに紐づく全データを削除
    const constructions = queryAll('SELECT id FROM constructions WHERE tenant_id=?', [id]);
    for (const c of constructions) {
      runSql('DELETE FROM construction_materials WHERE construction_id=?', [c.id]);
    }
    runSql('DELETE FROM invoices WHERE tenant_id=?', [id]);
    runSql('DELETE FROM constructions WHERE tenant_id=?', [id]);
    runSql('DELETE FROM materials WHERE tenant_id=?', [id]);
    runSql('DELETE FROM properties WHERE tenant_id=?', [id]);
    runSql('DELETE FROM users WHERE tenant_id=?', [id]);
    runSql('DELETE FROM audit_log WHERE tenant_id=?', [id]);
    runSql('DELETE FROM tenants WHERE id=?', [id]);
    logAudit('delete', 'tenant', id, '');
  });

  // ── 監査ログ ──
  ipcMain.handle('audit:list', () => queryAll('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100'));

  // ── ユーザー管理 ──
  ipcMain.handle('users:list', () => queryAll('SELECT id, username, role, created_at FROM users ORDER BY id'));
  ipcMain.handle('users:create', (_e, data: any) => {
    // ソルト付きハッシュ（SHA-256 + ランダムソルト）
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(salt + data.password).digest('hex');
    const saltedHash = `${salt}:${hash}`;
    const id = runSql('INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, ?)',
      [data.username, saltedHash, data.role || 'user', getCurrentTenant()]);
    logAudit('create', 'user', id, data.username);
    return id;
  });
  ipcMain.handle('users:delete', (_e, id: number) => {
    runSql('DELETE FROM users WHERE id=?', [id]);
    logAudit('delete', 'user', id, '');
  });

  // ── CSVエクスポート ──
  ipcMain.handle('export:constructions', async () => {
    const rows = queryAll(`SELECT c.title, p.name as property_name, c.construction_date, c.labor_cost, c.markup_rate,
      (SELECT COALESCE(SUM(cm.quantity*cm.unit_price),0) FROM construction_materials cm WHERE cm.construction_id=c.id) as mat_cost
      FROM constructions c LEFT JOIN properties p ON c.property_id=p.id ORDER BY c.id`);
    let csv = '\uFEFF施工名,物件名,施工日,材料費,人件費,原価,売価,粗利\n';
    rows.forEach((r: any) => {
      const mc = r.mat_cost||0, lc = r.labor_cost||0, cost = mc+lc;
      const sell = Math.ceil(cost*(r.markup_rate||1.3)), profit = sell-cost;
      csv += `"${r.title}","${r.property_name||''}","${r.construction_date||''}",${mc},${lc},${cost},${sell},${profit}\n`;
    });
    const savePath = await dialog.showSaveDialog({ defaultPath: '施工データ.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!savePath.canceled && savePath.filePath) { fs.writeFileSync(savePath.filePath, csv, 'utf-8'); shell.openPath(savePath.filePath); }
  });
  ipcMain.handle('export:invoices', async () => {
    const rows = queryAll(`SELECT i.id, i.client_name, c.title, i.amount, i.tax_rate, i.issue_date, i.due_date, i.status
      FROM invoices i LEFT JOIN constructions c ON i.construction_id=c.id ORDER BY i.id`);
    let csv = '\uFEFF請求書No,請求先,施工名,金額(税抜),消費税,金額(税込),発行日,期限,ステータス\n';
    rows.forEach((r: any) => {
      const tax = Math.round((r.amount||0)*(r.tax_rate||0.1));
      csv += `INV-${String(r.id).padStart(4,'0')},"${r.client_name}","${r.title||''}",${r.amount||0},${tax},${(r.amount||0)+tax},"${r.issue_date}","${r.due_date||''}","${r.status}"\n`;
    });
    const savePath = await dialog.showSaveDialog({ defaultPath: '請求書データ.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!savePath.canceled && savePath.filePath) { fs.writeFileSync(savePath.filePath, csv, 'utf-8'); shell.openPath(savePath.filePath); }
  });
  ipcMain.handle('export:materials', async () => {
    const rows = queryAll('SELECT * FROM materials ORDER BY category, name');
    let csv = '\uFEFFカテゴリ,材料名,単位,単価,メモ\n';
    rows.forEach((r: any) => { csv += `"${r.category}","${r.name}","${r.unit}",${r.unit_price},"${r.notes||''}"\n`; });
    const savePath = await dialog.showSaveDialog({ defaultPath: '材料マスタ.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!savePath.canceled && savePath.filePath) { fs.writeFileSync(savePath.filePath, csv, 'utf-8'); shell.openPath(savePath.filePath); }
  });

  // ── 施工の複製 ──
  ipcMain.handle('constructions:duplicate', (_e, id: number) => {
    const c = queryOne('SELECT * FROM constructions WHERE id=?', [id]);
    if (!c) return null;
    const newId = runSql('INSERT INTO constructions (property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id, status) VALUES (?,?,?,?,?,?,?,?)',
      [c.property_id, c.title + '（コピー）', new Date().toISOString().split('T')[0], c.labor_cost, c.markup_rate, c.notes, getCurrentTenant(), '見積中']);
    const mats = queryAll('SELECT * FROM construction_materials WHERE construction_id=?', [id]);
    for (const m of mats) {
      runSql('INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (?,?,?,?)', [newId, m.material_id, m.quantity, m.unit_price]);
    }
    logAudit('create', 'construction', newId, `複製元:${id} ${c.title}`);
    return newId;
  });

  // ── 材料マスタCSVインポート ──
  ipcMain.handle('materials:importCSV', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (result.canceled || !result.filePaths.length) return 0;
    const csv = fs.readFileSync(result.filePaths[0], 'utf-8');
    const lines = csv.split('\n').filter(l => l.trim());
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].match(/(".*?"|[^,]+)/g)?.map(c => c.replace(/^"|"$/g, '').trim()) || [];
      if (cols.length < 4) continue;
      const [category, name, unit, priceStr] = cols;
      const price = parseFloat(priceStr) || 0;
      if (!name) continue;
      runSql('INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?,?,?,?,?,?)',
        [name, category || 'その他', unit || '式', price, cols[4] || 'CSVインポート', getCurrentTenant()]);
      count++;
    }
    return count;
  });

  // ── バックアップ ──
  ipcMain.handle('backup:run', () => runBackup(dbPath));
  ipcMain.handle('backup:list', () => {
    const dir = path.join(path.dirname(dbPath), 'backups');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f: string) => f.endsWith('.db')).sort().reverse();
  });

  // ── 画像ファイル保存（Base64→ファイル）──
  ipcMain.handle('dialog:selectImage', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '画像', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).slice(1);
    const fileName = `img_${Date.now()}.${ext}`;
    const imagesDir = getImagesDir(dbPath);
    const dest = path.join(imagesDir, fileName);
    fs.copyFileSync(filePath, dest);
    // Base64も返す（互換性のため）
    const buffer = fs.readFileSync(dest);
    const mimeExt = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mimeExt};base64,${buffer.toString('base64')}`;
  });

  // ── 外部公開トンネル ──
  let activeTunnel: any = null;

  ipcMain.handle('tunnel:start', async () => {
    if (activeTunnel) return activeTunnel.url;
    const localtunnel = require('localtunnel');
    const tunnel = await localtunnel({ port: 3456 });
    activeTunnel = tunnel;
    tunnel.on('close', () => { activeTunnel = null; });
    return tunnel.url;
  });

  ipcMain.handle('tunnel:stop', async () => {
    if (activeTunnel) { activeTunnel.close(); activeTunnel = null; }
  });

  ipcMain.handle('tunnel:status', () => {
    return activeTunnel ? { active: true, url: activeTunnel.url } : { active: false, url: null };
  });

  // ── クレジット（AIストック）管理 ──
  ipcMain.handle('credits:get', () => getCredits());
  ipcMain.handle('credits:usage', () => getMonthlyUsage());
  ipcMain.handle('credits:add', (_e, amount: number, reason: string) => {
    addCredits(amount, reason || '管理者追加');
    return getMonthlyUsage();
  });
  ipcMain.handle('credits:log', () => {
    return queryAll('SELECT * FROM credit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT 100', [getCurrentTenant()]);
  });

  // ── プラン管理 ──
  ipcMain.handle('plan:get', () => {
    const plan = getTenantPlan();
    const usage = getMonthlyUsage();
    const planDef = PLANS[plan.plan];
    return { ...plan, ...usage, planName: planDef?.name || plan.plan, price: planDef?.price || 0, description: planDef?.description || '' };
  });
  ipcMain.handle('plan:set', (_e, planKey: string, tenantId?: number) => {
    setTenantPlan(planKey, tenantId);
    return getTenantPlan(tenantId);
  });
  // ── 見積ログ ──
  ipcMain.handle('estimates:log', () => {
    return queryAll(
      'SELECT id, work_type, ai_total, ai_material_cost, ai_labor_cost, ai_markup_rate, construction_id, created_at, ai_json, generated_image, uploaded_image FROM estimate_log WHERE tenant_id = ? ORDER BY id DESC LIMIT 50',
      [getCurrentTenant()]
    );
  });

  ipcMain.handle('estimates:saveImage', (_e, data: { constructionId?: number; logId?: number; imageData: string }) => {
    if (data.logId) {
      runSql('UPDATE estimate_log SET generated_image = ? WHERE id = ?', [data.imageData, data.logId]);
    } else if (data.constructionId) {
      runSql('UPDATE estimate_log SET generated_image = ? WHERE construction_id = ? AND tenant_id = ?',
        [data.imageData, data.constructionId, getCurrentTenant()]);
    } else {
      // 最新のレコードを更新
      runSql('UPDATE estimate_log SET generated_image = ? WHERE id = (SELECT MAX(id) FROM estimate_log WHERE tenant_id = ?)',
        [data.imageData, getCurrentTenant()]);
    }
  });

  ipcMain.handle('plan:list', () => PLANS);
  ipcMain.handle('plan:costs', () => CREDIT_COSTS);

  // ── プラン申請・請求書 ──
  ipcMain.handle('plan:request', async (_e, planKey: string) => {
    const reqId = createPlanRequest(planKey);
    if (!reqId) throw new Error('無効なプランです');
    const req = queryOne('SELECT * FROM plan_requests WHERE id = ?', [reqId]);
    const tenant = queryOne('SELECT name FROM tenants WHERE id = ?', [getCurrentTenant()]);
    const planDef = PLANS[planKey];

    // オーナーにメール通知
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: 'mitsuakinakano0215@gmail.com', pass: 'cmlz usad gycg sbem' },
      });
      await transporter.sendMail({
        from: '建築ブースト <mitsuakinakano0215@gmail.com>',
        to: 'mitsuakinakano0215@gmail.com',
        subject: `【建築ブースト】プラン変更申請 - ${tenant?.name || 'テナント'}`,
        text: [
          `テナント「${tenant?.name}」からプラン変更申請がありました。`,
          '',
          `■ 現在のプラン: ${PLANS[req.current_plan]?.name || req.current_plan}`,
          `■ 申請プラン: ${planDef?.name}`,
          `■ 月額料金: ¥${planDef?.price.toLocaleString()}（税込）`,
          `■ 請求番号: ${req.invoice_number}`,
          `■ 申請日時: ${new Date().toLocaleString('ja-JP')}`,
          '',
          '入金確認後、管理画面から承認してください。',
          '',
          '---',
          '建築ブースト 自動通知',
        ].join('\n'),
      });
    } catch (e) { console.error('Plan request email failed:', e); }

    return req;
  });

  ipcMain.handle('plan:requestList', () => listPlanRequests());
  ipcMain.handle('plan:allRequests', () => listAllPlanRequests());

  ipcMain.handle('plan:approve', (_e, requestId: number) => {
    const result = approvePlanRequest(requestId);
    if (!result) throw new Error('承認できません');
    return { success: true };
  });

  ipcMain.handle('plan:reject', (_e, requestId: number) => {
    rejectPlanRequest(requestId);
    return { success: true };
  });

  ipcMain.handle('plan:cancel', (_e, requestId: number) => {
    const result = cancelPlanRequest(requestId);
    if (!result) throw new Error('キャンセルできません');
    return { success: true };
  });

  // プラン請求書PDF生成
  ipcMain.handle('plan:generateInvoice', async (_e, requestId: number) => {
    const req = queryOne('SELECT pr.*, t.name as tenant_name FROM plan_requests pr JOIN tenants t ON t.id = pr.tenant_id WHERE pr.id = ?', [requestId]);
    if (!req) throw new Error('申請が見つかりません');
    const planDef = PLANS[req.requested_plan];
    const currentPlanDef = PLANS[req.current_plan];
    const isUpgrade = currentPlanDef && planDef && planDef.price > currentPlanDef.price;
    const cfg = loadApiConfig();
    const taxRate = 0.1;
    const priceExTax = Math.round(req.price / (1 + taxRate));
    const taxAmount = req.price - priceExTax;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Yu Gothic', 'Meiryo', sans-serif; padding: 40px 35px; color: #333; font-size: 12px; }
  h1 { text-align:center; font-size:26px; letter-spacing:10px; margin-bottom:24px; }
  .header { display:flex; justify-content:space-between; margin-bottom:24px; }
  .client { font-size:16px; font-weight:bold; border-bottom:2px solid #333; padding-bottom:4px; }
  table { width:100%; border-collapse:collapse; margin:16px 0; }
  th { background:#2c3e50; color:#fff; padding:8px 12px; text-align:left; font-size:11px; }
  td { border-bottom:1px solid #ddd; padding:8px 12px; }
  .total-row { font-weight:bold; font-size:14px; background:#f8f9fa; }
  .bank-info { background:#fffbf0; border:2px solid #e67e22; border-radius:8px; padding:16px; margin:20px 0; }
</style>
</head><body>
<h1>請　求　書</h1>
<div class="header">
  <div>
    <div class="client">${escapeHtml(req.tenant_name)} 御中</div>
    <div style="margin-top:12px; font-size:11px; color:#666">
      請求番号: ${escapeHtml(req.invoice_number)}<br>
      発行日: ${new Date().toLocaleDateString('ja-JP')}<br>
      お支払期限: ${new Date(Date.now() + 14 * 86400000).toLocaleDateString('ja-JP')}
    </div>
  </div>
  <div style="text-align:right">
    <div style="font-size:14px; font-weight:bold">${escapeHtml(cfg.companyName || '建築ブースト')}</div>
    <div style="font-size:11px; color:#666; margin-top:4px">
      ${escapeHtml(cfg.companyAddress || '')}<br>
      ${cfg.companyTel ? 'TEL: ' + escapeHtml(cfg.companyTel) : ''}<br>
      ${cfg.invoiceNumber ? 'インボイス番号: ' + escapeHtml(cfg.invoiceNumber) : ''}
    </div>
    ${cfg.companySeal ? '<img src="' + cfg.companySeal + '" style="max-width:80px; max-height:80px; margin-top:8px">' : ''}
  </div>
</div>

<div style="text-align:center; font-size:20px; font-weight:bold; margin:20px 0; padding:12px; background:#f0f7ff; border-radius:8px;">
  ご請求金額: ¥${req.price.toLocaleString()}（税込）
</div>

<table>
  <thead><tr><th>No.</th><th>内容</th><th style="text-align:center">数量</th><th style="text-align:right">単価</th><th style="text-align:right">金額</th></tr></thead>
  <tbody>
    <tr>
      <td style="text-align:center">1</td>
      <td>建築ブースト ${escapeHtml(planDef?.name || '')}プラン 月額利用料<br><span style="font-size:10px; color:#888">AIストック ${planDef?.monthlyLimit}回/月</span></td>
      <td style="text-align:center">1</td>
      <td style="text-align:right">¥${Math.round((planDef?.price || 0) / (1 + taxRate)).toLocaleString()}</td>
      <td style="text-align:right">¥${Math.round((planDef?.price || 0) / (1 + taxRate)).toLocaleString()}</td>
    </tr>
    ${isUpgrade ? `<tr>
      <td style="text-align:center">2</td>
      <td>現プラン（${escapeHtml(currentPlanDef?.name || '')}）差額控除</td>
      <td style="text-align:center">1</td>
      <td style="text-align:right">-¥${Math.round((currentPlanDef?.price || 0) / (1 + taxRate)).toLocaleString()}</td>
      <td style="text-align:right">-¥${Math.round((currentPlanDef?.price || 0) / (1 + taxRate)).toLocaleString()}</td>
    </tr>` : ''}
    <tr><td colspan="4" style="text-align:right">小計</td><td style="text-align:right">¥${priceExTax.toLocaleString()}</td></tr>
    <tr><td colspan="4" style="text-align:right">消費税（10%）</td><td style="text-align:right">¥${taxAmount.toLocaleString()}</td></tr>
    <tr class="total-row"><td colspan="4" style="text-align:right">合計（税込）</td><td style="text-align:right">¥${req.price.toLocaleString()}</td></tr>
  </tbody>
</table>

<div class="bank-info">
  <div style="font-weight:bold; margin-bottom:8px; font-size:14px">お振込先</div>
    <div>シティ銀行 011</div>
    <div>普通 0402025</div>
    <div>口座名義: ユ）ナカノコウムテン</div>
  <div style="margin-top:8px; font-size:11px; color:#888">
    ※ 振込手数料はお客様ご負担でお願いいたします<br>
    ※ 入金確認後、プランが有効化されます
  </div>
</div>

<div style="text-align:center; margin-top:24px; font-size:11px; color:#aaa">
  建築ブースト — AI建築見積・業務自動化システム
</div>
</body></html>`;

    const pdfWin = new BrowserWindow({ show: false, width: 794, height: 1123 });
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 500));
    const pdfBuf = await pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    pdfWin.close();

    const result = await dialog.showSaveDialog({
      defaultPath: `プラン請求書_${req.invoice_number}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    fs.writeFileSync(result.filePath, pdfBuf);
    shell.openPath(result.filePath);
    return { saved: true, path: result.filePath };
  });

  // ── API キー・DB設定管理 ──
  ipcMain.handle('config:load', () => {
    const cfg = loadApiConfig();
    // フロントにはAPIキーを返さない（トライアル版保護）
    const { anthropicKey, openaiKey, ...safe } = cfg;
    return safe;
  });
  ipcMain.handle('config:save', (_e, cfg: any) => {
    saveApiConfig(cfg);
    // テナントの連絡先も更新
    const tid = getCurrentTenant();
    if (tid > 1) {
      runSql('UPDATE tenants SET contact_company = ?, contact_tel = ?, contact_email = ? WHERE id = ?',
        [cfg.companyName || null, cfg.companyTel || null, cfg.contactEmail || null, tid]);
    }
  });

  ipcMain.handle('config:selectDbPath', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '共有データベースフォルダを選択',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('config:setDbPath', async (_e, folderPath: string) => {
    const newDbPath = path.join(folderPath, 'kentiku.db');
    // 既存DBがなければ現在のDBをコピー
    if (!fs.existsSync(newDbPath)) {
      const currentConfig = loadApiConfig();
      const currentDbPath = currentConfig.dbPath || path.join(app.getPath('userData'), 'kentiku.db');
      if (fs.existsSync(currentDbPath)) {
        fs.copyFileSync(currentDbPath, newDbPath);
      }
    }
    const cfg = loadApiConfig();
    cfg.dbPath = newDbPath;
    saveApiConfig(cfg);
    return newDbPath;
  });

  // ── 見積書PDF ──
  ipcMain.handle('estimates:generatePDF', async (_e, data: any) => {
    const { invoice, materials } = data;
    const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();
    let materialTotal = 0;
    let rows = '';
    let num = 1;
    if (materials?.length) {
      materials.forEach((m: any) => {
        const name = escapeHtml(m.material_name || m.name || '（項目名なし）');
        const unit = escapeHtml(m.unit || '式');
        const qty = m.quantity || 1;
        const price = m.unit_price || 0;
        const sub = Math.round(qty * price);
        materialTotal += sub;
        rows += `<tr><td style="text-align:center;color:#888">${num++}</td><td>${name}</td><td style="text-align:center">${qty}</td><td style="text-align:center">${unit}</td><td style="text-align:right">${fmt(price)}</td><td style="text-align:right">${fmt(sub)}</td></tr>`;
      });
    }
    const laborCost = invoice.labor_cost || 0;
    if (laborCost > 0) {
      rows += `<tr style="border-top:2px solid #ccc"><td style="text-align:center;color:#888">${num++}</td><td><strong>施工費</strong></td><td style="text-align:center">1</td><td style="text-align:center">式</td><td style="text-align:right">${fmt(laborCost)}</td><td style="text-align:right">${fmt(laborCost)}</td></tr>`;
    }
    const costTotal = materialTotal + laborCost;
    const taxExcluded = invoice.amount || 0;
    const managementFee = taxExcluded - costTotal;
    if (managementFee > 0) {
      rows += `<tr><td style="text-align:center;color:#888">${num++}</td><td><strong>設計・工事管理費</strong></td><td style="text-align:center">1</td><td style="text-align:center">式</td><td style="text-align:right">${fmt(managementFee)}</td><td style="text-align:right">${fmt(managementFee)}</td></tr>`;
    }
    const taxRate = invoice.tax_rate || 0.1;
    const taxAmount = Math.round(taxExcluded * taxRate);
    const totalWithTax = taxExcluded + taxAmount;
    const title = escapeHtml(invoice.construction_title || '（未設定）');
    const cfg = loadApiConfig();

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Yu Gothic','Meiryo',sans-serif;padding:40px 35px;color:#333;font-size:11px}
h1{text-align:center;font-size:26px;letter-spacing:10px;margin-bottom:24px}
.header{display:flex;justify-content:space-between;margin-bottom:16px}.client{font-size:16px;font-weight:bold;border-bottom:2px solid #333;padding-bottom:4px}
.meta{text-align:right;font-size:10px;line-height:1.8}.total-box{background:#f0f0f0;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;margin:16px 0;border-radius:4px}
table{width:100%;border-collapse:collapse;margin:12px 0}th{background:#2e4057;color:#fff;padding:6px 8px;text-align:left;font-size:10px}td{padding:5px 8px;border-bottom:1px solid #eee;font-size:10px}
.summary{margin-top:8px;width:300px;margin-left:auto}.summary-row{display:flex;justify-content:space-between;padding:3px 8px;font-size:11px}
.summary-row.sub{border-top:1px solid #ccc;padding-top:6px;margin-top:4px}.summary-row.total{border-top:2px solid #333;font-size:14px;font-weight:bold;padding-top:6px;margin-top:4px}
.validity{text-align:center;margin:8px 0;padding:8px;background:#fff8e1;border-radius:4px;font-size:11px;color:#e67e22}</style>
</head><body>
<h1>御 見 積 書</h1>
<div class="header"><div><div class="client">${escapeHtml(invoice.client_name)} 御中</div>${invoice.client_address ? `<div style="margin-top:3px;font-size:10px">${escapeHtml(invoice.client_address)}</div>` : ''}</div>
<div class="meta">No. EST-${String(invoice.id).padStart(4, '0')}<br>発行日: ${invoice.issue_date}
${cfg.companyName ? `<div style="margin-top:10px;border-top:1px solid #ccc;padding-top:6px"><div style="display:flex;align-items:flex-start;gap:8px"><div style="flex:1">${cfg.companyLogo ? `<img src="${cfg.companyLogo}" style="max-width:80px;max-height:30px;margin-bottom:4px" /><br>` : ''}<strong>${escapeHtml(cfg.companyName)}</strong><br><span style="font-size:9px">${escapeHtml(cfg.companyAddress || '')}${cfg.companyTel ? '<br>TEL: ' + escapeHtml(cfg.companyTel) : ''}</span></div>${cfg.companySeal ? `<img src="${cfg.companySeal}" style="width:60px;height:60px;object-fit:contain;opacity:0.85" />` : ''}</div></div>` : ''}</div></div>
<div class="validity">有効期限: 発行日より30日間</div>
<div style="margin:12px 0;font-size:12px">件名: ${title}${invoice.property_name ? ' / ' + escapeHtml(invoice.property_name) : ''}</div>
<div class="total-box"><span style="font-size:13px">お見積金額（税込）</span><span style="font-size:22px;font-weight:bold">${fmt(totalWithTax)}</span></div>
<table><thead><tr><th style="text-align:center;width:30px">No</th><th>項目</th><th style="text-align:center;width:50px">数量</th><th style="text-align:center;width:40px">単位</th><th style="text-align:right;width:80px">単価</th><th style="text-align:right;width:90px">金額</th></tr></thead><tbody>${rows}</tbody></table>
<div class="summary"><div class="summary-row sub"><span>小計（税抜）</span><span>${fmt(taxExcluded)}</span></div><div class="summary-row"><span>消費税（${Math.round(taxRate * 100)}%）</span><span>${fmt(taxAmount)}</span></div><div class="summary-row total"><span>お見積金額（税込）</span><span>${fmt(totalWithTax)}</span></div></div>
${invoice.notes ? `<div style="margin-top:20px;padding:10px;background:#fafafa;border:1px solid #ddd;border-radius:4px;font-size:10px;white-space:pre-wrap"><strong>備考</strong><br>${escapeHtml(invoice.notes)}</div>` : ''}
</body></html>`;

    const tmpHtml = path.join(app.getPath('temp'), `estimate_${Date.now()}.html`);
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(tmpHtml, Buffer.concat([bom, Buffer.from(html, 'utf-8')]));
    const pdfWin = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { defaultEncoding: 'utf-8' } });
    await pdfWin.loadURL(`file:///${tmpHtml.replace(/\\/g, '/')}`);
    await new Promise<void>(r => setTimeout(r, 1000));
    const pdf = await pdfWin.webContents.printToPDF({ printBackground: true, margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } });
    pdfWin.close();
    try { fs.unlinkSync(tmpHtml); } catch(_) {}
    const savePath = await dialog.showSaveDialog({ defaultPath: `見積書_${invoice.client_name}_${invoice.issue_date}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!savePath.canceled && savePath.filePath) { fs.writeFileSync(savePath.filePath, pdf); shell.openPath(savePath.filePath); }
  });

  // ── 工事写真管理 ──
  ipcMain.handle('constructionPhotos:list', (_e, cid: number) => {
    return queryAll('SELECT * FROM construction_photos WHERE construction_id = ? ORDER BY label, id', [cid]);
  });
  ipcMain.handle('constructionPhotos:add', (_e, data: any) => {
    return runSql('INSERT INTO construction_photos (construction_id, photo_data, label, notes) VALUES (?, ?, ?, ?)',
      [data.constructionId, data.photoData, data.label || 'before', data.notes || null]);
  });
  ipcMain.handle('constructionPhotos:delete', (_e, id: number) => {
    runSql('DELETE FROM construction_photos WHERE id = ?', [id]);
  });

  // ── 紙の見積書/請求書をAI-OCRで電子化 ──
  ipcMain.handle('ai:ocrInvoice', async (_e, imageBase64: string) => {
    // クレジットチェック（OCR = 1ストック）
    const ocrCreditResult = useCredits(1, 'OCR取込');
    if (!ocrCreditResult.success) {
      if (ocrCreditResult.limitReached) await sendLimitNotification('OCR取込');
      throw new Error('ERROR: 今月のAIストックの上限に達しました。管理者に連絡済みです。追加ストックについてはご連絡をお待ちください。');
    }
    const config = loadApiConfig();
    if (!config.anthropicKey) throw new Error('AI機能の初期化に失敗しました。サポートにお問い合わせください。');

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: config.anthropicKey });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg', data: imageBase64.replace(/^data:image\/\w+;base64,/, '') },
          },
          {
            type: 'text',
            text: `この画像は建築工事の見積書または請求書です。内容を正確に読み取って以下のJSON形式で返してください。
手書きでも印刷でもOKです。読み取れない部分はnullにしてください。

\`\`\`json
{
  "documentType": "見積書 or 請求書",
  "clientName": "請求先/宛先の名前",
  "clientAddress": "請求先の住所（あれば）",
  "issuerName": "発行元の会社名",
  "issuerAddress": "発行元の住所",
  "issueDate": "発行日 YYYY-MM-DD",
  "dueDate": "支払期限 YYYY-MM-DD（あれば）",
  "title": "件名/工事名",
  "subtotal": 小計（税抜、数値）,
  "taxRate": 消費税率（数値、例: 0.1）,
  "taxAmount": 消費税額（数値）,
  "total": 合計（税込、数値）,
  "items": [
    {
      "name": "項目名",
      "quantity": 数量（数値）,
      "unit": "単位",
      "unitPrice": 単価（数値）,
      "amount": 金額（数値）,
      "category": "推定カテゴリ（木材/基礎/屋根/外壁/内装/設備/電気/水道/解体/耐震/仮設/外構/造園/その他）"
    }
  ],
  "notes": "備考欄の内容"
}
\`\`\`

金額は数値のみ（カンマや円記号は除去）。日付はYYYY-MM-DD形式に変換。`
          }
        ]
      }]
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('読み取りに失敗しました');
    return JSON.parse(jsonMatch[1] || jsonMatch[0]);
  });

  // ── OCR結果をDBに一括登録 ──
  ipcMain.handle('ai:importOcrResult', (_e, data: any) => {
    const today = new Date().toISOString().split('T')[0];
    const tid = getCurrentTenant();

    // 物件登録
    const propertyId = runSql('INSERT INTO properties (name, address, notes, tenant_id) VALUES (?,?,?,?)',
      [data.title || '読み取り書類', data.clientAddress || null, `OCR取り込み: ${data.documentType}\n発行元: ${data.issuerName || ''}`, tid]);

    // 施工登録
    let laborCost = 0;
    let materialTotal = 0;
    if (data.items) {
      for (const item of data.items) {
        const amt = item.amount || (item.quantity || 1) * (item.unitPrice || 0);
        if (item.name && (item.name.includes('人件費') || item.name.includes('施工費') || item.name.includes('労務費'))) {
          laborCost += amt;
        } else {
          materialTotal += amt;
        }
      }
    }
    const totalCost = materialTotal + laborCost;
    const sellingPrice = data.subtotal || data.total || totalCost;
    const markupRate = totalCost > 0 ? Math.round((sellingPrice / totalCost) * 100) / 100 : 1.3;

    const conId = runSql('INSERT INTO constructions (property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id) VALUES (?,?,?,?,?,?,?)',
      [propertyId, data.title || 'OCR取り込み工事', data.issueDate || today, laborCost, markupRate, `OCR取り込み\n発行元: ${data.issuerName || ''}`, tid]);

    // 材料明細
    if (data.items) {
      for (const item of data.items) {
        if (item.name && (item.name.includes('人件費') || item.name.includes('施工費') || item.name.includes('労務費'))) continue;
        const matId = runSql('INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?,?,?,?,?,?)',
          [item.name || '（品名不明）', item.category || 'その他', item.unit || '式', item.unitPrice || item.amount || 0, 'OCR取り込み', tid]);
        runSql('INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (?,?,?,?)',
          [conId, matId, item.quantity || 1, item.unitPrice || item.amount || 0]);
      }
    }

    // 請求書
    const dueDate = data.dueDate || null;
    const invId = runSql('INSERT INTO invoices (construction_id, client_name, client_address, issue_date, due_date, amount, tax_rate, notes, status, tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [conId, data.clientName || '（読み取り）', data.clientAddress || null, data.issueDate || today, dueDate, sellingPrice, data.taxRate || 0.1, `OCR取り込み\n${data.notes || ''}`, 'draft', tid]);

    logAudit('create', 'ocr_import', conId, `${data.documentType}: ${data.title}`);
    return { propertyId, constructionId: conId, invoiceId: invId, itemCount: data.items?.length || 0 };
  });

  // ── AI画像解析 → 類似工事検索 → 見積もり ──
  ipcMain.handle('ai:analyzeImage', async (_e, data: any) => {
    const { imageBase64, beforeImage, afterImage, comment, location } = typeof data === 'string' ? { imageBase64: data, beforeImage: null, afterImage: null, comment: '', location: '' } : data;
    const isBeforeAfter = beforeImage && afterImage;

    // クレジット消費量
    const hasCommentInput = comment && comment.trim().length > 0;
    const hasImageInput = (imageBase64 && imageBase64.length > 0) || isBeforeAfter;
    const creditCost = (hasImageInput && hasCommentInput) ? 2 : 1;
    const opName = isBeforeAfter ? 'ビフォーアフター見積' : hasImageInput && hasCommentInput ? '写真+コメント見積' : hasImageInput ? 'AI見積' : 'テキスト見積';
    // クレジットチェック
    const creditResult = useCredits(creditCost, opName);
    if (!creditResult.success) {
      if (creditResult.limitReached) {
        await sendLimitNotification(opName);
      }
      throw new Error('ERROR: 今月のAIストックの上限に達しました。管理者に連絡済みです。追加ストックについてはご連絡をお待ちください。');
    }

    const config = loadApiConfig();
    if (!config.anthropicKey) throw new Error('AI機能の初期化に失敗しました。サポートにお問い合わせください。設定画面から入力してください。');

    // DBの既存施工・材料データを取得
    const constructions = queryAll(`
      SELECT c.id, c.title, c.labor_cost, c.markup_rate, c.notes, p.name as property_name,
        (SELECT SUM(cm.quantity * cm.unit_price) FROM construction_materials cm WHERE cm.construction_id = c.id) as material_cost
      FROM constructions c LEFT JOIN properties p ON c.property_id = p.id
    `);
    const materialCategories = queryAll('SELECT DISTINCT category FROM materials ORDER BY category');

    // 1万件の実績を工事タイプ別に統計集約してAIに渡す
    const statsRows = queryAll(`
      SELECT c.notes as type_tag,
        COUNT(*) as cnt,
        ROUND(AVG(cm_total)) as avg_mat,
        MIN(cm_total) as min_mat, MAX(cm_total) as max_mat,
        ROUND(AVG(c.labor_cost)) as avg_labor,
        ROUND(AVG(c.markup_rate * 100)) as avg_markup
      FROM constructions c
      LEFT JOIN (SELECT construction_id, SUM(quantity * unit_price) as cm_total FROM construction_materials GROUP BY construction_id) cm ON cm.construction_id = c.id
      GROUP BY SUBSTR(c.notes, 1, INSTR(c.notes || '|', CHAR(10)) - 1)
      HAVING cnt >= 3
      ORDER BY cnt DESC
      LIMIT 30
    `);
    const pastWorkSummary = statsRows.map((s: any) => {
      const tag = (s.type_tag || '').split('\n')[0];
      return `- ${tag}: ${s.cnt}件実績 | 材料費 平均${Math.round(s.avg_mat||0).toLocaleString()}円（${Math.round(s.min_mat||0).toLocaleString()}〜${Math.round(s.max_mat||0).toLocaleString()}）| 人件費 平均${Math.round(s.avg_labor||0).toLocaleString()}円 | 掛率平均${s.avg_markup||130}%`;
    }).join('\n');
    const totalCount = queryOne('SELECT COUNT(*) as c FROM constructions')?.c || 0;

    const categories = materialCategories.map((c: any) => c.category).join(', ');

    // AI見積 vs 実際の編集結果のフィードバックデータを生成（学習ループ: 自動蓄積された実績値を使用）
    const feedbackRows = queryAll(`
      SELECT el.work_type,
        el.ai_material_cost, el.ai_labor_cost, el.ai_total, el.ai_markup_rate,
        COALESCE(el.actual_material_cost, (SELECT SUM(cm.quantity * cm.unit_price) FROM construction_materials cm WHERE cm.construction_id = el.construction_id), 0) as actual_material_cost,
        COALESCE(el.actual_labor_cost, c.labor_cost) as actual_labor_cost,
        COALESCE(el.actual_markup_rate, c.markup_rate) as actual_markup_rate,
        COALESCE(el.actual_selling_price, c.fixed_selling_price) as actual_selling_price,
        el.ai_json, el.feedback_at
      FROM estimate_log el
      LEFT JOIN constructions c ON c.id = el.construction_id
      WHERE el.tenant_id = ? AND el.construction_id IS NOT NULL
      ORDER BY COALESCE(el.feedback_at, el.created_at) DESC
      LIMIT 50
    `, [getCurrentTenant()]);

    let feedbackSummary = '';
    if (feedbackRows.length > 0) {
      const corrections: string[] = [];
      for (const fb of feedbackRows) {
        const matDiff = fb.actual_material_cost - fb.ai_material_cost;
        const laborDiff = fb.actual_labor_cost - fb.ai_labor_cost;
        const matPct = fb.ai_material_cost > 0 ? Math.round((matDiff / fb.ai_material_cost) * 100) : 0;
        const laborPct = fb.ai_labor_cost > 0 ? Math.round((laborDiff / fb.ai_labor_cost) * 100) : 0;
        const totalDiff = (fb.actual_selling_price || 0) - (fb.ai_total || 0);
        const totalPct = fb.ai_total > 0 ? Math.round((totalDiff / fb.ai_total) * 100) : 0;

        // 5%以上の差分がある場合フィードバック
        if (Math.abs(matPct) >= 5 || Math.abs(laborPct) >= 5 || Math.abs(totalPct) >= 5) {
          const parts: string[] = [`${fb.work_type}`];
          if (Math.abs(matPct) >= 5) parts.push(`材料費: AI${fb.ai_material_cost.toLocaleString()}円→修正後${fb.actual_material_cost.toLocaleString()}円(${matDiff > 0 ? '+' : ''}${matPct}%)`);
          if (Math.abs(laborPct) >= 5) parts.push(`人件費: AI${fb.ai_labor_cost.toLocaleString()}円→修正後${fb.actual_labor_cost.toLocaleString()}円(${laborDiff > 0 ? '+' : ''}${laborPct}%)`);
          if (Math.abs(totalPct) >= 5) parts.push(`売価: AI${(fb.ai_total||0).toLocaleString()}円→修正後${(fb.actual_selling_price||0).toLocaleString()}円(${totalDiff > 0 ? '+' : ''}${totalPct}%)`);
          if (fb.actual_markup_rate !== fb.ai_markup_rate) parts.push(`掛率: AI${fb.ai_markup_rate}→実際${fb.actual_markup_rate}`);

          // AI見積のbreakdownから削除・追加された項目を検出
          try {
            const aiResult = JSON.parse(fb.ai_json);
            const aiItems = (aiResult.breakdown || []).map((b: any) => b.item);
            const actualMats = queryAll(
              `SELECT m.name FROM construction_materials cm JOIN materials m ON m.id = cm.material_id WHERE cm.construction_id = (SELECT construction_id FROM estimate_log WHERE ai_json = ? LIMIT 1)`,
              [fb.ai_json]
            ).map((m: any) => m.name);
            const added = actualMats.filter((n: string) => !aiItems.some((ai: string) => n.includes(ai) || ai.includes(n)));
            const removed = aiItems.filter((ai: string) => !actualMats.some((n: string) => n.includes(ai) || ai.includes(n)));
            if (added.length > 0) parts.push(`追加された項目: ${added.slice(0, 3).join(', ')}`);
            if (removed.length > 0) parts.push(`削除された項目: ${removed.slice(0, 3).join(', ')}`);
          } catch (_) {}

          corrections.push(parts.join(' | '));
        }
      }
      if (corrections.length > 0) {
        feedbackSummary = `\n## ★★★ 過去のAI見積に対するユーザー修正履歴（最重要）★★★\n以下は過去のAI見積が実際にどう修正されたかの記録です。これはお客様が「正しい金額」として修正した実績データです。\n同じ種類の工事では、必ずこの修正傾向を反映して金額を調整してください。\n例: 過去に材料費が+20%修正されていたら、今回も同種の工事では材料費を20%高めに見積もること。\n${corrections.join('\n')}\n`;
      }
    }

    // 学習ループ: Supabase係数 + 旧統計を取得してプロンプトに追加
    let globalStats = '';
    try {
      const coefficients = await fetchCostCoefficients();
      globalStats = coefficientsToPromptText(coefficients);
    } catch (_) {}
    // フォールバック: 旧サーバーの統計も取得
    if (!globalStats) {
      try { globalStats = await fetchAggregatedStats(); } catch (_) {}
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: config.anthropicKey });

    const hasComment = comment && comment.trim().length > 0;
    const hasImage = imageBase64 && imageBase64.length > 0;
    const hasLocation = location && location.trim().length > 0;

    const userContent: any[] = [];
    if (isBeforeAfter) {
      userContent.push({
        type: 'text',
        text: '【Before写真（施工前）】以下の画像は施工前の状態です：',
      });
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: beforeImage.startsWith('data:image/png') ? 'image/png' : 'image/jpeg', data: beforeImage.replace(/^data:image\/\w+;base64,/, '') },
      });
      userContent.push({
        type: 'text',
        text: '【After写真（施工後）】以下の画像は施工後の状態です：',
      });
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: afterImage.startsWith('data:image/png') ? 'image/png' : 'image/jpeg', data: afterImage.replace(/^data:image\/\w+;base64,/, '') },
      });
    } else if (hasImage) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg', data: imageBase64.replace(/^data:image\/\w+;base64,/, '') },
      });
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0,
      system: isBeforeAfter
        ? 'あなたは大阪の建築見積もりの専門家です（実務経験20年以上）。ビフォー（施工前）とアフター（施工後）の2枚の写真を比較して、実施された工事内容を正確に判定してください。判定した工事内容に基づいて、同様の工事を行う場合の見積もりを算出してください。'
        : hasComment
        ? 'あなたは大阪の建築見積もりの専門家です（実務経験20年以上）。ユーザーがコメントで依頼した工事内容のみを見積もってください。依頼されていない工事は金額に絶対に含めないでください。追加提案はrecommendationsフィールドに書いてください。画像が図面（間取り図・平面図・立面図・設計図）の場合は、図面から部屋数・面積・構造を読み取り、工事規模の判定に活用してください。'
        : 'あなたは大阪の建築見積もりの専門家です（実務経験20年以上）。画像から必要な工事を判断して見積もりを出してください。画像が図面（間取り図・平面図・立面図・設計図）の場合は、図面から部屋数・面積・構造・寸法を読み取り、それに基づいて正確な見積もりを出してください。',
      messages: [{
        role: 'user',
        content: [...userContent, {
            type: 'text',
            text: `あなたは大阪の建築見積もりの専門家です（実務経験20年以上、図面読解も得意）。以下の膨大な相場データベースを参照して、${hasComment ? 'ユーザーが依頼した工事内容のみ' : hasImage ? 'この画像から判断した工事' : '依頼内容'}の正確な見積もりを出してください。

${isBeforeAfter ? `## ★ビフォーアフター解析ルール★
Before（施工前）とAfter（施工後）の2枚の画像が提供されています。
1. 2枚を比較して、何が変わったか（工事内容）を正確に判定しろ
2. 判定した工事内容に基づいて、同様の工事を新規で行う場合の見積もりを算出しろ
3. Before→Afterで変化した箇所のみを工事項目としてbreakdownに含めろ
4. descriptionには「Before: ○○ → After: ○○」の形式で変化内容を記載しろ
` : ''}
## 外構工事（エクステリア）の解析ルール
画像や依頼内容が以下に該当する場合、外構工事として見積もること：
- 駐車場（土間コンクリート・カーポート）、フェンス、塀、門扉、門柱
- ウッドデッキ、テラス、サンルーム、庭園、植栽、芝生、砂利敷き
- アプローチ（タイル・インターロッキング）、土留め、擁壁、排水工事
- 外構の写真（建物の外側・庭・駐車スペース等）が入力された場合
相場DBの「外構工事（エクステリア）相場データ」セクションを必ず参照し、m²単価やm単価から正確に算出すること。

## 画像が図面の場合の解析ルール
画像が間取り図・平面図・立面図・設計図の場合は以下を読み取ること：
- 部屋数・各部屋の用途（LDK、洋室、和室、水回り等）
- 延床面積・各階の面積（寸法表記があれば計算）
- 構造（木造・鉄骨・RC等）
- 階数
- 窓・ドアの数と種類
- 設備（キッチン・浴室・トイレ等の位置と数）
これらの情報をestimatedScaleに記載し、見積もりの根拠として活用すること。

## 建築工事 相場データベース（2025-2026年）
${COST_REFERENCE}

${hasLocation ? `## 現場場所\n${location}\n\n★重要: 上記の場所に基づいて「全国 地域別 工事費係数」テーブルから該当する都道府県の係数を適用し、金額を補正すること。大阪以外の場合は必ず地域係数を掛けて算出すること。\n` : ''}
${comment ? `## ユーザーが依頼した工事内容（★最重要★）\n${comment}\n` : ''}

## ★★★ 最重要ルール（絶対に守れ）★★★
1. breakdownには「ユーザーが依頼した工事内容」に直接関係する項目だけを入れろ
2. ユーザーが「キッチン交換」としか書いていないなら、キッチン関連の材料・施工費だけをbreakdownに入れろ。外壁・屋根・耐震・浴室など依頼されていない工事は絶対にbreakdownに入れるな
3. estimatedMaterialCost・estimatedLaborCost・estimatedTotalは依頼された工事のみの金額にしろ
4. 画像から追加で必要そうな工事を見つけた場合は「recommendations」に「○○も検討をおすすめします（参考: 約○万円）」と書け。金額計算には一切含めるな
5. コメントが空の場合のみ、画像から判断した全工事を見積もれ
6. ★必須★ breakdownには以下の3項目を必ず最後に含めろ（2025-2026年の建設業界情勢を反映した現実的な金額にすること。資材高騰・人件費上昇・働き方改革による人手不足を考慮）:
   - 「仮設工事」（足場・養生シート・仮設電気水道・仮設トイレ・交通誘導員等。直接工事費の8〜15%。最低でも5万円以上）
   - 「現場管理費」（現場監督人件費・安全管理・品質管理・書類作成・近隣対応等。直接工事費の10〜15%��最低でも8万円以上）
   - 「福利厚生費」（法定福利費・社会保険・雇用保険・退職金積立等。人件費の15〜20%。2024年問題で上昇中。最低でも3万円以上）

## 過去の施工実績（${totalCount}件のデータベースから集約）
${pastWorkSummary || 'まだ実績なし'}

※上記は${totalCount}件の実績データを工事タイプ別に集約した統計値です。この統計を見積もりの根拠として活用してください。
${feedbackSummary}
${globalStats}
## 登録済み材料カテゴリ
${categories}

## 粗利率ルール（必ず守ること）
- 原価500万円未満の工事: 粗利率30%（掛け率 約1.43）
- 原価500万〜1000万円: 粗利率25%（掛け率 約1.33）
- 原価1000万〜3000万円: 粗利率20%（掛け率 1.25）
- 原価3000万円以上: 粗利率15%（掛け率 約1.18）
- estimatedTotal は上記ルールに基づいて算出すること

## ★精度向上ルール（必ず守ること）★

### ルールA: 数量×単価で算出しろ（「一式」を極力避ける）
- 面積が分かる場合: m²数 × m²単価 で算出
- 人工が分かる場合: 人数 × 日数 × 日当 で算出
- 設備機器: 台数 × 単価 で算出
- 「一式」は本当に分解不可能な場合のみ使用

### ルールB: 面積・坪数ベースの逆算チェック
- 坪単価が相場データにある場合、推定面積×坪単価で妥当性を検証
- 例: キッチンリフォーム7m² → 相場DB「キッチン交換（対面L型）100〜200万円」と照合
- 実例データにある類似工事の金額レンジ内に収まっているか確認

### ルールC: 自己検証（出力前に必ず実行）
1. breakdownの全項目のcostを合計 → estimatedMaterialCost + estimatedLaborCost と大きくずれていないか確認
2. (estimatedMaterialCost + estimatedLaborCost) × markupRate ≒ estimatedTotal になっているか確認
3. 相場データベースの「実際の工事見積 実例データ」セクションの類似工事と比較し、金額が極端に乖離していないか確認

### ルールD: 見積金額は高めに出せ（最重要）
- 材料単価は相場の上位価格帯を採用しろ（安い方ではなく高い方）
- 人件費は熟練工の単価を基準にしろ
- 予備費・不測の事態に備えた余裕を含めろ
- 安く見積もって後から追加請求するより、最初から十分な金額を提示する方がお客様の信頼を得られる
- 迷ったら高い方の金額を採用しろ
4. もし乖離がある場合は金額を修正してから出力

### ルールD: breakdownの書き方
- 各項目に「数量×単価」の根拠をnoteに記載（例: "7m²×5,570円/m²" や "3人工×2日×25,000円"）
- 設備機器は型番相当のグレードをnoteに記載（例: "TOTO同等品中級グレード"）

## 出力形式（必ずこのJSON形式で返してください）
\`\`\`json
{
  "workType": "工事の種類（例: 耐震補強工事、新築工事、リフォーム工事、解体工事、外構工事、エクステリア工事）",
  "description": "ユーザーが依頼した工事内容の要約（100文字程度）",
  "estimatedScale": "推定規模（例: 木造2階建て 30坪、施工面積13.3m²等）",
  "similarWork": "過去の施工実績で最も似ている工事名（なければnull）",
  "estimatedMaterialCost": 推定材料費（数値、円。依頼された工事のみ）,
  "estimatedLaborCost": 推定人件費（数値、円。依頼された工事のみ）,
  "estimatedTotal": 推定売価（数値、円。依頼された工事のみ。粗利率ルールに基づく）,
  "markupRate": 適用した掛け率（数値、例: 1.43）,
  "profitRate": 適用した粗利率（数値、%、例: 30）,
  "confidence": "高/中/低",
  "breakdown": [
    {"item": "項目名", "cost": 金額, "note": "数量×単価の根拠（例: 13.3m²×5,570円）"}
  ],
  "recommendations": "画像から判断した追加提案（依頼内容以外で必要そうな工事や注意点。例:『外壁のひび割れも確認されます。外壁補修も検討をおすすめします（別途約○万円）』）",
  "imagePrompt": "この工事で施工した箇所の完成後の写真を生成するための英語プロンプト。内装工事の場合は室内インテリア写真風（自然光・暖かい木の質感・モダンジャパニーズ）、外構工事の場合はexterior/landscaping写真風（青空・ゴールデンアワー・植栽・コンクリート質感）で記述。施工した部分にフォーカスし、美しい仕上がりを表現。80語程度の英語で。"
}
\`\`\`

## 出力例（キッチンリフォームの場合）
breakdownの書き方例:
- {"item": "システムキッチン本体（ペニンシュラI型W2274）", "cost": 635000, "note": "中級グレード人工大理石トップ食洗機付"}
- {"item": "キッチン組立・設置", "cost": 128000, "note": "設備工2人×2日"}
- {"item": "給排水配管工事", "cost": 67000, "note": "給水13A+給湯15A+排水50A各5m切回し"}
- {"item": "電気工事", "cost": 22000, "note": "IH用200V配線+照明移設"}
- {"item": "床フローリング張替", "cost": 50000, "note": "7m²×7,100円/m²（材工共）"}

大阪エリアの2025-2026年相場で見積もってください。自己検証ルールCを必ず実行してから出力すること。`
          }]
      }]
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    console.log('AI response text:', text.substring(0, 500));
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI応答の解析に失敗しました: ' + text.substring(0, 200));
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    try {
      return JSON.parse(jsonStr);
    } catch (e: any) {
      throw new Error('JSON解析エラー: ' + e.message + ' / ' + jsonStr.substring(0, 200));
    }
  });

  // ── AI画像生成（完成イメージ — 元画像ベース編集）──
  ipcMain.handle('ai:generateImage', async (_e, data: any) => {
    // クレジットチェック（画像生成 = 3ストック）
    const imgCreditResult = useCredits(3, '画像生成');
    if (!imgCreditResult.success) {
      if (imgCreditResult.limitReached) await sendLimitNotification('画像生成');
      throw new Error('ERROR: 今月のAIストックの上限に達しました。管理者に連絡済みです。追加ストックについてはご連絡をお待ちください。');
    }
    const config = loadApiConfig();
    if (!config.openaiKey) throw new Error('画像生成機能の初期化に失敗しました。サポートにお問い合わせください。');

    const ImageAI = require('openai');
    const client = new ImageAI({ apiKey: config.openaiKey });

    // data が文字列の場合は旧API互換（プロンプトのみ）
    const prompt = typeof data === 'string' ? data : data.prompt;
    const sourceImage = typeof data === 'string' ? null : data.sourceImage;

    // 外構工事かどうかを判定
    const exteriorKeywords = ['exterior', 'outdoor', 'garden', 'parking', 'fence', 'deck', 'carport', 'gate', 'patio', 'landscap', 'driveway', 'yard', 'terrace'];
    const isExterior = exteriorKeywords.some(kw => prompt.toLowerCase().includes(kw));

    // 元画像がある場合 → 元画像を参照して最小限の変更のみ
    if (sourceImage) {
      // MIMEタイプを判定してファイルに書き出し
      const mimeMatch = sourceImage.match(/^data:(image\/\w+);base64,/);
      let mime = mimeMatch ? mimeMatch[1] : 'image/png';
      if (mime === 'image/jpg') mime = 'image/jpeg';
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
      const base64Data = sourceImage.replace(/^data:image\/\w+;base64,/, '');
      const imgBuffer = Buffer.from(base64Data, 'base64');
      const tmpImg = path.join(app.getPath('temp'), `edit_src_${Date.now()}.${ext}`);
      fs.writeFileSync(tmpImg, imgBuffer);

      try {
        const editPrompt = `I am giving you a reference photo. Your output MUST look like this EXACT same photo — same room/building, same angle, same lighting, same everything. The ONLY difference is: ${prompt}. Keep 99% of the image identical to the reference. Just add/change that one small thing.`;

        // OpenAI SDK にMIMEタイプ付きでファイルを渡す
        const { toFile } = require('openai');
        const fileObj = await toFile(fs.createReadStream(tmpImg), `source.${ext}`, { type: mime });

        const response = await client.images.edit({
          model: 'gpt-image-1',
          image: fileObj,
          prompt: editPrompt,
        });

        const b64 = response.data?.[0]?.b64_json;
        if (b64) return `data:image/png;base64,${b64}`;
        const url = response.data?.[0]?.url;
        if (url) return url;
        throw new Error('画像データが取得できませんでした');
      } finally {
        try { fs.unlinkSync(tmpImg); } catch (_) {}
      }
    }

    // 元画像がない場合のみ → 新規生成
    const enhancedPrompt = isExterior
      ? `Professional architectural photography of completed exterior/landscaping work in a Japanese residential property. Photorealistic, golden hour lighting, clean design. ${prompt}`
      : `Professional interior photography of a beautifully renovated Japanese residential space. Photorealistic, natural window light, modern Japanese aesthetic. ${prompt}`;

    const response = await client.images.generate({
      model: 'gpt-image-1',
      prompt: enhancedPrompt,
      n: 1,
      size: '1536x1024',
      quality: 'medium',
    });

    const b64 = response.data[0]?.b64_json;
    if (b64) return `data:image/png;base64,${b64}`;
    return response.data[0]?.url || null;
  });

  // ── AI解析結果から物件・施工・材料明細・請求書を一括自動作成 ──
  ipcMain.handle('ai:autoCreate', (_e, data: any) => {
    const { result, imageBase64, comment, location } = data;
    const today = new Date().toISOString().split('T')[0];
    const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const tid = getCurrentTenant();

    // 1. 物件登録
    const propertyId = runSql(
      'INSERT INTO properties (name, address, floor_plan_image, notes, tenant_id) VALUES (?, ?, ?, ?, ?)',
      [result.workType + '（AI見積もり）', location || result.estimatedScale || '', imageBase64 || null,
       `AI解析: ${result.description || ''}\n信頼度: ${result.confidence || ''}${location ? '\n場所: ' + location : ''}`, tid]
    );

    // 2. 施工登録（掛率をAI総額から逆算して精度を保つ）
    const aiCost = (result.estimatedMaterialCost || 0) + (result.estimatedLaborCost || 0);
    const markupRate = result.estimatedTotal && aiCost > 0
      ? Math.round((result.estimatedTotal / aiCost) * 10000) / 10000
      : 1.3;
    const constructionId = runSql(
      'INSERT INTO constructions (property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [propertyId, result.workType, today, result.estimatedLaborCost || 0, markupRate,
       `AI自動作成\n${result.recommendations || ''}`, tid]
    );

    // 3. 内訳を材料明細として登録
    let breakdownTotal = 0;
    if (result.breakdown && result.breakdown.length > 0) {
      for (const item of result.breakdown) {
        const cost = item.cost || 0;
        breakdownTotal += cost;
        // 材料マスタに登録
        const matId = runSql(
          'INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
          [item.item, 'AI見積', '式', cost, item.note || 'AI自動見積もり', tid]
        );
        // 施工材料明細に追加
        runSql(
          'INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
          [constructionId, matId, 1, cost]
        );
      }
    }
    // 明細合計とAI推定材料費の差額を調整
    const aiMaterialCost = result.estimatedMaterialCost || 0;
    const diff = aiMaterialCost - breakdownTotal;
    if (Math.abs(diff) >= 1) {
      const adjMatId = runSql(
        'INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
        ['諸経費', 'AI見積', '式', diff, '明細差額の自動調整', tid]
      );
      runSql(
        'INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
        [constructionId, adjMatId, 1, diff]
      );
    }

    // 4. AI見積ログ保存（精度改善用フィードバック）
    try {
      const jstNow = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
      runSql(
        'INSERT INTO estimate_log (tenant_id, construction_id, work_type, ai_material_cost, ai_labor_cost, ai_total, ai_markup_rate, ai_json, created_at, uploaded_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [getCurrentTenant(), constructionId, result.workType || '',
         result.estimatedMaterialCost || 0, result.estimatedLaborCost || 0,
         result.estimatedTotal || 0, markupRate,
         JSON.stringify(result), jstNow, imageBase64 || null]
      );
    } catch (_) {}

    // 5. 請求書作成（コメント内容を備考に反映）
    const remarksLines = [];
    if (location) remarksLines.push(`現場: ${location}`);
    if (comment) remarksLines.push(`工事内容: ${comment}`);
    if (result.recommendations) remarksLines.push(`提案: ${result.recommendations}`);
    const invoiceNotes = remarksLines.length > 0 ? remarksLines.join('\n') : `AI見積もりから自動作成\n工事種別: ${result.workType}`;

    const invoiceId = runSql(
      'INSERT INTO invoices (construction_id, client_name, client_address, issue_date, due_date, amount, tax_rate, notes, status, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [constructionId, '（請求先未定）', null, today, dueDate,
       result.estimatedTotal || 0, 0.1,
       invoiceNotes,
       'draft', tid]
    );

    // 売価はAI推定総額を確定値として保存
    const sellingPrice = result.estimatedTotal || 0;
    runSql('UPDATE constructions SET fixed_selling_price = ? WHERE id = ?', [sellingPrice, constructionId]);

    // 請求書・estimate_logも実際の売価に更新
    try {
      runSql('UPDATE invoices SET amount = ? WHERE id = ?', [sellingPrice, invoiceId]);
      runSql('UPDATE estimate_log SET ai_total = ? WHERE construction_id = ? AND tenant_id = ?',
        [sellingPrice, constructionId, tid]);
    } catch (_) {}

    return { propertyId, constructionId, invoiceId, sellingPrice };
  });

  // ── テナントデータ エクスポート（トライアル企業→本体へ渡す用）──
  ipcMain.handle('data:export', async () => {
    const tid = getCurrentTenant();
    const tenant = queryOne('SELECT * FROM tenants WHERE id = ?', [tid]);
    const properties = queryAll('SELECT * FROM properties WHERE tenant_id = ?', [tid]);
    const materials = queryAll('SELECT * FROM materials WHERE tenant_id = ?', [tid]);
    const constructions = queryAll('SELECT * FROM constructions WHERE tenant_id = ?', [tid]);
    const invoices = queryAll('SELECT * FROM invoices WHERE tenant_id = ?', [tid]);
    const customers = queryAll('SELECT * FROM customers WHERE tenant_id = ?', [tid]);

    // 施工ごとの材料明細と写真
    const constructionDetails: any[] = [];
    for (const c of constructions) {
      const mats = queryAll('SELECT cm.*, m.name as material_name, m.category, m.unit FROM construction_materials cm JOIN materials m ON m.id = cm.material_id WHERE cm.construction_id = ?', [c.id]);
      const photos = queryAll('SELECT * FROM construction_photos WHERE construction_id = ?', [c.id]);
      constructionDetails.push({ ...c, materials: mats, photos });
    }

    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      tenantName: tenant?.name || '',
      properties,
      materials,
      constructions: constructionDetails,
      invoices,
      customers,
    };

    const savePath = await dialog.showSaveDialog({
      defaultPath: `建築ブースト_データ_${tenant?.name || 'export'}_${new Date().toISOString().split('T')[0]}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!savePath.canceled && savePath.filePath) {
      fs.writeFileSync(savePath.filePath, JSON.stringify(exportData, null, 2), 'utf-8');
      shell.showItemInFolder(savePath.filePath);
      return { success: true, path: savePath.filePath };
    }
    return { success: false };
  });

  // ── テナントデータ インポート（本体側で取り込み）──
  ipcMain.handle('data:import', async () => {
    const openPath = await dialog.showOpenDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (openPath.canceled || !openPath.filePaths[0]) return { success: false };

    const raw = JSON.parse(fs.readFileSync(openPath.filePaths[0], 'utf-8'));
    if (!raw.version || !raw.exportedAt) throw new Error('不正なエクスポートファイルです');

    const tid = getCurrentTenant();
    let imported = { properties: 0, materials: 0, constructions: 0, invoices: 0, customers: 0, photos: 0 };

    // 材料マスタ（名前+カテゴリで重複チェック、なければ追加・あれば単価更新）
    for (const m of (raw.materials || [])) {
      const existing = queryOne('SELECT id FROM materials WHERE name = ? AND category = ? AND tenant_id = ?', [m.name, m.category, tid]);
      if (existing) {
        runSql('UPDATE materials SET unit_price = ?, unit = ?, notes = ? WHERE id = ?', [m.unit_price, m.unit, m.notes, existing.id]);
      } else {
        runSql('INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
          [m.name, m.category, m.unit, m.unit_price, m.notes, tid]);
      }
      imported.materials++;
    }

    // 顧客
    for (const c of (raw.customers || [])) {
      const existing = queryOne('SELECT id FROM customers WHERE name = ? AND tenant_id = ?', [c.name, tid]);
      if (!existing) {
        runSql('INSERT INTO customers (name, company, phone, email, address, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [c.name, c.company, c.phone, c.email, c.address, c.notes, tid]);
        imported.customers++;
      }
    }

    // 物件
    const propIdMap: Record<number, number> = {};
    for (const p of (raw.properties || [])) {
      const newId = runSql('INSERT INTO properties (name, address, floor_plan_image, notes, tenant_id) VALUES (?, ?, ?, ?, ?)',
        [p.name, p.address, p.floor_plan_image, p.notes, tid]);
      propIdMap[p.id] = newId;
      imported.properties++;
    }

    // 施工（材料明細・写真付き）
    const conIdMap: Record<number, number> = {};
    for (const c of (raw.constructions || [])) {
      const propId = propIdMap[c.property_id] || null;
      const newConId = runSql(
        'INSERT INTO constructions (property_id, title, construction_date, labor_cost, markup_rate, status, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [propId, c.title, c.construction_date, c.labor_cost, c.markup_rate, c.status, c.notes, tid]);
      conIdMap[c.id] = newConId;
      imported.constructions++;

      // 材料明細
      for (const cm of (c.materials || [])) {
        const mat = queryOne('SELECT id FROM materials WHERE name = ? AND tenant_id = ? LIMIT 1', [cm.material_name, tid]);
        if (mat) {
          runSql('INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
            [newConId, mat.id, cm.quantity, cm.unit_price]);
        }
      }

      // 写真
      for (const ph of (c.photos || [])) {
        runSql('INSERT INTO construction_photos (construction_id, photo_data, label, notes) VALUES (?, ?, ?, ?)',
          [newConId, ph.photo_data, ph.label, ph.notes]);
        imported.photos++;
      }
    }

    // 請求書
    for (const inv of (raw.invoices || [])) {
      const conId = conIdMap[inv.construction_id] || null;
      runSql(
        'INSERT INTO invoices (construction_id, client_name, client_address, issue_date, due_date, amount, tax_rate, notes, status, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [conId, inv.client_name, inv.client_address, inv.issue_date, inv.due_date, inv.amount, inv.tax_rate, inv.notes, inv.status, tid]);
      imported.invoices++;
    }

    logAudit('import', 'data', 0, `インポート: ${raw.tenantName} - 物件${imported.properties} 材料${imported.materials} 施工${imported.constructions} 請求書${imported.invoices} 写真${imported.photos}`);
    return { success: true, imported, tenantName: raw.tenantName };
  });
});

// ── 終了時にテナントデータを自動スナップショット ──
function silentSnapshot() {
  try {
    const tid = getCurrentTenant();
    if (tid <= 1) return;
    const tenant = queryOne('SELECT * FROM tenants WHERE id = ?', [tid]);
    const properties = queryAll('SELECT * FROM properties WHERE tenant_id = ?', [tid]);
    const materials = queryAll('SELECT * FROM materials WHERE tenant_id = ?', [tid]);
    const constructions = queryAll('SELECT * FROM constructions WHERE tenant_id = ?', [tid]);
    const invoices = queryAll('SELECT * FROM invoices WHERE tenant_id = ?', [tid]);
    const customers = queryAll('SELECT * FROM customers WHERE tenant_id = ?', [tid]);
    const constructionDetails: any[] = [];
    for (const c of constructions) {
      const mats = queryAll('SELECT cm.*, m.name as material_name, m.category, m.unit FROM construction_materials cm JOIN materials m ON m.id = cm.material_id WHERE cm.construction_id = ?', [c.id]);
      const photos = queryAll('SELECT * FROM construction_photos WHERE construction_id = ?', [c.id]);
      constructionDetails.push({ ...c, materials: mats, photos });
    }
    const snapshot = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      tenantName: tenant?.name || '',
      properties, materials, constructions: constructionDetails, invoices, customers,
    };
    const snapshotDir = path.join(app.getPath('userData'), '.sync');
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'latest.json'), JSON.stringify(snapshot), 'utf-8');
  } catch (_) {}
}

app.on('before-quit', () => { silentSnapshot(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
