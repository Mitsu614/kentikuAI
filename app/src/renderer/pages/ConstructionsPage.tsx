import React, { useEffect, useState } from 'react';

export default function ConstructionsPage({ highlightId, onHighlightClear }: { highlightId?: number | null; onHighlightClear?: () => void }) {
  const [constructions, setConstructions] = useState<any[]>([]);
  const [properties, setProperties] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showDetail, setShowDetail] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ propertyId: '', title: '', constructionDate: '', laborCost: 0, markupRate: 1.3, notes: '', status: '見積中' });

  // 明細関連
  const [detailMaterials, setDetailMaterials] = useState<any[]>([]);
  const [calcResult, setCalcResult] = useState<any>(null);
  const [addMaterialId, setAddMaterialId] = useState('');
  const [addQuantity, setAddQuantity] = useState<string>('1');
  const [addUnitPrice, setAddUnitPrice] = useState<string>('');
  // 手入力モード
  const [search, setSearch] = useState('');
  const [addMode, setAddMode] = useState<'select' | 'manual'>('select');
  const [manualName, setManualName] = useState('');
  const [manualUnit, setManualUnit] = useState('式');

  useEffect(() => { load(); }, []);

  // ハイライト指定があれば自動で開く
  useEffect(() => {
    if (highlightId && constructions.length > 0) {
      const target = constructions.find((c: any) => c.id === highlightId);
      if (target) openDetail(target);
    }
  }, [highlightId, constructions]);

  const load = async () => {
    const [c, p, m] = await Promise.all([
      window.api.listConstructions(),
      window.api.listProperties(),
      window.api.listMaterials(),
    ]);
    setConstructions(c);
    setProperties(p);
    setMaterials(m);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ propertyId: '', title: '', constructionDate: new Date().toISOString().split('T')[0], laborCost: 0, markupRate: 1.3, notes: '', status: '見積中' });
    setShowModal(true);
  };

  const openEdit = (c: any) => {
    setEditing(c);
    setForm({
      propertyId: c.property_id?.toString() || '',
      title: c.title,
      constructionDate: c.construction_date || '',
      laborCost: c.labor_cost,
      markupRate: c.markup_rate,
      notes: c.notes || '',
      status: c.status || '完了',
    });
    setShowModal(true);
  };

  const save = async () => {
    if (!form.title.trim()) return;
    const data = { ...form, propertyId: form.propertyId ? Number(form.propertyId) : null };
    if (editing) {
      await window.api.updateConstruction({ ...data, id: editing.id });
    } else {
      await window.api.createConstruction(data);
    }
    setShowModal(false);
    load();
  };

  const remove = async (id: number) => {
    if (confirm('この施工履歴を削除しますか？紐づく材料明細も削除されます。')) {
      await window.api.deleteConstruction(id);
      load();
      if (showDetail?.id === id) setShowDetail(null);
    }
  };

  const openDetail = async (c: any) => {
    setShowDetail(c);
    await loadDetail(c.id);
  };

  const loadDetail = async (constructionId: number) => {
    const [mats, calc] = await Promise.all([
      window.api.listConstructionMaterials(constructionId),
      window.api.calculateConstruction(constructionId),
    ]);
    setDetailMaterials(mats);
    setCalcResult(calc);
  };

  // マスタから選択して材料を追加
  const onMaterialSelect = (matId: string) => {
    setAddMaterialId(matId);
    if (matId) {
      const mat = materials.find(m => m.id === Number(matId));
      if (mat) setAddUnitPrice(String(mat.unit_price));
    } else {
      setAddUnitPrice('');
    }
  };

  // 手入力用: まず材料マスタに登録してからconstruction_materialsに追加
  const addMaterial = async () => {
    if (!showDetail) return;
    const qty = Number(addQuantity) || 0;
    const price = Number(addUnitPrice) || 0;
    if (qty <= 0 || price < 0) return;

    if (addMode === 'select') {
      if (!addMaterialId) return;
      await window.api.addConstructionMaterial({
        constructionId: showDetail.id,
        materialId: Number(addMaterialId),
        quantity: qty,
        unitPrice: price,
      });
      setAddMaterialId('');
    } else {
      // 手入力: 材料マスタに新規登録してから追加
      if (!manualName.trim()) return;
      const matId = await window.api.createMaterial({
        name: manualName,
        category: 'その他',
        unit: manualUnit,
        unitPrice: price,
        notes: '手入力で追加',
      });
      await window.api.addConstructionMaterial({
        constructionId: showDetail.id,
        materialId: matId,
        quantity: qty,
        unitPrice: price,
      });
      setManualName('');
      // マスタ更新
      const m = await window.api.listMaterials();
      setMaterials(m);
    }

    setAddQuantity('1');
    setAddUnitPrice('');
    loadDetail(showDetail.id);
  };

  const removeMaterial = async (id: number) => {
    await window.api.removeConstructionMaterial(id);
    if (showDetail) loadDetail(showDetail.id);
  };

  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

  return (
    <div>
      <div className="page-header">
        <h1>施工・見積管理</h1>
        <button className="btn btn-primary" onClick={openCreate}>+ 新規施工</button>
      </div>
      <div style={{ marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 施工名・物件で検索..." style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 6, width: 300, fontSize: 14 }} />
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        {/* 左: 一覧 */}
        <div style={{ flex: showDetail ? '0 0 400px' : '1' }}>
          {constructions.length === 0 ? (
            <div className="empty-state">
              <p>施工履歴がまだありません</p>
              <button className="btn btn-primary" onClick={openCreate}>最初の施工を登録する</button>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>施工名</th>
                  <th>物件</th>
                  <th style={{ textAlign: 'right' }}>経費</th>
                  <th style={{ textAlign: 'right' }}>売上</th>
                  <th style={{ textAlign: 'right' }}>粗利</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {constructions.filter((c: any) => !search || (c.title||'').includes(search) || (c.property_name||'').includes(search)).map((c: any) => (
                  <tr key={c.id} style={{ cursor: 'pointer', background: highlightId === c.id ? '#ffe0e0' : showDetail?.id === c.id ? '#e8f4f8' : undefined, border: highlightId === c.id ? '2px solid #e74c3c' : undefined }} onClick={() => { openDetail(c); if (highlightId === c.id && onHighlightClear) onHighlightClear(); }}>
                    <td>
                      <strong>{c.title}</strong><br/>
                      <span style={{ fontSize: 11, color: '#888' }}>{c.construction_date || ''}</span>
                      {c.status && (() => {
                        const colors: any = { '見積中': '#95a5a6', '受注済': '#3498db', '施工中': '#e67e22', '完了': '#27ae60', 'キャンセル': '#e74c3c' };
                        return <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 8, fontSize: 9, background: (colors[c.status] || '#888') + '20', color: colors[c.status] || '#888' }}>{c.status}</span>;
                      })()}
                    </td>
                    <td>{c.property_name || '-'}</td>
                    <td style={{ textAlign: 'right', color: '#c0392b' }}>{fmt(c.total_cost || 0)}</td>
                    <td style={{ textAlign: 'right', color: '#2980b9', fontWeight: 'bold' }}>{fmt(c.selling_price || 0)}</td>
                    <td style={{ textAlign: 'right', color: '#27ae60', fontWeight: 'bold' }}>{fmt(c.gross_profit || 0)}</td>
                    <td>
                      <button className="btn btn-sm btn-secondary" onClick={e => { e.stopPropagation(); openEdit(c); }}>編集</button>
                      {' '}
                      <button className="btn btn-sm btn-success" onClick={async e => { e.stopPropagation(); await (window as any).api.duplicateConstruction(c.id); load(); }}>複製</button>
                      {' '}
                      <button className="btn btn-sm btn-danger" onClick={e => { e.stopPropagation(); remove(c.id); }}>削除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 右: 詳細 */}
        {showDetail && (
          <div style={{ flex: 1 }}>
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2>{showDetail.title}</h2>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowDetail(null)}>✕ 閉じる</button>
              </div>

              {/* 計算結果 */}
              {calcResult && (
                <div className="calc-card">
                  <div className="calc-item">
                    <div className="label">材料費</div>
                    <div className="value">{fmt(calcResult.materialCost)}</div>
                  </div>
                  <div className="calc-item">
                    <div className="label">人件費</div>
                    <div className="value">{fmt(calcResult.laborCost)}</div>
                  </div>
                  <div className="calc-item">
                    <div className="label">原価合計</div>
                    <div className="value">{fmt(calcResult.totalCost)}</div>
                  </div>
                  <div className="calc-item">
                    <div className="label">売価 (×{calcResult.markupRate})</div>
                    <div className="value">{fmt(calcResult.sellingPrice)}</div>
                  </div>
                  <div className="calc-item profit">
                    <div className="label">粗利</div>
                    <div className="value">{fmt(calcResult.grossProfit)}</div>
                  </div>
                  <div className="calc-item profit">
                    <div className="label">粗利率</div>
                    <div className="value">{calcResult.profitRate}%</div>
                  </div>
                </div>
              )}

              {/* 原価割れアラート */}
              {calcResult && calcResult.profitRate < 15 && (
                <div style={{ background: '#fdecea', border: '2px solid #e74c3c', borderRadius: 8, padding: '10px 16px', margin: '8px 0', color: '#c0392b', fontWeight: 'bold', fontSize: 13 }}>
                  ⚠ 原価割れ注意: 粗利率が15%を下回っています（{calcResult.profitRate}%）
                </div>
              )}
              {calcResult && calcResult.profitRate >= 15 && calcResult.profitRate < 20 && (
                <div style={{ background: '#fff8e1', border: '2px solid #f0d060', borderRadius: 8, padding: '10px 16px', margin: '8px 0', color: '#e67e22', fontWeight: 'bold', fontSize: 13 }}>
                  ⚠ 粗利率が低めです（{calcResult.profitRate}% / 目安20%以上）
                </div>
              )}

              {/* 材料追加 */}
              <h3 style={{ marginTop: 16, marginBottom: 8 }}>項目を追加</h3>

              {/* モード切替タブ */}
              <div style={{ display: 'flex', gap: 0, marginBottom: 12 }}>
                <button
                  onClick={() => setAddMode('select')}
                  style={{
                    padding: '6px 16px', border: '1px solid #ddd', cursor: 'pointer', fontSize: 13,
                    borderRadius: '6px 0 0 6px',
                    background: addMode === 'select' ? '#3a7bd5' : '#fff',
                    color: addMode === 'select' ? '#fff' : '#333',
                  }}
                >マスタから選択</button>
                <button
                  onClick={() => setAddMode('manual')}
                  style={{
                    padding: '6px 16px', border: '1px solid #ddd', borderLeft: 'none', cursor: 'pointer', fontSize: 13,
                    borderRadius: '0 6px 6px 0',
                    background: addMode === 'manual' ? '#3a7bd5' : '#fff',
                    color: addMode === 'manual' ? '#fff' : '#333',
                  }}
                >手入力</button>
              </div>

              {addMode === 'select' ? (
                /* マスタ選択モード */
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="form-group" style={{ flex: 2, marginBottom: 0, minWidth: 200 }}>
                    <label>材料を選択</label>
                    <select value={addMaterialId} onChange={e => onMaterialSelect(e.target.value)}>
                      <option value="">-- 選択 --</option>
                      {materials.map(m => (
                        <option key={m.id} value={String(m.id)}>{m.category} / {m.name} (¥{m.unit_price}/{m.unit})</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group" style={{ flex: 0.5, marginBottom: 0, minWidth: 80 }}>
                    <label>数量</label>
                    <input type="number" value={addQuantity} onChange={e => setAddQuantity(e.target.value)} min={0.1} step={0.1} />
                  </div>
                  <div className="form-group" style={{ flex: 0.7, marginBottom: 0, minWidth: 100 }}>
                    <label>単価（変更可）</label>
                    <input type="number" value={addUnitPrice} onChange={e => setAddUnitPrice(e.target.value)} placeholder="マスタ単価" />
                  </div>
                  <button className="btn btn-success" onClick={addMaterial} style={{ height: 36 }}>追加</button>
                </div>
              ) : (
                /* 手入力モード */
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="form-group" style={{ flex: 2, marginBottom: 0, minWidth: 180 }}>
                    <label>項目名</label>
                    <input value={manualName} onChange={e => setManualName(e.target.value)} placeholder="例: 諸経費、出張費" />
                  </div>
                  <div className="form-group" style={{ flex: 0.4, marginBottom: 0, minWidth: 70 }}>
                    <label>数量</label>
                    <input type="number" value={addQuantity} onChange={e => setAddQuantity(e.target.value)} min={0.1} step={0.1} />
                  </div>
                  <div className="form-group" style={{ flex: 0.4, marginBottom: 0, minWidth: 60 }}>
                    <label>単位</label>
                    <select value={manualUnit} onChange={e => setManualUnit(e.target.value)}>
                      <option value="式">式</option>
                      <option value="個">個</option>
                      <option value="m">m</option>
                      <option value="m²">m²</option>
                      <option value="坪">坪</option>
                      <option value="人日">人日</option>
                      <option value="台">台</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ flex: 0.6, marginBottom: 0, minWidth: 100 }}>
                    <label>単価 (円)</label>
                    <input type="number" value={addUnitPrice} onChange={e => setAddUnitPrice(e.target.value)} placeholder="0" />
                  </div>
                  <button className="btn btn-success" onClick={addMaterial} style={{ height: 36 }}>追加</button>
                </div>
              )}

              {/* 材料明細テーブル */}
              {detailMaterials.length > 0 && (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>カテゴリ</th>
                      <th>材料名</th>
                      <th>数量</th>
                      <th>単価</th>
                      <th>小計</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailMaterials.map((dm: any) => (
                      <EditableRow key={dm.id} dm={dm} onSave={async (d: any) => {
                        await (window as any).api.updateConstructionMaterial(d);
                        if (showDetail) loadDetail(showDetail.id);
                      }} onDelete={() => removeMaterial(dm.id)} />
                    ))}
                  </tbody>
                </table>
              )}

              {/* 工事写真 */}
              <PhotoSection constructionId={showDetail.id} />
            </div>
          </div>
        )}
      </div>

      {/* 新規/編集モーダル */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{editing ? '施工を編集' : '新規施工登録'}</h2>
            <div className="form-group">
              <label>施工名 *</label>
              <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="例: ○○邸キッチンリフォーム" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>物件</label>
                <select value={form.propertyId} onChange={e => setForm({ ...form, propertyId: e.target.value })}>
                  <option value="">-- 選択 --</option>
                  {properties.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>施工日</label>
                <input type="date" value={form.constructionDate} onChange={e => setForm({ ...form, constructionDate: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>人件費 (円)</label>
                <input type="number" value={form.laborCost} onChange={e => setForm({ ...form, laborCost: Number(e.target.value) })} />
              </div>
              <div className="form-group">
                <label>掛け率 (例: 1.3 = 30%上乗せ)</label>
                <input type="number" value={form.markupRate} onChange={e => setForm({ ...form, markupRate: Number(e.target.value) })} step={0.05} min={1} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>ステータス</label>
                <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                  <option value="見積中">見積中</option>
                  <option value="受注済">受注済</option>
                  <option value="施工中">施工中</option>
                  <option value="完了">完了</option>
                  <option value="キャンセル">キャンセル</option>
                </select>
              </div>
              <div className="form-group">
                <label>メモ</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
              </div>
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

function PhotoSection({ constructionId }: { constructionId: number }) {
  const [photos, setPhotos] = useState<any[]>([]);
  const [addLabel, setAddLabel] = useState<string>('before');

  useEffect(() => { load(); }, [constructionId]);

  const load = async () => {
    setPhotos(await (window as any).api.listConstructionPhotos(constructionId));
  };

  const addPhoto = async () => {
    const img = await window.api.selectImage();
    if (!img) return;
    await (window as any).api.addConstructionPhoto({ constructionId, photoData: img, label: addLabel });
    load();
  };

  const deletePhoto = async (id: number) => {
    await (window as any).api.deleteConstructionPhoto(id);
    load();
  };

  const labels: Record<string, string> = { before: 'ビフォー', during: '施工中', after: 'アフター' };
  const labelColors: Record<string, string> = { before: '#95a5a6', during: '#e67e22', after: '#27ae60' };

  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ marginBottom: 8 }}>📷 工事写真</h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <select value={addLabel} onChange={e => setAddLabel(e.target.value)} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd' }}>
          <option value="before">ビフォー</option>
          <option value="during">施工中</option>
          <option value="after">アフター</option>
        </select>
        <button className="btn btn-sm btn-primary" onClick={addPhoto}>写真を追加</button>
      </div>
      {['before', 'during', 'after'].map(label => {
        const filtered = photos.filter(p => p.label === label);
        if (filtered.length === 0) return null;
        return (
          <div key={label} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 'bold', color: labelColors[label], marginBottom: 4 }}>{labels[label]}（{filtered.length}枚）</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {filtered.map(p => (
                <div key={p.id} style={{ position: 'relative' }}>
                  <img src={p.photo_data} style={{ width: 100, height: 75, objectFit: 'cover', borderRadius: 6, border: `2px solid ${labelColors[label]}` }} />
                  <button onClick={() => deletePhoto(p.id)} style={{ position: 'absolute', top: -5, right: -5, background: '#e74c3c', color: '#fff', border: 'none', borderRadius: '50%', width: 16, height: 16, fontSize: 9, cursor: 'pointer' }}>×</button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {photos.length === 0 && <p style={{ color: '#aaa', fontSize: 12 }}>写真がまだありません</p>}
    </div>
  );
}

function EditableRow({ dm, onSave, onDelete }: { dm: any; onSave: (d: any) => void; onDelete: () => void }) {
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
        <td><span style={{ fontSize: 10, color: '#888' }}>{dm.category}</span></td>
        <td><input value={name} onChange={e => setName(e.target.value)} style={{ width: '100%', padding: 2, fontSize: 12, border: '1px solid #3a7bd5', borderRadius: 3 }} /></td>
        <td><div style={{ display: 'flex', gap: 2 }}><input value={qty} onChange={e => setQty(e.target.value)} type="number" style={{ width: 50, padding: 2, fontSize: 12, border: '1px solid #3a7bd5', borderRadius: 3 }} /><input value={unit} onChange={e => setUnit(e.target.value)} style={{ width: 30, padding: 2, fontSize: 12, border: '1px solid #3a7bd5', borderRadius: 3 }} /></div></td>
        <td><input value={price} onChange={e => setPrice(e.target.value)} type="number" style={{ width: 80, padding: 2, fontSize: 12, border: '1px solid #3a7bd5', borderRadius: 3 }} /></td>
        <td><strong>{fmt(Number(qty) * Number(price))}</strong></td>
        <td>
          <button className="btn btn-sm btn-primary" onClick={save} style={{ marginRight: 2 }}>保存</button>
          <button className="btn btn-sm btn-secondary" onClick={() => setEditing(false)}>取消</button>
        </td>
      </tr>
    );
  }

  return (
    <tr onDoubleClick={() => setEditing(true)} style={{ cursor: 'pointer' }} title="ダブルクリックで編集">
      <td>{dm.category}</td>
      <td>{dm.material_name}</td>
      <td>{dm.quantity} {dm.unit}</td>
      <td>{fmt(dm.unit_price)}</td>
      <td><strong>{fmt(dm.quantity * dm.unit_price)}</strong></td>
      <td>
        <button className="btn btn-sm btn-secondary" onClick={() => setEditing(true)} style={{ marginRight: 2 }}>✏</button>
        <button className="btn btn-sm btn-danger" onClick={onDelete}>×</button>
      </td>
    </tr>
  );
}
