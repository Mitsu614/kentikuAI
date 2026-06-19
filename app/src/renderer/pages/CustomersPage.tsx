import React, { useEffect, useState } from 'react';
import { PageGuide } from '../components/PageGuide';

export default function CustomersPage() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => { window.api.listInvoices().then(setInvoices); }, []);

  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

  // 顧客別に集計
  const customers: Record<string, { count: number; totalRevenue: number; firstDate: string; lastDate: string; statuses: string[] }> = {};
  invoices.forEach((inv: any) => {
    const name = inv.client_name || '不明';
    if (!customers[name]) customers[name] = { count: 0, totalRevenue: 0, firstDate: '9999', lastDate: '0000', statuses: [] };
    customers[name].count++;
    customers[name].totalRevenue += inv.amount || 0;
    if (inv.issue_date < customers[name].firstDate) customers[name].firstDate = inv.issue_date;
    if (inv.issue_date > customers[name].lastDate) customers[name].lastDate = inv.issue_date;
    customers[name].statuses.push(inv.status);
  });

  const entries = Object.entries(customers)
    .filter(([name]) => !search || name.includes(search))
    .sort((a, b) => b[1].totalRevenue - a[1].totalRevenue);

  const totalRevenue = entries.reduce((s, [, v]) => s + v.totalRevenue, 0);
  const repeatCustomers = entries.filter(([, v]) => v.count >= 2).length;

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>顧客管理</h1>
        <PageGuide pageKey="customers" steps={[
          { icon: '👥', title: 'STEP 1：顧客一覧を確認', desc: '請求書データから顧客が自動集計されます。取引額順にランキング表示されます。' },
          { icon: '🔁', title: 'STEP 2：リピーターを把握', desc: '2回以上取引のある顧客はリピーターとして表示。リピート率も確認できます。' },
          { icon: '🔍', title: 'STEP 3：顧客を検索', desc: '顧客名で検索して、取引履歴やステータスを素早く確認できます。' },
        ]} />
      </div>

      {/* サマリー */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ flex: 1, textAlign: 'center', padding: 14 }}>
          <div style={{ fontSize: 28, fontWeight: 'bold' }}>{entries.length}</div>
          <div style={{ fontSize: 12, color: '#888' }}>顧客数</div>
        </div>
        <div className="card" style={{ flex: 1, textAlign: 'center', padding: 14 }}>
          <div style={{ fontSize: 28, fontWeight: 'bold', color: '#27ae60' }}>{repeatCustomers}</div>
          <div style={{ fontSize: 12, color: '#888' }}>リピーター（2回以上）</div>
        </div>
        <div className="card" style={{ flex: 1, textAlign: 'center', padding: 14 }}>
          <div style={{ fontSize: 28, fontWeight: 'bold', color: '#3498db' }}>{entries.length > 0 ? Math.round(repeatCustomers / entries.length * 100) : 0}%</div>
          <div style={{ fontSize: 12, color: '#888' }}>リピート率</div>
        </div>
        <div className="card" style={{ flex: 1, textAlign: 'center', padding: 14 }}>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: '#2980b9' }}>{fmt(totalRevenue)}</div>
          <div style={{ fontSize: 12, color: '#888' }}>累計取引額</div>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 顧客名で検索..." style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 6, width: 300, fontSize: 14 }} />
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>顧客名</th>
            <th>取引回数</th>
            <th style={{ textAlign: 'right' }}>累計取引額</th>
            <th>初回取引</th>
            <th>直近取引</th>
            <th>ステータス</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([name, v]) => {
            const paidCount = v.statuses.filter(s => s === 'paid').length;
            const unpaid = v.count - paidCount;
            return (
              <tr key={name}>
                <td><strong>{name}</strong>{v.count >= 2 && <span style={{ marginLeft: 6, fontSize: 9, background: '#e8f8f0', color: '#27ae60', padding: '1px 6px', borderRadius: 8 }}>リピーター</span>}</td>
                <td>{v.count}回</td>
                <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#2980b9' }}>{fmt(v.totalRevenue)}</td>
                <td style={{ fontSize: 12 }}>{v.firstDate !== '9999' ? v.firstDate : '-'}</td>
                <td style={{ fontSize: 12 }}>{v.lastDate !== '0000' ? v.lastDate : '-'}</td>
                <td>
                  {paidCount > 0 && <span style={{ fontSize: 10, background: '#e8f8f0', color: '#27ae60', padding: '2px 6px', borderRadius: 8, marginRight: 4 }}>入金{paidCount}</span>}
                  {unpaid > 0 && <span style={{ fontSize: 10, background: '#fdecea', color: '#e74c3c', padding: '2px 6px', borderRadius: 8 }}>未入金{unpaid}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
