// スマホ対応用 内蔵Webサーバー
import path from 'path';
import fs from 'fs';
import { queryAll, queryOne, runSql, getCurrentTenant } from '../database/database';

let serverUrl = '';
let getConfigFn: (() => any) | null = null;
let analyzeFn: ((data: any) => Promise<any>) | null = null;
let autoCreateFn: ((data: any) => any) | null = null;
let generateFn: ((data: any) => Promise<any>) | null = null;

// AI解析ジョブ置き場。トンネル(loca.lt)は ~20〜30秒でリクエストを502で切るため、
// 長時間のClaude解析は同期で返さず、即 jobId を返してクライアントが状態をポーリングする。
type AnalyzeJob = { status: 'pending' | 'done' | 'error'; result?: any; error?: string; createdAt: number };
const analyzeJobs = new Map<string, AnalyzeJob>();
let analyzeJobSeq = 0;

export function getServerUrl() { return serverUrl; }
// 同一WiFiでスマホから届く実LANのIPを選ぶ。
// VirtualBox/Hyper-V の host-only(192.168.56.x) や未接続APIPA(169.254.x)を除外し、
// プライベートIP(192.168 / 10 / 172.16-31)を優先する（先頭を無条件採用しない）。
export function pickLanIp(): string {
  const os = require('os');
  const nets = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of (nets[name] || [])) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ip = net.address as string;
      if (ip.startsWith('169.254.')) continue;     // APIPA（DHCP未取得＝実際は未接続）
      if (ip.startsWith('192.168.56.')) continue;   // VirtualBox host-only の定番
      if (ip.startsWith('192.168.99.')) continue;   // VirtualBox/docker-machine の定番
      candidates.push(ip);
    }
  }
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return candidates.find(isPrivate) || candidates[0] || 'localhost';
}
export function setConfigLoader(fn: () => any) { getConfigFn = fn; }
// AI見積もりのコア処理（main.ts側で実装）をスマホAPIから呼べるように登録する
export function setAnalyzeHandler(fn: (data: any) => Promise<any>) { analyzeFn = fn; }
export function setAutoCreateHandler(fn: (data: any) => any) { autoCreateFn = fn; }
// AI完成イメージ画像生成（main.ts側で実装）をスマホAPIから呼べるように登録する
export function setGenerateImageHandler(fn: (data: any) => Promise<any>) { generateFn = fn; }

export function startServer(distPath: string) {
  const express = require('express');
  const cors = require('cors');
  const crypto = require('crypto');
  const app = express();

  // ── セキュリティヘッダー ──
  app.use((_req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // カメラは自撮影(写真取り込み)のために self を許可。マイク・位置情報は不要なので禁止のまま
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  // ── CORS制限（ローカルネットワーク + 外出先トンネル経由を許可）──
  // ※ トンネル(loca.lt / trycloudflare)経由だとブラウザが同一オリジンPOSTでも
  //   Origin: https://xxx.loca.lt を送るため、これを弾くとスマホからログインできない（500）。
  app.use(cors({
    origin: (origin: string | undefined, callback: any) => {
      if (!origin) return callback(null, true); // 同一オリジン（Originヘッダ無し）
      const isLan = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin);
      const isTunnel = /^https:\/\/[a-z0-9-]+\.(loca\.lt|trycloudflare\.com)$/.test(origin);
      if (isLan || isTunnel) return callback(null, true);
      // 不許可でも例外を投げず、単にCORSヘッダを付けないだけにする（500を避ける）
      callback(null, false);
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '50mb' }));

  // ── 認証ミドルウェア（レート制限・セッション有効期限付き）──
  const sessions = new Map<string, { expiry: number; tenantId: number; username: string }>(); // token -> セッション情報
  const SESSION_TTL = 24 * 60 * 60 * 1000; // 24時間
  const authAttempts = new Map<string, { count: number; lastAttempt: number }>();
  const MAX_AUTH_ATTEMPTS = 5;
  const AUTH_LOCKOUT_MS = 15 * 60 * 1000; // 15分ロックアウト

  // 期限切れセッションの定期クリーンアップ
  setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (now > session.expiry) sessions.delete(token);
    }
  }, 60 * 60 * 1000); // 1時間ごと

  app.post('/api/auth', (req: any, res: any) => {
    const { username, password } = req.body || {};

    // レート制限チェック
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const attempt = authAttempts.get(clientIp);
    if (attempt && attempt.count >= MAX_AUTH_ATTEMPTS && (Date.now() - attempt.lastAttempt) < AUTH_LOCKOUT_MS) {
      return res.status(429).json({ error: 'ログイン試行回数が上限に達しました。15分後に再試行してください。' });
    }

    // ユーザー名+パスワード認証（テナント紐づけ）
    if (username && password) {
      const user = queryOne('SELECT id, username, role, tenant_id, password_hash FROM users WHERE username = ?', [username]);
      if (user) {
        const [salt, hash] = (user.password_hash || '').split(':');
        const inputHash = crypto.createHash('sha256').update(salt + password).digest('hex');
        if (hash === inputHash) {
          authAttempts.delete(clientIp);
          const token = crypto.randomBytes(32).toString('hex');
          sessions.set(token, { expiry: Date.now() + SESSION_TTL, tenantId: user.tenant_id, username: user.username });
          return res.json({ ok: true, token, tenantId: user.tenant_id, username: user.username });
        }
      }
    }

    // ログイン失敗 → 試行回数カウント
    const current = authAttempts.get(clientIp) || { count: 0, lastAttempt: 0 };
    authAttempts.set(clientIp, { count: current.count + 1, lastAttempt: Date.now() });
    res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  });

  app.use((req: any, res: any, next: any) => {
    // localhost はスキップ
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    // 認証チェック（有効期限も確認）
    const token = req.headers['x-auth-token'] || req.query?.token;
    if (token && sessions.has(token)) {
      const session = sessions.get(token)!;
      if (Date.now() > session.expiry) {
        sessions.delete(token);
        return res.status(401).json({ error: 'セッションが期限切れです。再ログインしてください。' });
      }
      // セッション延長 + テナントIDをリクエストに付与
      session.expiry = Date.now() + SESSION_TTL;
      req.tenantId = session.tenantId;
      return next();
    }
    // 認証不要のパス
    if (req.path === '/api/auth' || req.path === '/api/version' || req.path === '/admin') return next();
    // 静的アセット（JS/CSS/画像/フォント等）は認証不要 = アプリの土台。
    // これを弾くとスマホで真っ白になる。データAPI(/api/*)は下で保護されたまま。
    if (/\.(js|mjs|css|map|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|eot|json|txt|wasm)$/i.test(req.path)) return next();
    // データAPI(/api/*)の未認証は必ず JSON 401 を返す。
    // ここでログインHTMLへリダイレクトすると、スマホの fetch が JSON を期待して壊れ、
    // 見積り・画像生成が「400」等の不可解なエラーになる（トークン失効時＝サーバー再起動後に多発）。
    // 401 を返せばアプリ側が検知してトークン破棄＆ログイン画面へ誘導できる。
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: '認証の有効期限が切れました。もう一度ログインしてください。' });
    }
    if (req.path === '/login') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ログイン - 建築ブースト</title>
<style>body{font-family:'Segoe UI','Yu Gothic UI','Meiryo',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f5f5f5;margin:0}
.box{background:#fff;padding:36px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.12);width:360px;text-align:center}
h2{color:#1a2332;margin-bottom:8px}
.sub{color:#888;font-size:13px;margin-bottom:20px}
input{width:100%;padding:14px;border:2px solid #e0e0e0;border-radius:10px;margin:8px 0;font-size:16px;box-sizing:border-box;min-height:48px;outline:none;transition:border-color 0.2s}
input:focus{border-color:#3a7bd5}
button{width:100%;padding:14px;background:#3a7bd5;color:#fff;border:none;border-radius:10px;font-size:16px;cursor:pointer;min-height:52px;font-weight:bold;margin-top:12px;transition:background 0.2s}
button:hover{background:#2a6bc5}
.err{color:#e74c3c;font-size:14px;min-height:20px}</style></head><body>
<div class="box">
<h2>建築ブースト</h2>
<p class="sub">AI建築見積管理システム</p>
<p id="e" class="err"></p>
<input id="u" type="text" placeholder="ユーザー名" autofocus>
<input id="p" type="password" placeholder="パスワード">
<button onclick="login()">ログイン</button>
</div>
<script>
document.getElementById('p').addEventListener('keydown',function(e){if(e.key==='Enter')login()});
async function login(){
  const u=document.getElementById('u').value;
  const p=document.getElementById('p').value;
  if(!u||!p){document.getElementById('e').textContent='ユーザー名とパスワードを入力してください';return}
  const r=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  const j=await r.json();
  if(j.ok){localStorage.setItem('auth_token',j.token);location.href='/?token='+j.token}
  else{document.getElementById('e').textContent=j.error}
}
</script></body></html>`);
      return;
    }
    res.redirect('/login');
  });

  // ── バージョンAPI（自動アップデート検知用）──
  const APP_VERSION = Date.now().toString();
  app.get('/api/version', (_req: any, res: any) => {
    res.json({ version: APP_VERSION });
  });

  // admin-dashboard配信（distにコピー済み）
  app.get('/admin', (_req: any, res: any) => {
    const adminPath = path.join(distPath, 'admin.html');
    if (fs.existsSync(adminPath)) return res.sendFile(adminPath);
    res.status(404).send('admin.html not found');
  });

  // Service Worker はキャッシュ禁止で配信
  app.get('/sw.js', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(distPath, 'sw.js'));
  });

  // 静的ファイル配信（renderer）
  app.use(express.static(distPath));

  // ── API Routes（テナント分離付き）──
  // Web版: セッションのテナントIDを優先、なければデスクトップの現在テナント
  const tid = (req?: any) => req?.tenantId || getCurrentTenant();

  // 物件
  app.get('/api/properties', (req: any, res: any) => {
    res.json(queryAll('SELECT * FROM properties WHERE tenant_id = ? ORDER BY created_at DESC', [tid(req)]));
  });
  app.post('/api/properties', (req: any, res: any) => {
    const d = req.body;
    const id = runSql('INSERT INTO properties (name, address, floor_plan_image, notes, tenant_id) VALUES (?, ?, ?, ?, ?)',
      [d.name, d.address, d.floorPlanImage || null, d.notes || null, tid()]);
    res.json({ id });
  });
  app.put('/api/properties/:id', (req: any, res: any) => {
    const d = req.body;
    runSql('UPDATE properties SET name=?, address=?, floor_plan_image=?, notes=? WHERE id=? AND tenant_id=?',
      [d.name, d.address, d.floorPlanImage || null, d.notes || null, req.params.id, tid()]);
    res.json({ ok: true });
  });
  app.delete('/api/properties/:id', (req: any, res: any) => {
    runSql('DELETE FROM properties WHERE id=? AND tenant_id=?', [Number(req.params.id), tid()]);
    res.json({ ok: true });
  });

  // 材料マスタ
  app.get('/api/materials', (req: any, res: any) => {
    res.json(queryAll('SELECT * FROM materials WHERE tenant_id = ? ORDER BY category, name', [tid(req)]));
  });
  app.post('/api/materials', (req: any, res: any) => {
    const d = req.body;
    const id = runSql('INSERT INTO materials (name, category, unit, unit_price, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
      [d.name, d.category, d.unit, d.unitPrice, d.notes || null, tid()]);
    res.json({ id });
  });
  app.put('/api/materials/:id', (req: any, res: any) => {
    const d = req.body;
    runSql('UPDATE materials SET name=?, category=?, unit=?, unit_price=?, notes=? WHERE id=? AND tenant_id=?',
      [d.name, d.category, d.unit, d.unitPrice, d.notes || null, req.params.id, tid()]);
    res.json({ ok: true });
  });
  app.delete('/api/materials/:id', (req: any, res: any) => {
    runSql('DELETE FROM materials WHERE id=? AND tenant_id=?', [Number(req.params.id), tid()]);
    res.json({ ok: true });
  });

  // 施工（経費・売上付き）
  app.get('/api/constructions', (req: any, res: any) => {
    const rows = queryAll(`
      SELECT c.*, p.name as property_name,
        (SELECT COALESCE(SUM(cm.quantity * cm.unit_price), 0) FROM construction_materials cm WHERE cm.construction_id = c.id) as material_cost
      FROM constructions c LEFT JOIN properties p ON c.property_id = p.id WHERE c.tenant_id = ? ORDER BY c.construction_date DESC
    `, [tid(req)]);
    res.json(rows.map((r: any) => {
      const matCost = r.material_cost || 0;
      const laborCost = r.labor_cost || 0;
      const totalCost = matCost + laborCost;
      const selling = Math.ceil(totalCost * (r.markup_rate || 1.3));
      return { ...r, total_cost: totalCost, selling_price: selling, gross_profit: selling - totalCost };
    }));
  });
  app.post('/api/constructions', (req: any, res: any) => {
    const d = req.body;
    const id = runSql('INSERT INTO constructions (property_id, title, construction_date, labor_cost, markup_rate, notes, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [d.propertyId, d.title, d.constructionDate, d.laborCost, d.markupRate || 1.3, d.notes || null, tid()]);
    res.json({ id });
  });
  app.delete('/api/constructions/:id', (req: any, res: any) => {
    runSql('DELETE FROM construction_materials WHERE construction_id=?', [Number(req.params.id)]);
    runSql('DELETE FROM constructions WHERE id=? AND tenant_id=?', [Number(req.params.id), tid()]);
    res.json({ ok: true });
  });

  // 施工材料明細
  app.get('/api/constructions/:id/materials', (req: any, res: any) => {
    // テナント所有確認
    const c = queryOne('SELECT id FROM constructions WHERE id=? AND tenant_id=?', [Number(req.params.id), tid()]);
    if (!c) return res.status(403).json({ error: 'アクセス権がありません' });
    res.json(queryAll(`
      SELECT cm.*, m.name as material_name, m.unit, m.unit_price as master_unit_price, m.category
      FROM construction_materials cm LEFT JOIN materials m ON cm.material_id = m.id
      WHERE cm.construction_id = ? ORDER BY cm.id
    `, [Number(req.params.id)]));
  });
  app.post('/api/constructions/:id/materials', (req: any, res: any) => {
    const c = queryOne('SELECT id FROM constructions WHERE id=? AND tenant_id=?', [Number(req.params.id), tid()]);
    if (!c) return res.status(403).json({ error: 'アクセス権がありません' });
    const d = req.body;
    const id = runSql('INSERT INTO construction_materials (construction_id, material_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
      [Number(req.params.id), d.materialId, d.quantity, d.unitPrice]);
    res.json({ id });
  });
  app.delete('/api/construction-materials/:id', (req: any, res: any) => {
    runSql('DELETE FROM construction_materials WHERE id=?', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  // 施工計算
  app.get('/api/constructions/:id/calculate', (req: any, res: any) => {
    const c = queryOne('SELECT * FROM constructions WHERE id=? AND tenant_id=?', [Number(req.params.id), tid()]);
    if (!c) return res.status(403).json({ error: 'アクセス権がありません' });
    const mat = queryOne('SELECT SUM(quantity * unit_price) as total FROM construction_materials WHERE construction_id=?', [Number(req.params.id)]);
    const materialCost = mat?.total || 0;
    const laborCost = c?.labor_cost || 0;
    const totalCost = materialCost + laborCost;
    const markupRate = c?.markup_rate || 1.3;
    const sellingPrice = Math.ceil(totalCost * markupRate);
    const grossProfit = sellingPrice - totalCost;
    const profitRate = totalCost > 0 ? Math.round((grossProfit / sellingPrice) * 1000) / 10 : 0;
    res.json({ materialCost, laborCost, totalCost, markupRate, sellingPrice, grossProfit, profitRate });
  });

  // 請求書
  app.get('/api/invoices', (req: any, res: any) => {
    const rows = queryAll(`
      SELECT i.*, c.title as construction_title, c.labor_cost, c.markup_rate, p.name as property_name,
        (SELECT COALESCE(SUM(cm.quantity * cm.unit_price), 0) FROM construction_materials cm WHERE cm.construction_id = c.id) as material_cost
      FROM invoices i LEFT JOIN constructions c ON i.construction_id = c.id LEFT JOIN properties p ON c.property_id = p.id
      WHERE i.tenant_id = ? ORDER BY i.issue_date DESC
    `, [tid(req)]);
    res.json(rows.map((r: any) => {
      const matCost = r.material_cost || 0;
      const laborCost = r.labor_cost || 0;
      const totalCost = matCost + laborCost;
      const selling = Math.ceil(totalCost * (r.markup_rate || 1.3));
      return { ...r, total_cost: totalCost, selling_price: selling, gross_profit: selling - totalCost };
    }));
  });
  app.post('/api/invoices', (req: any, res: any) => {
    const d = req.body;
    const id = runSql('INSERT INTO invoices (construction_id, client_name, client_address, issue_date, due_date, amount, tax_rate, notes, status, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [d.constructionId || null, d.clientName, d.clientAddress || null, d.issueDate, d.dueDate || null, d.amount || 0, d.taxRate != null ? d.taxRate : 0.1, d.notes || null, d.status || 'draft', tid()]);
    res.json({ id });
  });
  app.put('/api/invoices/:id', (req: any, res: any) => {
    const d = req.body;
    runSql('UPDATE invoices SET client_name=?, client_address=?, issue_date=?, due_date=?, amount=?, tax_rate=?, notes=?, status=? WHERE id=? AND tenant_id=?',
      [d.clientName, d.clientAddress || null, d.issueDate, d.dueDate || null, d.amount || 0, d.taxRate != null ? d.taxRate : 0.1, d.notes || null, d.status || 'draft', req.params.id, tid()]);
    res.json({ ok: true });
  });
  app.delete('/api/invoices/:id', (req: any, res: any) => {
    runSql('DELETE FROM invoices WHERE id=? AND tenant_id=?', [Number(req.params.id), tid()]);
    res.json({ ok: true });
  });

  // ダッシュボード
  app.get('/api/dashboard', (req: any, res: any) => {
    const constructions = queryAll('SELECT id, labor_cost, markup_rate FROM constructions WHERE tenant_id = ?', [tid(req)]);
    let totalMaterialCost = 0, totalLaborCost = 0, totalSelling = 0, totalGrossProfit = 0;
    for (const c of constructions) {
      const mat = queryOne('SELECT SUM(quantity * unit_price) as total FROM construction_materials WHERE construction_id=?', [c.id]);
      const matCost = (mat?.total || 0) as number;
      const laborCost = (c.labor_cost || 0) as number;
      const cost = matCost + laborCost;
      const selling = Math.ceil(cost * ((c.markup_rate as number) || 1.3));
      totalMaterialCost += matCost;
      totalLaborCost += laborCost;
      totalSelling += selling;
      totalGrossProfit += selling - cost;
    }
    res.json({
      totalMaterialCost, totalLaborCost, totalSelling, totalGrossProfit,
      profitRate: totalSelling > 0 ? Math.round((totalGrossProfit / totalSelling) * 1000) / 10 : 0,
    });
  });

  // AI見積もり（スマホ）：解析は20〜30秒かかり、トンネル(loca.lt)が長時間リクエストを502で切るため、
  // ここでは即 jobId を返し、実際の解析はバックグラウンドで実行。クライアントは /api/analyze-status を叩く。
  app.post('/api/analyze-image', (req: any, res: any) => {
    if (!analyzeFn) return res.status(503).json({ error: 'AI見積もりは現在利用できません（PC側の準備中）' });
    const now = Date.now();
    // 5分以上前の古いジョブを掃除
    for (const [k, v] of analyzeJobs) { if (now - v.createdAt > 300000) analyzeJobs.delete(k); }
    const jobId = (++analyzeJobSeq) + '-' + now.toString(36);
    analyzeJobs.set(jobId, { status: 'pending', createdAt: now });
    const body = req.body || {};
    // レスポンスは待たずにバックグラウンド実行
    Promise.resolve().then(() => analyzeFn!(body))
      .then((result) => { analyzeJobs.set(jobId, { status: 'done', result, createdAt: now }); })
      .catch((e: any) => {
        const msg = (e && e.message) ? String(e.message) : 'AI解析に失敗しました';
        analyzeJobs.set(jobId, { status: 'error', error: msg.replace(/^ERROR:\s*/, ''), createdAt: now });
      });
    res.json({ jobId });
  });

  // AI完成イメージ画像生成（スマホ）：画像生成も時間がかかりトンネルが502で切るため、
  // 解析と同じくジョブ化して即 jobId を返し、状態は /api/analyze-status を共用してポーリングする。
  app.post('/api/generate-image', (req: any, res: any) => {
    if (!generateFn) return res.status(503).json({ error: '完成イメージ生成は現在利用できません（PC側の準備中）' });
    const now = Date.now();
    for (const [k, v] of analyzeJobs) { if (now - v.createdAt > 300000) analyzeJobs.delete(k); }
    const jobId = 'img' + (++analyzeJobSeq) + '-' + now.toString(36);
    analyzeJobs.set(jobId, { status: 'pending', createdAt: now });
    const body = req.body || {};
    Promise.resolve().then(() => generateFn!(body))
      .then((result) => { analyzeJobs.set(jobId, { status: 'done', result, createdAt: now }); })
      .catch((e: any) => {
        const msg = (e && e.message) ? String(e.message) : '完成イメージの生成に失敗しました';
        analyzeJobs.set(jobId, { status: 'error', error: msg.replace(/^ERROR:\s*/, ''), createdAt: now });
      });
    res.json({ jobId });
  });

  // AI解析／画像生成ジョブの状態取得（スマホ）。done/error を返したらジョブは破棄。
  app.get('/api/analyze-status/:jobId', (req: any, res: any) => {
    const job = analyzeJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ status: 'error', error: '解析ジョブが見つかりません（時間切れの可能性）' });
    if (job.status === 'done') { const r = job.result; analyzeJobs.delete(req.params.jobId); return res.json({ status: 'done', result: r }); }
    if (job.status === 'error') { const err = job.error; analyzeJobs.delete(req.params.jobId); return res.json({ status: 'error', error: err }); }
    res.json({ status: 'pending' });
  });

  // 見積もり結果から物件・施工・請求書を自動作成（スマホ）
  app.post('/api/auto-create-from-estimate', (req: any, res: any) => {
    if (!autoCreateFn) return res.status(503).json({ error: '自動作成は現在利用できません' });
    try {
      const created = autoCreateFn(req.body || {});
      res.json(created);
    } catch (e: any) {
      res.status(400).json({ error: (e && e.message) ? String(e.message) : '自動作成に失敗しました' });
    }
  });

  // 見積共有ページ
  app.get('/share/estimate/:id', (req: any, res: any) => {
    try {
      const log = queryOne('SELECT el.*, c.title as construction_title FROM estimate_log el LEFT JOIN constructions c ON c.id = el.construction_id WHERE el.id = ?', [parseInt(req.params.id)]);
      if (!log) return res.status(404).send('見積が見つかりません');
      let breakdown: any[] = [];
      try { const parsed = JSON.parse(log.ai_json); breakdown = parsed?.breakdown || []; } catch (_) {}
      res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${log.construction_title || log.work_type || '見積'} - 建築ブースト</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI','Yu Gothic UI','Meiryo',sans-serif;background:#f5f5f5;color:#333;padding:20px}
  .card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,0.08);max-width:600px;margin:0 auto}
  h1{font-size:20px;color:#1a2332;margin-bottom:16px;text-align:center}
  .total{font-size:32px;font-weight:bold;color:#27ae60;text-align:center;margin:16px 0}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  th{background:#f8f9fa;padding:10px;text-align:left;font-size:13px;color:#666}
  td{padding:10px;border-bottom:1px solid #f0f0f0;font-size:14px}
  .footer{text-align:center;margin-top:20px;color:#aaa;font-size:12px}
  .badge{display:inline-block;background:#3a7bd5;color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;margin-bottom:12px}
</style></head><body>
<div class="card">
  <div style="text-align:center"><span class="badge">建築ブースト AI見積</span></div>
  <h1>${log.construction_title || log.work_type || 'AI見積結果'}</h1>
  <div class="total">¥${Math.round(log.ai_total || 0).toLocaleString('ja-JP')}</div>
  <table>
    <thead><tr><th>項目</th><th style="text-align:right">金額</th></tr></thead>
    <tbody>
      ${breakdown.map((b: any) => '<tr><td>' + (b.item || b.name || '') + '</td><td style="text-align:right;font-weight:bold">¥' + Math.round(b.cost || b.amount || 0).toLocaleString('ja-JP') + '</td></tr>').join('')}
      <tr style="border-top:2px solid #333;font-weight:bold"><td>合計</td><td style="text-align:right;color:#27ae60">¥${Math.round(log.ai_total || 0).toLocaleString('ja-JP')}</td></tr>
    </tbody>
  </table>
  <div class="footer">
    <p>建築ブースト — AI建築見積管理システム</p>
    <p style="margin-top:4px">作成日: ${log.created_at || ''}</p>
  </div>
</div></body></html>`);
    } catch (e: any) {
      res.status(500).send('エラー: ' + e.message);
    }
  });

  // SPA fallback（スマホでダウンロード扱いにならないよう Content-Type を明示）
  app.use((_req: any, res: any) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(distPath, 'index.html'));
  });

  const PORT = 3456;
  const server = app.listen(PORT, '0.0.0.0', () => {
    serverUrl = `http://${pickLanIp()}:${PORT}`;
    console.log(`Web server: ${serverUrl}`);
  });

  return server;
}
