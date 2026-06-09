import React, { useEffect, useState } from 'react';

export default function CalendarPage() {
  const [constructions, setConstructions] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  useEffect(() => { load(); }, []);

  const load = async () => {
    const [c, i] = await Promise.all([
      window.api.listConstructions(),
      window.api.listInvoices(),
    ]);
    setConstructions(c);
    setInvoices(i);
  };

  const year = parseInt(currentMonth.split('-')[0]);
  const month = parseInt(currentMonth.split('-')[1]);
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date().toISOString().split('T')[0];

  const prevMonth = () => {
    const d = new Date(year, month - 2, 1);
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const nextMonth = () => {
    const d = new Date(year, month, 1);
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  // 日付ごとのイベントを集約
  const events: Record<string, any[]> = {};
  constructions.forEach(c => {
    if (!c.construction_date) return;
    const d = c.construction_date;
    if (!events[d]) events[d] = [];
    events[d].push({ type: 'construction', label: c.title, color: '#3a7bd5' });
  });
  invoices.forEach(inv => {
    if (inv.due_date && inv.status !== 'paid') {
      const d = inv.due_date;
      if (!events[d]) events[d] = [];
      const overdue = d < today;
      events[d].push({ type: 'due', label: `${inv.client_name} 期限`, color: overdue ? '#e74c3c' : '#e67e22' });
    }
    if (inv.issue_date) {
      const d = inv.issue_date;
      if (!events[d]) events[d] = [];
      events[d].push({ type: 'invoice', label: `${inv.client_name} 発行`, color: '#27ae60' });
    }
  });

  const days = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);

  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

  // 月の集計
  const monthStr = currentMonth;
  const monthCons = constructions.filter(c => c.construction_date?.startsWith(monthStr));
  const monthSelling = monthCons.reduce((s, c) => s + (c.selling_price || 0), 0);
  const monthProfit = monthCons.reduce((s, c) => s + (c.gross_profit || 0), 0);
  const monthDueInvoices = invoices.filter(inv => inv.due_date?.startsWith(monthStr) && inv.status !== 'paid');

  return (
    <div>
      <div className="page-header">
        <h1>カレンダー</h1>
      </div>

      {/* 月ナビ */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, marginBottom: 16 }}>
        <button className="btn btn-secondary" onClick={prevMonth}>◀</button>
        <h2 style={{ margin: 0 }}>{year}年 {month}月</h2>
        <button className="btn btn-secondary" onClick={nextMonth}>▶</button>
      </div>

      {/* 月サマリー */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ flex: 1, textAlign: 'center', padding: 12 }}>
          <div style={{ fontSize: 11, color: '#888' }}>施工</div>
          <div style={{ fontSize: 20, fontWeight: 'bold' }}>{monthCons.length}件</div>
        </div>
        <div className="card" style={{ flex: 1, textAlign: 'center', padding: 12 }}>
          <div style={{ fontSize: 11, color: '#888' }}>売上</div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: '#2980b9' }}>{fmt(monthSelling)}</div>
        </div>
        <div className="card" style={{ flex: 1, textAlign: 'center', padding: 12 }}>
          <div style={{ fontSize: 11, color: '#888' }}>粗利</div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: '#27ae60' }}>{fmt(monthProfit)}</div>
        </div>
        <div className="card" style={{ flex: 1, textAlign: 'center', padding: 12 }}>
          <div style={{ fontSize: 11, color: '#888' }}>支払期限</div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: monthDueInvoices.length > 0 ? '#e74c3c' : '#888' }}>{monthDueInvoices.length}件</div>
        </div>
        <div className="card" style={{ flex: 1, textAlign: 'center', padding: 12 }}>
          <div style={{ fontSize: 11, color: '#888' }}>入金予定</div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: '#3498db' }}>{fmt(monthDueInvoices.reduce((s: number, i: any) => s + (i.amount || 0) * (1 + (i.tax_rate || 0.1)), 0))}</div>
        </div>
      </div>

      {/* 入金予定一覧 */}
      {monthDueInvoices.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 8 }}>💰 入金予定（{month}月）</h3>
          <table className="data-table">
            <thead><tr><th>期限</th><th>請求先</th><th style={{ textAlign: 'right' }}>金額（税込）</th></tr></thead>
            <tbody>
              {monthDueInvoices.sort((a: any, b: any) => (a.due_date || '').localeCompare(b.due_date || '')).map((inv: any) => (
                <tr key={inv.id}>
                  <td style={{ color: inv.due_date < today ? '#e74c3c' : '#333', fontWeight: inv.due_date < today ? 'bold' : 'normal' }}>{inv.due_date}{inv.due_date < today ? ' ⚠超過' : ''}</td>
                  <td>{inv.client_name}</td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{fmt(Math.round((inv.amount || 0) * (1 + (inv.tax_rate || 0.1))))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* カレンダーグリッド */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
          {['日', '月', '火', '水', '木', '金', '土'].map((d, i) => (
            <div key={d} style={{ textAlign: 'center', padding: 6, fontWeight: 'bold', fontSize: 12, color: i === 0 ? '#e74c3c' : i === 6 ? '#3a7bd5' : '#666' }}>{d}</div>
          ))}
          {days.map((day, i) => {
            if (day === null) return <div key={`e${i}`} />;
            const dateStr = `${currentMonth}-${String(day).padStart(2, '0')}`;
            const dayEvents = events[dateStr] || [];
            const isToday = dateStr === today;
            const dow = (firstDay + day - 1) % 7;

            return (
              <div key={day} style={{
                minHeight: 70, padding: 4, border: '1px solid #f0f0f0', borderRadius: 4,
                background: isToday ? '#e8f4f8' : '#fff',
              }}>
                <div style={{
                  fontSize: 13, fontWeight: isToday ? 'bold' : 'normal',
                  color: dow === 0 ? '#e74c3c' : dow === 6 ? '#3a7bd5' : '#333',
                }}>
                  {day}
                </div>
                {dayEvents.slice(0, 3).map((ev, j) => (
                  <div key={j} style={{
                    fontSize: 9, padding: '1px 3px', marginTop: 1, borderRadius: 3,
                    background: ev.color + '20', color: ev.color,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {ev.label}
                  </div>
                ))}
                {dayEvents.length > 3 && <div style={{ fontSize: 9, color: '#888' }}>+{dayEvents.length - 3}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
