import React, { useEffect, useState } from 'react';

const api = (window as any).api;
const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

export default function BudgetPage() {
  const [data, setData] = useState<any[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<any>({});

  const load = () => api.getBudgetSummary().then((d: any[]) => setData(d));
  useEffect(() => { load(); }, []);

  const startEdit = (r: any) => {
    setEditingId(r.id);
    setEditValues({
      actual_selling_price: r.actual.selling || '',
      actual_material_cost: r.actual.material || '',
      actual_labor_cost: r.actual.labor || '',
      status: r.status || '見積中',
    });
  };

  const cancelEdit = () => { setEditingId(null); setEditValues({}); };

  const saveEdit = async (id: number) => {
    await api.updateBudgetActual({
      construction_id: id,
      actual_selling_price: Number(editValues.actual_selling_price) || 0,
      actual_material_cost: Number(editValues.actual_material_cost) || 0,
      actual_labor_cost: Number(editValues.actual_labor_cost) || 0,
      status: editValues.status,
    });
    setEditingId(null);
    setEditValues({});
    load();
  };

  const totals = data.reduce((acc, r) => ({
    estSelling: acc.estSelling + r.estimated.selling,
    actSelling: acc.actSelling + r.actual.selling,
    estMaterial: acc.estMaterial + r.estimated.material,
    actMaterial: acc.actMaterial + r.actual.material,
    estLabor: acc.estLabor + r.estimated.labor,
    actLabor: acc.actLabor + r.actual.labor,
    estProfit: acc.estProfit + r.estimated.profit,
    actProfit: acc.actProfit + r.actual.profit,
    invoiced: acc.invoiced + r.invoiced,
    purchased: acc.purchased + r.purchaseOrdered,
  }), { estSelling: 0, actSelling: 0, estMaterial: 0, actMaterial: 0, estLabor: 0, actLabor: 0, estProfit: 0, actProfit: 0, invoiced: 0, purchased: 0 });

  const kpis = [
    { label: '見積売上合計', value: totals.estSelling, color: '#3498db' },
    { label: '実績売上合計', value: totals.actSelling, color: '#27ae60' },
    { label: '見積粗利合計', value: totals.estProfit, color: '#f39c12' },
    { label: '実績粗利合計', value: totals.actProfit, color: totals.actProfit >= totals.estProfit ? '#27ae60' : '#e74c3c' },
  ];

  const diffColor = (diff: number) => diff >= 0 ? '#27ae60' : '#e74c3c';
  const diffFmt = (diff: number) => (diff >= 0 ? '+' : '') + fmt(diff);

  return (
    <div>
      <div className="page-header">
        <h1>💰 予実管理</h1>
        <span style={{ fontSize: 12, color: '#888' }}>実績を入力すると学習ループが自動で走り、次回AI見積もりの精度が向上します</span>
      </div>

      {/* KPIカード */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {kpis.map((k, i) => (
          <div key={i} className="card" style={{ textAlign: 'center', borderTop: `4px solid ${k.color}` }}>
            <div style={{ fontSize: 12, color: '#888' }}>{k.label}</div>
            <div style={{ fontSize: 24, fontWeight: 'bold', color: k.color, marginTop: 4 }}>{fmt(k.value)}</div>
          </div>
        ))}
      </div>

      {/* 案件別比較 */}
      <div className="card" style={{ overflow: 'auto' }}>
        <h3 style={{ marginBottom: 12 }}>案件別 予実比較</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>施工案件</th>
              <th>状態</th>
              <th style={{ textAlign: 'right' }}>見積売価</th>
              <th style={{ textAlign: 'right' }}>実績売価</th>
              <th style={{ textAlign: 'right' }}>見積材料費</th>
              <th style={{ textAlign: 'right' }}>実績材料費</th>
              <th style={{ textAlign: 'right' }}>見積人件費</th>
              <th style={{ textAlign: 'right' }}>実績人件費</th>
              <th style={{ textAlign: 'right' }}>見積粗利</th>
              <th style={{ textAlign: 'right' }}>実績粗利</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((r: any) => {
              const isEditing = editingId === r.id;
              const actCost = r.actual.material + r.actual.labor;
              const actProfit = r.actual.selling - actCost;
              const profitDiff = actProfit - r.estimated.profit;

              if (isEditing) {
                const eSelling = Number(editValues.actual_selling_price) || 0;
                const eMat = Number(editValues.actual_material_cost) || 0;
                const eLabor = Number(editValues.actual_labor_cost) || 0;
                const eProfit = eSelling - eMat - eLabor;
                return (
                  <tr key={r.id} style={{ background: '#fffde7' }}>
                    <td><strong>{r.title}</strong></td>
                    <td>
                      <select value={editValues.status} onChange={e => setEditValues({ ...editValues, status: e.target.value })} style={{ fontSize: 11, padding: '2px 4px' }}>
                        {['見積中', '施工中', '完了', '請求済'].map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: 'right', color: '#888' }}>{fmt(r.estimated.selling)}</td>
                    <td><input type="number" value={editValues.actual_selling_price} onChange={e => setEditValues({ ...editValues, actual_selling_price: e.target.value })} style={{ width: 100, textAlign: 'right' }} /></td>
                    <td style={{ textAlign: 'right', color: '#888' }}>{fmt(r.estimated.material)}</td>
                    <td><input type="number" value={editValues.actual_material_cost} onChange={e => setEditValues({ ...editValues, actual_material_cost: e.target.value })} style={{ width: 100, textAlign: 'right' }} /></td>
                    <td style={{ textAlign: 'right', color: '#888' }}>{fmt(r.estimated.labor)}</td>
                    <td><input type="number" value={editValues.actual_labor_cost} onChange={e => setEditValues({ ...editValues, actual_labor_cost: e.target.value })} style={{ width: 100, textAlign: 'right' }} /></td>
                    <td style={{ textAlign: 'right', color: '#888' }}>{fmt(r.estimated.profit)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold', color: eProfit >= 0 ? '#27ae60' : '#e74c3c' }}>{fmt(eProfit)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-primary" onClick={() => saveEdit(r.id)}>確定</button>
                      <button className="btn btn-sm btn-secondary" onClick={cancelEdit} style={{ marginLeft: 4 }}>×</button>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={r.id} style={{ background: r.actual.selling > 0 && profitDiff < 0 ? '#fff5f5' : undefined }}>
                  <td>
                    <strong>{r.title}</strong>
                    {r.property_name && <div style={{ fontSize: 11, color: '#888' }}>{r.property_name}</div>}
                  </td>
                  <td>
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10,
                      background: r.status === '完了' ? '#e8f5e9' : r.status === '施工中' ? '#e3f2fd' : r.status === '見積中' ? '#fff8e1' : r.status === '請求済' ? '#f3e8ff' : '#f5f5f5',
                      color: r.status === '完了' ? '#27ae60' : r.status === '施工中' ? '#1976d2' : r.status === '請求済' ? '#8e44ad' : '#666' }}>
                      {r.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.estimated.selling)}</td>
                  <td style={{ textAlign: 'right', fontWeight: r.actual.selling > 0 ? 'bold' : 'normal' }}>
                    {r.actual.selling > 0 ? fmt(r.actual.selling) : <span style={{ color: '#ccc' }}>—</span>}
                    {r.actual.selling > 0 && r.estimated.selling > 0 && (
                      <div style={{ fontSize: 10, color: diffColor(r.actual.selling - r.estimated.selling) }}>
                        {diffFmt(r.actual.selling - r.estimated.selling)}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.estimated.material)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {r.actual.material > 0 ? fmt(r.actual.material) : <span style={{ color: '#ccc' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.estimated.labor)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {r.actual.labor > 0 ? fmt(r.actual.labor) : <span style={{ color: '#ccc' }}>—</span>}
                    {r.actual.labor > 0 && (
                      <div style={{ fontSize: 10, color: diffColor(r.estimated.labor - r.actual.labor) }}>
                        {diffFmt(r.estimated.labor - r.actual.labor)}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.estimated.profit)}</td>
                  <td style={{ textAlign: 'right', fontWeight: r.actual.selling > 0 ? 'bold' : 'normal', color: r.actual.selling > 0 ? (actProfit >= r.estimated.profit ? '#27ae60' : '#e74c3c') : undefined }}>
                    {r.actual.selling > 0 ? fmt(actProfit) : <span style={{ color: '#ccc' }}>—</span>}
                    {r.actual.selling > 0 && (
                      <div style={{ fontSize: 10, color: diffColor(profitDiff) }}>{diffFmt(profitDiff)}</div>
                    )}
                  </td>
                  <td>
                    <button className="btn btn-sm btn-secondary" onClick={() => startEdit(r)}>編集</button>
                  </td>
                </tr>
              );
            })}
            {data.length === 0 && <tr><td colSpan={11} style={{ textAlign: 'center', color: '#999' }}>データなし</td></tr>}
            {data.length > 0 && (
              <tr style={{ borderTop: '3px solid #333', fontWeight: 'bold', background: '#f8f9fa' }}>
                <td>合計</td>
                <td></td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.estSelling)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.actSelling)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.estMaterial)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.actMaterial)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.estLabor)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.actLabor)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.estProfit)}</td>
                <td style={{ textAlign: 'right', color: diffColor(totals.actProfit - totals.estProfit) }}>{fmt(totals.actProfit)}</td>
                <td></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 学習ステータス */}
      {data.some((r: any) => r.actual.selling > 0) && (
        <div className="card" style={{ marginTop: 16, background: '#f0fff4', border: '1px solid #27ae60' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20 }}>🧠</span>
            <div>
              <strong>学習データ蓄積中</strong>
              <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                実績入力済み {data.filter((r: any) => r.actual.selling > 0).length} 件 / 全 {data.length} 件 — 実績データが増えるほどAI見積もりの精度が向上します
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
