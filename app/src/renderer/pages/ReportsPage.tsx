import React, { useEffect, useState } from 'react';

export default function ReportsPage() {
  const [constructions, setConstructions] = useState<any[]>([]);

  useEffect(() => {
    window.api.listConstructions().then(setConstructions);
  }, []);

  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

  // 月別集計
  const monthly: Record<string, { count: number; revenue: number; matCost: number; laborCost: number; profit: number }> = {};
  constructions.forEach((c: any) => {
    const m = c.construction_date?.substring(0, 7) || '不明';
    if (!monthly[m]) monthly[m] = { count: 0, revenue: 0, matCost: 0, laborCost: 0, profit: 0 };
    monthly[m].count++;
    monthly[m].revenue += c.selling_price || 0;
    monthly[m].matCost += c.material_cost || 0;
    monthly[m].laborCost += c.labor_cost || 0;
    monthly[m].profit += c.gross_profit || 0;
  });
  const monthlyEntries = Object.entries(monthly).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12);

  // 工事タイプ別集計
  const byType: Record<string, { count: number; totalRevenue: number; totalProfit: number }> = {};
  constructions.forEach((c: any) => {
    const type = c.notes?.split('\n')[0] || c.title?.split(' ').pop() || 'その他';
    if (!byType[type]) byType[type] = { count: 0, totalRevenue: 0, totalProfit: 0 };
    byType[type].count++;
    byType[type].totalRevenue += c.selling_price || 0;
    byType[type].totalProfit += c.gross_profit || 0;
  });
  const typeEntries = Object.entries(byType).sort((a, b) => b[1].count - a[1].count).slice(0, 15);

  // ステータス別
  const byStatus: Record<string, number> = {};
  constructions.forEach((c: any) => {
    const s = c.status || '完了';
    byStatus[s] = (byStatus[s] || 0) + 1;
  });

  return (
    <div>
      <div className="page-header">
        <h1>利益レポート</h1>
      </div>

      {/* ステータス別サマリー */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {Object.entries(byStatus).map(([s, cnt]) => {
          const colors: any = { '見積中': '#95a5a6', '受注済': '#3498db', '施工中': '#e67e22', '完了': '#27ae60', 'キャンセル': '#e74c3c' };
          return (
            <div key={s} className="card" style={{ padding: '10px 20px', textAlign: 'center', borderTop: `3px solid ${colors[s] || '#888'}` }}>
              <div style={{ fontSize: 24, fontWeight: 'bold', color: colors[s] || '#888' }}>{cnt}</div>
              <div style={{ fontSize: 12, color: '#888' }}>{s}</div>
            </div>
          );
        })}
      </div>

      {/* 月別テーブル */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>月別サマリー</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>月</th>
              <th>施工数</th>
              <th style={{ textAlign: 'right' }}>売上</th>
              <th style={{ textAlign: 'right' }}>材料費</th>
              <th style={{ textAlign: 'right' }}>人件費</th>
              <th style={{ textAlign: 'right' }}>粗利</th>
              <th style={{ textAlign: 'right' }}>粗利率</th>
            </tr>
          </thead>
          <tbody>
            {monthlyEntries.map(([m, v]) => {
              const rate = v.revenue > 0 ? Math.round((v.profit / v.revenue) * 1000) / 10 : 0;
              return (
                <tr key={m}>
                  <td><strong>{m}</strong></td>
                  <td>{v.count}件</td>
                  <td style={{ textAlign: 'right', color: '#2980b9', fontWeight: 'bold' }}>{fmt(v.revenue)}</td>
                  <td style={{ textAlign: 'right', color: '#c0392b', fontSize: 12 }}>{fmt(v.matCost)}</td>
                  <td style={{ textAlign: 'right', color: '#e67e22', fontSize: 12 }}>{fmt(v.laborCost)}</td>
                  <td style={{ textAlign: 'right', color: '#27ae60', fontWeight: 'bold' }}>{fmt(v.profit)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold', color: rate < 15 ? '#e74c3c' : rate < 20 ? '#e67e22' : '#27ae60' }}>{rate}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 工事タイプ別 */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>工事タイプ別</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>工事タイプ</th>
              <th>件数</th>
              <th style={{ textAlign: 'right' }}>平均売価</th>
              <th style={{ textAlign: 'right' }}>平均粗利率</th>
            </tr>
          </thead>
          <tbody>
            {typeEntries.map(([type, v]) => {
              const avgRevenue = v.count > 0 ? v.totalRevenue / v.count : 0;
              const avgRate = v.totalRevenue > 0 ? Math.round((v.totalProfit / v.totalRevenue) * 1000) / 10 : 0;
              return (
                <tr key={type}>
                  <td><strong>{type}</strong></td>
                  <td>{v.count}件</td>
                  <td style={{ textAlign: 'right' }}>{fmt(avgRevenue)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold', color: avgRate < 15 ? '#e74c3c' : avgRate < 20 ? '#e67e22' : '#27ae60' }}>{avgRate}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
