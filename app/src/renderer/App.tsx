import React, { useState, useEffect } from 'react';
import PropertiesPage from './pages/PropertiesPage';
import MaterialsPage from './pages/MaterialsPage';
import ConstructionsPage from './pages/ConstructionsPage';
import InvoicesPage from './pages/InvoicesPage';
import DashboardPage from './pages/DashboardPage';
import AIEstimatePage from './pages/AIEstimatePage';
import SettingsPage from './pages/SettingsPage';
import ImageSearchPage from './pages/ImageSearchPage';
import OcrPage from './pages/OcrPage';
import CalendarPage from './pages/CalendarPage';
import ReportsPage from './pages/ReportsPage';
import CustomersPage from './pages/CustomersPage';
import AttendancePage from './pages/AttendancePage';
import PurchaseOrdersPage from './pages/PurchaseOrdersPage';
import BudgetPage from './pages/BudgetPage';

type Page = 'dashboard' | 'properties' | 'materials' | 'constructions' | 'invoices' | 'ai-estimate' | 'ocr' | 'image-search' | 'customers' | 'calendar' | 'reports' | 'attendance' | 'purchase-orders' | 'budget' | 'settings';

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [highlightConstructionId, setHighlightConstructionId] = useState<number | null>(null);
  const [tenants, setTenants] = useState<any[]>([]);
  const [currentTenant, setCurrentTenant] = useState<number>(1);
  const [tenantKey, setTenantKey] = useState(0);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('darkMode') === 'true');
  const [showNewTenant, setShowNewTenant] = useState(false);
  const [newTenantName, setNewTenantName] = useState('');

  useEffect(() => { loadTenants(); }, []);
  useEffect(() => {
    document.body.classList.toggle('dark-mode', darkMode);
    localStorage.setItem('darkMode', String(darkMode));
  }, [darkMode]);

  const loadTenants = async () => {
    try {
      const t = await (window as any).api.listTenants();
      setTenants(t);
      const cur = await (window as any).api.currentTenant();
      setCurrentTenant(cur);
    } catch (_) {}
  };

  const switchTenant = async (id: number) => {
    await (window as any).api.switchTenant(id);
    setCurrentTenant(id);
    setTenantKey(k => k + 1); // 全ページを再描画
  };

  const createTenant = async () => {
    if (!newTenantName.trim()) return;
    const id = await (window as any).api.createTenant(newTenantName.trim());
    setNewTenantName('');
    setShowNewTenant(false);
    await loadTenants();
    switchTenant(id);
  };

  const deleteTenant = async (id: number) => {
    const name = tenants.find(t => t.id === id)?.name || '';
    if (!confirm(`「${name}」を削除しますか？\n\nこの企業の物件・施工・請求書など全データが削除されます。この操作は元に戻せません。`)) return;
    await (window as any).api.deleteTenant(id);
    await loadTenants();
    const remaining = tenants.filter(t => t.id !== id);
    if (remaining.length > 0) switchTenant(remaining[0].id);
  };

  const currentTenantName = tenants.find(t => t.id === currentTenant)?.name || '';

  const isTrial = tenants.filter(t => t.id > 1).length <= 1;
  const pages: { key: Page; label: string; icon: string }[] = [
    { key: 'dashboard', label: 'ダッシュボード', icon: '📊' },
    { key: 'ai-estimate', label: 'AI 見積もり', icon: '🤖' },
    { key: 'ocr', label: '紙を電子化', icon: '📸' },
    { key: 'image-search', label: '画像検索', icon: '🔍' },
    { key: 'properties', label: '物件管理', icon: '🏠' },
    ...(!isTrial ? [{ key: 'materials' as Page, label: '材料マスタ', icon: '🧱' }] : []),
    { key: 'constructions', label: '施工・見積', icon: '🔨' },
    { key: 'invoices', label: '請求書', icon: '📄' },
    { key: 'purchase-orders', label: '発注書', icon: '📝' },
    { key: 'attendance', label: '出面管理', icon: '📋' },
    { key: 'customers', label: '顧客管理', icon: '👥' },
    { key: 'calendar', label: 'カレンダー', icon: '📅' },
    { key: 'reports', label: '利益レポート', icon: '📈' },
    { key: 'budget', label: '予実管理', icon: '💰' },
    { key: 'settings', label: '設定', icon: '⚙️' },
  ];

  const navigateToConstruction = (constructionId: number) => {
    setHighlightConstructionId(constructionId);
    setCurrentPage('invoices');
  };

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard': return <DashboardPage key={tenantKey} onNavigate={(page: string) => setCurrentPage(page as Page)} onNavigateToInvoice={navigateToConstruction} />;
      case 'ai-estimate': return <AIEstimatePage key={tenantKey} onNavigateToConstruction={navigateToConstruction} />;
      case 'ocr': return <OcrPage key={tenantKey} />;
      case 'image-search': return <ImageSearchPage />;
      case 'properties': return <PropertiesPage key={tenantKey} />;
      case 'materials': return <MaterialsPage key={tenantKey} />;
      case 'constructions': return <ConstructionsPage key={tenantKey} highlightId={highlightConstructionId} onHighlightClear={() => setHighlightConstructionId(null)} />;
      case 'invoices': return <InvoicesPage key={tenantKey} highlightConstructionId={highlightConstructionId} onHighlightClear={() => setHighlightConstructionId(null)} />;
      case 'customers': return <CustomersPage key={tenantKey} />;
      case 'calendar': return <CalendarPage key={tenantKey} />;
      case 'reports': return <ReportsPage key={tenantKey} />;
      case 'attendance': return <AttendancePage key={tenantKey} />;
      case 'purchase-orders': return <PurchaseOrdersPage key={tenantKey} />;
      case 'budget': return <BudgetPage key={tenantKey} />;
      case 'settings': return <SettingsPage />;
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">建築ブースト</div>

        {/* テナント切替（複数企業がある場合のみ表示） */}
        {tenants.filter(t => t.id > 1).length > 1 && (
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #2a3a4a' }}>
            <select
              value={currentTenant}
              onChange={e => switchTenant(Number(e.target.value))}
              style={{
                width: '100%', padding: '6px 8px', borderRadius: 6, border: 'none',
                background: '#2a3a4a', color: '#fff', fontSize: 12, cursor: 'pointer',
              }}
            >
              {tenants.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {!showNewTenant ? (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 4 }}>
                <span onClick={() => setShowNewTenant(true)} style={{ color: '#5cacee', fontSize: 11, cursor: 'pointer' }}>+ 追加</span>
                {tenants.length > 1 && <span onClick={() => deleteTenant(currentTenant)} style={{ color: '#e74c3c', fontSize: 11, cursor: 'pointer' }}>× 削除</span>}
              </div>
            ) : (
              <div style={{ marginTop: 6 }}>
                <input
                  value={newTenantName}
                  onChange={e => setNewTenantName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createTenant()}
                  placeholder="企業名を入力"
                  style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '2px solid #5cacee', fontSize: 12, marginBottom: 4, background: '#fff', color: '#333' }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={createTenant} style={{ flex: 1, padding: '6px', borderRadius: 4, border: 'none', background: '#5cacee', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 'bold' }}>追加</button>
                  <button onClick={() => { setShowNewTenant(false); setNewTenantName(''); }} style={{ padding: '6px 10px', borderRadius: 4, border: 'none', background: '#555', color: '#fff', fontSize: 12, cursor: 'pointer' }}>×</button>
                </div>
              </div>
            )}
          </div>
        )}

        <ul className="sidebar-nav">
          <li onClick={() => setDarkMode(!darkMode)} style={{ borderBottom: '1px solid #2a3a4a', fontSize: 12 }}>
            <span>{darkMode ? '☀️' : '🌙'}</span><span>{darkMode ? 'ライトモード' : 'ダークモード'}</span>
          </li>
          {pages.map(p => (
            <li
              key={p.key}
              className={currentPage === p.key ? 'active' : ''}
              onClick={() => setCurrentPage(p.key)}
            >
              <span>{p.icon}</span>
              <span>{p.label}</span>
            </li>
          ))}
        </ul>
      </aside>
      <main className="main-content">
        {renderPage()}
      </main>
    </div>
  );
}
