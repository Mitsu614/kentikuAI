// スマホ（ブラウザ）用のAPI。Electron IPC の代わりに fetch を使う
const BASE = window.location.origin;

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('auth_token');
  const headers: Record<string, string> = {};
  if (token) headers['x-auth-token'] = token;
  return headers;
}

async function handleResponse(r: Response) {
  if (r.status === 401) {
    localStorage.removeItem('auth_token');
    window.location.href = '/login';
    throw new Error('認証エラー');
  }
  return r.json();
}

async function get(url: string) { const r = await fetch(BASE + url, { headers: getAuthHeaders() }); return handleResponse(r); }
async function post(url: string, body: any) { const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(body) }); return handleResponse(r); }
async function put(url: string, body: any) { const r = await fetch(BASE + url, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(body) }); return handleResponse(r); }
async function del(url: string) { const r = await fetch(BASE + url, { method: 'DELETE', headers: getAuthHeaders() }); return handleResponse(r); }

const webApiImpl: any = {
  // 認証（ブラウザ）。401でも handleResponse のリダイレクトを通さず、そのまま結果を返す
  login: async (username: string, password: string) => {
    try {
      const r = await fetch(BASE + '/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 200 && j.ok && j.token) {
        localStorage.setItem('auth_token', j.token);
        return { ok: true, tenantId: j.tenantId, username: j.username, token: j.token };
      }
      return { ok: false, error: j.error || 'ログインに失敗しました' };
    } catch (e: any) {
      return { ok: false, error: 'サーバーに接続できませんでした' };
    }
  },
  logout: async () => {
    localStorage.removeItem('auth_token');
    return { ok: true };
  },
  register: async () => ({ ok: false, error: '新規登録はデスクトップアプリから行ってください' }),

  listProperties: () => get('/api/properties'),
  createProperty: (d: any) => post('/api/properties', d).then(r => r.id),
  updateProperty: (d: any) => put(`/api/properties/${d.id}`, d),
  deleteProperty: (id: number) => del(`/api/properties/${id}`),
  selectImage: async () => {
    // ブラウザ: file input で画像選択（カメラ or アルバムを端末に選ばせる）
    // ※ capture を強制するとカメラのみになり、機種によっては何も取り込めない（画像が入らない）ため付けない
    return new Promise<string | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) { resolve(null); cleanup(); return; }
        const reader = new FileReader();
        reader.onload = () => { resolve(reader.result as string); cleanup(); };
        reader.onerror = () => { alert('画像の読み込みに失敗しました。別の画像でお試しください。'); resolve(null); cleanup(); };
        reader.readAsDataURL(file);
      };
      const cleanup = () => { try { document.body.removeChild(input); } catch (_) {} };
      document.body.appendChild(input); // 一部端末は DOM に無いと click が効かない
      input.click();
    });
  },

  listMaterials: () => get('/api/materials'),
  createMaterial: (d: any) => post('/api/materials', d).then(r => r.id),
  updateMaterial: (d: any) => put(`/api/materials/${d.id}`, d),
  deleteMaterial: (id: number) => del(`/api/materials/${id}`),

  listConstructions: () => get('/api/constructions'),
  createConstruction: (d: any) => post('/api/constructions', d).then(r => r.id),
  updateConstruction: (d: any) => put(`/api/constructions/${d.id}`, d),
  deleteConstruction: (id: number) => del(`/api/constructions/${id}`),
  calculateConstruction: (id: number) => get(`/api/constructions/${id}/calculate`),

  listConstructionMaterials: (cid: number) => get(`/api/constructions/${cid}/materials`),
  addConstructionMaterial: (d: any) => post(`/api/constructions/${d.constructionId}/materials`, d).then(r => r.id),
  removeConstructionMaterial: (id: number) => del(`/api/construction-materials/${id}`),

  listInvoices: () => get('/api/invoices'),
  createInvoice: (d: any) => post('/api/invoices', d).then(r => r.id),
  updateInvoice: (d: any) => put(`/api/invoices/${d.id}`, d),
  deleteInvoice: (id: number) => del(`/api/invoices/${id}`),
  getInvoiceDetail: async (id: number) => ({ invoice: null, materials: [] }), // PDF生成はデスクトップのみ
  generatePDF: async () => { alert('PDF出力はデスクトップアプリからのみ利用できます'); },

  getDashboardSummary: () => get('/api/dashboard'),
  loadConfig: async () => ({}),
  saveConfig: async () => {},
  // AI見積もり：PC(サーバー)側でClaude解析を実行し、結果だけ受け取る。
  // 解析は20〜30秒かかり、トンネル(loca.lt)が長時間リクエストを502で切るため、
  // 「即 jobId を受け取り→状態をポーリング」方式にして各リクエストを短く保つ。
  analyzeImage: async (payload: any) => {
    const r = await fetch(BASE + '/api/analyze-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(payload),
    });
    if (r.status === 401) { localStorage.removeItem('auth_token'); window.location.href = '/login'; throw new Error('認証エラー'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'AI解析に失敗しました');
    // 旧サーバー互換：jobId が無ければ結果そのものが返っている
    if (!j.jobId) return j;
    // ポーリング（最大3分）。各リクエストは1秒未満なのでトンネルの502に当たらない。
    const jobId = j.jobId as string;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 2000));
      let sr: Response;
      try {
        sr = await fetch(BASE + '/api/analyze-status/' + encodeURIComponent(jobId), { headers: getAuthHeaders() });
      } catch (_) { continue; } // ネットワーク瞬断・トンネル瞬断は次のポーリングで再試行
      if (sr.status === 404) throw new Error('解析がタイムアウトしました。もう一度お試しください。');
      const sj = await sr.json().catch(() => ({}));
      if (sj.status === 'done') return sj.result;
      if (sj.status === 'error') throw new Error(sj.error || 'AI解析に失敗しました');
      // pending → 継続
    }
    throw new Error('解析に時間がかかっています。電波の良い場所でもう一度お試しください。');
  },
  autoCreateFromEstimate: async (payload: any) => {
    const r = await fetch(BASE + '/api/auto-create-from-estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(payload),
    });
    if (r.status === 401) { localStorage.removeItem('auth_token'); window.location.href = '/login'; throw new Error('認証エラー'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '自動作成に失敗しました');
    return j;
  },
  // AI完成イメージ画像生成：解析と同じく即 jobId を受け取り→状態をポーリング。
  // 画像生成は時間がかかるため、各リクエストを短く保ってトンネルの502を避ける。
  generateImage: async (payload: any) => {
    const r = await fetch(BASE + '/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(payload || {}),
    });
    if (r.status === 401) { localStorage.removeItem('auth_token'); window.location.href = '/login'; throw new Error('認証エラー'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '完成イメージの生成に失敗しました');
    if (!j.jobId) return j.result ?? j;
    const jobId = j.jobId as string;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 2500));
      let sr: Response;
      try {
        sr = await fetch(BASE + '/api/analyze-status/' + encodeURIComponent(jobId), { headers: getAuthHeaders() });
      } catch (_) { continue; }
      if (sr.status === 404) throw new Error('生成がタイムアウトしました。もう一度お試しください。');
      const sj = await sr.json().catch(() => ({}));
      if (sj.status === 'done') return sj.result;
      if (sj.status === 'error') throw new Error(sj.error || '完成イメージの生成に失敗しました');
    }
    throw new Error('生成に時間がかかっています。電波の良い場所でもう一度お試しください。');
  },

  // ── AI見積ページがマウント時/操作時に呼ぶメソッド群 ──
  // 対応するサーバーAPIが無いものは安全な既定値を返す（未定義だと undefined.then() で白画面になるため）。
  getEstimateLog: async () => [],        // スマホでは過去ログ一覧は非対応（空配列）
  listChatSessions: async () => [],
  // テナント系（スマホは単一テナント運用。配列/数値を返して .find/.map で落ちないようにする）
  listTenants: async () => [],
  currentTenant: async () => 1,
  switchTenant: async () => null,
  createTenant: async () => null,
  deleteTenant: async () => null,
  listUsers: async () => [],
  isOwnerPC: async () => false,
  saveChatSession: async () => null,
  getChatSession: async () => null,
  aiChat: async () => ({ text: 'チャット見積はデスクトップアプリでご利用ください。写真からのAI見積はこの画面で使えます。', estimate: null }),
  getPOByConstruction: async () => null,
  getInvoiceByConstruction: async () => null,
  createPOFromConstruction: async () => null,
  addConstructionPhoto: async () => null,
  saveEstimateImage: async () => null,
  updateConstructionMaterial: async () => null,
  generatePurchaseOrderPDF: async () => { alert('発注書PDFの出力はデスクトップアプリからご利用ください。'); return null; },
};

// 未実装APIを呼んでも undefined にならないようProxyでラップ（白画面クラッシュの根絶）。
// 定義済みメソッドはそのまま、未定義の文字列プロパティは「安全に null を返す非同期関数」を返す。
export const webApi: any = new Proxy(webApiImpl, {
  get(target, prop) {
    if (prop in target) return (target as any)[prop];
    if (typeof prop === 'string' && prop !== 'then') {
      return async () => null;
    }
    return undefined;
  },
});
