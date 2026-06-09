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
  listProperties: () => get('/api/properties'),
  createProperty: (d: any) => post('/api/properties', d).then(r => r.id),
  updateProperty: (d: any) => put(`/api/properties/${d.id}`, d),
  deleteProperty: (id: number) => del(`/api/properties/${id}`),
  selectImage: async () => {
    // ブラウザ: file input で画像選択
    return new Promise<string | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      };
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
  analyzeImage: async () => { alert('AI見積もりはデスクトップアプリからのみ利用できます'); return null; },
  generateImage: async () => null,
  autoCreateFromEstimate: async () => null,
};
