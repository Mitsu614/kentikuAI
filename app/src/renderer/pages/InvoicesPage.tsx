import React, { useEffect, useState } from 'react';
import { generateInvoicePDF } from '../utils/pdfGenerator';

export default function InvoicesPage({ highlightConstructionId, onHighlightClear }: { highlightConstructionId?: number | null; onHighlightClear?: () => void }) {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [constructions, setConstructions] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [detailMaterials, setDetailMaterials] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [addName, setAddName] = useState('');
  const [addQty, setAddQty] = useState('1');
  const [addUnit, setAddUnit] = useState('式');
  const [addPrice, setAddPrice] = useState('');
  const [form, setForm] = useState({
    constructionId: '', clientName: '', clientAddress: '',
    issueDate: '', dueDate: '', amount: 0, taxRate: 0.1, notes: '', status: 'draft',
  });

  useEffect(() => { load(); }, []);

  // ハイライト指定があれば自動で詳細を開く
  useEffect(() => {
    if (highlightConstructionId && invoices.length > 0) {
      const target = invoices.find((inv: any) => inv.construction_id === highlightConstructionId);
      if (target) openDetail(target);
    }
  }, [highlightConstructionId, invoices]);

  const load = async () => {
    const [inv, con, mat] = await Promise.all([
      window.api.listInvoices(),
      window.api.listConstructions(),
      window.api.listMaterials(),
    ]);
    setInvoices(inv);
    setConstructions(con);
    setMaterials(mat);
  };

  const openCreate = () => {
    setEditing(null);
    setError('');
    const today = new Date().toISOString().split('T')[0];
    const due = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    setForm({ constructionId: '', clientName: '', clientAddress: '', issueDate: today, dueDate: due, amount: 0, taxRate: 0.1, notes: '', status: 'draft' });
    setShowModal(true);
  };

  const openEdit = (inv: any) => {
    setEditing(inv);
    setError('');
    setForm({
      constructionId: inv.construction_id != null ? String(inv.construction_id) : '',
      clientName: inv.client_name || '',
      clientAddress: inv.client_address || '',
      issueDate: inv.issue_date || '',
      dueDate: inv.due_date || '',
      amount: inv.amount || 0,
      taxRate: inv.tax_rate != null ? inv.tax_rate : 0.1,
      notes: inv.notes || '',
      status: inv.status || 'draft',
    });
    setShowModal(true);
  };

  const onConstructionChange = async (constructionId: string) => {
    setForm(prev => ({ ...prev, constructionId }));
    if (constructionId) {
      try {
        const calc = await window.api.calculateConstruction(Number(constructionId));
        setForm(prev => ({ ...prev, amount: calc.sellingPrice }));
      } catch (e: any) { console.error(e); }
    }
  };

  const save = async () => {
    if (!form.clientName.trim()) { setError('請求先名を入力してください'); return; }
    if (!form.issueDate) { setError('発行日を入力してください'); return; }
    setError('');
    try {
      const data = {
        constructionId: form.constructionId ? Number(form.constructionId) : null,
        clientName: form.clientName, clientAddress: form.clientAddress || null,
        issueDate: form.issueDate, dueDate: form.dueDate || null,
        amount: form.amount, taxRate: form.taxRate, notes: form.notes || null, status: form.status,
      };
      if (editing) {
        await window.api.updateInvoice({ ...data, id: editing.id });
      } else {
        await window.api.createInvoice(data);
      }
      setShowModal(false);
      load();
    } catch (e: any) { setError('保存に失敗: ' + (e.message || e)); }
  };

  const remove = async (id: number) => {
    if (confirm('この請求書を削除しますか？')) { await window.api.deleteInvoice(id); load(); if (detail?.id === id) setDetail(null); }
  };

  const exportPDF = async (invoiceId: number) => {
    try {
      const d = await window.api.getInvoiceDetail(invoiceId);
      await generateInvoicePDF(d.invoice, d.materials);
    } catch (e: any) { alert('PDF生成に失敗: ' + (e.message || e)); }
  };

  const openDetail = async (inv: any) => {
    setDetail(inv);
    if (inv.construction_id) {
      const mats = await (window as any).api.listConstructionMaterials(inv.construction_id);
      setDetailMaterials(mats);
    } else {
      setDetailMaterials([]);
    }
  };

  const updateMaterial = async (data: any) => {
    await (window as any).api.updateConstructionMaterial(data);
    if (detail?.construction_id) {
      const mats = await (window as any).api.listConstructionMaterials(detail.construction_id);
      setDetailMaterials(mats);
    }
    load();
  };

  const statusLabel = (s: string) => {
    const map: any = { draft: '下書き', sent: '送付済', paid: '入金済', overdue: '未入金' };
    return map[s] || s;
  };

  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();
  const filtered = invoices.filter((inv: any) => !search || (inv.client_name || '').includes(search) || (inv.construction_title || '').includes(search));

  return (
    <div>
      <div className="page-header">
        <h1>請求書管理</h1>
        <button className="btn btn-primary" onClick={openCreate}>+ 新規請求書</button>
      </div>
      <div style={{ marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 請求先・施工名で検索..." style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 6, width: 300, fontSize: 14 }} />
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        {/* 左: 一覧 */}
        <div style={{ flex: detail ? '0 0 420px' : '1' }}>
          {filtered.length === 0 ? (
            <div className="empty-state"><p>請求書がありません</p></div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>請求先</th>
                  <th>施工名</th>
                  <th>物件</th>
                  <th>発行日</th>
                  <th>支払期限</th>
                  <th style={{ textAlign: 'right' }}>税抜金額</th>
                  <th style={{ textAlign: 'right' }}>税込金額</th>
                  <th style={{ textAlign: 'right' }}>経費</th>
                  <th style={{ textAlign: 'right' }}>粗利</th>
                  <th>ステータス</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((inv: any) => (
                  <tr key={inv.id} onDoubleClick={() => openDetail(inv)} onClick={() => openDetail(inv)} style={{ cursor: 'pointer', background: highlightConstructionId && inv.construction_id === highlightConstructionId ? '#ffe0e0' : detail?.id === inv.id ? '#e8f4f8' : undefined, border: highlightConstructionId && inv.construction_id === highlightConstructionId ? '2px solid #e74c3c' : undefined }} title="クリックで詳細">
                    <td><strong>{inv.client_name}</strong></td>
                    <td style={{ fontSize: 12 }}>{inv.construction_title || '-'}</td>
                    <td style={{ fontSize: 12, color: '#888' }}>{inv.property_name || '-'}</td>
                    <td style={{ fontSize: 12 }}>{inv.issue_date || '-'}</td>
                    <td style={{ fontSize: 12, color: inv.due_date && inv.due_date < new Date().toISOString().split('T')[0] && inv.status !== 'paid' ? '#e74c3c' : '#888' }}>{inv.due_date || '-'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold', fontSize: 13 }}>{fmt(inv.amount)}</td>
                    <td style={{ textAlign: 'right', color: '#2980b9', fontWeight: 'bold', fontSize: 13 }}>{fmt(Math.ceil((inv.amount || 0) * (1 + (inv.tax_rate || 0.1))))}</td>
                    <td style={{ textAlign: 'right', fontSize: 12, color: '#e67e22' }}>{fmt(inv.total_cost || 0)}</td>
                    <td style={{ textAlign: 'right', fontSize: 12, fontWeight: 'bold', color: (inv.gross_profit || 0) > 0 ? '#27ae60' : '#e74c3c' }}>{fmt(inv.gross_profit || 0)}</td>
                    <td><span className={`badge badge-${inv.status}`}>{statusLabel(inv.status)}</span></td>
                    <td>
                      <button className="btn btn-sm btn-success" onClick={e => { e.stopPropagation(); exportPDF(inv.id); }}>PDF</button>
                      {' '}
                      <button className="btn btn-sm btn-danger" onClick={e => { e.stopPropagation(); remove(inv.id); }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 右: 詳細パネル */}
        {detail && (
          <div style={{ flex: 1 }}>
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h2 style={{ fontSize: 18 }}>請求書詳細</h2>
                <button className="btn btn-sm btn-secondary" onClick={() => setDetail(null)}>✕ 閉じる</button>
              </div>

              {/* 請求書情報（編集可能） */}
              <div style={{ background: '#f8f9fa', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <div className="form-row">
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>請求先</label>
                    <input value={detail.client_name} onChange={e => setDetail({ ...detail, client_name: e.target.value })} style={{ fontSize: 15, fontWeight: 'bold' }} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>ステータス</label>
                    <select value={detail.status} onChange={async e => {
                      const newStatus = e.target.value;
                      setDetail({ ...detail, status: newStatus });
                      await window.api.updateInvoice({ ...detail, clientName: detail.client_name, clientAddress: detail.client_address, issueDate: detail.issue_date, dueDate: detail.due_date, taxRate: detail.tax_rate, id: detail.id, status: newStatus });
                      load();
                    }}>
                      <option value="draft">下書き</option>
                      <option value="sent">送付済</option>
                      <option value="paid">入金済</option>
                      <option value="overdue">未入金</option>
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>請求先住所</label>
                    <input value={detail.client_address || ''} onChange={e => setDetail({ ...detail, client_address: e.target.value })} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>発行日</label>
                    <input type="date" value={detail.issue_date} onChange={e => setDetail({ ...detail, issue_date: e.target.value })} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>支払期限</label>
                    <input type="date" value={detail.due_date || ''} onChange={e => setDetail({ ...detail, due_date: e.target.value })} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>金額（税抜）</label>
                    <input type="number" value={detail.amount} onChange={e => setDetail({ ...detail, amount: Number(e.target.value) })} style={{ fontWeight: 'bold' }} />
                  </div>
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label>備考</label>
                  <textarea value={detail.notes || ''} onChange={e => setDetail({ ...detail, notes: e.target.value })} style={{ height: 50 }} />
                </div>
                <button className="btn btn-primary btn-sm" onClick={async () => {
                  await window.api.updateInvoice({
                    id: detail.id, clientName: detail.client_name, clientAddress: detail.client_address,
                    issueDate: detail.issue_date, dueDate: detail.due_date, amount: detail.amount,
                    taxRate: detail.tax_rate, notes: detail.notes, status: detail.status,
                  });
                  load();
                }}>変更を保存</button>
              </div>

              {/* 金額サマリー */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
                <div style={{ background: '#fdecea', borderRadius: 8, padding: 10, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#888' }}>経費</div>
                  <div style={{ fontSize: 18, fontWeight: 'bold', color: '#c0392b' }}>{fmt(detail.total_cost || 0)}</div>
                </div>
                <div style={{ background: '#e3f2fd', borderRadius: 8, padding: 10, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#888' }}>売上（税抜）</div>
                  <div style={{ fontSize: 18, fontWeight: 'bold', color: '#2980b9' }}>{fmt(detail.amount)}</div>
                </div>
                <div style={{ background: '#e8f5e9', borderRadius: 8, padding: 10, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#888' }}>粗利</div>
                  <div style={{ fontSize: 18, fontWeight: 'bold', color: '#27ae60' }}>{fmt(detail.gross_profit || 0)}</div>
                </div>
              </div>

              {/* 材料明細（編集可能） */}
              {detailMaterials.length > 0 && (
                <>
                  <h3 style={{ marginBottom: 8 }}>明細（ダブルクリックで編集）</h3>
                  <table className="data-table">
                    <thead>
                      <tr><th>品名</th><th>数量</th><th style={{ textAlign: 'right' }}>単価</th><th style={{ textAlign: 'right' }}>小計</th><th></th></tr>
                    </thead>
                    <tbody>
                      {detailMaterials.map((dm: any) => (
                        <InlineEditRow key={dm.id} dm={dm} onSave={updateMaterial} />
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {/* 明細追加 */}
              {detail.construction_id && (
                <div style={{ marginTop: 8, padding: 10, background: '#f8f9fa', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 'bold', marginBottom: 6 }}>+ 明細を追加</div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <input value={addName} onChange={e => setAddName(e.target.value)} placeholder="品名" style={{ flex: 2, padding: 4, fontSize: 12, border: '1px solid #ddd', borderRadius: 3, minWidth: 120 }} />
                    <input value={addQty} onChange={e => setAddQty(e.target.value)} type="number" placeholder="数量" style={{ width: 50, padding: 4, fontSize: 12, border: '1px solid #ddd', borderRadius: 3 }} />
                    <input value={addUnit} onChange={e => setAddUnit(e.target.value)} placeholder="単位" style={{ width: 35, padding: 4, fontSize: 12, border: '1px solid #ddd', borderRadius: 3 }} />
                    <input value={addPrice} onChange={e => setAddPrice(e.target.value)} type="number" placeholder="単価" style={{ width: 80, padding: 4, fontSize: 12, border: '1px solid #ddd', borderRadius: 3 }} />
                    <button className="btn btn-sm btn-success" onClick={async () => {
                      if (!addName || !addPrice) return;
                      const matId = await window.api.createMaterial({ name: addName, category: 'その他', unit: addUnit, unitPrice: Number(addPrice), notes: '請求書から追加' });
                      await window.api.addConstructionMaterial({ constructionId: detail.construction_id, materialId: matId, quantity: Number(addQty) || 1, unitPrice: Number(addPrice) });
                      setAddName(''); setAddQty('1'); setAddUnit('式'); setAddPrice('');
                      const mats = await (window as any).api.listConstructionMaterials(detail.construction_id);
                      setDetailMaterials(mats);
                      load();
                    }}>追加</button>
                  </div>
                </div>
              )}

              {/* PDF出力ボタン */}
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button className="btn btn-success" onClick={() => exportPDF(detail.id)} style={{ flex: 1 }}>📄 請求書PDF出力</button>
                <button className="btn btn-secondary" onClick={async () => { const d = await window.api.getInvoiceDetail(detail.id); await (window as any).api.generateEstimatePDF(d); }} style={{ flex: 1 }}>📋 見積書PDF出力</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 新規/編集モーダル */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{editing ? '請求書を編集' : '新規請求書作成'}</h2>
            {error && <div style={{ background: '#fdecea', color: '#c0392b', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{error}</div>}
            <div className="form-group">
              <label>施工を紐づけ</label>
              <select value={form.constructionId} onChange={e => onConstructionChange(e.target.value)}>
                <option value="">-- なし --</option>
                {constructions.map(c => (<option key={c.id} value={String(c.id)}>{c.title} ({c.property_name || '物件なし'})</option>))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group"><label>請求先名 *</label><input value={form.clientName} onChange={e => setForm({ ...form, clientName: e.target.value })} /></div>
              <div className="form-group"><label>ステータス</label>
                <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                  <option value="draft">下書き</option><option value="sent">送付済</option><option value="paid">入金済</option><option value="overdue">未入金</option>
                </select>
              </div>
            </div>
            <div className="form-group"><label>請求先住所</label><input value={form.clientAddress} onChange={e => setForm({ ...form, clientAddress: e.target.value })} /></div>
            <div className="form-row">
              <div className="form-group"><label>発行日 *</label><input type="date" value={form.issueDate} onChange={e => setForm({ ...form, issueDate: e.target.value })} /></div>
              <div className="form-group"><label>支払期限</label><input type="date" value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></div>
            </div>
            <div className="form-row">
              <div className="form-group"><label>金額 (税抜)</label><input type="number" value={form.amount} onChange={e => setForm({ ...form, amount: Number(e.target.value) })} /></div>
              <div className="form-group"><label>消費税率</label>
                <select value={String(form.taxRate)} onChange={e => setForm({ ...form, taxRate: Number(e.target.value) })}>
                  <option value="0.1">10%</option><option value="0.08">8%</option><option value="0">非課税</option>
                </select>
              </div>
            </div>
            <div className="card" style={{ background: '#f8f9fa' }}><strong>税込金額: {fmt(form.amount * (1 + form.taxRate))}</strong></div>
            <div className="form-group"><label>備考</label><textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="振込先など..." /></div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>キャンセル</button>
              <button className="btn btn-primary" onClick={save}>{editing ? '更新' : '作成'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineEditRow({ dm, onSave }: { dm: any; onSave: (d: any) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(dm.material_name || '');
  const [qty, setQty] = useState(String(dm.quantity));
  const [unit, setUnit] = useState(dm.unit || '式');
  const [price, setPrice] = useState(String(dm.unit_price));
  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

  const save = () => {
    onSave({ id: dm.id, materialId: dm.material_id, name, quantity: Number(qty), unit, unitPrice: Number(price) });
    setEditing(false);
  };

  if (editing) {
    return (
      <tr style={{ background: '#fffff0' }}>
        <td><input value={name} onChange={e => setName(e.target.value)} style={{ width: '100%', padding: 3, fontSize: 12, border: '1px solid #3a7bd5', borderRadius: 3 }} /></td>
        <td><div style={{ display: 'flex', gap: 2 }}><input value={qty} onChange={e => setQty(e.target.value)} type="number" style={{ width: 45, padding: 3, fontSize: 12, border: '1px solid #3a7bd5', borderRadius: 3 }} /><input value={unit} onChange={e => setUnit(e.target.value)} style={{ width: 30, padding: 3, fontSize: 12, border: '1px solid #3a7bd5', borderRadius: 3 }} /></div></td>
        <td><input value={price} onChange={e => setPrice(e.target.value)} type="number" style={{ width: 80, padding: 3, fontSize: 12, border: '1px solid #3a7bd5', borderRadius: 3, textAlign: 'right' }} /></td>
        <td style={{ textAlign: 'right' }}><strong>{fmt(Number(qty) * Number(price))}</strong></td>
        <td><button className="btn btn-sm btn-primary" onClick={save}>保存</button></td>
      </tr>
    );
  }

  return (
    <tr onDoubleClick={() => setEditing(true)} style={{ cursor: 'pointer' }} title="ダブルクリックで編集">
      <td>{dm.material_name}</td>
      <td>{dm.quantity} {dm.unit}</td>
      <td style={{ textAlign: 'right' }}>{fmt(dm.unit_price)}</td>
      <td style={{ textAlign: 'right' }}><strong>{fmt(dm.quantity * dm.unit_price)}</strong></td>
      <td><button className="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>✏</button></td>
    </tr>
  );
}
