import React, { useEffect, useState } from 'react';
import { PageGuide } from '../components/PageGuide';

export default function MaterialsPage() {
  const [materials, setMaterials] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: '', category: '', unit: '個', unitPrice: 0, notes: '' });
  const [search, setSearch] = useState('');

  useEffect(() => { load(); }, []);

  const load = async () => {
    setMaterials(await window.api.listMaterials());
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', category: '', unit: '個', unitPrice: 0, notes: '' });
    setShowModal(true);
  };

  const openEdit = (m: any) => {
    setEditing(m);
    setForm({ name: m.name, category: m.category, unit: m.unit, unitPrice: m.unit_price, notes: m.notes || '' });
    setShowModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) return;
    if (editing) {
      await window.api.updateMaterial({ ...form, id: editing.id });
    } else {
      await window.api.createMaterial(form);
    }
    setShowModal(false);
    load();
  };

  const remove = async (id: number) => {
    if (confirm('この材料を削除しますか？')) {
      await window.api.deleteMaterial(id);
      load();
    }
  };

  const filtered = materials.filter(m => !search || (m.name||'').includes(search) || (m.category||'').includes(search));
  const categories = [...new Set(filtered.map(m => m.category))];

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>材料マスタ</h1>
        <PageGuide pageKey="materials" steps={[
          { icon: '🧱', title: 'STEP 1：材料を登録', desc: '「+ 新規材料」からよく使う材料の名前・カテゴリ・単位・単価を登録します。', sub: 'CSVインポートで一括登録も可能です' },
          { icon: '📂', title: 'STEP 2：カテゴリで整理', desc: '材料はカテゴリ別に自動グループ化されます。検索で素早く見つけられます。' },
          { icon: '⚡', title: 'STEP 3：施工時に呼び出し', desc: '登録した材料は施工案件の明細追加時にマスタから選択できます。入力の手間を大幅に削減します。' },
        ]} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 材料名・カテゴリで検索..." style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 6, width: 300, fontSize: 14 }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={async () => { const n = await (window as any).api.importMaterialsCSV(); if (n) { alert(`${n}件インポートしました`); load(); } }}>CSVインポート</button>
          <button className="btn btn-primary" onClick={openCreate}>+ 新規材料</button>
        </div>
      </div>

      {materials.length === 0 ? (
        <div className="empty-state">
          <p>材料がまだ登録されていません</p>
          <button className="btn btn-primary" onClick={openCreate}>最初の材料を登録する</button>
        </div>
      ) : (
        <>
          {categories.map(cat => (
            <div key={cat} className="card">
              <h3 style={{ marginBottom: 12 }}>{cat}</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>材料名</th>
                    <th>単位</th>
                    <th>単価</th>
                    <th>メモ</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.filter(m => m.category === cat).map((m: any) => (
                    <tr key={m.id}>
                      <td><strong>{m.name}</strong></td>
                      <td>{m.unit}</td>
                      <td>¥{m.unit_price.toLocaleString()}</td>
                      <td>{m.notes || '-'}</td>
                      <td>
                        <button className="btn btn-sm btn-secondary" onClick={() => openEdit(m)}>編集</button>
                        {' '}
                        <button className="btn btn-sm btn-danger" onClick={() => remove(m.id)}>削除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{editing ? '材料を編集' : '新規材料登録'}</h2>
            <div className="form-row">
              <div className="form-group">
                <label>材料名 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例: 構造用合板" />
              </div>
              <div className="form-group">
                <label>カテゴリ</label>
                <input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} list="categories" placeholder="例: 木材" />
                <datalist id="categories">
                  <option value="木材" />
                  <option value="金属" />
                  <option value="建材" />
                  <option value="塗料" />
                  <option value="電気" />
                  <option value="水道" />
                  <option value="外構" />
                  <option value="内装" />
                  <option value="その他" />
                </datalist>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>単位</label>
                <select value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })}>
                  <option value="個">個</option>
                  <option value="本">本</option>
                  <option value="枚">枚</option>
                  <option value="m">m</option>
                  <option value="m²">m²</option>
                  <option value="m³">m³</option>
                  <option value="kg">kg</option>
                  <option value="缶">缶</option>
                  <option value="セット">セット</option>
                  <option value="式">式</option>
                </select>
              </div>
              <div className="form-group">
                <label>単価 (円)</label>
                <input type="number" value={form.unitPrice} onChange={e => setForm({ ...form, unitPrice: Number(e.target.value) })} />
              </div>
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
