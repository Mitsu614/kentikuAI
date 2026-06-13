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
import DailyReportPage from './pages/DailyReportPage';
import GanttPage from './pages/GanttPage';
import SafetyDocsPage from './pages/SafetyDocsPage';
import QuoteComparisonPage from './pages/QuoteComparisonPage';
import PhotoLedgerPage from './pages/PhotoLedgerPage';
import FeedbackPage from './pages/FeedbackPage';

type Page = 'dashboard' | 'properties' | 'materials' | 'constructions' | 'invoices' | 'ai-estimate' | 'ocr' | 'image-search' | 'customers' | 'calendar' | 'reports' | 'attendance' | 'purchase-orders' | 'budget' | 'daily-report' | 'gantt' | 'safety-docs' | 'quote-comparison' | 'photo-ledger' | 'feedback' | 'settings';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(true);
  const [sessionInfo, setSessionInfo] = useState<any>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [regUser, setRegUser] = useState('');
  const [regPass, setRegPass] = useState('');
  const [regCompany, setRegCompany] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regTel, setRegTel] = useState('');
  const [regMessage, setRegMessage] = useState('');
  const [regError, setRegError] = useState('');
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [highlightConstructionId, setHighlightConstructionId] = useState<number | null>(null);
  const [tenants, setTenants] = useState<any[]>([]);
  const [currentTenant, setCurrentTenant] = useState<number>(1);
  const [tenantKey, setTenantKey] = useState(0);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('darkMode') === 'true');
  const [showNewTenant, setShowNewTenant] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showOnlineToast, setShowOnlineToast] = useState(false);
  const [newTenantName, setNewTenantName] = useState('');
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('onboarding_done'));
  const [onboardingStep, setOnboardingStep] = useState(0);

  const onboardingSteps = [
    { icon: '👋', title: 'ようこそ！建築ブーストへ', description: '建築見積をAIが自動作成する、建設業専用の管理システムです。\n初めてでも3ステップで見積が作れます。' },
    { icon: '📷', title: 'ステップ1: 写真を撮る', description: '現場の写真を1枚撮るだけ。\nAIが工事の内容を自動判定し、材料費・人件費を計算します。' },
    { icon: '🤖', title: 'ステップ2: AIが見積作成', description: '写真+コメントで見積を自動生成。\nチャットで「外壁塗装」と話しかけるだけでもOK。' },
    { icon: '📄', title: 'ステップ3: 書類を自動出力', description: '見積書・請求書・発注書をワンクリックでPDF出力。\n物件・施工・請求書が自動で紐づきます。' },
    { icon: '💡', title: '困ったら「改善要望」へ', description: 'サイドバーの「改善要望」からいつでもご意見をお寄せください。\nお客様の声がサービス改善に直結します。' },
  ];

  const closeOnboarding = () => {
    setShowOnboarding(false);
    const key = sessionInfo?.username ? `onboarding_done_${sessionInfo.username}` : 'onboarding_done';
    localStorage.setItem(key, 'true');
  };

  // 起動時: セッション確認（管理者PCのみ自動ログイン）
  useEffect(() => {
    (async () => {
      try {
        const session = await (window as any).api.getSession?.();
        if (session) {
          setSessionInfo(session);
          setLoggedIn(true);
        } else {
          // 管理者PCのみ自動ログイン（ユーザー未作成時）
          const users = await (window as any).api.listUsers?.();
          const isOwnerPC = await (window as any).api.isOwnerPC?.();
          if (isOwnerPC && (!users || users.length === 0)) {
            setLoggedIn(true);
          }
        }
      } catch (_) {}
      setLoginLoading(false);
    })();
  }, []);

  const handleLogin = async () => {
    if (!loginUser.trim() || !loginPass) { setLoginError('ユーザー名とパスワードを入力してください'); return; }
    setLoginError('');
    setLoginLoading(true);
    try {
      const res = await (window as any).api.login(loginUser.trim(), loginPass);
      if (res.ok) {
        setSessionInfo(res);
        setLoggedIn(true);
        setCurrentTenant(res.tenantId);
        setTenantKey(k => k + 1);
        // 初回ログイン時にオンボーディング表示
        const onboardingKey = `onboarding_done_${res.username}`;
        if (!localStorage.getItem(onboardingKey)) {
          setShowOnboarding(true);
          setOnboardingStep(0);
        }
      } else {
        setLoginError(res.error || 'ログインに失敗しました');
      }
    } catch (e: any) {
      setLoginError('エラー: ' + e.message);
    }
    setLoginLoading(false);
  };

  const handleLogout = async () => {
    await (window as any).api.logout?.();
    setLoggedIn(false);
    setSessionInfo(null);
    setLoginUser('');
    setLoginPass('');
    setCurrentPage('dashboard');
  };

  const handleRegister = async () => {
    if (!regUser.trim() || !regPass || !regCompany.trim()) {
      setRegError('ユーザー名・パスワード・会社名は必須です');
      return;
    }
    setRegError('');
    try {
      const res = await (window as any).api.register({
        username: regUser.trim(), password: regPass,
        company: regCompany.trim(), email: regEmail.trim(), tel: regTel.trim(),
      });
      if (res.ok) {
        setRegMessage('登録申請を送信しました。管理者の承認をお待ちください。');
        setRegUser(''); setRegPass(''); setRegCompany(''); setRegEmail(''); setRegTel('');
      } else {
        setRegError(res.error || '登録に失敗しました');
      }
    } catch (e: any) {
      setRegError('エラー: ' + e.message);
    }
  };

  useEffect(() => { if (loggedIn) loadTenants(); }, [loggedIn]);
  useEffect(() => {
    document.body.classList.toggle('dark-mode', darkMode);
    localStorage.setItem('darkMode', String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    const handleOnline = () => { setIsOnline(true); setShowOnlineToast(true); setTimeout(() => setShowOnlineToast(false), 3000); };
    const handleOffline = () => { setIsOnline(false); setShowOnlineToast(false); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
  }, []);

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
    { key: 'daily-report', label: '作業日報', icon: '📓' },
    { key: 'gantt', label: '工程表', icon: '📊' },
    { key: 'photo-ledger', label: '写真台帳', icon: '📷' },
    { key: 'safety-docs', label: '安全書類', icon: '🦺' },
    { key: 'quote-comparison', label: '見積比較', icon: '⚖️' },
    { key: 'customers', label: '顧客管理', icon: '👥' },
    { key: 'calendar', label: 'カレンダー', icon: '📅' },
    { key: 'reports', label: '利益レポート', icon: '📈' },
    { key: 'budget', label: '予実管理', icon: '💰' },
    { key: 'feedback', label: '改善要望', icon: '💡' },
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
      case 'daily-report': return <DailyReportPage key={tenantKey} />;
      case 'gantt': return <GanttPage key={tenantKey} />;
      case 'safety-docs': return <SafetyDocsPage key={tenantKey} />;
      case 'quote-comparison': return <QuoteComparisonPage key={tenantKey} />;
      case 'photo-ledger': return <PhotoLedgerPage key={tenantKey} />;
      case 'feedback': return <FeedbackPage key={tenantKey} />;
      case 'settings': return <SettingsPage />;
    }
  };

  // ログイン画面
  if (loginLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f5f5f5' }}>
        <div style={{ textAlign: 'center', color: '#888' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>建築ブースト</div>
          <div>読み込み中...</div>
        </div>
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'linear-gradient(135deg, #1a2332, #2c3e50)',
      }}>
        <div style={{
          background: '#fff', padding: '40px 36px', borderRadius: 20,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)', width: 380, textAlign: 'center',
        }}>
          <div style={{ fontSize: 28, fontWeight: 'bold', color: '#1a2332', marginBottom: 8 }}>建築ブースト</div>
          <div style={{ color: '#888', fontSize: 14, marginBottom: 24 }}>AI建築見積管理システム</div>
          {loginError && <div style={{ color: '#e74c3c', fontSize: 14, marginBottom: 12 }}>{loginError}</div>}
          <input
            value={loginUser}
            onChange={e => setLoginUser(e.target.value)}
            placeholder="ユーザー名"
            autoFocus
            style={{
              width: '100%', padding: '14px 16px', border: '2px solid #e0e0e0', borderRadius: 10,
              fontSize: 16, marginBottom: 10, boxSizing: 'border-box', outline: 'none', minHeight: 48,
            }}
            onFocus={e => e.target.style.borderColor = '#3a7bd5'}
            onBlur={e => e.target.style.borderColor = '#e0e0e0'}
          />
          <input
            type="password"
            value={loginPass}
            onChange={e => setLoginPass(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            placeholder="パスワード"
            style={{
              width: '100%', padding: '14px 16px', border: '2px solid #e0e0e0', borderRadius: 10,
              fontSize: 16, marginBottom: 16, boxSizing: 'border-box', outline: 'none', minHeight: 48,
            }}
            onFocus={e => e.target.style.borderColor = '#3a7bd5'}
            onBlur={e => e.target.style.borderColor = '#e0e0e0'}
          />
          <button
            onClick={handleLogin}
            style={{
              width: '100%', padding: '14px', background: '#3a7bd5', color: '#fff',
              border: 'none', borderRadius: 10, fontSize: 16, fontWeight: 'bold',
              cursor: 'pointer', minHeight: 52,
            }}
          >ログイン</button>
          <div style={{ marginTop: 16 }}>
            <span onClick={() => { setShowRegister(!showRegister); setRegMessage(''); setRegError(''); }}
              style={{ fontSize: 14, color: '#3a7bd5', cursor: 'pointer' }}>
              {showRegister ? '← ログインに戻る' : '新規登録はこちら'}
            </span>
          </div>
          {showRegister && (
            <div style={{ marginTop: 16, textAlign: 'left', borderTop: '1px solid #eee', paddingTop: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 12, textAlign: 'center', color: '#1a2332' }}>新規登録（承認制）</div>
              {regMessage && <div style={{ color: '#27ae60', fontSize: 14, marginBottom: 12, textAlign: 'center' }}>{regMessage}</div>}
              {regError && <div style={{ color: '#e74c3c', fontSize: 14, marginBottom: 12, textAlign: 'center' }}>{regError}</div>}
              <input value={regCompany} onChange={e => setRegCompany(e.target.value)} placeholder="会社名（必須）"
                style={{ width: '100%', padding: '12px 14px', border: '2px solid #e0e0e0', borderRadius: 10, fontSize: 16, marginBottom: 8, boxSizing: 'border-box', outline: 'none', minHeight: 48 }}
                onFocus={e => e.target.style.borderColor = '#3a7bd5'} onBlur={e => e.target.style.borderColor = '#e0e0e0'} />
              <input value={regUser} onChange={e => setRegUser(e.target.value)} placeholder="ユーザー名（必須）"
                style={{ width: '100%', padding: '12px 14px', border: '2px solid #e0e0e0', borderRadius: 10, fontSize: 16, marginBottom: 8, boxSizing: 'border-box', outline: 'none', minHeight: 48 }}
                onFocus={e => e.target.style.borderColor = '#3a7bd5'} onBlur={e => e.target.style.borderColor = '#e0e0e0'} />
              <input type="password" value={regPass} onChange={e => setRegPass(e.target.value)} placeholder="パスワード（必須）"
                style={{ width: '100%', padding: '12px 14px', border: '2px solid #e0e0e0', borderRadius: 10, fontSize: 16, marginBottom: 8, boxSizing: 'border-box', outline: 'none', minHeight: 48 }}
                onFocus={e => e.target.style.borderColor = '#3a7bd5'} onBlur={e => e.target.style.borderColor = '#e0e0e0'} />
              <input value={regEmail} onChange={e => setRegEmail(e.target.value)} placeholder="メールアドレス"
                style={{ width: '100%', padding: '12px 14px', border: '2px solid #e0e0e0', borderRadius: 10, fontSize: 16, marginBottom: 8, boxSizing: 'border-box', outline: 'none', minHeight: 48 }}
                onFocus={e => e.target.style.borderColor = '#3a7bd5'} onBlur={e => e.target.style.borderColor = '#e0e0e0'} />
              <input value={regTel} onChange={e => setRegTel(e.target.value)} placeholder="電話番号"
                style={{ width: '100%', padding: '12px 14px', border: '2px solid #e0e0e0', borderRadius: 10, fontSize: 16, marginBottom: 8, boxSizing: 'border-box', outline: 'none', minHeight: 48 }}
                onFocus={e => e.target.style.borderColor = '#3a7bd5'} onBlur={e => e.target.style.borderColor = '#e0e0e0'} />
              <button onClick={handleRegister}
                style={{ width: '100%', padding: '14px', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 10, fontSize: 16, fontWeight: 'bold', cursor: 'pointer', minHeight: 52 }}>
                登録申請する
              </button>
              <div style={{ fontSize: 12, color: '#888', marginTop: 8, textAlign: 'center' }}>
                ※ 管理者の承認後にログインできるようになります
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">建築ブースト</div>

        {/* ログインユーザー表示 */}
        {sessionInfo && (
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #2a3a4a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#aaa' }}>{sessionInfo.username}</span>
            <span onClick={handleLogout} style={{ fontSize: 11, color: '#e74c3c', cursor: 'pointer' }}>ログアウト</span>
          </div>
        )}

        {/* テナント切替（管理者のみ表示） */}
        {!sessionInfo && tenants.filter(t => t.id > 1).length > 1 && (
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
      {/* オンボーディング */}
      {showOnboarding && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 10000,
        }}>
          <div style={{
            background: '#fff', borderRadius: 20, padding: '40px 36px', maxWidth: 480, width: '90%',
            textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>{onboardingSteps[onboardingStep].icon}</div>
            <h2 style={{ fontSize: 22, marginBottom: 12, color: '#1a2332' }}>{onboardingSteps[onboardingStep].title}</h2>
            <p style={{ fontSize: 16, lineHeight: 1.8, color: '#555', whiteSpace: 'pre-wrap', marginBottom: 24 }}>
              {onboardingSteps[onboardingStep].description}
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 20 }}>
              {onboardingSteps.map((_, i) => (
                <div key={i} style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: i === onboardingStep ? '#3a7bd5' : '#ddd',
                  transition: 'background 0.3s',
                }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              {onboardingStep > 0 && (
                <button onClick={() => setOnboardingStep(s => s - 1)}
                  style={{ padding: '12px 24px', fontSize: 16, borderRadius: 10, border: '2px solid #ddd', background: '#fff', cursor: 'pointer', minHeight: 48 }}>
                  戻る
                </button>
              )}
              {onboardingStep < onboardingSteps.length - 1 ? (
                <button onClick={() => setOnboardingStep(s => s + 1)}
                  style={{ padding: '12px 32px', fontSize: 16, borderRadius: 10, border: 'none', background: '#3a7bd5', color: '#fff', cursor: 'pointer', fontWeight: 'bold', minHeight: 48 }}>
                  次へ
                </button>
              ) : (
                <button onClick={closeOnboarding}
                  style={{ padding: '12px 32px', fontSize: 16, borderRadius: 10, border: 'none', background: '#27ae60', color: '#fff', cursor: 'pointer', fontWeight: 'bold', minHeight: 48 }}>
                  始める！
                </button>
              )}
            </div>
            <div style={{ marginTop: 16 }}>
              <span onClick={closeOnboarding} style={{ fontSize: 13, color: '#aaa', cursor: 'pointer' }}>スキップ</span>
            </div>
          </div>
        </div>
      )}
      {/* オフライン/オンライン表示 */}
      {!isOnline && (
        <div className="offline-banner">
          ⚠ オフライン — 入力内容はローカルに自動保存されます
        </div>
      )}
      {showOnlineToast && (
        <div className="online-banner">
          ✓ オンラインに復帰しました — データを同期中...
        </div>
      )}
      <main className="main-content">
        {renderPage()}
      </main>
    </div>
  );
}
