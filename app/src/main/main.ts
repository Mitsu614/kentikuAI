import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { initDatabase, queryAll, queryOne, runSql, logAudit, setCurrentTenant, getCurrentTenant, getCredits, useCredits, addCredits, getMonthlyUsage, getTenantPlan, setTenantPlan, PLANS, CREDIT_COSTS, createPlanRequest, listPlanRequests, listAllPlanRequests, approvePlanRequest, rejectPlanRequest, cancelPlanRequest, listFeedbackRequests, listAllFeedbackRequests, createFeedbackRequest, updateFeedbackStatus, listEstimateOutcomes, createEstimateOutcome, updateEstimateOutcome, deleteEstimateOutcome, getOutcomeStats, getSimilarEstimates } from '../database/database';
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
const APP_VERSION = '2.2.0';

// ── 学習ループ: Supabaseで実績データを管理 ──

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
      if (stats && stats.length > 0) {
        const feedbackList = stats.map((s: any) => ({
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

// AI利用時のメール通知（誰が何をいつ使ったか）
async function sendUsageNotification(operation: string, detail?: string, extras?: { images?: { filename: string; content: string }[]; estimateResult?: any; comment?: string }) {
  try {
    const tid = getCurrentTenant();
    // 管理者（テナントID=1）の操作は通知しない
    if (tid === 1) return;
    const tenant = queryOne('SELECT name, contact_company, contact_tel, contact_email FROM tenants WHERE id = ?', [tid]);
    const usage = getMonthlyUsage(tid);
    const planDef = PLANS[usage.plan];
    const now = new Date();

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: 'mitsuakinakano0215@gmail.com', pass: 'cmlz usad gycg sbem' },
    });

    // 見積詳細テキスト
    let estimateDetail = '';
    if (extras?.estimateResult) {
      const r = extras.estimateResult;
      estimateDetail = [
        '', '【見積詳細】',
        `■ 工事種別: ${r.workType || '不明'}`,
        `■ 売価: ¥${Math.round(r.estimatedTotal || 0).toLocaleString()}`,
        `■ 材料費: ¥${Math.round(r.estimatedMaterialCost || 0).toLocaleString()}`,
        `■ 人件費: ¥${Math.round(r.estimatedLaborCost || 0).toLocaleString()}`,
        `■ 掛率: ${r.markupRate || '-'}`,
        `■ 信頼度: ${r.confidence || '-'}`,
        r.breakdown ? `■ 内訳: ${r.breakdown.map((b: any) => `${b.item}: ¥${Math.round(b.cost || 0).toLocaleString()}`).join(' / ')}` : '',
        r.description ? `■ 説明: ${r.description}` : '',
        r.recommendations ? `■ 推奨事項: ${r.recommendations}` : '',
      ].filter(Boolean).join('\n');
    }
    if (extras?.comment) {
      estimateDetail += `\n\n【ユーザーコメント】\n${extras.comment}`;
    }

    // 画像添付
    const attachments: any[] = [];
    if (extras?.images) {
      for (const img of extras.images) {
        if (img.content) {
          const base64Data = img.content.replace(/^data:image\/\w+;base64,/, '');
          attachments.push({ filename: img.filename, content: Buffer.from(base64Data, 'base64'), cid: img.filename });
        }
      }
    }

    await transporter.sendMail({
      from: '建築ブースト <mitsuakinakano0215@gmail.com>',
      to: 'mitsuakinakano0215@gmail.com',
      subject: `【利用通知】${tenant?.name || 'テナント' + tid} — ${operation}`,
      text: [
        `テナント「${tenant?.name || 'ID:' + tid}」がAI機能を使用しました。`,
        '',
        '【利用内容】',
        `■ 操作: ${operation}`,
        `■ 日時: ${now.toLocaleString('ja-JP')}`,
        detail ? `■ 詳細: ${detail}` : '',
        '',
        '【お客様情報】',
        `■ 会社名: ${tenant?.contact_company || tenant?.name || '未登録'}`,
        `■ 電話番号: ${tenant?.contact_tel || '未登録'}`,
        `■ メールアドレス: ${tenant?.contact_email || '未登録'}`,
        '',
        '【利用状況】',
        `■ プラン: ${planDef?.name || usage.plan}`,
        `■ 今月の使用量: ${usage.used}/${usage.limit}回`,
        `■ 残ストック: ${usage.remaining}回`,
        estimateDetail,
        '',
        '---',
        '建築ブースト 利用通知',
      ].filter(Boolean).join('\n'),
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  } catch (e: any) {
    console.error('Usage notification email failed:', e?.message || e);
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
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://api.qrserver.com; connect-src 'self'"],
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

// ── 自動アップデート（GitHub Releases ベース）──
const GITHUB_REPO = 'Mitsu614/kentikuAI';
const CURRENT_VERSION = '2.4.0';

async function checkForUpdates() {
  try {
    const https = require('https');
    const data: string = await new Promise((resolve, reject) => {
      https.get(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'User-Agent': 'kenchiku-boost', 'Accept': 'application/vnd.github.v3+json' },
      }, (res: any) => {
        let body = '';
        res.on('data', (d: string) => body += d);
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    const release = JSON.parse(data);
    const latestVersion = (release.tag_name || '').replace(/^v/, '');

    if (!latestVersion || latestVersion === CURRENT_VERSION) return;

    // 既にこのバージョンの通知を表示済みならスキップ
    const skipFile = path.join(app.getPath('userData'), '.update-skipped');
    try {
      if (fs.existsSync(skipFile) && fs.readFileSync(skipFile, 'utf-8').trim() === latestVersion) return;
    } catch (_) {}

    // バージョン比較（新しいバージョンがある場合のみ）
    const current = CURRENT_VERSION.split('.').map(Number);
    const latest = latestVersion.split('.').map(Number);
    let isNewer = false;
    for (let i = 0; i < 3; i++) {
      if ((latest[i] || 0) > (current[i] || 0)) { isNewer = true; break; }
      if ((latest[i] || 0) < (current[i] || 0)) break;
    }
    if (!isNewer) return;

    // ZIPアセットを探す
    const zipAsset = release.assets?.find((a: any) => a.name.endsWith('.zip'));
    if (!zipAsset) return;

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'アップデートがあります',
      message: `新しいバージョン v${latestVersion} が利用可能です（現在 v${CURRENT_VERSION}）`,
      detail: release.body || '',
      buttons: ['今すぐ更新', '後で'],
      defaultId: 0,
    });
    if (response !== 0) {
      // 「後で」を選んだらこのバージョンはスキップ
      try { fs.writeFileSync(path.join(app.getPath('userData'), '.update-skipped'), latestVersion, 'utf-8'); } catch (_) {}
      return;
    }

    // ダウンロード
    const downloadUrl = zipAsset.browser_download_url;
    const updateDir = path.join(app.getPath('userData'), 'update');
    const zipPath = path.join(updateDir, 'update.zip');
    if (!fs.existsSync(updateDir)) fs.mkdirSync(updateDir, { recursive: true });

    // プログレスウィンドウ
    const progressWin = new BrowserWindow({ width: 400, height: 150, resizable: false, title: 'アップデート中...', webPreferences: { contextIsolation: false } });
    progressWin.setMenuBarVisibility(false);
    progressWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:30px;text-align:center;background:#f5f5f5}h3{margin-bottom:16px;color:#333}.bar{width:100%;height:20px;background:#e0e0e0;border-radius:10px;overflow:hidden}.fill{height:100%;background:#3a7bd5;transition:width 0.3s;width:0%}</style></head><body><h3>アップデートをダウンロード中...</h3><div class="bar"><div class="fill" id="p"></div></div><p id="t" style="margin-top:8px;color:#888;font-size:13px">0%</p></body></html>'
    ));

    // ダウンロード実行
    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(zipPath);
      const follow = (url: string) => {
        https.get(url, { headers: { 'User-Agent': 'kenchiku-boost' } }, (res: any) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            return follow(res.headers.location);
          }
          const total = parseInt(res.headers['content-length'] || '0');
          let downloaded = 0;
          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            file.write(chunk);
            if (total > 0) {
              const pct = Math.round((downloaded / total) * 100);
              try { progressWin.webContents.executeJavaScript(`document.getElementById('p').style.width='${pct}%';document.getElementById('t').textContent='${pct}%'`); } catch (_) {}
            }
          });
          res.on('end', () => { file.end(); resolve(); });
          res.on('error', reject);
        }).on('error', reject);
      };
      follow(downloadUrl);
    });

    try { progressWin.close(); } catch (_) {}

    // 展開先: アプリの実行パスの親ディレクトリ
    const appDir = path.dirname(app.getPath('exe'));
    const extractDir = path.join(updateDir, 'extracted');

    // バッチファイルで更新（アプリ終了後に上書きコピー＆再起動）
    const batPath = path.join(updateDir, 'update.bat');
    const batContent = [
      '@echo off',
      'echo アップデートを適用しています...',
      'timeout /t 3 /nobreak > nul',
      `powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/\//g, '\\\\')}', '${extractDir.replace(/\//g, '\\\\')}', $true)"`,
      // ZIPの中にフォルダが1つだけある場合、そのフォルダの中身をコピー
      `for /d %%d in ("${extractDir.replace(/\//g, '\\\\')}\\*") do xcopy /E /Y /Q "%%d\\*" "${appDir.replace(/\//g, '\\\\')}\\"`,
      `rmdir /S /Q "${extractDir.replace(/\//g, '\\\\')}"`,
      `del "${zipPath.replace(/\//g, '\\\\')}"`,
      `start "" "${app.getPath('exe')}"`,
      `del "%~f0"`,
    ].join('\r\n');
    fs.writeFileSync(batPath, batContent, 'utf-8');

    await dialog.showMessageBox({
      type: 'info',
      title: 'アップデート準備完了',
      message: 'アプリを再起動してアップデートを適用します。',
      buttons: ['OK'],
    });

    // バッチ実行＆アプリ終了
    require('child_process').spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
    app.quit();

  } catch (e: any) {
    console.log('Auto-update check failed:', e?.message || e);
  }
}

app.whenReady().then(async () => {
  // ── 旧バージョンの.integrityファイルを自動削除 ──
  try {
    const integrityFile = path.join(app.getPath('userData'), '.integrity');
    if (fs.existsSync(integrityFile)) fs.unlinkSync(integrityFile);
  } catch (_) {}

  const isOwner = require('os').hostname() === 'DESKTOP-MRETEV6' && require('os').userInfo().username === 'mitsu';

  // ── アップデートチェック ──
  checkForUpdates();

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
    // 管理者のテナントはストック50確保
    const myTenant = allTenants[0];
    const myPlan = queryOne('SELECT plan, plan_limit FROM tenants WHERE id = ?', [myTenant.id]);
    if (!myPlan?.plan_limit || myPlan.plan_limit < 50) {
      runSql('UPDATE tenants SET plan = ?, plan_limit = ? WHERE id = ?', ['standard', 50, myTenant.id]);
    }
  }

  // ── 初回起動時に会社名を登録 ──
  if (!isOwner) {
    const tenant = queryOne('SELECT name FROM tenants WHERE id = ?', [getCurrentTenant()]);
    if (tenant && (tenant.name === '無料トライアル' || !tenant.name)) {
      const { response, checkboxChecked } = await dialog.showMessageBox({
        type: 'question',
        title: '初回セットアップ',
        message: '建築ブーストをご利用いただきありがとうございます。\n\n御社名を登録してください。',
        detail: '入力された会社名でライセンスが管理されます。',
        buttons: ['次へ'],
      });
      let companyName = '';
      while (!companyName.trim()) {
        const input = await dialog.showMessageBox({
          type: 'question',
          title: '会社名の登録',
          message: '会社名を入力してください',
          buttons: ['OK'],
          defaultId: 0,
        });
        // showMessageBoxでは入力欄が使えないのでpromptを使う
        // Electronにはpromptがないので、BrowserWindowで入力画面を作る
        companyName = await new Promise<string>((resolve) => {
          const promptWin = new BrowserWindow({ width: 450, height: 220, resizable: false, minimizable: false, maximizable: false, title: '会社名の登録', parent: undefined, modal: false, webPreferences: { contextIsolation: false, nodeIntegration: true } });
          promptWin.setMenuBarVisibility(false);
          promptWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:'Yu Gothic','Meiryo',sans-serif;padding:24px;background:#f5f5f5;text-align:center}h2{font-size:16px;margin-bottom:16px;color:#333}input{width:90%;padding:12px;font-size:15px;border:2px solid #3a7bd5;border-radius:8px;text-align:center;outline:none}input:focus{border-color:#27ae60}button{margin-top:16px;padding:10px 40px;background:#3a7bd5;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-weight:bold}button:hover{background:#2d6bc4}.note{font-size:11px;color:#888;margin-top:8px}</style></head><body><h2>御社名を入力してください</h2><input id="name" placeholder="例: 株式会社○○建設" autofocus onkeydown="if(event.key==='Enter')submit()"><br><button onclick="submit()">登録</button><p class="note">※ ライセンス管理に使用されます</p><script>const{ipcRenderer}=require('electron');function submit(){const v=document.getElementById('name').value.trim();if(v)ipcRenderer.send('company-name-result',v)}</script></body></html>`));
          const { ipcMain: ipc } = require('electron');
          ipc.once('company-name-result', (_: any, name: string) => { promptWin.close(); resolve(name); });
          promptWin.on('closed', () => resolve(''));
        });
      }
      if (companyName.trim()) {
        runSql('UPDATE tenants SET name = ? WHERE id = ?', [companyName.trim(), getCurrentTenant()]);
      }
    }
  }

  // ── リモートライセンスチェック ──
  if (!isOwner) {
    try {
      const https = require('https');
      const tenant = queryOne('SELECT name FROM tenants WHERE id = ?', [getCurrentTenant()]);
      const tenantName = encodeURIComponent(tenant?.name || '');
      const licenseCheck: any = await new Promise((resolve) => {
        const req = https.get(
          `https://slhgkedzlormaovwpadi.supabase.co/rest/v1/remote_licenses?company_name=eq.${tenantName}&select=id,active,credits,blocked_message`,
          { headers: { 'apikey': 'sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Authorization': 'Bearer sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e' }, timeout: 8000 },
          (res: any) => {
            let body = '';
            res.on('data', (c: string) => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
          }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (Array.isArray(licenseCheck) && licenseCheck.length > 0) {
        const lic = licenseCheck[0];
        if (!lic.active) {
          dialog.showErrorBox('ご利用停止', lic.blocked_message || 'ご利用期間が終了しました。ご契約については担当者にお問い合わせください。');
          app.quit();
          return;
        }
        if (lic.credits <= 0) {
          dialog.showErrorBox('クレジット残量不足', 'AIクレジットが0です。追加クレジットについては担当者にお問い合わせください。');
          app.quit();
          return;
        }
        // リモートのクレジットをローカルに同期
        runSql('UPDATE tenants SET credits = ?, plan_limit = ? WHERE id = ?', [lic.credits, lic.credits, getCurrentTenant()]);
      } else if (Array.isArray(licenseCheck) && licenseCheck.length === 0) {
        // 未登録 → 自動でremote_licensesに追加
        const tenant = queryOne('SELECT name, credits, plan_limit FROM tenants WHERE id = ?', [getCurrentTenant()]);
        const newId = 'auto_' + Date.now().toString(36);
        const regBody = JSON.stringify({
          id: newId,
          company_name: tenant?.name || '不明',
          plan: 'trial',
          credits: tenant?.credits || 50,
          max_credits: tenant?.plan_limit || 50,
          active: true,
        });
        await new Promise<void>((resolve) => {
          const postReq = https.request({
            hostname: 'slhgkedzlormaovwpadi.supabase.co', path: '/rest/v1/remote_licenses', method: 'POST',
            headers: { 'apikey': 'sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Authorization': 'Bearer sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            timeout: 5000,
          }, () => resolve());
          postReq.on('error', () => resolve());
          postReq.write(regBody);
          postReq.end();
        });
      }
    } catch (_) {
      // ネットワークエラー時はローカルのクレジットで続行
    }

    // ── アクティビティ送信（起動通知） ──
    try {
      const https = require('https');
      const os = require('os');
      const tenant = queryOne('SELECT name, credits FROM tenants WHERE id = ?', [getCurrentTenant()]);
      const licRow = await new Promise((resolve) => {
        const tn = encodeURIComponent(tenant?.name || '');
        const req = https.get(
          `https://slhgkedzlormaovwpadi.supabase.co/rest/v1/remote_licenses?company_name=eq.${tn}&select=id`,
          { headers: { 'apikey': 'sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Authorization': 'Bearer sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e' }, timeout: 5000 },
          (res: any) => { let b = ''; res.on('data', (c: string) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } }); }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      const licenseId = Array.isArray(licRow) && licRow.length > 0 ? licRow[0].id : null;
      const activityData = JSON.stringify({
        license_id: licenseId,
        company_name: tenant?.name || '不明',
        hostname: os.hostname(),
        username: os.userInfo().username,
        app_version: APP_VERSION,
        event: 'startup',
        credits_remaining: tenant?.credits || 0,
      });
      const postReq = https.request({
        hostname: 'slhgkedzlormaovwpadi.supabase.co', path: '/rest/v1/app_activity', method: 'POST',
        headers: { 'apikey': 'sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Authorization': 'Bearer sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        timeout: 5000,
      }, () => {});
      postReq.on('error', () => {});
      postReq.write(activityData);
      postReq.end();
    } catch (_) {}
  }

  createWindow();

  // ── 自動アップデートチェック ──
  setTimeout(async () => {
    try {
      const https = require('https');
      const updateInfo: any = await new Promise((resolve) => {
        const req = https.get('https://api.github.com/repos/Mitsu614/kentikuAI/releases/latest', {
          headers: { 'User-Agent': 'kenchiku-boost', 'Accept': 'application/vnd.github.v3+json' },
          timeout: 10000,
        }, (res: any) => {
          let body = '';
          res.on('data', (c: string) => body += c);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (!updateInfo || !updateInfo.tag_name) return;
      const latestVer = updateInfo.tag_name.replace(/^v/, '');
      if (latestVer <= APP_VERSION) return;

      // ダウンロードURLを取得
      const asset = (updateInfo.assets || []).find((a: any) => a.name && a.name.endsWith('.zip'));
      const downloadUrl = asset ? asset.browser_download_url : updateInfo.html_url;
      const releaseNotes = updateInfo.body || '';

      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: 'info',
        title: 'アップデートのお知らせ',
        message: `建築ブーストの新しいバージョン v${latestVer} があります。\n\n現在: v${APP_VERSION}\n最新: v${latestVer}`,
        detail: releaseNotes.substring(0, 300) || '新機能・バグ修正が含まれています。',
        buttons: ['ダウンロードする', '後で'],
        defaultId: 0,
      });
      if (response === 0) {
        const { shell } = require('electron');
        shell.openExternal(downloadUrl);
      }
    } catch (_) {}
  }, 15000);

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

  // ── 月次レポート自動送信 + 更新前レビューリマインダー ──
  setTimeout(async () => {
    try {
      const tenants = queryAll('SELECT * FROM tenants WHERE id > 1 AND plan_started_at IS NOT NULL');
      for (const t of tenants) {
        const started = new Date(t.plan_started_at);
        const now = new Date();
        const diffDays = Math.floor((now.getTime() - started.getTime()) / (1000 * 60 * 60 * 24));
        const monthsSinceStart = Math.floor(diffDays / 30);

        // 月初（毎月1日〜3日）かつ前回送信から25日以上経過している場合のみ送信
        const today = now.getDate();
        const lastReport = t.last_report_at ? new Date(t.last_report_at) : null;
        const daysSinceLastReport = lastReport ? Math.floor((now.getTime() - lastReport.getTime()) / (1000 * 60 * 60 * 24)) : 999;

        if (today <= 3 && daysSinceLastReport >= 25 && monthsSinceStart >= 1) {
          // 利用統計を集計
          const usage = getMonthlyUsage(t.id);
          const totalEstimates = queryOne('SELECT COUNT(*) as cnt FROM estimate_log WHERE tenant_id = ?', [t.id])?.cnt || 0;
          const totalConstructions = queryOne('SELECT COUNT(*) as cnt FROM constructions WHERE tenant_id = ?', [t.id])?.cnt || 0;
          const totalInvoices = queryOne('SELECT COUNT(*) as cnt FROM invoices WHERE tenant_id = ?', [t.id])?.cnt || 0;
          const totalPOs = queryOne('SELECT COUNT(*) as cnt FROM purchase_orders WHERE tenant_id = ?', [t.id])?.cnt || 0;
          const thisMonthEstimates = queryOne("SELECT COUNT(*) as cnt FROM estimate_log WHERE tenant_id = ? AND created_at >= date('now', 'start of month')", [t.id])?.cnt || 0;
          const learnings = queryOne('SELECT COUNT(*) as cnt FROM chat_learnings WHERE tenant_id = ?', [t.id])?.cnt || 0;

          // 時間削減の推定（1件あたり4時間→30秒 = 3.99時間削減）
          const hoursSaved = Math.round(totalEstimates * 3.99);
          const moneySaved = hoursSaved * 3750; // 日当3万円÷8時間=3,750円/時

          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: 'mitsuakinakano0215@gmail.com', pass: 'cmlz usad gycg sbem' },
          });

          // 顧客向けレポート
          if (t.contact_email) {
            await transporter.sendMail({
              from: '建築ブースト <mitsuakinakano0215@gmail.com>',
              to: t.contact_email,
              subject: `【建築ブースト】月次ご利用レポート（${now.getFullYear()}年${now.getMonth() + 1}月）`,
              text: [
                `${t.contact_company || t.name} 様`,
                '',
                'いつも建築ブーストをご利用いただきありがとうございます。',
                '月次のご利用レポートをお送りいたします。',
                '',
                '━━━━━━━━━━━━━━━━━━━━━━━━',
                `  ${now.getFullYear()}年${now.getMonth() + 1}月 ご利用レポート`,
                '━━━━━━━━━━━━━━━━━━━━━━━━',
                '',
                '【今月の利用状況】',
                `  AI見積回数:     ${thisMonthEstimates}件`,
                `  クレジット残:   ${usage.remaining} / ${usage.limit}`,
                '',
                '【累計の成果】',
                `  AI見積 累計:    ${totalEstimates}件`,
                `  施工案件:       ${totalConstructions}件`,
                `  請求書作成:     ${totalInvoices}件`,
                `  発注書作成:     ${totalPOs}件`,
                `  AI学習データ:   ${learnings}件（御社専用に最適化中）`,
                '',
                '【削減効果（推定）】',
                `  削減時間:       約${hoursSaved}時間`,
                `  コスト削減:     約${Math.round(moneySaved).toLocaleString()}円相当`,
                `  ※ 見積1件あたり約4時間の削減で算出`,
                '',
                '━━━━━━━━━━━━━━━━━━━━━━━━',
                '',
                'ご不明な点やご要望がございましたら、お気軽にご連絡ください。',
                '',
                '有限会社中野工務店',
                'TEL: 080-6138-0698',
                'MAIL: mitsuakinakano0215@gmail.com',
              ].join('\n'),
            });
          }

          // 管理者向け通知
          await transporter.sendMail({
            from: '建築ブースト <mitsuakinakano0215@gmail.com>',
            to: 'mitsuakinakano0215@gmail.com',
            subject: `【月次レポート送信】${t.contact_company || t.name} — ${thisMonthEstimates}件利用`,
            text: [
              `月次レポートを送信しました。`,
              '',
              `■ 会社名: ${t.contact_company || t.name}`,
              `■ 利用開始: ${t.plan_started_at}（${monthsSinceStart}ヶ月目）`,
              `■ 今月AI見積: ${thisMonthEstimates}件`,
              `■ 累計AI見積: ${totalEstimates}件`,
              `■ クレジット残: ${usage.remaining} / ${usage.limit}`,
              `■ 学習データ: ${learnings}件`,
              `■ 推定削減時間: ${hoursSaved}時間（${Math.round(moneySaved).toLocaleString()}円相当）`,
              thisMonthEstimates === 0 ? '\n⚠️ 今月の利用が0件です。フォロー電話をおすすめします。' : '',
              '',
              `■ 連絡先: ${t.contact_tel || '未登録'} / ${t.contact_email || '未登録'}`,
            ].filter(Boolean).join('\n'),
          });

          // 送信日を記録
          runSql('UPDATE tenants SET last_report_at = ? WHERE id = ?', [now.toISOString(), t.id]);
          console.log(`月次レポート送信: ${t.contact_company || t.name}`);
        }

        // ── 更新2ヶ月前（10ヶ月目）のレビューリマインダー ──
        if (monthsSinceStart === 10 && !(t as any).review_notified) {
          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: 'mitsuakinakano0215@gmail.com', pass: 'cmlz usad gycg sbem' },
          });
          const totalEstimates = queryOne('SELECT COUNT(*) as cnt FROM estimate_log WHERE tenant_id = ?', [t.id])?.cnt || 0;
          const hoursSaved = Math.round(totalEstimates * 3.99);

          await transporter.sendMail({
            from: '建築ブースト <mitsuakinakano0215@gmail.com>',
            to: 'mitsuakinakano0215@gmail.com',
            subject: `【要対応】更新2ヶ月前 — ${t.contact_company || t.name} レビュー訪問してください`,
            text: [
              `${t.contact_company || t.name} の年間契約が残り2ヶ月です。`,
              '',
              '★ レビュー訪問を実施してください ★',
              '',
              '【訪問時のアジェンダ】',
              '1. 1年間の成果を数字で振り返る',
              `   - AI見積 累計${totalEstimates}件`,
              `   - 推定${hoursSaved}時間の削減`,
              '2. 困っていることはないかヒアリング',
              '3. 来期のプラン提案（アップグレード検討）',
              '4. 更新手続きの案内',
              '',
              '【お客様情報】',
              `■ 会社名: ${t.contact_company || t.name}`,
              `■ 利用開始: ${t.plan_started_at}`,
              `■ 更新期限: あと約2ヶ月`,
              `■ 電話: ${t.contact_tel || '未登録'}`,
              `■ メール: ${t.contact_email || '未登録'}`,
              '',
              '---',
              '建築ブースト 自動リマインダー',
            ].join('\n'),
          });
          try { runSql("UPDATE tenants SET month_notified = 10 WHERE id = ?", [t.id]); } catch (_) {}
          console.log(`更新レビューリマインダー送信: ${t.contact_company || t.name}`);
        }
      }
    } catch (e: any) {
      console.error('Monthly report failed:', e?.message || e);
    }
  }, 12000);

  // トンネル変数（外出先アクセス用）
  let activeTunnel: any = null;

  // スマホ用Webサーバー起動
  try {
    setConfigLoader(loadApiConfig);
    const distPath = path.join(__dirname);
    startServer(distPath);
    setTimeout(() => {
      const url = getServerUrl();
      if (url) console.log(`\n📱 スマホからアクセス（同一Wi-Fi）: ${url}\n`);
    }, 1000);
    // 外出先からもアクセスできるようにトンネルを自動起動
    setTimeout(async () => {
      try {
        const localtunnel = require('localtunnel');
        const tunnel = await localtunnel({ port: 3456 });
        activeTunnel = tunnel;
        tunnel.on('close', () => { activeTunnel = null; });
        console.log(`\n🌐 外出先からアクセス: ${tunnel.url}\n`);
        // トンネルURLをSupabaseに記録（ダッシュボードから確認可能に）
        try {
          const https = require('https');
          const os = require('os');
          const tenant = queryOne('SELECT name FROM tenants WHERE id = ?', [getCurrentTenant()]);
          const actData = JSON.stringify({ company_name: tenant?.name || '不明', hostname: os.hostname(), username: os.userInfo().username, app_version: APP_VERSION, event: 'tunnel_started:' + tunnel.url, credits_remaining: 0 });
          const pr = https.request({ hostname: 'slhgkedzlormaovwpadi.supabase.co', path: '/rest/v1/app_activity', method: 'POST', headers: { 'apikey': 'sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Authorization': 'Bearer sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, timeout: 5000 }, () => {});
          pr.on('error', () => {}); pr.write(actData); pr.end();
        } catch (_) {}
      } catch (e: any) {
        console.log('トンネル起動スキップ:', e?.message || e);
      }
    }, 5000);
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
    const tid = getCurrentTenant();
    // 変更前の値を取得（学習用）
    const before = queryOne('SELECT labor_cost, markup_rate, title FROM constructions WHERE id = ?', [data.id]);

    runSql(
      'UPDATE constructions SET property_id=?, title=?, construction_date=?, labor_cost=?, markup_rate=?, notes=?, status=? WHERE id=?',
      [data.propertyId, data.title, data.constructionDate, data.laborCost, data.markupRate, data.notes || null, data.status || '見積中', data.id]
    );

    // 学習: 掛率変更を記録
    if (before && data.markupRate && before.markup_rate !== data.markupRate) {
      try {
        runSql(
          'INSERT INTO chat_learnings (tenant_id, category, key, value, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, category, key) DO UPDATE SET value=?, confidence=confidence+0.3',
          [tid, '単価', '掛率の傾向', `AI推定${before.markup_rate}→修正${data.markupRate}（好みの掛率: ${data.markupRate}）`, 'edit', `好みの掛率: ${data.markupRate}（最新修正）`]
        );
      } catch (_) {}
    }
    // 学習: 人件費変更を記録
    if (before && data.laborCost != null && before.labor_cost !== data.laborCost) {
      try {
        const diff = data.laborCost - (before.labor_cost || 0);
        runSql(
          'INSERT INTO chat_learnings (tenant_id, category, key, value, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, category, key) DO UPDATE SET value=?, confidence=confidence+0.2',
          [tid, '単価', '人件費の傾向', `AI推定から${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString()}円修正が多い`, 'edit', `AI推定から${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString()}円修正（最新）`]
        );
      } catch (_) {}
    }

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
    // 学習: 手動追加された材料を記録
    try {
      const mat = queryOne('SELECT name, category FROM materials WHERE id = ?', [data.materialId]);
      if (mat) {
        const con = queryOne('SELECT title FROM constructions WHERE id = ?', [data.constructionId]);
        runSql(
          'INSERT INTO chat_learnings (tenant_id, category, key, value, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, category, key) DO UPDATE SET value=value||? , confidence=confidence+0.1',
          [getCurrentTenant(), '材料', `${mat.category}で追加されやすい材料`, `${mat.name}`, 'edit', `、${mat.name}`]
        );
      }
    } catch (_) {}
    return id;
  });

  ipcMain.handle('constructionMaterials:update', (_e, data: any) => {
    const tid = getCurrentTenant();
    // 変更前の値を取得（学習用）
    const before = queryOne('SELECT cm.quantity, cm.unit_price, m.name, m.unit_price as master_price, m.category FROM construction_materials cm LEFT JOIN materials m ON cm.material_id = m.id WHERE cm.id = ?', [data.id]);

    // 材料マスタ側も更新
    if (data.materialId) {
      runSql('UPDATE materials SET name=?, unit=? WHERE id=?', [data.name || '', data.unit || '式', data.materialId]);
    }
    // 明細の数量・単価を更新
    runSql('UPDATE construction_materials SET quantity=?, unit_price=? WHERE id=?', [data.quantity || 1, data.unitPrice || 0, data.id]);

    // ── 学習: 単価変更を検知して材料マスタ＋chat_learningsに反映 ──
    if (before) {
      const newPrice = data.unitPrice || 0;
      const oldPrice = before.unit_price || 0;
      const newQty = data.quantity || 1;
      const oldQty = before.quantity || 1;
      const matName = data.name || before.name || '';
      const category = before.category || 'その他';

      // 単価が変更された場合 → 材料マスタの単価を更新＋学習記録
      if (newPrice !== oldPrice && newPrice > 0) {
        if (data.materialId) {
          runSql('UPDATE materials SET unit_price = ? WHERE id = ? AND tenant_id = ?', [newPrice, data.materialId, tid]);
        }
        const pctChange = oldPrice > 0 ? Math.round(((newPrice - oldPrice) / oldPrice) * 100) : 0;
        try {
          runSql(
            'INSERT INTO chat_learnings (tenant_id, category, key, value, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, category, key) DO UPDATE SET value=?, confidence=confidence+0.2',
            [tid, '単価', `${matName}の単価`, `${newPrice.toLocaleString()}円（AI見積から${pctChange > 0 ? '+' : ''}${pctChange}%修正）`, 'edit', `${newPrice.toLocaleString()}円（AI見積から${pctChange > 0 ? '+' : ''}${pctChange}%修正）`]
          );
        } catch (_) {}
      }

      // 数量が変更された場合 → 学習記録
      if (newQty !== oldQty) {
        try {
          runSql(
            'INSERT INTO chat_learnings (tenant_id, category, key, value, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, category, key) DO UPDATE SET value=?, confidence=confidence+0.2',
            [tid, '数量', `${matName}の数量傾向`, `AI推定${oldQty}→実際${newQty}（${category}）`, 'edit', `AI推定${oldQty}→実際${newQty}（${category}）`]
          );
        } catch (_) {}
      }
    }

    // constructionIdを取得して再計算
    const cm = queryOne('SELECT construction_id FROM construction_materials WHERE id = ?', [data.id]);
    if (cm) recalcConstruction(cm.construction_id);
  });

  ipcMain.handle('constructionMaterials:remove', (_e, id: number) => {
    const cm = queryOne('SELECT cm.construction_id, m.name, m.category FROM construction_materials cm LEFT JOIN materials m ON cm.material_id = m.id WHERE cm.id = ?', [id]);
    runSql('DELETE FROM construction_materials WHERE id=?', [id]);
    if (cm) {
      recalcConstruction(cm.construction_id);
      // 学習: 削除された材料を記録
      try {
        if (cm.name) {
          runSql(
            'INSERT INTO chat_learnings (tenant_id, category, key, value, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, category, key) DO UPDATE SET value=value||?, confidence=confidence+0.1',
            [getCurrentTenant(), '材料', `${cm.category || 'その他'}で不要になりやすい材料`, `${cm.name}`, 'edit', `、${cm.name}`]
          );
        }
      } catch (_) {}
    }
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

  ipcMain.handle('invoices:getByConstruction', (_e, cid: number) => {
    const tid = getCurrentTenant();
    const invoice = queryOne(`
      SELECT i.*, c.title as construction_title, c.labor_cost, c.markup_rate,
             p.name as property_name, p.address as property_address
      FROM invoices i
      LEFT JOIN constructions c ON i.construction_id = c.id
      LEFT JOIN properties p ON c.property_id = p.id
      WHERE i.construction_id = ? AND i.tenant_id = ?
      ORDER BY i.id DESC LIMIT 1
    `, [cid, tid]);
    if (!invoice) return null;
    const materials = queryAll(`
      SELECT cm.*, m.name as material_name, m.unit, m.category
      FROM construction_materials cm
      LEFT JOIN materials m ON cm.material_id = m.id
      WHERE cm.construction_id = ?
      ORDER BY m.category, m.name
    `, [cid]);
    return { invoice, materials };
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
    const cfg_pre = loadApiConfig();
    const isLease = cfg_pre.industryType === 'lease';

    // リース業向けカテゴリグループ定義
    const leaseGroups: Record<string, { label: string; order: number }> = {
      '足場': { label: '【足場工事】', order: 1 },
      '養生': { label: '【養生・安全設備】', order: 2 },
      '仮囲い': { label: '【仮囲い・ゲート】', order: 3 },
      '仮設リース': { label: '【仮設建物・設備リース】', order: 4 },
      '重機リース': { label: '【重機・機材リース】', order: 5 },
      '運搬': { label: '【運搬・人工費】', order: 6 },
      '産廃処理': { label: '【産廃処理】', order: 7 },
      '技能者報酬': { label: '【技能者報酬（CCUS基準）】', order: 8 },
      '技術者報酬': { label: '【技術者報酬（国交省基準）】', order: 9 },
    };

    // ── 金額を明細から積み上げて計算（DBの値と一致させる）──
    let materialTotal = 0;
    let materialRows = '';
    let rowNum = 1;

    if (materials && materials.length > 0) {
      if (isLease) {
        // リース業: カテゴリ別にグループ分けして表示
        const grouped: Record<string, any[]> = {};
        const ungrouped: any[] = [];
        materials.forEach((m: any) => {
          const cat = m.category || '';
          if (leaseGroups[cat]) {
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(m);
          } else {
            ungrouped.push(m);
          }
        });

        // カテゴリ順にソートして出力
        const sortedCats = Object.keys(grouped).sort((a, b) => (leaseGroups[a]?.order || 99) - (leaseGroups[b]?.order || 99));
        for (const cat of sortedCats) {
          const group = grouped[cat];
          let groupTotal = 0;
          // グループヘッダー
          materialRows += `<tr style="background:#e8edf3;border-top:2px solid #999">
            <td colspan="6" style="font-weight:bold;font-size:11px;padding:6px 8px;color:#2e4057">${leaseGroups[cat].label}</td>
          </tr>`;
          for (const m of group) {
            const name = escapeHtml(m.material_name || m.name || '（項目名なし）');
            const unit = escapeHtml(m.unit || '式');
            const qty = m.quantity || 1;
            const price = m.unit_price || 0;
            const subtotal = Math.round(qty * price);
            materialTotal += subtotal;
            groupTotal += subtotal;
            // リース期間の補足（月/日の場合）
            const periodNote = (unit === '月' || unit === '日') ? `<span style="color:#888;font-size:9px"> (${qty}${unit})</span>` : '';
            materialRows += `<tr>
              <td style="text-align:center;color:#888;width:30px">${rowNum++}</td>
              <td>${name}${periodNote}</td>
              <td style="text-align:center">${qty}</td>
              <td style="text-align:center">${unit}</td>
              <td style="text-align:right">${fmt(price)}</td>
              <td style="text-align:right">${fmt(subtotal)}</td>
            </tr>`;
          }
          // グループ小計
          materialRows += `<tr style="background:#f5f7fa">
            <td colspan="5" style="text-align:right;font-size:10px;color:#555;padding-right:12px">${leaseGroups[cat].label.replace(/[【】]/g, '')} 小計</td>
            <td style="text-align:right;font-weight:bold;font-size:10px">${fmt(groupTotal)}</td>
          </tr>`;
        }

        // グループに属さない項目
        if (ungrouped.length > 0) {
          if (sortedCats.length > 0) {
            materialRows += `<tr style="background:#e8edf3;border-top:2px solid #999">
              <td colspan="6" style="font-weight:bold;font-size:11px;padding:6px 8px;color:#2e4057">【その他】</td>
            </tr>`;
          }
          for (const m of ungrouped) {
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
          }
        }
      } else {
        // 通常業種: フラット表示
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
    }

    // 人件費（施工費）
    const laborCost = invoice.labor_cost || 0;
    if (laborCost > 0) {
      materialRows += `<tr style="border-top:2px solid #ccc">
        <td style="text-align:center;color:#888">${rowNum++}</td>
        <td><strong>${isLease ? '設置・撤去作業費' : '施工費'}</strong></td>
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
    // マージン = 売価 - 原価 → 管理費として明細に入れる
    const managementFee = taxExcluded - costTotal;
    if (managementFee > 0) {
      materialRows += `<tr>
        <td style="text-align:center;color:#888">${rowNum++}</td>
        <td><strong>${isLease ? '現場管理・諸経費' : '設計・工事管理費'}</strong></td>
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
    const cfg = cfg_pre;
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
    // 無料トライアル: 50回、1回限り
    const today = new Date().toISOString().split('T')[0];
    runSql('UPDATE tenants SET plan = ?, plan_limit = ?, plan_started_at = ? WHERE id = ?',
      ['trial', 50, today, id]);
    // デフォルトテナントの材料マスタをコピー
    const defaultMats = queryAll('SELECT name, category, unit, unit_price, notes FROM materials WHERE tenant_id = 1');
    for (const m of defaultMats) {
      runSql('INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
        [m.name, m.category, m.unit, m.unit_price, m.notes, id]);
    }
    logAudit('create', 'tenant', id, `${name}（無料トライアル50回・材料${defaultMats.length}件コピー）`);
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

  // ── ログイン認証 ──
  let currentSession: { username: string; tenantId: number; role: string } | null = null;

  ipcMain.handle('auth:login', (_e, username: string, password: string) => {
    const user = queryOne('SELECT id, username, role, tenant_id, password_hash FROM users WHERE username = ?', [username]);
    if (!user) return { ok: false, error: 'ユーザー名またはパスワードが違います' };
    const [salt, hash] = (user.password_hash || '').split(':');
    const inputHash = crypto.createHash('sha256').update(salt + password).digest('hex');
    if (hash !== inputHash) return { ok: false, error: 'ユーザー名またはパスワードが違います' };
    // 承認待ちチェック
    const tenant = queryOne('SELECT plan FROM tenants WHERE id = ?', [user.tenant_id]);
    if (tenant?.plan === 'pending') return { ok: false, error: '管理者の承認待ちです。しばらくお待ちください。' };
    // テナント切替
    setCurrentTenant(user.tenant_id);
    currentSession = { username: user.username, tenantId: user.tenant_id, role: user.role };
    logAudit('login', 'user', user.id, username);
    return { ok: true, username: user.username, tenantId: user.tenant_id, role: user.role };
  });

  ipcMain.handle('auth:logout', () => {
    currentSession = null;
    setCurrentTenant(1);
    return { ok: true };
  });

  ipcMain.handle('auth:session', () => {
    return currentSession;
  });

  ipcMain.handle('auth:isOwner', () => {
    return require('os').hostname() === 'DESKTOP-MRETEV6' && require('os').userInfo().username === 'mitsu';
  });

  ipcMain.handle('auth:register', async (_e, data: any) => {
    const { username, password, company, email, tel } = data;
    // ユーザー名重複チェック
    const existing = queryOne('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return { ok: false, error: 'このユーザー名は既に使われています' };

    // テナント作成（承認待ち状態）
    const tenantId = runSql(
      'INSERT INTO tenants (name, plan, plan_limit, contact_company, contact_email, contact_tel) VALUES (?, ?, ?, ?, ?, ?)',
      [username, 'pending', 0, company, email || '', tel || '']
    );

    // ユーザー作成
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
    const saltedHash = `${salt}:${hash}`;
    runSql('INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, ?)',
      [username, saltedHash, 'admin', tenantId]);

    logAudit('register', 'user', tenantId, `${company} (${username}) — 承認待ち`);

    // メール通知
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: 'mitsuakinakano0215@gmail.com', pass: 'cmlz usad gycg sbem' },
      });
      await transporter.sendMail({
        from: '建築ブースト <mitsuakinakano0215@gmail.com>',
        to: 'mitsuakinakano0215@gmail.com',
        subject: `【新規登録申請】${company} — ${username}`,
        text: [
          '新規ユーザー登録申請がありました。',
          '',
          '【申請者情報】',
          `■ 会社名: ${company}`,
          `■ ユーザー名: ${username}`,
          `■ メール: ${email || '未入力'}`,
          `■ 電話: ${tel || '未入力'}`,
          `■ テナントID: ${tenantId}`,
          `■ 日時: ${new Date().toLocaleString('ja-JP')}`,
          `■ PC: ${require('os').hostname()}`,
          '',
          '承認するには管理画面でプランを "standard" に変更してください。',
          '',
          '---',
          '建築ブースト 自動通知',
        ].join('\n'),
      });
    } catch (e: any) {
      console.error('Registration notification failed:', e?.message || e);
    }

    return { ok: true };
  });

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

  // ── ローカルIPアドレス取得 ──
  ipcMain.handle('system:localIp', () => {
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('192.168.56')) {
          return net.address;
        }
      }
    }
    return '';
  });

  // ── 外部公開トンネル ──
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
    const estCfg = loadApiConfig();
    const estIsLease = estCfg.industryType === 'lease';
    const estLeaseGroups: Record<string, { label: string; order: number }> = {
      '足場': { label: '【足場工事】', order: 1 }, '養生': { label: '【養生・安全設備】', order: 2 },
      '仮囲い': { label: '【仮囲い・ゲート】', order: 3 }, '仮設リース': { label: '【仮設建物・設備リース】', order: 4 },
      '重機リース': { label: '【重機・機材リース】', order: 5 }, '運搬': { label: '【運搬・人工費】', order: 6 },
      '産廃処理': { label: '【産廃処理】', order: 7 },
      '技能者報酬': { label: '【技能者報酬（CCUS基準）】', order: 8 },
      '技術者報酬': { label: '【技術者報酬（国交省基準）】', order: 9 },
    };
    let materialTotal = 0;
    let rows = '';
    let num = 1;
    if (materials?.length) {
      if (estIsLease) {
        const grouped: Record<string, any[]> = {};
        const ungrouped: any[] = [];
        materials.forEach((m: any) => {
          const cat = m.category || '';
          if (estLeaseGroups[cat]) { if (!grouped[cat]) grouped[cat] = []; grouped[cat].push(m); }
          else { ungrouped.push(m); }
        });
        const sortedCats = Object.keys(grouped).sort((a, b) => (estLeaseGroups[a]?.order || 99) - (estLeaseGroups[b]?.order || 99));
        for (const cat of sortedCats) {
          let groupTotal = 0;
          rows += `<tr style="background:#e8edf3;border-top:2px solid #999"><td colspan="6" style="font-weight:bold;font-size:11px;padding:6px 8px;color:#2e4057">${estLeaseGroups[cat].label}</td></tr>`;
          for (const m of grouped[cat]) {
            const name = escapeHtml(m.material_name || m.name || '（項目名なし）');
            const unit = escapeHtml(m.unit || '式');
            const qty = m.quantity || 1; const price = m.unit_price || 0; const sub = Math.round(qty * price);
            materialTotal += sub; groupTotal += sub;
            const periodNote = (unit === '月' || unit === '日') ? `<span style="color:#888;font-size:9px"> (${qty}${unit})</span>` : '';
            rows += `<tr><td style="text-align:center;color:#888">${num++}</td><td>${name}${periodNote}</td><td style="text-align:center">${qty}</td><td style="text-align:center">${unit}</td><td style="text-align:right">${fmt(price)}</td><td style="text-align:right">${fmt(sub)}</td></tr>`;
          }
          rows += `<tr style="background:#f5f7fa"><td colspan="5" style="text-align:right;font-size:10px;color:#555;padding-right:12px">${estLeaseGroups[cat].label.replace(/[【】]/g, '')} 小計</td><td style="text-align:right;font-weight:bold;font-size:10px">${fmt(groupTotal)}</td></tr>`;
        }
        for (const m of ungrouped) {
          const name = escapeHtml(m.material_name || m.name || '（項目名なし）');
          const unit = escapeHtml(m.unit || '式');
          const qty = m.quantity || 1; const price = m.unit_price || 0; const sub = Math.round(qty * price);
          materialTotal += sub;
          rows += `<tr><td style="text-align:center;color:#888">${num++}</td><td>${name}</td><td style="text-align:center">${qty}</td><td style="text-align:center">${unit}</td><td style="text-align:right">${fmt(price)}</td><td style="text-align:right">${fmt(sub)}</td></tr>`;
        }
      } else {
        materials.forEach((m: any) => {
          const name = escapeHtml(m.material_name || m.name || '（項目名なし）');
          const unit = escapeHtml(m.unit || '式');
          const qty = m.quantity || 1; const price = m.unit_price || 0; const sub = Math.round(qty * price);
          materialTotal += sub;
          rows += `<tr><td style="text-align:center;color:#888">${num++}</td><td>${name}</td><td style="text-align:center">${qty}</td><td style="text-align:center">${unit}</td><td style="text-align:right">${fmt(price)}</td><td style="text-align:right">${fmt(sub)}</td></tr>`;
        });
      }
    }
    const laborCost = invoice.labor_cost || 0;
    if (laborCost > 0) {
      rows += `<tr style="border-top:2px solid #ccc"><td style="text-align:center;color:#888">${num++}</td><td><strong>${estIsLease ? '設置・撤去作業費' : '施工費'}</strong></td><td style="text-align:center">1</td><td style="text-align:center">式</td><td style="text-align:right">${fmt(laborCost)}</td><td style="text-align:right">${fmt(laborCost)}</td></tr>`;
    }
    const costTotal = materialTotal + laborCost;
    const taxExcluded = invoice.amount || 0;
    const managementFee = taxExcluded - costTotal;
    if (managementFee > 0) {
      rows += `<tr><td style="text-align:center;color:#888">${num++}</td><td><strong>${estIsLease ? '現場管理・諸経費' : '設計・工事管理費'}</strong></td><td style="text-align:center">1</td><td style="text-align:center">式</td><td style="text-align:right">${fmt(managementFee)}</td><td style="text-align:right">${fmt(managementFee)}</td></tr>`;
    }
    const taxRate = invoice.tax_rate || 0.1;
    const taxAmount = Math.round(taxExcluded * taxRate);
    const totalWithTax = taxExcluded + taxAmount;
    const title = escapeHtml(invoice.construction_title || '（未設定）');
    const cfg = estCfg;

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

  // ── 作業者管理 ──
  ipcMain.handle('workers:list', () => {
    return queryAll('SELECT * FROM workers WHERE tenant_id = ? ORDER BY name', [getCurrentTenant()]);
  });
  ipcMain.handle('workers:create', (_e, data: any) => {
    const id = runSql('INSERT INTO workers (tenant_id, name, daily_rate, role, notes) VALUES (?, ?, ?, ?, ?)',
      [getCurrentTenant(), data.name, data.daily_rate || 0, data.role || '作業員', data.notes || null]);
    logAudit('作成', '作業者', id, data.name);
    return id;
  });
  ipcMain.handle('workers:update', (_e, data: any) => {
    runSql('UPDATE workers SET name=?, daily_rate=?, role=?, notes=? WHERE id=? AND tenant_id=?',
      [data.name, data.daily_rate, data.role, data.notes || null, data.id, getCurrentTenant()]);
  });
  ipcMain.handle('workers:delete', (_e, id: number) => {
    runSql('DELETE FROM workers WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
  });

  // ── 出面管理（日報） ──
  ipcMain.handle('attendance:list', (_e, filter: any) => {
    const tid = getCurrentTenant();
    if (filter?.construction_id) {
      return queryAll(`SELECT a.*, w.name as worker_name, w.role as worker_role, c.title as construction_title
        FROM attendance a JOIN workers w ON a.worker_id = w.id LEFT JOIN constructions c ON a.construction_id = c.id
        WHERE a.tenant_id = ? AND a.construction_id = ? ORDER BY a.work_date DESC, w.name`, [tid, filter.construction_id]);
    }
    if (filter?.month) {
      return queryAll(`SELECT a.*, w.name as worker_name, w.role as worker_role, c.title as construction_title
        FROM attendance a JOIN workers w ON a.worker_id = w.id LEFT JOIN constructions c ON a.construction_id = c.id
        WHERE a.tenant_id = ? AND a.work_date LIKE ? ORDER BY a.work_date DESC, w.name`, [tid, filter.month + '%']);
    }
    return queryAll(`SELECT a.*, w.name as worker_name, w.role as worker_role, c.title as construction_title
      FROM attendance a JOIN workers w ON a.worker_id = w.id LEFT JOIN constructions c ON a.construction_id = c.id
      WHERE a.tenant_id = ? ORDER BY a.work_date DESC, w.name LIMIT 200`, [tid]);
  });
  // 出面変更時に実績人件費をestimate_logへフィードバック → 学習ループ発火
  function feedbackLaborFromAttendance(constructionId: number | null) {
    if (!constructionId) return;
    try {
      const log = queryOne('SELECT id, ai_material_cost, ai_labor_cost, ai_total, work_type FROM estimate_log WHERE construction_id = ?', [constructionId]);
      if (!log) return;
      const c = queryOne('SELECT * FROM constructions WHERE id = ?', [constructionId]);
      if (!c) return;
      // 出面から実績人件費を集計
      const att = queryOne('SELECT COALESCE(SUM(daily_rate * hours / 8), 0) as total FROM attendance WHERE construction_id = ?', [constructionId]);
      const actualLabor = att?.total || 0;
      const mat = queryOne('SELECT COALESCE(SUM(quantity * unit_price), 0) as total FROM construction_materials WHERE construction_id = ?', [constructionId]);
      const matCost = mat?.total || 0;
      const totalCost = matCost + actualLabor;
      const sellingPrice = c.fixed_selling_price || Math.ceil(totalCost * (c.markup_rate || 1.3));
      const markupRate = totalCost > 0 ? sellingPrice / totalCost : c.markup_rate || 1.3;
      const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
      runSql('UPDATE estimate_log SET actual_labor_cost=?, actual_selling_price=?, actual_markup_rate=?, feedback_at=? WHERE id=?',
        [actualLabor, sellingPrice, markupRate, now, log.id]);
      // 施工テーブルにも実績人件費を保存
      runSql('UPDATE constructions SET actual_labor_cost=? WHERE id=?', [actualLabor, constructionId]);
      // Supabaseに送信 → 係数更新
      const config = loadApiConfig();
      sendFeedbackToSupabase([{
        work_type: log.work_type || '不明',
        ai_material_cost: log.ai_material_cost, ai_labor_cost: log.ai_labor_cost, ai_total: log.ai_total,
        actual_material_cost: matCost, actual_labor_cost: actualLabor, actual_selling_price: sellingPrice,
        actual_markup_rate: markupRate, accuracy_ratio: log.ai_total > 0 ? sellingPrice / log.ai_total : null,
      }]).then(() => analyzeAndUpdateCoefficients(config.anthropicKey))
        .then(() => console.log('学習ループ（出面→人件費）: 係数更新完了'))
        .catch((e: any) => console.error('学習ループ（出面）エラー:', e));
    } catch (_) {}
  }

  ipcMain.handle('attendance:create', (_e, data: any) => {
    const worker = queryOne('SELECT daily_rate FROM workers WHERE id=?', [data.worker_id]);
    const rate = data.daily_rate || worker?.daily_rate || 0;
    const id = runSql('INSERT INTO attendance (tenant_id, construction_id, worker_id, work_date, hours, daily_rate, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [getCurrentTenant(), data.construction_id || null, data.worker_id, data.work_date, data.hours || 8, rate, data.notes || null]);
    feedbackLaborFromAttendance(data.construction_id);
    return id;
  });
  ipcMain.handle('attendance:update', (_e, data: any) => {
    // 更新前のconstruction_idも取得して両方フィードバック
    const old = queryOne('SELECT construction_id FROM attendance WHERE id=? AND tenant_id=?', [data.id, getCurrentTenant()]);
    runSql('UPDATE attendance SET construction_id=?, worker_id=?, work_date=?, hours=?, daily_rate=?, notes=? WHERE id=? AND tenant_id=?',
      [data.construction_id, data.worker_id, data.work_date, data.hours, data.daily_rate, data.notes, data.id, getCurrentTenant()]);
    feedbackLaborFromAttendance(data.construction_id);
    if (old?.construction_id && old.construction_id !== data.construction_id) feedbackLaborFromAttendance(old.construction_id);
  });
  ipcMain.handle('attendance:delete', (_e, id: number) => {
    const att = queryOne('SELECT construction_id FROM attendance WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
    runSql('DELETE FROM attendance WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
    feedbackLaborFromAttendance(att?.construction_id);
  });
  ipcMain.handle('attendance:summary', (_e, _filter: any) => {
    const tid = getCurrentTenant();
    const rows = queryAll(`SELECT c.id, c.title, c.labor_cost as estimated_labor,
      COALESCE(SUM(a.daily_rate * a.hours / 8), 0) as actual_labor,
      COUNT(a.id) as attendance_count
      FROM constructions c LEFT JOIN attendance a ON a.construction_id = c.id AND a.tenant_id = ?
      WHERE c.tenant_id = ? GROUP BY c.id ORDER BY c.id DESC`, [tid, tid]);
    return rows.map((r: any) => ({
      ...r,
      diff: (r.estimated_labor || 0) - r.actual_labor,
      diffPct: r.estimated_labor > 0 ? Math.round(((r.estimated_labor - r.actual_labor) / r.estimated_labor) * 100) : 0,
    }));
  });

  // ── 発注書管理 ──
  ipcMain.handle('purchaseOrders:list', () => {
    return queryAll(`SELECT po.*, c.title as construction_title FROM purchase_orders po
      LEFT JOIN constructions c ON po.construction_id = c.id WHERE po.tenant_id = ? ORDER BY po.id DESC`, [getCurrentTenant()]);
  });
  ipcMain.handle('purchaseOrders:create', (_e, data: any) => {
    const id = runSql(`INSERT INTO purchase_orders (tenant_id, construction_id, vendor_name, vendor_address, vendor_type, issue_date, delivery_date, amount, tax_rate, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [getCurrentTenant(), data.construction_id || null, data.vendor_name || '', data.vendor_address || '', data.vendor_type || 'material',
       data.issue_date || new Date().toISOString().split('T')[0], data.delivery_date || null, data.amount || 0, data.tax_rate || 0.1, data.notes || null, 'draft']);
    logAudit('作成', '発注書', id, data.vendor_name);
    return id;
  });
  ipcMain.handle('purchaseOrders:update', (_e, data: any) => {
    runSql(`UPDATE purchase_orders SET vendor_name=?, vendor_address=?, vendor_type=?, issue_date=?, delivery_date=?, amount=?, tax_rate=?, notes=?, status=? WHERE id=? AND tenant_id=?`,
      [data.vendor_name, data.vendor_address, data.vendor_type, data.issue_date, data.delivery_date, data.amount, data.tax_rate, data.notes, data.status, data.id, getCurrentTenant()]);
  });
  ipcMain.handle('purchaseOrders:delete', (_e, id: number) => {
    runSql('DELETE FROM purchase_orders WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
  });
  ipcMain.handle('purchaseOrders:getDetail', (_e, id: number) => {
    const po = queryOne('SELECT po.*, c.title as construction_title FROM purchase_orders po LEFT JOIN constructions c ON po.construction_id = c.id WHERE po.id=? AND po.tenant_id=?', [id, getCurrentTenant()]);
    const items = queryAll('SELECT * FROM purchase_order_items WHERE purchase_order_id=? ORDER BY id', [id]);
    return { ...po, items };
  });
  ipcMain.handle('purchaseOrders:addItem', (_e, data: any) => {
    const id = runSql('INSERT INTO purchase_order_items (purchase_order_id, name, quantity, unit, unit_price, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [data.purchase_order_id, data.name, data.quantity || 1, data.unit || '式', data.unit_price || 0, data.notes || null]);
    // 合計金額を再計算
    const total = queryOne('SELECT COALESCE(SUM(quantity * unit_price), 0) as total FROM purchase_order_items WHERE purchase_order_id=?', [data.purchase_order_id]);
    runSql('UPDATE purchase_orders SET amount=? WHERE id=?', [total?.total || 0, data.purchase_order_id]);
    return id;
  });
  ipcMain.handle('purchaseOrders:updateItem', (_e, data: any) => {
    runSql('UPDATE purchase_order_items SET name=?, quantity=?, unit=?, unit_price=?, notes=? WHERE id=?',
      [data.name, data.quantity, data.unit, data.unit_price, data.notes, data.id]);
    const item = queryOne('SELECT purchase_order_id FROM purchase_order_items WHERE id=?', [data.id]);
    if (item) {
      const total = queryOne('SELECT COALESCE(SUM(quantity * unit_price), 0) as total FROM purchase_order_items WHERE purchase_order_id=?', [item.purchase_order_id]);
      runSql('UPDATE purchase_orders SET amount=? WHERE id=?', [total?.total || 0, item.purchase_order_id]);
    }
  });
  ipcMain.handle('purchaseOrders:deleteItem', (_e, id: number) => {
    const item = queryOne('SELECT purchase_order_id FROM purchase_order_items WHERE id=?', [id]);
    runSql('DELETE FROM purchase_order_items WHERE id=?', [id]);
    if (item) {
      const total = queryOne('SELECT COALESCE(SUM(quantity * unit_price), 0) as total FROM purchase_order_items WHERE purchase_order_id=?', [item.purchase_order_id]);
      runSql('UPDATE purchase_orders SET amount=? WHERE id=?', [total?.total || 0, item.purchase_order_id]);
    }
  });
  ipcMain.handle('purchaseOrders:getByConstruction', (_e, cid: number) => {
    const tid = getCurrentTenant();
    const po = queryOne('SELECT po.*, c.title as construction_title FROM purchase_orders po LEFT JOIN constructions c ON po.construction_id = c.id WHERE po.construction_id=? AND po.tenant_id=? ORDER BY po.id DESC LIMIT 1', [cid, tid]);
    if (!po) return null;
    const items = queryAll('SELECT * FROM purchase_order_items WHERE purchase_order_id=? ORDER BY id', [po.id]);
    return { ...po, items };
  });
  ipcMain.handle('purchaseOrders:createFromConstruction', (_e, cid: number) => {
    const tid = getCurrentTenant();
    const con = queryOne('SELECT title FROM constructions WHERE id=? AND tenant_id=?', [cid, tid]);
    if (!con) return null;
    const today = new Date().toISOString().split('T')[0];
    const poId = runSql('INSERT INTO purchase_orders (tenant_id, construction_id, vendor_name, issue_date, status) VALUES (?, ?, ?, ?, ?)',
      [tid, cid, '', today, 'draft']);
    const mats = queryAll(`SELECT m.name, cm.quantity, m.unit, cm.unit_price FROM construction_materials cm
      JOIN materials m ON m.id = cm.material_id WHERE cm.construction_id = ?`, [cid]);
    let total = 0;
    for (const m of mats) {
      runSql('INSERT INTO purchase_order_items (purchase_order_id, name, quantity, unit, unit_price) VALUES (?, ?, ?, ?, ?)',
        [poId, m.name, m.quantity, m.unit, m.unit_price]);
      total += (m.quantity || 1) * (m.unit_price || 0);
    }
    runSql('UPDATE purchase_orders SET amount=? WHERE id=?', [total, poId]);
    logAudit('作成', '発注書', poId, `${con.title}から自動作成`);
    return poId;
  });
  ipcMain.handle('purchaseOrders:generatePDF', async (_e, data: any) => {
    const { po, items } = data;
    const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();
    const cfg = loadApiConfig();
    let rows = '';
    let num = 1;
    let itemTotal = 0;
    if (items?.length) {
      items.forEach((m: any) => {
        const sub = Math.round((m.quantity || 1) * (m.unit_price || 0));
        itemTotal += sub;
        rows += `<tr><td style="text-align:center;color:#888">${num++}</td><td>${escapeHtml(m.name)}</td><td style="text-align:center">${m.quantity || 1}</td><td style="text-align:center">${escapeHtml(m.unit || '式')}</td><td style="text-align:right">${fmt(m.unit_price || 0)}</td><td style="text-align:right">${fmt(sub)}</td></tr>`;
      });
    }
    const taxRate = po.tax_rate || 0.1;
    const taxAmount = Math.round(itemTotal * taxRate);
    const totalWithTax = itemTotal + taxAmount;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Yu Gothic','Meiryo',sans-serif;padding:40px 35px;color:#333;font-size:11px}
h1{text-align:center;font-size:26px;letter-spacing:10px;margin-bottom:24px}
.header{display:flex;justify-content:space-between;margin-bottom:16px}.client{font-size:16px;font-weight:bold;border-bottom:2px solid #333;padding-bottom:4px}
.meta{text-align:right;font-size:10px;line-height:1.8}.total-box{background:#f0f0f0;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;margin:16px 0;border-radius:4px}
table{width:100%;border-collapse:collapse;margin:12px 0}th{background:#2e4057;color:#fff;padding:6px 8px;text-align:left;font-size:10px}td{padding:5px 8px;border-bottom:1px solid #eee;font-size:10px}
.summary{margin-top:8px;width:300px;margin-left:auto}.summary-row{display:flex;justify-content:space-between;padding:3px 8px;font-size:11px}
.summary-row.sub{border-top:1px solid #ccc;padding-top:6px;margin-top:4px}.summary-row.total{border-top:2px solid #333;font-size:14px;font-weight:bold;padding-top:6px;margin-top:4px}
.notes{margin-top:20px;padding:10px;background:#fafafa;border:1px solid #ddd;border-radius:4px;font-size:10px;white-space:pre-wrap}</style>
</head><body>
<h1>発 注 書</h1>
<div class="header"><div><div class="client">${escapeHtml(po.vendor_name || '（発注先未設定）')} 御中</div>${po.vendor_address ? `<div style="margin-top:3px;font-size:10px">${escapeHtml(po.vendor_address)}</div>` : ''}</div>
<div class="meta">No. PO-${String(po.id).padStart(4, '0')}<br>発行日: ${po.issue_date}${po.delivery_date ? '<br>納期: ' + po.delivery_date : ''}
${cfg.companyName ? `<div style="margin-top:10px;border-top:1px solid #ccc;padding-top:6px"><strong>${escapeHtml(cfg.companyName)}</strong><br><span style="font-size:9px">${escapeHtml(cfg.companyAddress || '')}${cfg.companyTel ? '<br>TEL: ' + escapeHtml(cfg.companyTel) : ''}</span></div>` : ''}</div></div>
${po.construction_title ? `<div style="margin:12px 0;font-size:12px">件名: ${escapeHtml(po.construction_title)}</div>` : ''}
<div class="total-box"><span style="font-size:13px">発注金額（税込）</span><span style="font-size:22px;font-weight:bold">${fmt(totalWithTax)}</span></div>
<table><thead><tr><th style="text-align:center;width:30px">No</th><th>品名</th><th style="text-align:center;width:50px">数量</th><th style="text-align:center;width:40px">単位</th><th style="text-align:right;width:80px">単価</th><th style="text-align:right;width:90px">金額</th></tr></thead><tbody>${rows}</tbody></table>
<div class="summary"><div class="summary-row sub"><span>小計（税抜）</span><span>${fmt(itemTotal)}</span></div><div class="summary-row"><span>消費税（${Math.round(taxRate * 100)}%）</span><span>${fmt(taxAmount)}</span></div><div class="summary-row total"><span>発注金額（税込）</span><span>${fmt(totalWithTax)}</span></div></div>
${cfg.companyName ? `<div class="notes"><strong>納品先</strong><br>${escapeHtml(cfg.companyName)}<br>${escapeHtml(cfg.companyAddress || '')}${cfg.companyTel ? '<br>TEL: ' + escapeHtml(cfg.companyTel) : ''}</div>` : ''}
${po.notes ? `<div class="notes"><strong>備考</strong><br>${escapeHtml(po.notes)}</div>` : ''}
</body></html>`;
    const tmpHtml = path.join(app.getPath('temp'), `po_${Date.now()}.html`);
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(tmpHtml, Buffer.concat([bom, Buffer.from(html, 'utf-8')]));
    const pdfWin = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { defaultEncoding: 'utf-8' } });
    await pdfWin.loadURL(`file:///${tmpHtml.replace(/\\/g, '/')}`);
    await new Promise<void>(r => setTimeout(r, 1000));
    const pdf = await pdfWin.webContents.printToPDF({ printBackground: true, margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } });
    pdfWin.close();
    try { fs.unlinkSync(tmpHtml); } catch(_) {}
    const savePath = await dialog.showSaveDialog({ defaultPath: `発注書_${po.vendor_name || '未設定'}_${po.issue_date}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!savePath.canceled && savePath.filePath) { fs.writeFileSync(savePath.filePath, pdf); shell.openPath(savePath.filePath); }
  });

  // ── 予実管理 ──
  ipcMain.handle('budget:summary', () => {
    const tid = getCurrentTenant();
    const rows = queryAll(`SELECT c.id, c.title, c.status, c.labor_cost, c.markup_rate, c.fixed_selling_price, c.actual_selling_price, c.actual_labor_cost, c.actual_material_cost,
      p.name as property_name,
      (SELECT COALESCE(SUM(cm.quantity * cm.unit_price), 0) FROM construction_materials cm WHERE cm.construction_id = c.id) as est_material,
      (SELECT COALESCE(SUM(a.daily_rate * a.hours / 8), 0) FROM attendance a WHERE a.construction_id = c.id AND a.tenant_id = ?) as actual_labor_from_attendance,
      (SELECT COALESCE(SUM(po.amount), 0) FROM purchase_orders po WHERE po.construction_id = c.id AND po.tenant_id = ? AND po.status != 'cancelled') as purchase_ordered,
      (SELECT COALESCE(SUM(inv.amount), 0) FROM invoices inv WHERE inv.construction_id = c.id AND inv.tenant_id = ?) as invoiced
      FROM constructions c LEFT JOIN properties p ON c.property_id = p.id WHERE c.tenant_id = ? ORDER BY c.id DESC`,
      [tid, tid, tid, tid]);
    return rows.map((r: any) => {
      const estMaterial = r.est_material || 0;
      const estLabor = r.labor_cost || 0;
      const estCost = estMaterial + estLabor;
      const estSelling = r.fixed_selling_price || Math.round(estCost * (r.markup_rate || 1.3));
      const estProfit = estSelling - estCost;
      const actMaterial = r.actual_material_cost || estMaterial;
      const actLabor = r.actual_labor_cost || r.actual_labor_from_attendance || 0;
      const actSelling = r.actual_selling_price || r.invoiced || 0;
      const actCost = actMaterial + actLabor;
      const actProfit = actSelling - actCost;
      return {
        id: r.id, title: r.title, status: r.status, property_name: r.property_name,
        estimated: { material: estMaterial, labor: estLabor, selling: estSelling, profit: estProfit },
        actual: { material: actMaterial, labor: actLabor, selling: actSelling, profit: actProfit },
        diff: { material: estMaterial - actMaterial, labor: estLabor - actLabor, selling: estSelling - actSelling, profit: estProfit - actProfit },
        invoiced: r.invoiced || 0, purchaseOrdered: r.purchase_ordered || 0,
      };
    });
  });

  // 予実の実績を編集 → 学習ループ発火
  ipcMain.handle('budget:updateActual', (_e, data: any) => {
    const cid = data.construction_id;
    const tid = getCurrentTenant();
    // constructions テーブルに実績値を保存
    runSql('UPDATE constructions SET actual_selling_price=?, actual_material_cost=?, actual_labor_cost=?, status=? WHERE id=? AND tenant_id=?',
      [data.actual_selling_price || null, data.actual_material_cost || null, data.actual_labor_cost || null, data.status || '完了', cid, tid]);

    // estimate_log にフィードバック → 学習ループ
    try {
      const log = queryOne('SELECT id, ai_material_cost, ai_labor_cost, ai_total, work_type FROM estimate_log WHERE construction_id = ?', [cid]);
      if (log) {
        const actMat = data.actual_material_cost || 0;
        const actLabor = data.actual_labor_cost || 0;
        const actSelling = data.actual_selling_price || 0;
        const totalCost = actMat + actLabor;
        const markupRate = totalCost > 0 ? actSelling / totalCost : 1.3;
        const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
        runSql('UPDATE estimate_log SET actual_material_cost=?, actual_labor_cost=?, actual_selling_price=?, actual_markup_rate=?, feedback_at=? WHERE id=?',
          [actMat, actLabor, actSelling, markupRate, now, log.id]);

        // Supabase送信 → 係数更新
        const config = loadApiConfig();
        sendFeedbackToSupabase([{
          work_type: log.work_type || '不明',
          ai_material_cost: log.ai_material_cost, ai_labor_cost: log.ai_labor_cost, ai_total: log.ai_total,
          actual_material_cost: actMat, actual_labor_cost: actLabor, actual_selling_price: actSelling,
          actual_markup_rate: markupRate, accuracy_ratio: log.ai_total > 0 ? actSelling / log.ai_total : null,
        }]).then(() => analyzeAndUpdateCoefficients(config.anthropicKey))
          .then(() => console.log('学習ループ（予実管理）: 係数更新完了'))
          .catch((e: any) => console.error('学習ループ（予実管理）エラー:', e));
      }
    } catch (_) {}
  });

  // ── 日報管理 ──
  ipcMain.handle('dailyReports:list', (_e, filter: any) => {
    const tid = getCurrentTenant();
    if (filter?.construction_id) {
      return queryAll(`SELECT dr.*, c.title as construction_title FROM daily_reports dr
        LEFT JOIN constructions c ON dr.construction_id = c.id
        WHERE dr.tenant_id = ? AND dr.construction_id = ? ORDER BY dr.report_date DESC`, [tid, filter.construction_id]);
    }
    if (filter?.month) {
      return queryAll(`SELECT dr.*, c.title as construction_title FROM daily_reports dr
        LEFT JOIN constructions c ON dr.construction_id = c.id
        WHERE dr.tenant_id = ? AND dr.report_date LIKE ? ORDER BY dr.report_date DESC`, [tid, filter.month + '%']);
    }
    return queryAll(`SELECT dr.*, c.title as construction_title FROM daily_reports dr
      LEFT JOIN constructions c ON dr.construction_id = c.id
      WHERE dr.tenant_id = ? ORDER BY dr.report_date DESC LIMIT 100`, [tid]);
  });
  ipcMain.handle('dailyReports:create', (_e, data: any) => {
    return runSql(`INSERT INTO daily_reports (tenant_id, construction_id, report_date, weather, temp_min, temp_max, progress, work_content, safety_notes, tomorrow_plan, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [getCurrentTenant(), data.construction_id || null, data.report_date, data.weather || '晴れ',
       data.temp_min || null, data.temp_max || null, data.progress || 0,
       data.work_content || '', data.safety_notes || '', data.tomorrow_plan || '', data.notes || '']);
  });
  ipcMain.handle('dailyReports:update', (_e, data: any) => {
    runSql(`UPDATE daily_reports SET construction_id=?, report_date=?, weather=?, temp_min=?, temp_max=?, progress=?, work_content=?, safety_notes=?, tomorrow_plan=?, notes=?
      WHERE id=? AND tenant_id=?`,
      [data.construction_id, data.report_date, data.weather, data.temp_min, data.temp_max, data.progress,
       data.work_content, data.safety_notes, data.tomorrow_plan, data.notes, data.id, getCurrentTenant()]);
  });
  ipcMain.handle('dailyReports:delete', (_e, id: number) => {
    runSql('DELETE FROM daily_reports WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
  });
  ipcMain.handle('dailyReports:generatePDF', async (_e, data: any) => {
    const tid = getCurrentTenant();
    const reports = queryAll(`SELECT dr.*, c.title as construction_title FROM daily_reports dr
      LEFT JOIN constructions c ON dr.construction_id = c.id
      WHERE dr.tenant_id = ? AND dr.report_date >= ? AND dr.report_date <= ?
      ${data.construction_id ? 'AND dr.construction_id = ' + Number(data.construction_id) : ''}
      ORDER BY dr.report_date`, [tid, data.startDate, data.endDate]);
    const weatherIcon = (w: string) => ({ '晴れ': '☀️', '曇り': '☁️', '雨': '🌧️', '雪': '❄️' }[w] || w);
    const cfg = loadApiConfig();
    let rows = reports.map((r: any) => `<tr>
      <td>${r.report_date}</td><td style="text-align:center">${weatherIcon(r.weather)} ${r.weather}</td>
      <td>${r.temp_min != null ? r.temp_min + '〜' + r.temp_max + '℃' : '—'}</td>
      <td>${escapeHtml(r.construction_title || '—')}</td>
      <td style="text-align:center">${r.progress}%</td>
      <td style="font-size:9px">${escapeHtml(r.work_content || '')}</td>
      <td style="font-size:9px">${escapeHtml(r.safety_notes || '')}</td>
    </tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Yu Gothic','Meiryo',sans-serif;padding:30px;font-size:10px}
h1{text-align:center;font-size:20px;margin-bottom:16px}table{width:100%;border-collapse:collapse}th{background:#2e4057;color:#fff;padding:6px;font-size:9px}td{padding:4px 6px;border-bottom:1px solid #ddd;font-size:9px;vertical-align:top}
.meta{text-align:right;font-size:10px;margin-bottom:12px}</style></head><body>
<h1>作 業 日 報</h1>
<div class="meta">${cfg.companyName ? escapeHtml(cfg.companyName) + '<br>' : ''}期間: ${data.startDate} ～ ${data.endDate}</div>
<table><thead><tr><th>日付</th><th>天候</th><th>気温</th><th>施工案件</th><th>進捗</th><th>作業内容</th><th>安全事項</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
    const tmpHtml = path.join(app.getPath('temp'), `report_${Date.now()}.html`);
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(tmpHtml, Buffer.concat([bom, Buffer.from(html, 'utf-8')]));
    const pdfWin = new BrowserWindow({ show: false, width: 1123, height: 794, webPreferences: { defaultEncoding: 'utf-8' } });
    await pdfWin.loadURL(`file:///${tmpHtml.replace(/\\/g, '/')}`);
    await new Promise<void>(r => setTimeout(r, 800));
    const pdf = await pdfWin.webContents.printToPDF({ landscape: true, printBackground: true, margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } });
    pdfWin.close();
    try { fs.unlinkSync(tmpHtml); } catch(_) {}
    const savePath = await dialog.showSaveDialog({ defaultPath: `日報_${data.startDate}_${data.endDate}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!savePath.canceled && savePath.filePath) { fs.writeFileSync(savePath.filePath, pdf); shell.openPath(savePath.filePath); }
  });

  // ── 工程表（ガントチャート） ──
  ipcMain.handle('gantt:list', (_e, filter: any) => {
    const tid = getCurrentTenant();
    if (filter?.construction_id) {
      return queryAll(`SELECT gt.*, c.title as construction_title FROM gantt_tasks gt
        LEFT JOIN constructions c ON gt.construction_id = c.id
        WHERE gt.tenant_id = ? AND gt.construction_id = ? ORDER BY gt.sort_order, gt.start_date`, [tid, filter.construction_id]);
    }
    return queryAll(`SELECT gt.*, c.title as construction_title FROM gantt_tasks gt
      LEFT JOIN constructions c ON gt.construction_id = c.id
      WHERE gt.tenant_id = ? ORDER BY gt.sort_order, gt.start_date`, [tid]);
  });
  ipcMain.handle('gantt:create', (_e, data: any) => {
    return runSql(`INSERT INTO gantt_tasks (tenant_id, construction_id, task_name, assignee, start_date, end_date, progress, color, dependencies, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [getCurrentTenant(), data.construction_id || null, data.task_name, data.assignee || '',
       data.start_date, data.end_date, data.progress || 0, data.color || '#3498db', data.dependencies || '', data.sort_order || 0]);
  });
  ipcMain.handle('gantt:update', (_e, data: any) => {
    runSql(`UPDATE gantt_tasks SET construction_id=?, task_name=?, assignee=?, start_date=?, end_date=?, progress=?, color=?, dependencies=?, sort_order=?
      WHERE id=? AND tenant_id=?`,
      [data.construction_id, data.task_name, data.assignee, data.start_date, data.end_date, data.progress, data.color, data.dependencies, data.sort_order, data.id, getCurrentTenant()]);
  });
  ipcMain.handle('gantt:delete', (_e, id: number) => {
    runSql('DELETE FROM gantt_tasks WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
  });

  // ── 安全書類（グリーンファイル） ──
  ipcMain.handle('safety:listWorkers', () => {
    const tid = getCurrentTenant();
    return queryAll(`SELECT w.*, si.blood_type, si.emergency_contact, si.emergency_tel, si.health_check_date, si.insurance_type, si.certifications
      FROM workers w LEFT JOIN safety_worker_info si ON si.worker_id = w.id WHERE w.tenant_id = ? ORDER BY w.name`, [tid]);
  });
  ipcMain.handle('safety:updateInfo', (_e, data: any) => {
    const existing = queryOne('SELECT id FROM safety_worker_info WHERE worker_id=?', [data.worker_id]);
    if (existing) {
      runSql('UPDATE safety_worker_info SET blood_type=?, emergency_contact=?, emergency_tel=?, health_check_date=?, insurance_type=?, certifications=? WHERE worker_id=?',
        [data.blood_type, data.emergency_contact, data.emergency_tel, data.health_check_date, data.insurance_type, data.certifications, data.worker_id]);
    } else {
      runSql('INSERT INTO safety_worker_info (worker_id, blood_type, emergency_contact, emergency_tel, health_check_date, insurance_type, certifications) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [data.worker_id, data.blood_type, data.emergency_contact, data.emergency_tel, data.health_check_date, data.insurance_type, data.certifications]);
    }
  });
  ipcMain.handle('safety:listEducation', (_e, filter: any) => {
    const tid = getCurrentTenant();
    if (filter?.construction_id) {
      return queryAll(`SELECT se.*, w.name as worker_name, c.title as construction_title FROM safety_education se
        LEFT JOIN workers w ON se.worker_id = w.id LEFT JOIN constructions c ON se.construction_id = c.id
        WHERE se.tenant_id = ? AND se.construction_id = ? ORDER BY se.education_date DESC`, [tid, filter.construction_id]);
    }
    return queryAll(`SELECT se.*, w.name as worker_name, c.title as construction_title FROM safety_education se
      LEFT JOIN workers w ON se.worker_id = w.id LEFT JOIN constructions c ON se.construction_id = c.id
      WHERE se.tenant_id = ? ORDER BY se.education_date DESC LIMIT 200`, [tid]);
  });
  ipcMain.handle('safety:createEducation', (_e, data: any) => {
    return runSql('INSERT INTO safety_education (tenant_id, construction_id, worker_id, education_date, instructor, content) VALUES (?, ?, ?, ?, ?, ?)',
      [getCurrentTenant(), data.construction_id || null, data.worker_id || null, data.education_date, data.instructor || '', data.content || '']);
  });
  ipcMain.handle('safety:deleteEducation', (_e, id: number) => {
    runSql('DELETE FROM safety_education WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
  });
  ipcMain.handle('safety:listKY', (_e, filter: any) => {
    const tid = getCurrentTenant();
    if (filter?.construction_id) {
      return queryAll(`SELECT ky.*, c.title as construction_title FROM ky_records ky
        LEFT JOIN constructions c ON ky.construction_id = c.id
        WHERE ky.tenant_id = ? AND ky.construction_id = ? ORDER BY ky.activity_date DESC`, [tid, filter.construction_id]);
    }
    return queryAll(`SELECT ky.*, c.title as construction_title FROM ky_records ky
      LEFT JOIN constructions c ON ky.construction_id = c.id
      WHERE ky.tenant_id = ? ORDER BY ky.activity_date DESC LIMIT 200`, [tid]);
  });
  ipcMain.handle('safety:createKY', (_e, data: any) => {
    return runSql('INSERT INTO ky_records (tenant_id, construction_id, activity_date, participants, hazard, countermeasures, leader) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [getCurrentTenant(), data.construction_id || null, data.activity_date, data.participants || '', data.hazard || '', data.countermeasures || '', data.leader || '']);
  });
  ipcMain.handle('safety:deleteKY', (_e, id: number) => {
    runSql('DELETE FROM ky_records WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
  });
  ipcMain.handle('safety:generatePDF', async (_e, data: any) => {
    const tid = getCurrentTenant();
    const cfg = loadApiConfig();
    let html = '';
    const conTitle = data.construction_id ? queryOne('SELECT title FROM constructions WHERE id=?', [data.construction_id])?.title || '' : '全案件';

    if (data.type === 'worker_list') {
      const workers = queryAll(`SELECT w.*, si.blood_type, si.emergency_contact, si.emergency_tel, si.health_check_date, si.insurance_type, si.certifications
        FROM workers w LEFT JOIN safety_worker_info si ON si.worker_id = w.id WHERE w.tenant_id = ? ORDER BY w.name`, [tid]);
      let rows = workers.map((w: any) => `<tr>
        <td>${escapeHtml(w.name)}</td><td>${escapeHtml(w.role || '')}</td><td style="text-align:center">${escapeHtml(w.blood_type || '—')}</td>
        <td>${escapeHtml(w.emergency_contact || '—')}</td><td>${escapeHtml(w.emergency_tel || '—')}</td>
        <td>${escapeHtml(w.health_check_date || '—')}</td><td>${escapeHtml(w.insurance_type || '—')}</td>
        <td style="font-size:8px">${escapeHtml(w.certifications || '—')}</td>
      </tr>`).join('');
      html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Yu Gothic','Meiryo',sans-serif;padding:30px;font-size:10px}
h1{text-align:center;font-size:18px;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#2e4057;color:#fff;padding:5px;font-size:9px}td{padding:4px;border-bottom:1px solid #ddd;font-size:9px}
.meta{text-align:right;font-size:10px;margin-bottom:10px}</style></head><body>
<h1>作業員名簿</h1><div class="meta">${cfg.companyName ? escapeHtml(cfg.companyName) : ''}</div>
<table><thead><tr><th>氏名</th><th>職種</th><th>血液型</th><th>緊急連絡先</th><th>連絡先TEL</th><th>健康診断日</th><th>保険種別</th><th>保有資格</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    } else if (data.type === 'education') {
      const records = queryAll(`SELECT se.*, w.name as worker_name, c.title as construction_title FROM safety_education se
        LEFT JOIN workers w ON se.worker_id = w.id LEFT JOIN constructions c ON se.construction_id = c.id
        WHERE se.tenant_id = ? ${data.construction_id ? 'AND se.construction_id = ' + Number(data.construction_id) : ''} ORDER BY se.education_date DESC`, [tid]);
      let rows = records.map((r: any) => `<tr>
        <td>${r.education_date}</td><td>${escapeHtml(r.construction_title || '—')}</td><td>${escapeHtml(r.worker_name || '—')}</td>
        <td>${escapeHtml(r.instructor || '—')}</td><td style="font-size:8px">${escapeHtml(r.content || '')}</td>
      </tr>`).join('');
      html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Yu Gothic','Meiryo',sans-serif;padding:30px;font-size:10px}
h1{text-align:center;font-size:18px;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#2e4057;color:#fff;padding:5px;font-size:9px}td{padding:4px;border-bottom:1px solid #ddd;font-size:9px}
.meta{text-align:right;font-size:10px;margin-bottom:10px}</style></head><body>
<h1>新規入場者教育記録</h1><div class="meta">${escapeHtml(conTitle)}<br>${cfg.companyName ? escapeHtml(cfg.companyName) : ''}</div>
<table><thead><tr><th>教育日</th><th>施工案件</th><th>受講者</th><th>教育担当</th><th>教育内容</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    } else if (data.type === 'ky') {
      const records = queryAll(`SELECT ky.*, c.title as construction_title FROM ky_records ky
        LEFT JOIN constructions c ON ky.construction_id = c.id
        WHERE ky.tenant_id = ? ${data.construction_id ? 'AND ky.construction_id = ' + Number(data.construction_id) : ''} ORDER BY ky.activity_date DESC`, [tid]);
      let rows = records.map((r: any) => `<tr>
        <td>${r.activity_date}</td><td>${escapeHtml(r.construction_title || '—')}</td><td>${escapeHtml(r.leader || '—')}</td>
        <td>${escapeHtml(r.participants || '—')}</td><td>${escapeHtml(r.hazard || '')}</td><td>${escapeHtml(r.countermeasures || '')}</td>
      </tr>`).join('');
      html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Yu Gothic','Meiryo',sans-serif;padding:30px;font-size:10px}
h1{text-align:center;font-size:18px;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#2e4057;color:#fff;padding:5px;font-size:9px}td{padding:4px;border-bottom:1px solid #ddd;font-size:9px}
.meta{text-align:right;font-size:10px;margin-bottom:10px}</style></head><body>
<h1>KY活動記録（危険予知活動）</h1><div class="meta">${escapeHtml(conTitle)}<br>${cfg.companyName ? escapeHtml(cfg.companyName) : ''}</div>
<table><thead><tr><th>実施日</th><th>施工案件</th><th>リーダー</th><th>参加者</th><th>危険要因</th><th>対策</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    }
    if (!html) return;
    const tmpHtml = path.join(app.getPath('temp'), `safety_${Date.now()}.html`);
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(tmpHtml, Buffer.concat([bom, Buffer.from(html, 'utf-8')]));
    const pdfWin = new BrowserWindow({ show: false, width: 1123, height: 794, webPreferences: { defaultEncoding: 'utf-8' } });
    await pdfWin.loadURL(`file:///${tmpHtml.replace(/\\/g, '/')}`);
    await new Promise<void>(r => setTimeout(r, 800));
    const pdf = await pdfWin.webContents.printToPDF({ landscape: true, printBackground: true, margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } });
    pdfWin.close();
    try { fs.unlinkSync(tmpHtml); } catch(_) {}
    const typeLabel = { worker_list: '作業員名簿', education: '新規入場者教育', ky: 'KY活動記録' }[data.type as string] || '安全書類';
    const savePath = await dialog.showSaveDialog({ defaultPath: `${typeLabel}_${new Date().toISOString().split('T')[0]}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!savePath.canceled && savePath.filePath) { fs.writeFileSync(savePath.filePath, pdf); shell.openPath(savePath.filePath); }
  });

  // ── 見積比較 ──
  ipcMain.handle('quotes:listComparisons', (_e, cid?: number) => {
    const tid = getCurrentTenant();
    if (cid) {
      return queryAll(`SELECT qc.*, c.title as construction_title FROM quote_comparisons qc
        LEFT JOIN constructions c ON qc.construction_id = c.id WHERE qc.tenant_id = ? AND qc.construction_id = ? ORDER BY qc.id DESC`, [tid, cid]);
    }
    return queryAll(`SELECT qc.*, c.title as construction_title FROM quote_comparisons qc
      LEFT JOIN constructions c ON qc.construction_id = c.id WHERE qc.tenant_id = ? ORDER BY qc.id DESC`, [tid]);
  });
  ipcMain.handle('quotes:createComparison', (_e, data: any) => {
    return runSql('INSERT INTO quote_comparisons (tenant_id, construction_id, title) VALUES (?, ?, ?)',
      [getCurrentTenant(), data.construction_id || null, data.title || '見積比較']);
  });
  ipcMain.handle('quotes:deleteComparison', (_e, id: number) => {
    runSql('DELETE FROM quote_comparisons WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
  });
  ipcMain.handle('quotes:addVendor', (_e, data: any) => {
    const vendorId = runSql('INSERT INTO quote_vendors (comparison_id, vendor_name, notes) VALUES (?, ?, ?)',
      [data.comparison_id, data.vendor_name, data.notes || '']);
    if (data.items?.length) {
      for (const item of data.items) {
        runSql('INSERT INTO quote_vendor_items (vendor_id, name, quantity, unit, unit_price) VALUES (?, ?, ?, ?, ?)',
          [vendorId, item.name, item.quantity || 1, item.unit || '式', item.unit_price || 0]);
      }
    }
    return vendorId;
  });
  ipcMain.handle('quotes:deleteVendor', (_e, id: number) => {
    runSql('DELETE FROM quote_vendors WHERE id=?', [id]);
  });
  ipcMain.handle('quotes:getDetail', (_e, id: number) => {
    const comp = queryOne(`SELECT qc.*, c.title as construction_title FROM quote_comparisons qc
      LEFT JOIN constructions c ON qc.construction_id = c.id WHERE qc.id=? AND qc.tenant_id=?`, [id, getCurrentTenant()]);
    if (!comp) return null;
    const vendors = queryAll('SELECT * FROM quote_vendors WHERE comparison_id=? ORDER BY id', [id]);
    for (const v of vendors) {
      (v as any).items = queryAll('SELECT * FROM quote_vendor_items WHERE vendor_id=? ORDER BY id', [v.id]);
      (v as any).total = ((v as any).items as any[]).reduce((s: number, i: any) => s + (i.quantity || 1) * (i.unit_price || 0), 0);
    }
    return { ...comp, vendors };
  });
  ipcMain.handle('quotes:generatePDF', async (_e, data: any) => {
    const detail = queryOne(`SELECT qc.*, c.title as construction_title FROM quote_comparisons qc
      LEFT JOIN constructions c ON qc.construction_id = c.id WHERE qc.id=? AND qc.tenant_id=?`, [data.comparison_id, getCurrentTenant()]);
    if (!detail) return;
    const vendors = queryAll('SELECT * FROM quote_vendors WHERE comparison_id=? ORDER BY id', [data.comparison_id]);
    for (const v of vendors) {
      (v as any).items = queryAll('SELECT * FROM quote_vendor_items WHERE vendor_id=? ORDER BY id', [v.id]);
      (v as any).total = ((v as any).items as any[]).reduce((s: number, i: any) => s + (i.quantity || 1) * (i.unit_price || 0), 0);
    }
    const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();
    const cfg = loadApiConfig();
    const vHeaders = vendors.map((v: any) => `<th style="text-align:right">${escapeHtml(v.vendor_name)}</th>`).join('');
    // Collect all unique item names
    const allItems: string[] = [];
    for (const v of vendors) { for (const item of (v as any).items) { if (!allItems.includes(item.name)) allItems.push(item.name); } }
    let rows = allItems.map((itemName: string) => {
      const cells = vendors.map((v: any) => {
        const item = (v as any).items.find((i: any) => i.name === itemName);
        return `<td style="text-align:right">${item ? fmt(item.quantity * item.unit_price) : '—'}</td>`;
      }).join('');
      return `<tr><td>${escapeHtml(itemName)}</td>${cells}</tr>`;
    }).join('');
    const totals = vendors.map((v: any) => `<td style="text-align:right;font-weight:bold">${fmt((v as any).total)}</td>`).join('');
    rows += `<tr style="border-top:2px solid #333;background:#f5f5f5"><td><strong>合計</strong></td>${totals}</tr>`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Yu Gothic','Meiryo',sans-serif;padding:30px;font-size:10px}
h1{text-align:center;font-size:18px;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#2e4057;color:#fff;padding:5px;font-size:9px}td{padding:4px;border-bottom:1px solid #ddd;font-size:9px}
.meta{text-align:right;font-size:10px;margin-bottom:10px}</style></head><body>
<h1>見 積 比 較 表</h1>
<div class="meta">${cfg.companyName ? escapeHtml(cfg.companyName) + '<br>' : ''}${escapeHtml(detail.construction_title || '')}<br>${new Date().toISOString().split('T')[0]}</div>
<table><thead><tr><th>項目</th>${vHeaders}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const tmpHtml = path.join(app.getPath('temp'), `quote_cmp_${Date.now()}.html`);
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(tmpHtml, Buffer.concat([bom, Buffer.from(html, 'utf-8')]));
    const pdfWin = new BrowserWindow({ show: false, width: 1123, height: 794, webPreferences: { defaultEncoding: 'utf-8' } });
    await pdfWin.loadURL(`file:///${tmpHtml.replace(/\\/g, '/')}`);
    await new Promise<void>(r => setTimeout(r, 800));
    const pdf = await pdfWin.webContents.printToPDF({ landscape: true, printBackground: true, margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } });
    pdfWin.close();
    try { fs.unlinkSync(tmpHtml); } catch(_) {}
    const savePath = await dialog.showSaveDialog({ defaultPath: `見積比較_${detail.title || ''}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!savePath.canceled && savePath.filePath) { fs.writeFileSync(savePath.filePath, pdf); shell.openPath(savePath.filePath); }
  });

  // ── 写真台帳 ──
  ipcMain.handle('photoLedger:list', (_e, filter: any) => {
    const tid = getCurrentTenant();
    let where = 'pl.tenant_id = ?';
    const params: any[] = [tid];
    if (filter?.construction_id) { where += ' AND pl.construction_id = ?'; params.push(filter.construction_id); }
    if (filter?.category) { where += ' AND pl.category = ?'; params.push(filter.category); }
    if (filter?.work_type) { where += ' AND pl.work_type = ?'; params.push(filter.work_type); }
    return queryAll(`SELECT pl.*, c.title as construction_title FROM photo_ledger pl
      LEFT JOIN constructions c ON pl.construction_id = c.id WHERE ${where} ORDER BY pl.work_type, pl.photo_date DESC, pl.id DESC`, params);
  });
  ipcMain.handle('photoLedger:add', (_e, data: any) => {
    return runSql('INSERT INTO photo_ledger (tenant_id, construction_id, photo_data, category, work_type, location, photo_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [getCurrentTenant(), data.construction_id, data.photo_data, data.category || '施工中', data.work_type || 'その他',
       data.location || '', data.photo_date || new Date().toISOString().split('T')[0], data.notes || '']);
  });
  ipcMain.handle('photoLedger:delete', (_e, id: number) => {
    runSql('DELETE FROM photo_ledger WHERE id=? AND tenant_id=?', [id, getCurrentTenant()]);
  });
  ipcMain.handle('photoLedger:generatePDF', async (_e, data: any) => {
    const tid = getCurrentTenant();
    let where = 'pl.tenant_id = ?';
    const params: any[] = [tid];
    if (data.construction_id) { where += ' AND pl.construction_id = ?'; params.push(data.construction_id); }
    if (data.category) { where += ' AND pl.category = ?'; params.push(data.category); }
    if (data.work_type) { where += ' AND pl.work_type = ?'; params.push(data.work_type); }
    const photos = queryAll(`SELECT pl.*, c.title as construction_title FROM photo_ledger pl
      LEFT JOIN constructions c ON pl.construction_id = c.id WHERE ${where} ORDER BY pl.work_type, pl.photo_date`, params);
    const cfg = loadApiConfig();
    const conTitle = data.construction_id ? queryOne('SELECT title FROM constructions WHERE id=?', [data.construction_id])?.title || '' : '全案件';
    const catColor: Record<string, string> = { '着工前': '#3498db', '施工中': '#e67e22', '完了': '#27ae60', '是正前': '#e74c3c', '是正後': '#9b59b6', '検査': '#7f8c8d' };
    // 6 photos per page (2x3)
    let pages = '';
    for (let i = 0; i < photos.length; i += 6) {
      const chunk = photos.slice(i, i + 6);
      let cells = chunk.map((p: any) => `<div style="width:48%;border:1px solid #ddd;border-radius:4px;overflow:hidden;margin-bottom:8px">
        <div style="height:180px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;overflow:hidden">
          ${p.photo_data ? `<img src="${p.photo_data}" style="max-width:100%;max-height:180px;object-fit:contain">` : '<span style="color:#999">写真なし</span>'}
        </div>
        <div style="padding:6px;font-size:9px">
          <span style="background:${catColor[p.category] || '#999'};color:#fff;padding:1px 6px;border-radius:8px;font-size:8px">${escapeHtml(p.category)}</span>
          <span style="margin-left:4px;color:#555">${escapeHtml(p.work_type || '')}</span><br>
          <span>${p.photo_date || ''} | ${escapeHtml(p.location || '')}</span><br>
          <span style="color:#666">${escapeHtml(p.notes || '')}</span>
        </div>
      </div>`).join('');
      pages += `<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;${i > 0 ? 'page-break-before:always;' : ''}">${cells}</div>`;
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Yu Gothic','Meiryo',sans-serif;padding:25px;font-size:10px}
h1{text-align:center;font-size:18px;margin-bottom:8px}.meta{text-align:right;font-size:10px;margin-bottom:12px}</style></head><body>
<h1>現場写真台帳</h1><div class="meta">${escapeHtml(conTitle)}<br>${cfg.companyName ? escapeHtml(cfg.companyName) : ''}<br>${new Date().toISOString().split('T')[0]}</div>
${pages}</body></html>`;
    const tmpHtml = path.join(app.getPath('temp'), `photo_${Date.now()}.html`);
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(tmpHtml, Buffer.concat([bom, Buffer.from(html, 'utf-8')]));
    const pdfWin = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { defaultEncoding: 'utf-8' } });
    await pdfWin.loadURL(`file:///${tmpHtml.replace(/\\/g, '/')}`);
    await new Promise<void>(r => setTimeout(r, 1200));
    const pdf = await pdfWin.webContents.printToPDF({ printBackground: true, margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } });
    pdfWin.close();
    try { fs.unlinkSync(tmpHtml); } catch(_) {}
    const savePath = await dialog.showSaveDialog({ defaultPath: `写真台帳_${conTitle}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
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
      "category": "推定カテゴリ（木材/基礎/屋根/外壁/内装/設備/電気/水道/解体/耐震/仮設/外構/造園/足場/養生/仮囲い/重機リース/運搬/産廃処理/技能者報酬/技術者報酬/その他）"
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
    const ocrResult = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    sendUsageNotification('OCR取込', `書類種別: ${ocrResult.documentType || '不明'}, 金額: ${ocrResult.total || '不明'}円`);
    return ocrResult;
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
    // Supabase係数が取得できなかった場合は空文字のまま（ローカル実績統計で補完）

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: config.anthropicKey });

    const hasComment = comment && comment.trim().length > 0;
    const hasImage = imageBase64 && imageBase64.length > 0;
    const hasLocation = location && location.trim().length > 0;
    const industryType = config.industryType || 'general';

    // 業種別のAI指示
    const industryPrompt = industryType === 'lease'
      ? `\n## ★業種: 仮設工事リース業★
この会社は仮設工事一式のリース業です。見積もりは以下の観点を重視してください:
- 足場（くさび式・枠組・単管）のリース費用を架面積から正確に算出
- 養生シート・防音シート・仮囲いの面積を算出してリース費用を計上
- 仮設トイレ・仮設事務所・仮設電気水道のリース月額を工期から算出
- 重機（バックホー・高所作業車・クレーン）のリース日数×日額で算出
- 運搬費（回送費・トラック）を距離と台数から算出
- 鳶工・ガードマンの人工を日数×人数で算出
- 産廃処理費をm³数から算出
- 相場DBの「仮設工事リース 費用一覧」セクションの単価を必ず参照すること
- breakdownの各項目は「リース日数×日額」「月数×月額」「面積×m²単価」等の根拠をnoteに記載\n`
      : industryType === 'demolition'
      ? `\n## ★業種: 解体工事業★
この会社は解体工事業です。解体坪単価・産廃処理費・仮設足場・重機回送費を重視して見積もってください。\n`
      : industryType === 'exterior'
      ? `\n## ★業種: 外構・エクステリア業★
この会社は外構・エクステリア業です。駐車場・フェンス・門扉・ウッドデッキ・植栽等の外構工事を重視して見積もってください。\n`
      : industryType === 'painting'
      ? `\n## ★業種: 塗装工事業★
この会社は塗装工事業です。塗装面積・塗料グレード・足場費用を重視して見積もってください。\n`
      : industryType === 'equipment'
      ? `\n## ★業種: 設備工事業★
この会社は設備工事業（水道・電気・空調）です。設備機器の型番・施工費・配管配線工事を重視して見積もってください。\n`
      : '';

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
${industryPrompt}
## ★★★ 最重要ルール（絶対に守れ）★★★
1. breakdownには「ユーザーが依頼した工事内容」に直接関係する項目だけを入れろ
2. ユーザーが「キッチン交換」としか書いていないなら、キッチン関連の材料・施工費だけをbreakdownに入れろ。外壁・屋根・耐震・浴室など依頼されていない工事は絶対にbreakdownに入れるな
3. estimatedMaterialCost・estimatedLaborCost・estimatedTotalは依頼された工事のみの金額にしろ
4. 画像から追加で必要そうな工事を見つけた場合は「recommendations」に「○○も検討をおすすめします（参考: 約○万円）」と書け。金額計算には一切含めるな
5. コメントが空の場合のみ、画像から判断した全工事を見積もれ
6. ★必須★ breakdownには以下の3項目を必ず最後に含めろ（2025-2026年の建設業界情勢を反映した現実的な金額にすること。資材高騰・人件費上昇・働き方改革による人手不足を考慮）:
   - 「仮設工事」: 相場DBの「仮設工事リース 費用一覧」セクションを参照し、工事規模に応じて以下を積算すること:
     * 足場: くさび式650〜1,400円/m²（養生込み）、枠組1,000〜2,000円/m²。架面積から算出
     * 養生: メッシュシート100〜200円/m²、防音シート2,000〜5,000円/m²（住宅密集地）
     * 仮囲い: 安全鋼板3,200〜6,800円/m（高さ別）
     * 仮設トイレ: 簡易水洗洋式20,000〜40,000円/月 + 設置撤去各20,000〜50,000円
     * 仮設電気水道: 電気引込55,000〜300,000円、水道50,000〜150,000円
     * 交通誘導員: 有資格20,000〜25,000円/人日、無資格16,000〜20,000円/人日
     * 重機回送費: ミニ15,000〜30,000円/片道、中型20,000〜40,000円/片道
     直接工事費の8〜15%。最低でも5万円以上。数量×単価で積算しろ
   - 「現場管理費」（現場監督人件費・安全管理・品質管理・書類作成・近隣対応等。直接工事費の10〜15%。最低でも8万円以上）
   - 「福利厚生費」（法定福利費・社会保険・雇用保険・退職金積立等。人件費の15〜20%。2024年問題で上昇中。最低でも3万円以上）

## 過去の施工実績（${totalCount}件のデータベースから集約）
${pastWorkSummary || 'まだ実績なし'}

※上記は${totalCount}件の実績データを工事タイプ別に集約した統計値です。この統計を見積もりの根拠として活用してください。
${feedbackSummary}
${globalStats}
${(() => {
  const chatMemos = queryAll('SELECT category, key, value FROM chat_learnings WHERE tenant_id = ? ORDER BY category', [getCurrentTenant()]);
  if (chatMemos.length === 0) return '';
  return '\n## ★ この会社の好み・傾向（チャットから学習済み）★\n以下はこの会社のユーザーがチャットで伝えた好みです。必ず反映してください。\n' +
    chatMemos.map((m: any) => `- [${m.category}] ${m.key}: ${m.value}`).join('\n') + '\n';
})()}
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
  "estimatedDuration": "推定工期（例: '約5日', '約2週間', '約1.5ヶ月'）。全工程の着工から完了までの暦日数。並行作業を考慮して算出",
  "totalManDays": 総人工数（数値。全職種の延べ人工合計。例: 設備工2人×3日+大工1人×2日=8）,
  "manDaysBreakdown": [
    {"trade": "職種名", "workers": 人数, "days": 日数, "manDays": 人工数, "dailyRate": 日額単価}
  ],
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

manDaysBreakdownの書き方例:
- {"trade": "設備工（レベル3）", "workers": 2, "days": 3, "manDays": 6, "dailyRate": 30300}
- {"trade": "大工（レベル2）", "workers": 1, "days": 1, "manDays": 1, "dailyRate": 25800}
- {"trade": "電気工（レベル2）", "workers": 1, "days": 0.5, "manDays": 0.5, "dailyRate": 24800}
→ totalManDays = 7.5, estimatedDuration = "約4日"（並行作業あり）

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
      const estimateResult = JSON.parse(jsonStr);
      // メール通知（写真・コメント・見積詳細を含む）
      const notifyImages: { filename: string; content: string }[] = [];
      if (imageBase64) notifyImages.push({ filename: 'input-photo.jpg', content: imageBase64 });
      if (beforeImage) notifyImages.push({ filename: 'before.jpg', content: beforeImage });
      if (afterImage) notifyImages.push({ filename: 'after.jpg', content: afterImage });
      sendUsageNotification(opName, `工事種別: ${estimateResult.workType || '不明'}, 売価: ¥${Math.round(estimateResult.estimatedTotal || 0).toLocaleString()}`, {
        images: notifyImages,
        estimateResult,
        comment: comment || location || undefined,
      });
      // アクティビティ記録（AI見積使用）
      try {
        const os = require('os');
        const tenant = queryOne('SELECT name, credits FROM tenants WHERE id = ?', [getCurrentTenant()]);
        const actData = JSON.stringify({ company_name: tenant?.name || '不明', hostname: os.hostname(), username: os.userInfo().username, app_version: APP_VERSION, event: `ai_estimate:${estimateResult.workType || ''}`, credits_remaining: tenant?.credits || 0 });
        const https = require('https');
        const pr = https.request({ hostname: 'slhgkedzlormaovwpadi.supabase.co', path: '/rest/v1/app_activity', method: 'POST', headers: { 'apikey': 'sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Authorization': 'Bearer sb_publishable_nq8l4yeQYEHVJu-ETSa0JA_juFGv43e', 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, timeout: 5000 }, () => {});
        pr.on('error', () => {}); pr.write(actData); pr.end();
      } catch (_) {}
      return estimateResult;
    } catch (e: any) {
      throw new Error('JSON解析エラー: ' + e.message + ' / ' + jsonStr.substring(0, 200));
    }
  });

  // ── AIチャット見積（対話型）──
  ipcMain.handle('ai:chat', async (_e, data: { messages: any[], imageBase64?: string }) => {
    const creditResult = useCredits(1, 'チャット見積');
    if (!creditResult.success) {
      throw new Error('ERROR: 今月のクレジット上限に達しました。');
    }
    const config = loadApiConfig();
    if (!config.anthropicKey) throw new Error('AI機能の初期化に失敗しました。');

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: config.anthropicKey });

    // 相場DB参照用の簡易コスト情報
    const statsRows = queryAll(`
      SELECT SUBSTR(c.notes, 1, INSTR(c.notes || CHAR(10), CHAR(10)) - 1) as type_tag,
        COUNT(*) as cnt, ROUND(AVG(COALESCE(cm_total, 0))) as avg_mat, ROUND(AVG(c.labor_cost)) as avg_labor, ROUND(AVG(c.markup_rate * 100)) as avg_markup
      FROM constructions c LEFT JOIN (SELECT construction_id, SUM(quantity * unit_price) as cm_total FROM construction_materials GROUP BY construction_id) cm ON cm.construction_id = c.id
      GROUP BY SUBSTR(c.notes, 1, INSTR(c.notes || CHAR(10), CHAR(10)) - 1) HAVING cnt >= 2 ORDER BY cnt DESC LIMIT 20
    `);
    const pastWork = statsRows.map((s: any) => `${(s.type_tag||'').split('\n')[0]}: ${s.cnt}件 材料平均${Math.round(s.avg_mat||0).toLocaleString()}円 労務平均${Math.round(s.avg_labor||0).toLocaleString()}円`).join('\n');

    // 過去のチャット学習メモを取得
    const tid = getCurrentTenant();
    const learnings = queryAll('SELECT category, key, value FROM chat_learnings WHERE tenant_id = ? ORDER BY category, key', [tid]);
    const learningText = learnings.length > 0
      ? '\n## この会社の好み・傾向（過去のチャットから学習済み）\n' + learnings.map((l: any) => `- [${l.category}] ${l.key}: ${l.value}`).join('\n') + '\n\n★上記の好みを必ず反映して見積・提案してください。\n'
      : '';

    const systemPrompt = `あなたは大阪の建築見積の専門家（実務経験20年以上）です。ユーザーと対話しながら建築工事の見積を作成してください。

## ルール
- 工事内容をヒアリングして、必要な情報を質問してください（規模、材料グレード、場所など）
- 十分な情報が集まったら、見積結果をJSON形式で出力してください
- JSONを出力する場合は \`\`\`json ... \`\`\` で囲んでください
- まだ情報が足りない場合は質問を続けてください
- 親しみやすく、分かりやすい言葉で話してください
- 専門用語を使う場合は簡単な説明を添えてください
- ユーザーが好みや修正を伝えた場合、会話の最後に学習メモJSON（\`\`\`learning ... \`\`\`）を出力してください

## 見積JSON形式（十分な情報が集まった場合のみ出力）
\`\`\`json
{
  "workType": "工事の種類",
  "description": "工事内容の要約",
  "estimatedScale": "推定規模",
  "estimatedMaterialCost": 材料費,
  "estimatedLaborCost": 人件費,
  "estimatedTotal": 売価（粗利込み）,
  "confidence": "高/中/低",
  "breakdown": [{"item": "項目名", "cost": 金額, "note": "根拠"}],
  "manDaysBreakdown": [{"trade": "職種", "workers": 人数, "days": 日数, "manDays": 人工, "dailyRate": 日額}],
  "recommendations": "提案・注意点",
  "imagePrompt": "完成イメージ用英語プロンプト"
}
\`\`\`

## 粗利率ルール
- 原価500万未満: 粗利30%（掛率1.43）
- 500万〜1000万: 粗利25%（掛率1.33）
- 1000万〜3000万: 粗利20%（掛率1.25）
- 3000万以上: 粗利15%（掛率1.18）

## 学習メモ形式（ユーザーが好みや修正を伝えた場合、通常の返答に加えて以下も出力）
\`\`\`learning
[{"category":"材料","key":"塗料の好み","value":"フッ素系を優先"},{"category":"単価","key":"足場単価","value":"1,200円/m²が標準"}]
\`\`\`
categoryは: 材料 / 単価 / 工法 / 業者 / その他
★学習メモは好みや修正があった場合のみ出力。なければ出力不要。
${learningText}
## 過去実績
${pastWork || 'まだ実績なし'}`;

    const messages = data.messages.map((m: any) => {
      if (m.role === 'user' && m.image) {
        return {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: m.image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg', data: m.image.replace(/^data:image\/\w+;base64,/, '') } },
            { type: 'text', text: m.content || '写真を見て見積もりしてください' },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.3,
      system: systemPrompt,
      messages,
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    // JSONが含まれていれば見積結果として抽出
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    let estimate = null;
    if (jsonMatch) {
      try { estimate = JSON.parse(jsonMatch[1]); } catch (_) {}
    }

    // 学習メモが含まれていればDBに保存
    const learningMatch = text.match(/```learning\s*([\s\S]*?)\s*```/);
    if (learningMatch) {
      try {
        const memos = JSON.parse(learningMatch[1]);
        for (const memo of memos) {
          if (memo.category && memo.key && memo.value) {
            runSql(
              'INSERT INTO chat_learnings (tenant_id, category, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, category, key) DO UPDATE SET value=?, confidence=confidence+0.1',
              [tid, memo.category, memo.key, memo.value, memo.value]
            );
          }
        }
        console.log(`チャット学習: ${memos.length}件の好みを記憶しました`);
      } catch (_) {}
    }

    // 学習メモ部分はユーザーに見せない
    const cleanText = text.replace(/```learning[\s\S]*?```/g, '').trim();

    return { text: cleanText, estimate };
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
        sendUsageNotification('完成イメージ画像生成（編集）', `プロンプト: ${prompt.substring(0, 80)}`, {
          images: [
            { filename: 'source.jpg', content: sourceImage },
            ...(b64 ? [{ filename: 'generated.png', content: `data:image/png;base64,${b64}` }] : []),
          ],
        });
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
    sendUsageNotification('完成イメージ画像生成', `プロンプト: ${prompt.substring(0, 80)}`, {
      images: b64 ? [{ filename: 'generated.png', content: `data:image/png;base64,${b64}` }] : [],
    });
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
      const adjName = diff > 0 ? '諸経費' : '値引き';
      const adjMatId = runSql(
        'INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
        [adjName, 'AI見積', '式', diff, '明細差額の自動調整', tid]
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

  // ── フィードバック・改善要望 ──
  ipcMain.handle('feedback:list', () => listFeedbackRequests());
  ipcMain.handle('feedback:listAll', () => listAllFeedbackRequests());
  ipcMain.handle('feedback:create', async (_e, data: any) => {
    const id = createFeedbackRequest(data);
    logAudit('create', 'feedback', id, `改善要望: ${data.title}`);
    // メール通知
    try {
      const tid = getCurrentTenant();
      const tenant = queryOne('SELECT name, contact_company, contact_tel, contact_email FROM tenants WHERE id = ?', [tid]);
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: 'mitsuakinakano0215@gmail.com', pass: 'cmlz usad gycg sbem' },
      });
      await transporter.sendMail({
        from: '建築ブースト <mitsuakinakano0215@gmail.com>',
        to: 'mitsuakinakano0215@gmail.com',
        subject: `【改善要望】${tenant?.name || 'テナント'} — ${data.title}`,
        text: [
          `テナント「${tenant?.name || ''}」から改善要望が届きました。`,
          '',
          '【要望内容】',
          `■ カテゴリ: ${data.category}`,
          `■ タイトル: ${data.title}`,
          `■ 優先度: ${data.priority || 'normal'}`,
          `■ 詳細:`,
          data.description || '(なし)',
          '',
          '【お客様情報】',
          `■ 会社名: ${tenant?.contact_company || tenant?.name || '未登録'}`,
          `■ 電話番号: ${tenant?.contact_tel || '未登録'}`,
          `■ メールアドレス: ${tenant?.contact_email || '未登録'}`,
          '',
          `■ 日時: ${new Date().toLocaleString('ja-JP')}`,
          '',
          '---',
          '建築ブースト 自動通知',
        ].join('\n'),
      });
    } catch (e: any) {
      console.error('Feedback notification email failed:', e?.message || e);
    }
    return id;
  });
  ipcMain.handle('feedback:updateStatus', (_e, id: number, status: string, reply?: string) => {
    updateFeedbackStatus(id, status, reply);
    return true;
  });

  // ── 受注/失注トラッキング ──
  ipcMain.handle('outcomes:list', () => listEstimateOutcomes());
  ipcMain.handle('outcomes:create', (_e, data: any) => {
    const id = createEstimateOutcome(data);
    logAudit('create', 'outcome', id, `${data.outcome}: ${data.feedback_notes || ''}`);
    return id;
  });
  ipcMain.handle('outcomes:update', (_e, data: any) => {
    updateEstimateOutcome(data);
    logAudit('update', 'outcome', data.id, `${data.outcome}`);
    return true;
  });
  ipcMain.handle('outcomes:delete', (_e, id: number) => {
    deleteEstimateOutcome(id);
    return true;
  });
  ipcMain.handle('outcomes:stats', () => getOutcomeStats());
  ipcMain.handle('outcomes:similar', (_e, workType: string) => getSimilarEstimates(workType));

  // ── 見積共有URL生成 ──
  ipcMain.handle('estimates:shareUrl', (_e, logId: number) => {
    const log = queryOne('SELECT el.*, c.title as construction_title FROM estimate_log el LEFT JOIN constructions c ON c.id = el.construction_id WHERE el.id = ?', [logId]);
    if (!log) return null;
    const os = require('os');
    const nets = os.networkInterfaces();
    let localIp = 'localhost';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; }
      }
    }
    return {
      url: `http://${localIp}:3456/share/estimate/${logId}`,
      data: log,
    };
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
