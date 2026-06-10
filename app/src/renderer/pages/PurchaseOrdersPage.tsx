import React, { useEffect, useState } from 'react';

const api = (window as any).api;
const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

const statusColors: any = { draft: '#999', sent: '#3498db', delivered: '#27ae60', cancelled: '#e74c3c' };
const statusLabels: any = { draft: '下書き', sent: '発注済', delivered: '納品済', cancelled: 'キャンセル' };

export default function PurchaseOrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [constructions, setConstructions] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);

  // 新規作成
  const [vendorName, setVendorName] = useState('');
  const [vendorAddress, setVendorAddress] = useState('');
  const [constructionId, setConstructionId] = useState<number | null>(null);
  const [deliveryDate, setDeliveryDate] = useState('');
  const [poNotes, setPoNotes] = useState('');

  // 明細追加
  const [itemName, setItemName] = useState('');
  const [itemQty, setItemQty] = useState(1);
  const [itemUnit, setItemUnit] = useState('式');
  const [itemPrice, setItemPrice] = useState(0);

  const load = async () => {
    const [o, c] = await Promise.all([api.listPurchaseOrders(), api.listConstructions()]);
    setOrders(o);
    setConstructions(c);
  };
  useEffect(() => { load(); }, []);

  const selectOrder = async (id: number) => {
    const d = await api.getPurchaseOrderDetail(id);
    setDetail(d);
    setSelected(d);
  };

  const createOrder = async () => {
    const id = await api.createPurchaseOrder({
      vendor_name: vendorName, vendor_address: vendorAddress,
      construction_id: constructionId, delivery_date: deliveryDate || null, notes: poNotes,
    });
    setShowCreate(false);
    setVendorName(''); setVendorAddress(''); setConstructionId(null); setDeliveryDate(''); setPoNotes('');
    await load();
    if (id) selectOrder(id);
  };

  const createFromConstruction = async () => {
    if (!constructionId) return alert('施工案件を選択してください');
    const id = await api.createPOFromConstruction(constructionId);
    setShowCreate(false);
    setConstructionId(null);
    await load();
    if (id) selectOrder(id);
  };

  const deleteOrder = async (id: number) => {
    if (!confirm('この発注書を削除しますか？')) return;
    await api.deletePurchaseOrder(id);
    setSelected(null); setDetail(null);
    load();
  };

  const updateStatus = async (status: string) => {
    if (!detail) return;
    await api.updatePurchaseOrder({ ...detail, status });
    selectOrder(detail.id);
    load();
  };

  const updateVendor = async () => {
    if (!detail) return;
    await api.updatePurchaseOrder(detail);
    load();
  };

  const addItem = async () => {
    if (!detail || !itemName.trim()) return;
    await api.addPurchaseOrderItem({ purchase_order_id: detail.id, name: itemName, quantity: itemQty, unit: itemUnit, unit_price: itemPrice });
    setItemName(''); setItemQty(1); setItemUnit('式'); setItemPrice(0);
    selectOrder(detail.id);
    load();
  };

  const deleteItem = async (id: number) => {
    await api.deletePurchaseOrderItem(id);
    selectOrder(detail.id);
    load();
  };

  const generatePDF = async () => {
    if (!detail) return;
    await api.generatePurchaseOrderPDF({ po: detail, items: detail.items });
  };

  return (
    <div>
      <div className="page-header">
        <h1>📝 発注書</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ 新規作成</button>
      </div>

      {showCreate && (
        <div className="card" style={{ marginBottom: 16, border: '2px solid #3498db' }}>
          <h3 style={{ marginBottom: 12 }}>発注書作成</h3>
          <div className="form-row">
            <div className="form-group">
              <label>発注先名</label>
              <input value={vendorName} onChange={e => setVendorName(e.target.value)} placeholder="例: ○○建材店" />
            </div>
            <div className="form-group">
              <label>発注先住所</label>
              <input value={vendorAddress} onChange={e => setVendorAddress(e.target.value)} placeholder="例: 大阪市..." />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>施工案件</label>
              <select value={constructionId || ''} onChange={e => setConstructionId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">（選択してください）</option>
                {constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>納期</label>
              <input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>備考</label>
            <input value={poNotes} onChange={e => setPoNotes(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={createOrder}>空の発注書を作成</button>
            {constructionId && <button className="btn btn-secondary" onClick={createFromConstruction}>見積明細から自動作成</button>}
            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>キャンセル</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16 }}>
        {/* 一覧 */}
        <div style={{ width: 360, flexShrink: 0 }}>
          {orders.map((o: any) => (
            <div key={o.id} className="card" style={{ marginBottom: 8, cursor: 'pointer', border: selected?.id === o.id ? '2px solid #3498db' : undefined }}
              onClick={() => selectOrder(o.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 'bold' }}>{o.vendor_name || '（発注先未設定）'}</div>
                  <div style={{ fontSize: 12, color: '#888' }}>{o.construction_title || '—'} / {o.issue_date}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 'bold' }}>{fmt(o.amount)}</div>
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: statusColors[o.status] + '22', color: statusColors[o.status] }}>
                    {statusLabels[o.status]}
                  </span>
                </div>
              </div>
            </div>
          ))}
          {orders.length === 0 && <div className="card" style={{ textAlign: 'center', color: '#999' }}>発注書なし</div>}
        </div>

        {/* 詳細 */}
        {detail && (
          <div style={{ flex: 1 }}>
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3>PO-{String(detail.id).padStart(4, '0')}</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm btn-primary" onClick={generatePDF}>PDF出力</button>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteOrder(detail.id)}>削除</button>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>発注先</label>
                  <input value={detail.vendor_name || ''} onChange={e => setDetail({ ...detail, vendor_name: e.target.value })} onBlur={updateVendor} />
                </div>
                <div className="form-group">
                  <label>ステータス</label>
                  <select value={detail.status} onChange={e => updateStatus(e.target.value)}>
                    <option value="draft">下書き</option>
                    <option value="sent">発注済</option>
                    <option value="delivered">納品済</option>
                    <option value="cancelled">キャンセル</option>
                  </select>
                </div>
              </div>

              <h4 style={{ marginTop: 16, marginBottom: 8 }}>明細</h4>
              <table className="data-table">
                <thead>
                  <tr><th>品名</th><th style={{ textAlign: 'center' }}>数量</th><th style={{ textAlign: 'center' }}>単位</th><th style={{ textAlign: 'right' }}>単価</th><th style={{ textAlign: 'right' }}>金額</th><th></th></tr>
                </thead>
                <tbody>
                  {(detail.items || []).map((item: any) => (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td style={{ textAlign: 'center' }}>{item.quantity}</td>
                      <td style={{ textAlign: 'center' }}>{item.unit}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(item.unit_price)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{fmt(item.quantity * item.unit_price)}</td>
                      <td><button className="btn btn-sm btn-danger" onClick={() => deleteItem(item.id)}>×</button></td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid #333', fontWeight: 'bold' }}>
                    <td colSpan={4} style={{ textAlign: 'right' }}>合計（税抜）</td>
                    <td style={{ textAlign: 'right' }}>{fmt(detail.amount || 0)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>

              <div style={{ marginTop: 12, padding: 12, background: '#f8f9fa', borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>明細追加</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <input value={itemName} onChange={e => setItemName(e.target.value)} placeholder="品名" style={{ flex: 1 }} />
                  <input type="number" value={itemQty} onChange={e => setItemQty(Number(e.target.value))} style={{ width: 60 }} min={0.1} step={0.1} />
                  <input value={itemUnit} onChange={e => setItemUnit(e.target.value)} style={{ width: 50 }} />
                  <input type="number" value={itemPrice} onChange={e => setItemPrice(Number(e.target.value))} placeholder="単価" style={{ width: 100 }} />
                  <button className="btn btn-sm btn-primary" onClick={addItem}>追加</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
