import React, { useEffect, useState } from 'react';

const api = (window as any).api;
const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

export default function BudgetPage() {
  const [data, setData] = useState<any[]>([]);

  useEffect(() => {
    api.getBudgetSummary().then((d: any[]) => setData(d));
  }, []);

  const totals = data.reduce((acc, r) => ({
    estSelling: acc.estSelling + r.estimated.selling,
    actSelling: acc.actSelling + r.actual.selling,
    estMaterial: acc.estMaterial + r.estimated.material,
    estLabor: acc.estLabor + r.estimated.labor,
    actLabor: acc.actLabor + r.actual.labor,
    estProfit: acc.estProfit + r.estimated.profit,
    actProfit: acc.actProfit + r.actual.profit,
    invoiced: acc.invoiced + r.invoiced,
    purchased: acc.purchased + r.purchaseOrdered,
  }), { estSelling: 0, actSelling: 0, estMaterial: 0, estLabor: 0, actLabor: 0, estProfit: 0, actProfit: 0, invoiced: 0, purchased: 0 });

  const kpis = [
    { label: '見積売上合計', value: totals.estSelling, color: '#3498db' },
    { label: '請求済合計', value: totals.invoiced, color: '#27ae60' },
    { label: '見積粗利合計', value: totals.estProfit, color: '#f39c12' },
    { label: '発注済合計', value: totals.purchased, color: '#e74c3c' },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>📊 予実管理</h1>
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
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>案件別 予実比較</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>施工案件</th>
              <th>ステータス</th>
              <th style={{ textAlign: 'right' }}>見積売価</th>
              <th style={{ textAlign: 'right' }}>請求済</th>
              <th style={{ textAlign: 'right' }}>見積人件費</th>
              <th style={{ textAlign: 'right' }}>実績人件費</th>
              <th style={{ textAlign: 'right' }}>人件費差額</th>
              <th style={{ textAlign: 'right' }}>見積粗利</th>
              <th style={{ textAlign: 'right' }}>発注済</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r: any) => {
              const laborOver = r.diff.labor < 0;
              const profitDown = r.actual.profit < r.estimated.profit && r.actual.selling > 0;
              return (
                <tr key={r.id} style={{ background: laborOver ? '#fff5f5' : undefined }}>
                  <td>
                    <strong>{r.title}</strong>
                    {r.property_name && <div style={{ fontSize: 11, color: '#888' }}>{r.property_name}</div>}
                  </td>
                  <td>
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10,
                      background: r.status === '完了' ? '#e8f5e9' : r.status === '施工中' ? '#e3f2fd' : r.status === '見積中' ? '#fff8e1' : '#f5f5f5',
                      color: r.status === '完了' ? '#27ae60' : r.status === '施工中' ? '#1976d2' : '#666' }}>
                      {r.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.estimated.selling)}</td>
                  <td style={{ textAlign: 'right' }}>{r.invoiced > 0 ? fmt(r.invoiced) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.estimated.labor)}</td>
                  <td style={{ textAlign: 'right' }}>{r.actual.labor > 0 ? fmt(r.actual.labor) : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold', color: laborOver ? '#e74c3c' : '#27ae60' }}>
                    {r.actual.labor > 0 ? (r.diff.labor >= 0 ? '+' : '') + fmt(r.diff.labor) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: profitDown ? '#e74c3c' : undefined }}>{fmt(r.estimated.profit)}</td>
                  <td style={{ textAlign: 'right' }}>{r.purchaseOrdered > 0 ? fmt(r.purchaseOrdered) : '—'}</td>
                </tr>
              );
            })}
            {data.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: '#999' }}>データなし</td></tr>}
            {data.length > 0 && (
              <tr style={{ borderTop: '3px solid #333', fontWeight: 'bold', background: '#f8f9fa' }}>
                <td>合計</td>
                <td></td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.estSelling)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.invoiced)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.estLabor)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.actLabor)}</td>
                <td style={{ textAlign: 'right', color: totals.estLabor - totals.actLabor < 0 ? '#e74c3c' : '#27ae60' }}>
                  {(totals.estLabor - totals.actLabor >= 0 ? '+' : '') + fmt(totals.estLabor - totals.actLabor)}
                </td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.estProfit)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totals.purchased)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
