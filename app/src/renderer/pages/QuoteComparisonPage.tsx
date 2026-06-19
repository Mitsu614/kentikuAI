import React, { useEffect, useState } from 'react';
import { PageGuide } from '../components/PageGuide';

const api = (window as any).api;
const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

export default function QuoteComparisonPage() {
  const [tab, setTab] = useState<'create' | 'compare'>('create');
  const [constructions, setConstructions] = useState<any[]>([]);
  const [comparisons, setComparisons] = useState<any[]>([]);
  const [selectedComp, setSelectedComp] = useState<any>(null);

  // new comparison
  const [newTitle, setNewTitle] = useState('');
  const [newCid, setNewCid] = useState<number | null>(null);

  // add vendor
  const [addingTo, setAddingTo] = useState<number | null>(null);
  const [vendorName, setVendorName] = useState('');
  const [vendorNotes, setVendorNotes] = useState('');
  const [vendorItems, setVendorItems] = useState<{ name: string; quantity: number; unit: string; unit_price: number }[]>([{ name: '', quantity: 1, unit: '式', unit_price: 0 }]);

  const load = async () => {
    const c = await api.listConstructions();
    setConstructions(c);
    const comps = await api.listQuoteComparisons();
    setComparisons(comps);
  };
  useEffect(() => { load(); }, []);

  const createComparison = async () => {
    if (!newTitle.trim()) return alert('タイトルを入力してください');
    await api.createQuoteComparison({ construction_id: newCid, title: newTitle });
    setNewTitle('');
    load();
  };

  const deleteComparison = async (id: number) => {
    if (!confirm('この比較表を削除しますか？')) return;
    await api.deleteQuoteComparison(id);
    if (selectedComp?.id === id) setSelectedComp(null);
    load();
  };

  const addVendor = async (compId: number) => {
    if (!vendorName.trim()) return alert('業者名を入力してください');
    const items = vendorItems.filter(i => i.name.trim());
    await api.addQuoteVendor({ comparison_id: compId, vendor_name: vendorName, items, notes: vendorNotes });
    setVendorName(''); setVendorNotes('');
    setVendorItems([{ name: '', quantity: 1, unit: '式', unit_price: 0 }]);
    setAddingTo(null);
    loadDetail(compId);
  };

  const loadDetail = async (id: number) => {
    const detail = await api.getQuoteComparisonDetail(id);
    setSelectedComp(detail);
  };

  const deleteVendor = async (vendorId: number) => {
    if (!confirm('この業者の見積を削除しますか？')) return;
    await api.deleteQuoteVendor(vendorId);
    if (selectedComp) loadDetail(selectedComp.id);
  };

  const addItemRow = () => {
    setVendorItems([...vendorItems, { name: '', quantity: 1, unit: '式', unit_price: 0 }]);
  };

  const updateItem = (idx: number, field: string, value: any) => {
    const items = [...vendorItems];
    (items[idx] as any)[field] = value;
    setVendorItems(items);
  };

  const removeItem = (idx: number) => {
    setVendorItems(vendorItems.filter((_, i) => i !== idx));
  };

  // comparison view
  const comparisonView = () => {
    if (!selectedComp?.vendors?.length) return null;
    const vendors = selectedComp.vendors;
    const allItems: string[] = [];
    for (const v of vendors) { for (const item of v.items || []) { if (!allItems.includes(item.name)) allItems.push(item.name); } }

    const totals = vendors.map((v: any) => v.total || 0);
    const minTotal = Math.min(...totals);

    return (
      <div className="card" style={{ marginTop: 16, overflow: 'auto' }}>
        <h3 style={{ marginBottom: 12 }}>比較ビュー: {selectedComp.title}</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>項目</th>
              {vendors.map((v: any) => <th key={v.id} style={{ textAlign: 'right', minWidth: 120 }}>{v.vendor_name}</th>)}
            </tr>
          </thead>
          <tbody>
            {allItems.map((itemName: string) => {
              const prices = vendors.map((v: any) => {
                const item = (v.items || []).find((i: any) => i.name === itemName);
                return item ? Math.round(item.quantity * item.unit_price) : null;
              });
              const validPrices = prices.filter((p: any): p is number => p !== null);
              const minPrice = Math.min(...validPrices);
              const maxPrice = Math.max(...validPrices);

              return (
                <tr key={itemName}>
                  <td>{itemName}</td>
                  {prices.map((p: number | null, i: number) => (
                    <td key={i} style={{
                      textAlign: 'right',
                      background: p === minPrice && validPrices.length > 1 ? '#e8f5e9' : p === maxPrice && validPrices.length > 1 ? '#fde8e8' : 'transparent',
                      color: p === minPrice && validPrices.length > 1 ? '#27ae60' : p === maxPrice && validPrices.length > 1 ? '#e74c3c' : '#333',
                      fontWeight: (p === minPrice || p === maxPrice) && validPrices.length > 1 ? 'bold' : 'normal',
                    }}>
                      {p !== null ? fmt(p) : '—'}
                      {p !== null && p !== minPrice && minPrice > 0 && (
                        <span style={{ fontSize: 10, color: '#e74c3c', marginLeft: 4 }}>+{Math.round(((p - minPrice) / minPrice) * 100)}%</span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr style={{ borderTop: '2px solid #333', background: '#f5f5f5' }}>
              <td><strong>合計</strong></td>
              {vendors.map((v: any) => (
                <td key={v.id} style={{ textAlign: 'right', fontWeight: 'bold', fontSize: 14 }}>
                  {fmt(v.total)} {v.total === minTotal && vendors.length > 1 && <span style={{ color: '#27ae60' }}>🏆</span>}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => api.generateQuoteComparisonPDF({ comparison_id: selectedComp.id })}>PDF出力</button>
          {vendors.map((v: any) => (
            <button key={v.id} className="btn btn-sm btn-danger" onClick={() => deleteVendor(v.id)}>
              {v.vendor_name}を削除
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>⚖️ 見積比較</h1>
        <PageGuide pageKey="quote-comparison" steps={[
          { icon: '📝', title: 'STEP 1：比較表を作成', desc: 'タイトルと施工案件を選んで比較表を作成します。' },
          { icon: '🏢', title: 'STEP 2：業者の見積を追加', desc: '複数の業者から届いた見積もりの明細（品名・数量・単価）を入力します。' },
          { icon: '⚖️', title: 'STEP 3：比較して最適な業者を選定', desc: '業者ごとの合計金額を並べて比較し、最適な発注先を判断できます。' },
        ]} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn ${tab === 'create' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('create')}>比較表管理</button>
        <button className={`btn ${tab === 'compare' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('compare')}>比較ビュー</button>
      </div>

      {tab === 'create' && (
        <div>
          <div className="card">
            <h3 style={{ marginBottom: 12 }}>新規比較表</h3>
            <div className="form-row">
              <div className="form-group"><label>タイトル</label><input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="例: 足場業者比較" /></div>
              <div className="form-group"><label>施工案件</label>
                <select value={newCid || ''} onChange={e => setNewCid(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">（任意）</option>{constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </div>
            </div>
            <button className="btn btn-primary" onClick={createComparison}>作成</button>
          </div>

          {comparisons.map((comp: any) => (
            <div key={comp.id} className="card" style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ fontSize: 16 }}>{comp.title}</strong>
                  {comp.construction_title && <span style={{ marginLeft: 8, color: '#888', fontSize: 12 }}>{comp.construction_title}</span>}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm btn-primary" onClick={() => { loadDetail(comp.id); setTab('compare'); }}>比較ビュー</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => setAddingTo(addingTo === comp.id ? null : comp.id)}>+ 業者追加</button>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteComparison(comp.id)}>削除</button>
                </div>
              </div>

              {addingTo === comp.id && (
                <div style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 8 }}>
                  <div className="form-row">
                    <div className="form-group"><label>業者名</label><input value={vendorName} onChange={e => setVendorName(e.target.value)} placeholder="例: ○○建材" /></div>
                    <div className="form-group"><label>備考</label><input value={vendorNotes} onChange={e => setVendorNotes(e.target.value)} /></div>
                  </div>
                  <label style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 8, display: 'block' }}>明細</label>
                  {vendorItems.map((item, idx) => (
                    <div key={idx} className="form-row" style={{ marginBottom: 4 }}>
                      <input value={item.name} onChange={e => updateItem(idx, 'name', e.target.value)} placeholder="品名" style={{ flex: 2 }} />
                      <input type="number" value={item.quantity} onChange={e => updateItem(idx, 'quantity', Number(e.target.value))} style={{ width: 60 }} />
                      <input value={item.unit} onChange={e => updateItem(idx, 'unit', e.target.value)} style={{ width: 50 }} />
                      <input type="number" value={item.unit_price} onChange={e => updateItem(idx, 'unit_price', Number(e.target.value))} placeholder="単価" style={{ width: 100 }} />
                      <span style={{ fontSize: 12, color: '#888', minWidth: 80, textAlign: 'right' }}>{fmt(item.quantity * item.unit_price)}</span>
                      {vendorItems.length > 1 && <button onClick={() => removeItem(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>🗑️</button>}
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn btn-sm btn-secondary" onClick={addItemRow}>+ 行追加</button>
                    <button className="btn btn-sm btn-primary" onClick={() => addVendor(comp.id)}>業者を登録</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {comparisons.length === 0 && <div className="card" style={{ textAlign: 'center', color: '#999', marginTop: 12 }}>比較表なし</div>}
        </div>
      )}

      {tab === 'compare' && (
        <div>
          {!selectedComp && (
            <div className="card">
              <h3 style={{ marginBottom: 12 }}>比較表を選択</h3>
              {comparisons.map((comp: any) => (
                <button key={comp.id} className="btn btn-secondary" style={{ margin: 4 }} onClick={() => loadDetail(comp.id)}>
                  {comp.title}
                </button>
              ))}
              {comparisons.length === 0 && <p style={{ color: '#999' }}>先に比較表を作成してください</p>}
            </div>
          )}
          {selectedComp && comparisonView()}
        </div>
      )}
    </div>
  );
}
