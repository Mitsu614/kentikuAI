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

export const webApi = {
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
  // AI見積もり：PC(サーバー)側でClaude解析を実行し、結果だけ受け取る
  analyzeImage: async (payload: any) => {
    const r = await fetch(BASE + '/api/analyze-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(payload),
    });
    if (r.status === 401) { localStorage.removeItem('auth_token'); window.location.href = '/login'; throw new Error('認証エラー'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'AI解析に失敗しました');
    return j;
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
  // 画像生成はPC専用（スマホでは非表示扱い）
  generateImage: async () => null,
};
