import React, { useEffect, useState } from 'react';
import { PageGuide } from '../components/PageGuide';

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string; border: string }> = {
  draft:   { label: '未受注', bg: '#f8f9fa', color: '#636e72', border: '#dfe6e9' },
  sent:    { label: '請求中', bg: '#fff8e1', color: '#e67e22', border: '#f0d060' },
  overdue: { label: '未入金', bg: '#fdecea', color: '#c0392b', border: '#f5b7b1' },
  paid:    { label: '入金済', bg: '#e8f8f0', color: '#1e8449', border: '#a3e4d7' },
};

export default function DashboardPage({ onNavigate, onNavigateToInvoice }: { onNavigate?: (page: string) => void; onNavigateToInvoice?: (constructionId: number) => void }) {
  const [stats, setStats] = useState({ properties: 0, materials: 0, constructions: 0, invoices: 0 });
  const [summary, setSummary] = useState({ totalMaterialCost: 0, totalLaborCost: 0, totalSelling: 0, totalGrossProfit: 0, profitRate: 0 });
  const [invoices, setInvoices] = useState<any[]>([]);
  const [recentConstructions, setRecentConstructions] = useState<any[]>([]);
  const [allConstructions, setAllConstructions] = useState<any[]>([]);
  const [usage, setUsage] = useState<{ used: number; limit: number; remaining: number; plan: string; expiresAt?: string | null; daysLeft?: number | null } | null>(null);
  const [showDetail, setShowDetail] = useState<'material' | 'labor' | 'sales' | 'profit' | null>(null);
  const [outcomeStats, setOutcomeStats] = useState<{total: number; won: number; lost: number; pending: number; winRate: number} | null>(null);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    const [properties, materials, constructions, inv, sum, usageData, tenant] = await Promise.all([
      window.api.listProperties(),
      window.api.listMaterials(),
      window.api.listConstructions(),
      window.api.listInvoices(),
      (window as any).api.getDashboardSummary(),
      (window as any).api.getMonthlyUsage?.().catch(() => null),
      (window as any).api.currentTenant?.() ?? 1,
    ]);
    setUsage(tenant === 1 ? null : usageData);
    setStats({
      properties: properties.length,
      materials: materials.length,
      constructions: constructions.length,
      invoices: inv.length,
    });
    setSummary(sum);
    setInvoices(inv);
    setAllConstructions(constructions);
    setRecentConstructions(constructions.slice(0, 5));
    try {
      const os = await (window as any).api.getOutcomeStats?.();
      if (os) setOutcomeStats(os);
    } catch (_) {}
  };

  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

  // ステータス別に集計
  const statusGroups: Record<string, any[]> = { draft: [], sent: [], overdue: [], paid: [] };
  invoices.forEach(inv => {
    const key = inv.status || 'draft';
    if (statusGroups[key]) statusGroups[key].push(inv);
    else statusGroups.draft.push(inv);
  });
  const statusTotals: Record<string, number> = {};
  Object.keys(statusGroups).forEach(k => {
    statusTotals[k] = statusGroups[k].reduce((s: number, inv: any) => s + (inv.amount || 0), 0);
  });

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>ダッシュボード</h1>
        <PageGuide pageKey="dashboard" steps={[
          { icon: '📊', title: 'STEP 1：経営数字を一目で把握', desc: '売上・粗利・施工件数など、経営の重要指標をリアルタイムで確認できます。', sub: 'カードをクリックすると詳細が表示されます' },
          { icon: '💰', title: 'STEP 2：請求状況を確認', desc: '未入金・請求中・入金済みの請求書をステータス別に管理します。', sub: '期限超過の請求書は赤く表示されます' },
          { icon: '📈', title: 'STEP 3：受注率をチェック', desc: '見積もりの受注率を確認し、営業戦略の改善に活かせます。' },
        ]} />
        {usage ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: usage.remaining <= 5 ? 'linear-gradient(135deg, #e74c3c, #c0392b)' : usage.remaining <= Math.round(usage.limit * 0.2) ? 'linear-gradient(135deg, #f39c12, #e67e22)' : 'linear-gradient(135deg, #27ae60, #2ecc71)',
            borderRadius: 10, padding: '8px 18px', color: '#fff',
            boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
          }}>
            <span style={{ fontSize: 13, opacity: 0.9 }}>AIストック</span>
            <span style={{ fontSize: 22, fontWeight: 'bold' }}>{usage.used}</span>
            <span style={{ fontSize: 12, opacity: 0.8 }}>/ {usage.limit}</span>
            <span style={{ fontSize: 11, opacity: 0.7, marginLeft: 4 }}>（残{usage.remaining}）</span>
            {/* デモは残ストックだけでなく期限でも止まる。予告なく切れると商談中に事故る */}
            {typeof usage.daysLeft === 'number' && (
              <span style={{ fontSize: 11, marginLeft: 6, paddingLeft: 10, borderLeft: '1px solid rgba(255,255,255,.4)' }}>
                {usage.daysLeft > 0 ? `期限 ${usage.expiresAt}（あと${usage.daysLeft}日）` : '期限切れ'}
              </span>
            )}
          </div>
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'linear-gradient(135deg, #2c3e50, #3498db)',
            borderRadius: 10, padding: '8px 18px', color: '#fff',
            boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
          }}>
            <span style={{ fontSize: 13, opacity: 0.9 }}>AIストック</span>
            <span style={{ fontSize: 24, fontWeight: 'bold', marginLeft: 4 }}>∞</span>
            <span style={{ fontSize: 11, opacity: 0.8 }}>無制限</span>
          </div>
        )}
      </div>

      {/* メイン集計 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 12, marginBottom: 24 }}>
        <div style={{
          background: 'linear-gradient(135deg, #2c3e50, #3498db)',
          borderRadius: 12, padding: 20, color: '#fff', textAlign: 'center',
          boxShadow: '0 4px 15px rgba(52,152,219,0.3)',
          cursor: 'pointer', transition: 'transform 0.15s',
        }} onClick={() => setShowDetail(showDetail === 'sales' ? null : 'sales')}
           onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.03)')}
           onMouseLeave={e => (e.currentTarget.style.transform = '')}>
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>売上 ▼</div>
          <div style={{ fontSize: 26, fontWeight: 'bold', letterSpacing: 1 }}>{fmt(summary.totalSelling)}</div>
        </div>
        <div style={{
          background: 'linear-gradient(135deg, #8e44ad, #c0392b)',
          borderRadius: 12, padding: 20, color: '#fff', textAlign: 'center',
          boxShadow: '0 4px 15px rgba(192,57,43,0.3)',
          cursor: 'pointer', transition: 'transform 0.15s',
        }} onClick={() => setShowDetail(showDetail === 'material' ? null : 'material')}
           onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.03)')}
           onMouseLeave={e => (e.currentTarget.style.transform = '')}>
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>材料費 ▼</div>
          <div style={{ fontSize: 26, fontWeight: 'bold', letterSpacing: 1 }}>{fmt(summary.totalMaterialCost)}</div>
        </div>
        <div style={{
          background: 'linear-gradient(135deg, #d35400, #e67e22)',
          borderRadius: 12, padding: 20, color: '#fff', textAlign: 'center',
          boxShadow: '0 4px 15px rgba(230,126,34,0.3)',
          cursor: 'pointer', transition: 'transform 0.15s',
        }} onClick={() => setShowDetail(showDetail === 'labor' ? null : 'labor')}
           onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.03)')}
           onMouseLeave={e => (e.currentTarget.style.transform = '')}>
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>人件費 ▼</div>
          <div style={{ fontSize: 26, fontWeight: 'bold', letterSpacing: 1 }}>{fmt(summary.totalLaborCost)}</div>
        </div>
        <div style={{
          background: 'linear-gradient(135deg, #7f8c8d, #95a5a6)',
          borderRadius: 12, padding: 20, color: '#fff', textAlign: 'center',
          boxShadow: '0 4px 15px rgba(127,140,141,0.3)',
        }}>
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>経費合計</div>
          <div style={{ fontSize: 26, fontWeight: 'bold', letterSpacing: 1 }}>{fmt(summary.totalMaterialCost + summary.totalLaborCost)}</div>
        </div>
        <div style={{
          background: 'linear-gradient(135deg, #1e8449, #27ae60)',
          borderRadius: 12, padding: 20, color: '#fff', textAlign: 'center',
          boxShadow: '0 4px 15px rgba(39,174,96,0.3)',
          cursor: 'pointer', transition: 'transform 0.15s',
        }} onClick={() => setShowDetail(showDetail === 'profit' ? null : 'profit')}
           onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.03)')}
           onMouseLeave={e => (e.currentTarget.style.transform = '')}>
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>粗利 ▼</div>
          <div style={{ fontSize: 26, fontWeight: 'bold', letterSpacing: 1 }}>{fmt(summary.totalGrossProfit)}</div>
          <div style={{ fontSize: 12, marginTop: 4, opacity: 0.9 }}>粗利率 {summary.profitRate}%</div>
        </div>
      </div>

      {/* 詳細一覧 */}
      {showDetail && (() => {
        const config: Record<string, { label: string; color: string; getValue: (c: any) => number; total: number }> = {
          sales:    { label: '売上',   color: '#3498db', getValue: c => c.selling_price || 0, total: summary.totalSelling },
          material: { label: '材料費', color: '#c0392b', getValue: c => c.material_cost || 0, total: summary.totalMaterialCost },
          labor:    { label: '人件費', color: '#e67e22', getValue: c => c.labor_cost || 0,    total: summary.totalLaborCost },
          profit:   { label: '粗利',   color: '#27ae60', getValue: c => c.gross_profit || 0,  total: summary.totalGrossProfit },
        };
        const cfg = config[showDetail];
        return (
          <div className="card" style={{ marginBottom: 16, borderLeft: `4px solid ${cfg.color}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3>{cfg.label} 内訳（施工別）</h3>
              <button className="btn btn-sm btn-secondary" onClick={() => setShowDetail(null)}>閉じる</button>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>施工名</th>
                  <th>物件</th>
                  <th>日付</th>
                  {showDetail === 'profit' && <th style={{ textAlign: 'right' }}>売価</th>}
                  {showDetail === 'profit' && <th style={{ textAlign: 'right' }}>原価</th>}
                  <th style={{ textAlign: 'right' }}>{cfg.label}</th>
                  {showDetail === 'profit' && <th style={{ textAlign: 'right' }}>粗利率</th>}
                </tr>
              </thead>
              <tbody>
                {allConstructions
                  .filter((c: any) => cfg.getValue(c) > 0)
                  .map((c: any) => {
                    const profitRate = (c.selling_price || 0) > 0 ? Math.round(((c.gross_profit || 0) / (c.selling_price || 1)) * 100) : 0;
                    return (
                      <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => onNavigateToInvoice?.(c.id)}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f0f7ff')}
                          onMouseLeave={e => (e.currentTarget.style.background = '')}>
                        <td><strong style={{ color: '#3a7bd5' }}>{c.title}</strong></td>
                        <td style={{ fontSize: 12, color: '#888' }}>{c.property_name || '-'}</td>
                        <td style={{ fontSize: 12 }}>{c.construction_date || '-'}</td>
                        {showDetail === 'profit' && <td style={{ textAlign: 'right' }}>{fmt(c.selling_price || 0)}</td>}
                        {showDetail === 'profit' && <td style={{ textAlign: 'right' }}>{fmt(c.total_cost || 0)}</td>}
                        <td style={{ textAlign: 'right', fontWeight: 'bold', color: cfg.color }}>
                          {fmt(cfg.getValue(c))}
                        </td>
                        {showDetail === 'profit' && <td style={{ textAlign: 'right', color: profitRate >= 30 ? '#27ae60' : profitRate >= 15 ? '#f39c12' : '#e74c3c' }}>{profitRate}%</td>}
                      </tr>
                    );
                  })}
                <tr style={{ fontWeight: 'bold', borderTop: '2px solid #333' }}>
                  <td colSpan={3}>合計</td>
                  {showDetail === 'profit' && <td style={{ textAlign: 'right' }}>{fmt(summary.totalSelling)}</td>}
                  {showDetail === 'profit' && <td style={{ textAlign: 'right' }}>{fmt(summary.totalMaterialCost + summary.totalLaborCost)}</td>}
                  <td style={{ textAlign: 'right', color: cfg.color }}>{fmt(cfg.total)}</td>
                  {showDetail === 'profit' && <td style={{ textAlign: 'right' }}>{summary.profitRate}%</td>}
                </tr>
              </tbody>
            </table>
          </div>
        );
      })()}

      {/* 期限3日以内アラート */}
      {(() => {
        const today = new Date();
        const threeDays = new Date(today.getTime() + 3 * 86400000).toISOString().split('T')[0];
        const todayStr = today.toISOString().split('T')[0];
        const upcoming = invoices.filter((inv: any) => inv.due_date && inv.due_date > todayStr && inv.due_date <= threeDays && inv.status !== 'paid');
        if (upcoming.length === 0) return null;
        return (
          <div style={{ background: '#fff8e1', border: '2px solid #f0d060', borderRadius: 10, padding: '14px 20px', marginBottom: 16 }}>
            <div style={{ fontWeight: 'bold', color: '#e67e22', fontSize: 15, marginBottom: 8 }}>⏰ 支払期限が近い: {upcoming.length}件（3日以内）</div>
            {upcoming.map((inv: any) => (
              <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span><strong>{inv.client_name}</strong> - {inv.construction_title || ''}</span>
                <span style={{ color: '#e67e22' }}>期限: {inv.due_date} / {fmt(inv.amount)}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* 支払期限超過アラート */}
      {(() => {
        const today = new Date().toISOString().split('T')[0];
        const overdue = invoices.filter((inv: any) => inv.due_date && inv.due_date < today && inv.status !== 'paid');
        if (overdue.length === 0) return null;
        return (
          <div style={{ background: '#fdecea', border: '2px solid #e74c3c', borderRadius: 10, padding: '14px 20px', marginBottom: 16 }}>
            <div style={{ fontWeight: 'bold', color: '#c0392b', fontSize: 15, marginBottom: 8 }}>⚠ 支払期限超過: {overdue.length}件</div>
            {overdue.map((inv: any) => (
              <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span><strong>{inv.client_name}</strong> - {inv.construction_title || '(施工名なし)'}</span>
                <span style={{ color: '#c0392b' }}>期限: {inv.due_date} / {fmt(inv.amount)}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* 受注率ダッシュボード */}
      {outcomeStats && outcomeStats.total > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 12 }}>受注実績</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <div style={{ textAlign: 'center', padding: 16, background: '#f0f7ff', borderRadius: 10 }}>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: '#3a7bd5' }}>{outcomeStats.total}</div>
              <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>見積総数</div>
            </div>
            <div style={{ textAlign: 'center', padding: 16, background: '#e8f8f0', borderRadius: 10 }}>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: '#27ae60' }}>{outcomeStats.won}</div>
              <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>受注</div>
            </div>
            <div style={{ textAlign: 'center', padding: 16, background: '#fef0f0', borderRadius: 10 }}>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: '#e74c3c' }}>{outcomeStats.lost}</div>
              <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>失注</div>
            </div>
            <div style={{ textAlign: 'center', padding: 16, background: outcomeStats.winRate >= 50 ? '#e8f8f0' : '#fff8e1', borderRadius: 10, border: '2px solid', borderColor: outcomeStats.winRate >= 50 ? '#27ae60' : '#f39c12' }}>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: outcomeStats.winRate >= 50 ? '#27ae60' : '#f39c12' }}>{outcomeStats.winRate}%</div>
              <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>受注率</div>
            </div>
          </div>
        </div>
      )}

      {/* 月別売上グラフ */}
      {(() => {
        const months: Record<string, { revenue: number; cost: number }> = {};
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          months[key] = { revenue: 0, cost: 0 };
        }
        allConstructions.forEach((c: any) => {
          const m = c.construction_date?.substring(0, 7);
          if (m && months[m]) {
            months[m].revenue += c.selling_price || 0;
            months[m].cost += c.total_cost || 0;
          }
        });
        const entries = Object.entries(months);
        const maxVal = Math.max(...entries.map(([, v]) => Math.max(v.revenue, 1)));
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginBottom: 12 }}>月別売上推移（直近12ヶ月）</h3>
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 140 }}>
              {entries.map(([m, v]) => (
                <div key={m} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
                  <div style={{ width: '80%', display: 'flex', gap: 1, alignItems: 'flex-end', height: '100%', justifyContent: 'center' }}>
                    <div style={{ width: '45%', background: '#3498db', borderRadius: '3px 3px 0 0', height: `${(v.revenue / maxVal) * 100}%`, minHeight: v.revenue > 0 ? 3 : 0 }} title={`売上: ¥${Math.round(v.revenue).toLocaleString()}`} />
                    <div style={{ width: '45%', background: '#e74c3c', borderRadius: '3px 3px 0 0', height: `${(v.cost / maxVal) * 100}%`, minHeight: v.cost > 0 ? 3 : 0, opacity: 0.6 }} title={`原価: ¥${Math.round(v.cost).toLocaleString()}`} />
                  </div>
                  <div style={{ fontSize: 9, color: '#888', marginTop: 4 }}>{m.slice(5)}月</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 8, fontSize: 11 }}>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#3498db', borderRadius: 2, marginRight: 4 }} />売上</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#e74c3c', borderRadius: 2, opacity: 0.6, marginRight: 4 }} />原価</span>
            </div>
          </div>
        );
      })()}

      {/* ステータス別カード */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16, marginBottom: 24 }}>
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <div key={key} style={{
            background: cfg.bg, border: `2px solid ${cfg.border}`,
            borderRadius: 12, padding: 20, textAlign: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
          }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{cfg.label}</div>
            <div style={{ fontSize: 32, fontWeight: 'bold', color: cfg.color }}>
              {statusGroups[key]?.length || 0}<span style={{ fontSize: 14, fontWeight: 'normal' }}> 件</span>
            </div>
            <div style={{ fontSize: 14, color: cfg.color, marginTop: 4, fontWeight: 600 }}>
              {fmt(statusTotals[key] || 0)}
            </div>
          </div>
        ))}
      </div>

      {/* ステータス別 請求書一覧 */}
      {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
        const items = statusGroups[key];
        if (!items || items.length === 0) return null;
        return (
          <div key={key} className="card" style={{ marginBottom: 16, borderLeft: `4px solid ${cfg.border}`, cursor: 'pointer' }} onClick={() => onNavigate?.('invoices')}>
            <h3 style={{ color: cfg.color, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                background: cfg.color,
              }} />
              {cfg.label}
              <span style={{ fontSize: 13, fontWeight: 'normal', color: '#888' }}>({items.length}件) → 詳細を見る</span>
            </h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>請求先</th>
                  <th>施工名</th>
                  <th style={{ textAlign: 'right' }}>金額</th>
                  <th>発行日</th>
                  <th>期限</th>
                </tr>
              </thead>
              <tbody>
                {items.map((inv: any) => (
                  <tr key={inv.id}>
                    <td><strong>{inv.client_name}</strong></td>
                    <td>
                      <span
                        style={{ cursor: 'pointer', color: '#2980b9', textDecoration: 'underline', fontWeight: 'bold' }}
                        onClick={e => { e.stopPropagation(); onNavigateToInvoice && inv.construction_id && onNavigateToInvoice(inv.construction_id); }}
                      >{inv.construction_title || '-'}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold', color: cfg.color }}>{fmt(inv.amount)}</td>
                    <td>{inv.issue_date}</td>
                    <td>{inv.due_date || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {/* 件数カード（クリックで遷移） */}
      <div className="dashboard-grid">
        {[
          { page: 'properties', value: stats.properties, label: '登録物件数' },
          { page: 'materials', value: stats.materials, label: '材料マスタ' },
          { page: 'constructions', value: stats.constructions, label: '施工履歴' },
          { page: 'invoices', value: stats.invoices, label: '請求書' },
        ].map(c => (
          <div key={c.page} className="stat-card" onClick={() => onNavigate?.(c.page)} style={{ cursor: 'pointer', transition: 'transform 0.15s' }} onMouseOver={e => (e.currentTarget.style.transform = 'scale(1.03)')} onMouseOut={e => (e.currentTarget.style.transform = 'scale(1)')}>
            <div className="stat-value">{c.value}</div>
            <div className="stat-label">{c.label} →</div>
          </div>
        ))}
      </div>

      {/* 最近の施工 */}
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>最近の施工履歴</h2>
        {recentConstructions.length === 0 ? (
          <p style={{ color: '#aaa' }}>まだ施工履歴がありません。「施工・見積」から登録してください。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>施工名</th>
                <th>物件</th>
                <th>施工日</th>
                <th style={{ textAlign: 'right' }}>経費</th>
                <th style={{ textAlign: 'right' }}>売上</th>
                <th style={{ textAlign: 'right' }}>粗利</th>
              </tr>
            </thead>
            <tbody>
              {recentConstructions.map((c: any) => (
                <tr key={c.id}>
                  <td>
                    <span
                      style={{ cursor: 'pointer', color: '#2980b9', textDecoration: 'underline' }}
                      onClick={() => onNavigateToInvoice && onNavigateToInvoice(c.id)}
                    >{c.title}</span>
                  </td>
                  <td>{c.property_name || '-'}</td>
                  <td>{c.construction_date || '-'}</td>
                  <td style={{ textAlign: 'right', color: '#c0392b', fontSize: 12 }}>{fmt(c.total_cost || 0)}</td>
                  <td style={{ textAlign: 'right', color: '#2980b9', fontWeight: 'bold' }}>{fmt(c.selling_price || 0)}</td>
                  <td style={{ textAlign: 'right', color: '#27ae60', fontWeight: 'bold' }}>{fmt(c.gross_profit || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
