import React, { useEffect, useState } from 'react';

export default function PropertiesPage() {
  const [properties, setProperties] = useState<any[]>([]);
  const [constructions, setConstructions] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: '', address: '', floorPlanImage: '', notes: '' });

  useEffect(() => { load(); }, []);

  const load = async () => {
    const [p, c] = await Promise.all([
      window.api.listProperties(),
      window.api.listConstructions(),
    ]);
    setProperties(p);
    setConstructions(c);
  };

  const getPropertyFinance = (propertyId: number) => {
    const pCons = constructions.filter((c: any) => c.property_id === propertyId);
    const totalCost = pCons.reduce((s: number, c: any) => s + (c.total_cost || 0), 0);
    const totalSelling = pCons.reduce((s: number, c: any) => s + (c.selling_price || 0), 0);
    const totalProfit = pCons.reduce((s: number, c: any) => s + (c.gross_profit || 0), 0);
    return { count: pCons.length, totalCost, totalSelling, totalProfit };
  };

  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', address: '', floorPlanImage: '', notes: '' });
    setShowModal(true);
  };

  const openEdit = (p: any) => {
    setEditing(p);
    setForm({ name: p.name, address: p.address || '', floorPlanImage: p.floor_plan_image || '', notes: p.notes || '' });
    setShowModal(true);
  };

  const selectImage = async () => {
    const img = await window.api.selectImage();
    if (img) setForm({ ...form, floorPlanImage: img });
  };

  const save = async () => {
    if (!form.name.trim()) return;
    if (editing) {
      await window.api.updateProperty({ ...form, id: editing.id });
    } else {
      await window.api.createProperty(form);
    }
    setShowModal(false);
    load();
  };

  const remove = async (id: number) => {
    if (confirm('この物件を削除しますか？')) {
      await window.api.deleteProperty(id);
      load();
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>物件管理</h1>
      </div>
      <div style={{ marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 物件名・住所で検索..." style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 6, width: 300, fontSize: 14 }} />
        <button className="btn btn-primary" onClick={openCreate}>+ 新規物件</button>
      </div>

      {properties.length === 0 ? (
        <div className="empty-state">
          <p>物件がまだ登録されていません</p>
          <button className="btn btn-primary" onClick={openCreate}>最初の物件を登録する</button>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>物件名</th>
              <th>住所</th>
              <th>間取り</th>
              <th>施工数</th>
              <th style={{ textAlign: 'right' }}>経費</th>
              <th style={{ textAlign: 'right' }}>売上</th>
              <th style={{ textAlign: 'right' }}>粗利</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {properties.filter((p: any) => !search || (p.name||'').includes(search) || (p.address||'').includes(search)).map((p: any) => {
              const fin = getPropertyFinance(p.id);
              return (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td style={{ fontSize: 12 }}>{p.address || '-'}</td>
                  <td>{p.floor_plan_image ? '📷' : '-'}</td>
                  <td>{fin.count > 0 ? `${fin.count}件` : '-'}</td>
                  <td style={{ textAlign: 'right', color: '#c0392b', fontSize: 12 }}>{fin.totalCost > 0 ? fmt(fin.totalCost) : '-'}</td>
                  <td style={{ textAlign: 'right', color: '#2980b9', fontWeight: fin.totalSelling > 0 ? 'bold' : 'normal', fontSize: 12 }}>{fin.totalSelling > 0 ? fmt(fin.totalSelling) : '-'}</td>
                  <td style={{ textAlign: 'right', color: '#27ae60', fontWeight: fin.totalProfit > 0 ? 'bold' : 'normal', fontSize: 12 }}>{fin.totalProfit > 0 ? fmt(fin.totalProfit) : '-'}</td>
                  <td>
                    <button className="btn btn-sm btn-secondary" onClick={() => openEdit(p)}>編集</button>
                    {' '}
                    <button className="btn btn-sm btn-danger" onClick={() => remove(p.id)}>削除</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{editing ? '物件を編集' : '新規物件登録'}</h2>
            <div className="form-group">
              <label>物件名 *</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例: ○○邸新築工事" />
            </div>
            <div className="form-group">
              <label>住所</label>
              <input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="例: 東京都渋谷区..." />
            </div>
            <div className="form-group">
              <label>間取り図</label>
              <button className="btn btn-secondary btn-sm" onClick={selectImage}>画像を選択</button>
              {form.floorPlanImage && <img src={form.floorPlanImage} className="image-preview" alt="間取り" />}
            </div>
            <div className="form-group">
              <label>メモ</label>
              <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="備考..." />
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>キャンセル</button>
              <button className="btn btn-primary" onClick={save}>{editing ? '更新' : '登録'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
