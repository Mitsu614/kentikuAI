import React, { useEffect, useState } from 'react';

/* ────────── 型定義 ────────── */
interface Tenant {
  id: number;
  name: string;
  plan: string;
  plan_limit: number;
  contact_company: string;
  contact_email: string;
  contact_tel: string;
  created_at: string;
}

interface User {
  id: number;
  username: string;
  role: string;
  tenant_id: number;
  created_at: string;
}

interface FeedbackItem {
  id: number;
  tenant_name?: string;
  category: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  created_at: string;
}

interface AuditLogEntry {
  id?: number;
  action: string;
  entity: string;
  detail: string;
  created_at: string;
}

interface PlanRequest {
  id: number;
  tenant_id: number;
  tenant_name?: string;
  requested_plan: string;
  status: string;
  created_at: string;
}

/* ────────── 定数 ────────── */
type TabKey = 'tenants' | 'feedback' | 'audit';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'tenants',  label: 'テナント管理' },
  { key: 'feedback', label: '改善要望' },
  { key: 'audit',    label: '監査ログ' },
];

const PLAN_OPTIONS = [
  { value: 'standard',   label: 'スタンダード' },
  { value: 'pro',        label: 'プロ' },
  { value: 'enterprise', label: 'エンタープライズ' },
];

const PLAN_LABEL: Record<string, string> = {
  standard:   'スタンダード',
  pro:        'プロ',
  enterprise: 'エンタープライズ',
  pending:    '承認待ち',
};

const STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  new:       { label: '新規',     bg: '#e3f2fd', color: '#1565c0' },
  reviewing: { label: '検討中',   bg: '#fff8e1', color: '#e67e22' },
  planned:   { label: '対応予定', bg: '#e8f5e9', color: '#2e7d32' },
  completed: { label: '対応済',   bg: '#e0f2f1', color: '#00796b' },
  rejected:  { label: '見送り',   bg: '#fce4ec', color: '#c62828' },
};

const FEEDBACK_STATUSES = ['all', 'new', 'reviewing', 'planned', 'completed', 'rejected'];
const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  all: 'すべて', new: '新規', reviewing: '検討中', planned: '対応予定', completed: '対応済', rejected: '見送り',
};

/* ────────── スタイル ────────── */
const COLOR = {
  primary: '#3a7bd5',
  danger:  '#e74c3c',
  success: '#27ae60',
  bg:      '#f5f5f5',
  card:    '#fff',
  pending: '#fff9c4',
};

const styles = {
  page: {
    padding: 24,
    background: COLOR.bg,
    minHeight: '100vh',
    fontFamily: '"Segoe UI", "Hiragino Sans", sans-serif',
  } as React.CSSProperties,
  h1: {
    fontSize: 22,
    fontWeight: 700,
    marginBottom: 16,
    color: '#2c3e50',
  } as React.CSSProperties,
  tabBar: {
    display: 'flex',
    gap: 0,
    marginBottom: 20,
    borderBottom: '2px solid #ddd',
  } as React.CSSProperties,
  tabBtn: (active: boolean) => ({
    padding: '10px 24px',
    fontSize: 15,
    fontWeight: active ? 700 : 400,
    color: active ? COLOR.primary : '#666',
    background: 'transparent',
    border: 'none',
    borderBottom: active ? `3px solid ${COLOR.primary}` : '3px solid transparent',
    cursor: 'pointer',
    marginBottom: -2,
  }) as React.CSSProperties,
  card: {
    background: COLOR.card,
    borderRadius: 8,
    padding: 20,
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
    marginBottom: 16,
  } as React.CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 14,
  } as React.CSSProperties,
  th: {
    textAlign: 'left' as const,
    padding: '10px 8px',
    borderBottom: '2px solid #ddd',
    fontWeight: 600,
    color: '#555',
    fontSize: 13,
  } as React.CSSProperties,
  td: {
    padding: '10px 8px',
    borderBottom: '1px solid #eee',
    verticalAlign: 'middle' as const,
  } as React.CSSProperties,
  btn: (bg: string, color = '#fff') => ({
    minHeight: 48,
    padding: '8px 16px',
    fontSize: 16,
    fontWeight: 600,
    background: bg,
    color,
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  }) as React.CSSProperties,
  btnSm: (bg: string, color = '#fff') => ({
    minHeight: 36,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    background: bg,
    color,
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    marginRight: 4,
  }) as React.CSSProperties,
  badge: (bg: string, color: string) => ({
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    background: bg,
    color,
  }) as React.CSSProperties,
  statBox: {
    display: 'inline-block',
    padding: '12px 20px',
    borderRadius: 8,
    background: COLOR.card,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    marginRight: 12,
    marginBottom: 12,
    textAlign: 'center' as const,
  } as React.CSSProperties,
  toast: {
    position: 'fixed' as const,
    top: 20,
    right: 20,
    padding: '12px 24px',
    borderRadius: 8,
    background: COLOR.success,
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    zIndex: 9999,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  } as React.CSSProperties,
  select: {
    minHeight: 36,
    padding: '4px 8px',
    fontSize: 13,
    borderRadius: 4,
    border: '1px solid #ccc',
    marginRight: 4,
  } as React.CSSProperties,
  input: {
    minHeight: 36,
    padding: '4px 8px',
    fontSize: 13,
    borderRadius: 4,
    border: '1px solid #ccc',
    marginRight: 4,
    flex: 1,
  } as React.CSSProperties,
};

const fmtDate = (s: string) => {
  if (!s) return '-';
  try { return new Date(s).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return s; }
};

/* ────────── コンポーネント ────────── */
export default function AdminPage() {
  const isWeb = !!(window as any).__isWeb; // スマホ（外部アクセス）は承認だけ表示
  const [tab, setTab] = useState<TabKey>('tenants');
  const [toast, setToast] = useState('');

  /* --- テナント --- */
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [planChanges, setPlanChanges] = useState<Record<number, string>>({});

  /* --- リモート登録申請（Supabase） --- */
  const [remoteRegs, setRemoteRegs] = useState<any[]>([]);
  const [regPlanChoices, setRegPlanChoices] = useState<Record<string, string>>({});

  /* --- 改善要望 --- */
  const [feedbackList, setFeedbackList] = useState<FeedbackItem[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState('all');
  const [replyTexts, setReplyTexts] = useState<Record<number, string>>({});
  const [statusChanges, setStatusChanges] = useState<Record<number, string>>({});

  /* --- 監査ログ --- */
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);

  /* --- クレジット操作 --- */
  const [creditEdits, setCreditEdits] = useState<Record<number, string>>({});
  const [usageEdits, setUsageEdits] = useState<Record<number, string>>({});
  const [tenantUsages, setTenantUsages] = useState<Record<number, { used: number; limit: number; remaining: number; expiresAt?: string | null; daysLeft?: number | null }>>({});

  /* --- スマホ承認の信頼端末（デスクトップのみ） --- */
  const [trustedDev, setTrustedDev] = useState<{ trusted: boolean; at: string }>({ trusted: false, at: '' });

  /* --- 共通 --- */
  const [loading, setLoading] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  /* ────── データ読み込み ────── */
  const [users, setUsers] = useState<User[]>([]);

  const loadTenants = async () => {
    try {
      const [list, userList, regs] = await Promise.all([
        (window as any).api.listTenants(),
        (window as any).api.listUsers(),
        (window as any).api.listRemoteRegistrations?.() || [],
      ]);
      setTenants(list || []);
      setUsers(userList || []);
      setRemoteRegs(Array.isArray(regs) ? regs : []);
      // 各テナントの使用状況を取得
      const usages: Record<number, any> = {};
      for (const t of (list || [])) {
        try {
          usages[t.id] = await (window as any).api.getTenantUsage(t.id);
        } catch (_) {}
      }
      setTenantUsages(usages);
    } catch (e) { console.error('loadTenants error:', e); }
  };

  const getUserForTenant = (tenantId: number) => users.find(u => u.tenant_id === tenantId);

  const loadFeedback = async () => {
    try {
      const list = await (window as any).api.listAllFeedback();
      setFeedbackList(list || []);
    } catch (e) { console.error('loadFeedback error:', e); }
  };

  const loadAuditLog = async () => {
    try {
      const list = await (window as any).api.listAuditLog();
      setAuditLog(list || []);
    } catch (e) { console.error('loadAuditLog error:', e); }
  };

  const loadTrustedDevice = async () => {
    if (isWeb) return; // スマホからは操作させない（PCのみ）
    try {
      const d = await (window as any).api.getTrustedDevice?.();
      if (d) setTrustedDev({ trusted: !!d.trusted, at: d.at || '' });
    } catch (_) {}
  };

  const handleResetTrustedDevice = async () => {
    if (!confirm('スマホ承認の「信頼端末」をリセットします。\n次にスマホで承認画面を開いた端末が、新しい信頼端末として登録されます。\nよろしいですか？')) return;
    try {
      await (window as any).api.resetTrustedDevice?.();
      await loadTrustedDevice();
      showToast('信頼端末をリセットしました。次に開いたスマホが登録されます。');
    } catch (e) { showToast('リセットに失敗しました'); }
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([loadTenants(), loadFeedback(), loadAuditLog(), loadTrustedDevice()])
      .finally(() => setLoading(false));
  }, []);

  /* ────── テナント操作 ────── */
  const handleApprove = async (tenantId: number) => {
    try {
      await (window as any).api.setPlan('standard', tenantId);
      showToast('テナントを承認しました');
      await loadTenants();
    } catch (e) { console.error(e); showToast('承認に失敗しました'); }
  };

  const handlePlanChange = async (tenantId: number) => {
    const plan = planChanges[tenantId];
    if (!plan) return;
    try {
      await (window as any).api.setPlan(plan, tenantId);
      showToast(`プランを${PLAN_LABEL[plan] || plan}に変更しました`);
      await loadTenants();
    } catch (e) { console.error(e); showToast('プラン変更に失敗しました'); }
  };

  const handleResetUsage = async (tenantId: number) => {
    if (!window.confirm('このテナントのクレジット使用履歴をリセットしますか？')) return;
    try {
      await (window as any).api.resetCreditLog(tenantId);
      showToast('使用履歴をリセットしました');
      await loadTenants();
    } catch (e) { console.error(e); showToast('リセットに失敗しました'); }
  };

  const handleSetUsage = async (tenantId: number) => {
    const val = usageEdits[tenantId];
    if (val === undefined || val === '') return;
    const used = parseInt(val);
    if (isNaN(used) || used < 0) { showToast('正しい数値を入力してください'); return; }
    try {
      await (window as any).api.setTenantUsage(tenantId, used);
      showToast(`使用量を${used}に変更しました`);
      setUsageEdits(prev => ({ ...prev, [tenantId]: '' }));
      await loadTenants();
    } catch (e) { console.error(e); showToast('変更に失敗しました'); }
  };

  const handleSetCredits = async (tenantId: number) => {
    const val = creditEdits[tenantId];
    if (val === undefined || val === '') return;
    const credits = parseInt(val);
    if (isNaN(credits) || credits < 0) { showToast('正しい数値を入力してください'); return; }
    try {
      await (window as any).api.setTenantCredits(tenantId, credits);
      showToast(`クレジットを${credits}に変更しました`);
      setCreditEdits(prev => ({ ...prev, [tenantId]: '' }));
      await loadTenants();
    } catch (e) { console.error(e); showToast('変更に失敗しました'); }
  };

  const handleToggleActive = async (tenant: Tenant) => {
    const isSuspended = tenant.plan === 'suspended';
    const action = isSuspended ? '有効化' : '利用停止';
    if (!window.confirm(`「${getUserForTenant(tenant.id)?.username || tenant.name}」を${action}しますか？`)) return;
    try {
      await (window as any).api.setTenantActive(tenant.id, isSuspended);
      showToast(`${action}しました`);
      await loadTenants();
    } catch (e) { console.error(e); showToast(`${action}に失敗しました`); }
  };

  const handleDeleteTenant = async (tenant: Tenant) => {
    if (!window.confirm(`テナント「${tenant.name}」を削除しますか？この操作は取り消せません。`)) return;
    try {
      await (window as any).api.deleteTenant(tenant.id);
      showToast('テナントを削除しました');
      await loadTenants();
    } catch (e) { console.error(e); showToast('削除に失敗しました'); }
  };

  /* ────── 改善要望操作 ────── */
  const handleUpdateFeedback = async (fb: FeedbackItem) => {
    const newStatus = statusChanges[fb.id] || fb.status;
    const reply = replyTexts[fb.id] || '';
    try {
      await (window as any).api.updateFeedbackStatus(fb.id, newStatus, reply);
      showToast('要望ステータスを更新しました');
      setReplyTexts(prev => ({ ...prev, [fb.id]: '' }));
      await loadFeedback();
    } catch (e) { console.error(e); showToast('更新に失敗しました'); }
  };

  /* ────── 集計値 ────── */
  const totalTenants = tenants.length;
  const pendingTenants = tenants.filter(t => t.plan === 'pending').length;
  const activeTenants = tenants.filter(t => t.plan !== 'pending').length;

  const filteredFeedback = feedbackFilter === 'all'
    ? feedbackList
    : feedbackList.filter(f => f.status === feedbackFilter);

  /* ────── レンダリング ────── */
  return (
    <div style={styles.page}>
      {toast && <div style={styles.toast}>{toast}</div>}

      <h1 style={styles.h1}>{isWeb ? '新規登録の承認' : '管理者ダッシュボード'}</h1>

      {/* タブバー（スマホは承認のみなので非表示） */}
      {!isWeb && (
        <div style={styles.tabBar}>
          {TABS.map(t => (
            <button key={t.key} style={styles.tabBtn(tab === t.key)} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {loading && <p style={{ color: '#999', fontSize: 14 }}>読み込み中...</p>}

      {/* ====== Tab 1: テナント管理 ====== */}
      {tab === 'tenants' && (
        <div>
          {/* スマホ承認の信頼端末（PCのみ表示） */}
          {!isWeb && (
            <div style={{ ...styles.card, marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#2c3e50', marginBottom: 4 }}>📱 スマホ承認の信頼端末</div>
                {trustedDev.trusted ? (
                  <div style={{ fontSize: 13, color: '#2e7d32' }}>
                    登録済み（{trustedDev.at ? fmtDate(trustedDev.at) : '登録日時不明'}）— この1台のスマホだけが承認できます
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: '#e67e22' }}>
                    未登録 — 次にスマホで承認画面を開いた端末が「信頼端末」として記憶されます
                  </div>
                )}
              </div>
              {trustedDev.trusted && (
                <button style={styles.btnSm(COLOR.danger)} onClick={handleResetTrustedDevice}>
                  端末をリセット（機種変更時）
                </button>
              )}
            </div>
          )}

          {/* リモート登録申請（Supabase） */}
          {remoteRegs.length > 0 && (
            <div style={{ ...styles.card, border: '2px solid #e67e22', marginBottom: 20 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: '#e67e22' }}>リモート登録申請（全顧客）</h3>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>会社名</th>
                    <th style={styles.th}>ユーザー名</th>
                    <th style={styles.th}>連絡先</th>
                    <th style={styles.th}>プラン</th>
                    <th style={styles.th}>クレジット</th>
                    <th style={styles.th}>状態</th>
                    <th style={styles.th}>登録日</th>
                    <th style={styles.th}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {remoteRegs.map((r: any) => {
                    const isPending = r.plan === 'pending';
                    return (
                      <tr key={r.id} style={isPending ? { background: '#fff9c4' } : undefined}>
                        <td style={styles.td}><strong>{r.company_name}</strong></td>
                        <td style={styles.td}>{(r.blocked_message || '').match(/ユーザー: ([^,]+)/)?.[1] || '-'}</td>
                        <td style={{ ...styles.td, fontSize: 11 }}>
                          {(r.blocked_message || '').match(/メール: ([^,]+)/)?.[1] || '-'}<br/>
                          {(r.blocked_message || '').match(/電話: ([^,]+)/)?.[1] || ''}
                        </td>
                        <td style={styles.td}>
                          <span style={{ ...styles.badge(isPending ? '#fff3e0' : '#e8f5e9', isPending ? '#e65100' : '#2e7d32') }}>
                            {r.plan === 'pending' ? '承認待ち' : r.plan === 'demo' ? 'デモ' : r.plan === 'standard' ? 'スタンダード' : r.plan === 'pro' ? 'プロ' : r.plan}
                          </span>
                        </td>
                        <td style={styles.td}>{r.credits} / {r.max_credits}</td>
                        <td style={styles.td}>
                          <span style={{ ...styles.badge(r.active ? '#e8f5e9' : '#fce4ec', r.active ? '#2e7d32' : '#c62828') }}>
                            {r.active ? '有効' : '無効'}
                          </span>
                        </td>
                        <td style={{ ...styles.td, fontSize: 12 }}>{r.created_at?.split('T')[0]}</td>
                        <td style={styles.td}>
                          {isPending ? (
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <select
                                value={regPlanChoices[r.company_name] || 'demo'}
                                onChange={e => setRegPlanChoices(prev => ({ ...prev, [r.company_name]: e.target.value }))}
                                style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12 }}
                              >
                                <option value="demo">デモ</option>
                                <option value="standard">スタンダード</option>
                                <option value="pro">プロ</option>
                              </select>
                              <button
                                style={{ ...styles.btnSm(COLOR.success), fontSize: 12 }}
                                onClick={async () => {
                                  const plan = regPlanChoices[r.company_name] || 'demo';
                                  await (window as any).api.approveRemoteRegistration(r.company_name, plan);
                                  showToast(`${r.company_name} を承認しました（${plan}）`);
                                  await loadTenants();
                                }}
                              >承認</button>
                              <button
                                style={{ ...styles.btnSm(COLOR.danger), fontSize: 12 }}
                                onClick={async () => {
                                  if (!confirm(`${r.company_name} の申請を却下しますか？`)) return;
                                  await (window as any).api.rejectRemoteRegistration(r.company_name);
                                  showToast(`${r.company_name} を却下しました`);
                                  await loadTenants();
                                }}
                              >却下</button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <select
                                value={regPlanChoices[r.company_name] || r.plan}
                                onChange={e => setRegPlanChoices(prev => ({ ...prev, [r.company_name]: e.target.value }))}
                                style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12 }}
                              >
                                <option value="demo">デモ</option>
                                <option value="standard">スタンダード</option>
                                <option value="pro">プロ</option>
                              </select>
                              <button
                                style={{ ...styles.btnSm(COLOR.primary), fontSize: 12 }}
                                onClick={async () => {
                                  const plan = regPlanChoices[r.company_name] || r.plan;
                                  await (window as any).api.approveRemoteRegistration(r.company_name, plan);
                                  showToast(`${r.company_name} のプランを ${plan} に変更しました`);
                                  await loadTenants();
                                }}
                              >変更</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {isWeb && !remoteRegs.some((r: any) => r.plan === 'pending') && (
            <div style={{ ...styles.card, textAlign: 'center', color: '#888', padding: 32 }}>
              現在、承認待ちの申請はありません。
            </div>
          )}

          {!isWeb && (<>
          {/* 集計カード */}
          <div style={{ marginBottom: 20 }}>
            <div style={styles.statBox}>
              <div style={{ fontSize: 13, color: '#888' }}>全テナント数</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: COLOR.primary }}>{totalTenants}</div>
            </div>
            <div style={styles.statBox}>
              <div style={{ fontSize: 13, color: '#888' }}>承認待ち数</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#e67e22' }}>{pendingTenants}</div>
            </div>
            <div style={styles.statBox}>
              <div style={{ fontSize: 13, color: '#888' }}>有効テナント数</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: COLOR.success }}>{activeTenants}</div>
            </div>
          </div>

          {/* テナント一覧 */}
          <div style={styles.card}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>ID</th>
                  <th style={styles.th}>ユーザー名</th>
                  <th style={styles.th}>会社名</th>
                  <th style={styles.th}>プラン</th>
                  <th style={styles.th}>クレジット上限</th>
                  <th style={styles.th}>連絡先</th>
                  <th style={styles.th}>登録日</th>
                  <th style={styles.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map(t => {
                  const isPending = t.plan === 'pending';
                  return (
                    <tr key={t.id} style={isPending ? { background: COLOR.pending } : undefined}>
                      <td style={styles.td}>{t.id}</td>
                      <td style={styles.td}>
                        <strong>{getUserForTenant(t.id)?.username || t.name}</strong>
                        {isPending && (
                          <span style={{ ...styles.badge('#fff3e0', '#e65100'), marginLeft: 8 }}>
                            承認待ち
                          </span>
                        )}
                      </td>
                      <td style={styles.td}>{t.contact_company || '-'}</td>
                      <td style={styles.td}>{PLAN_LABEL[t.plan] || t.plan}</td>
                      <td style={styles.td}>
                        <div>残: <strong style={{ color: (tenantUsages[t.id]?.remaining || 0) <= 5 ? '#e74c3c' : '#27ae60' }}>{tenantUsages[t.id]?.remaining ?? '-'}</strong> / {t.plan_limit ?? '-'}</div>
                        {/* デモは期限でも止まる。顧客画面には出さないが、オーナーはここで気づけるようにする */}
                        {typeof tenantUsages[t.id]?.daysLeft === 'number' && (
                          <div style={{ fontSize: 11, fontWeight: 700, color: (tenantUsages[t.id]!.daysLeft as number) <= 5 ? '#e74c3c' : '#e67e22' }}>
                            {(tenantUsages[t.id]!.daysLeft as number) > 0
                              ? `デモ期限 ${tenantUsages[t.id]!.expiresAt}（あと${tenantUsages[t.id]!.daysLeft}日）`
                              : `デモ期限切れ（${tenantUsages[t.id]!.expiresAt}）`}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#888' }}>
                          使用:
                          <input
                            type="number" placeholder={String(tenantUsages[t.id]?.used ?? 0)}
                            value={usageEdits[t.id] || ''}
                            onChange={e => setUsageEdits(prev => ({ ...prev, [t.id]: e.target.value }))}
                            style={{ width: 50, padding: '2px 4px', border: '1px solid #ddd', borderRadius: 4, fontSize: 12 }}
                          />
                          <button style={{ ...styles.btnSm('#f39c12'), fontSize: 10, padding: '2px 6px' }} onClick={() => handleSetUsage(t.id)}>
                            設定
                          </button>
                        </div>
                      </td>
                      <td style={styles.td}>
                        <div style={{ fontSize: 13 }}>{t.contact_company || '-'}</div>
                        <div style={{ fontSize: 12, color: '#888' }}>{t.contact_email}</div>
                        <div style={{ fontSize: 12, color: '#888' }}>{t.contact_tel}</div>
                      </td>
                      <td style={styles.td}>{fmtDate(t.created_at)}</td>
                      <td style={styles.td}>
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                          {isPending && (
                            <button style={styles.btnSm(COLOR.success)} onClick={() => handleApprove(t.id)}>
                              承認
                            </button>
                          )}
                          <select
                            style={styles.select}
                            value={planChanges[t.id] || ''}
                            onChange={e => setPlanChanges(prev => ({ ...prev, [t.id]: e.target.value }))}
                          >
                            <option value="">プラン変更</option>
                            {PLAN_OPTIONS.map(p => (
                              <option key={p.value} value={p.value}>{p.label}</option>
                            ))}
                          </select>
                          {planChanges[t.id] && (
                            <button style={styles.btnSm(COLOR.primary)} onClick={() => handlePlanChange(t.id)}>
                              適用
                            </button>
                          )}
                          {t.plan !== 'suspended' && t.plan !== 'pending' && t.id > 1 && (
                            <button style={styles.btnSm('#e74c3c')} onClick={() => handleToggleActive(t)}>
                              停止
                            </button>
                          )}
                          {t.plan === 'suspended' && (
                            <button style={styles.btnSm(COLOR.success)} onClick={() => handleToggleActive(t)}>
                              有効化
                            </button>
                          )}
                          <button style={styles.btnSm(COLOR.danger)} onClick={() => handleDeleteTenant(t)}>
                            削除
                          </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                          <input
                            type="number" placeholder="クレジット"
                            value={creditEdits[t.id] || ''}
                            onChange={e => setCreditEdits(prev => ({ ...prev, [t.id]: e.target.value }))}
                            style={{ width: 80, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
                          />
                          <button style={styles.btnSm(COLOR.primary)} onClick={() => handleSetCredits(t.id)}>
                            変更
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {tenants.length === 0 && (
                  <tr>
                    <td style={{ ...styles.td, textAlign: 'center', color: '#999' }} colSpan={7}>
                      テナントがありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </>)}
        </div>
      )}

      {/* ====== Tab 2: 改善要望 ====== */}
      {tab === 'feedback' && (
        <div>
          {/* フィルター */}
          <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#555' }}>ステータス絞り込み:</span>
            {FEEDBACK_STATUSES.map(s => (
              <button
                key={s}
                style={{
                  ...styles.btnSm(feedbackFilter === s ? COLOR.primary : '#e0e0e0', feedbackFilter === s ? '#fff' : '#333'),
                  minHeight: 32,
                }}
                onClick={() => setFeedbackFilter(s)}
              >
                {FEEDBACK_STATUS_LABELS[s]}
              </button>
            ))}
          </div>

          <div style={styles.card}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>テナント</th>
                  <th style={styles.th}>カテゴリ</th>
                  <th style={styles.th}>タイトル</th>
                  <th style={styles.th}>内容</th>
                  <th style={styles.th}>優先度</th>
                  <th style={styles.th}>ステータス</th>
                  <th style={styles.th}>登録日</th>
                  <th style={styles.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredFeedback.map(fb => {
                  const sb = STATUS_BADGE[fb.status] || STATUS_BADGE.new;
                  return (
                    <tr key={fb.id}>
                      <td style={styles.td}>{fb.tenant_name || '-'}</td>
                      <td style={styles.td}>{fb.category}</td>
                      <td style={styles.td}>{fb.title}</td>
                      <td style={{ ...styles.td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fb.description}
                      </td>
                      <td style={styles.td}>{fb.priority}</td>
                      <td style={styles.td}>
                        <span style={styles.badge(sb.bg, sb.color)}>{sb.label}</span>
                      </td>
                      <td style={styles.td}>{fmtDate(fb.created_at)}</td>
                      <td style={styles.td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                          <select
                            style={styles.select}
                            value={statusChanges[fb.id] || fb.status}
                            onChange={e => setStatusChanges(prev => ({ ...prev, [fb.id]: e.target.value }))}
                          >
                            {Object.entries(STATUS_BADGE).map(([k, v]) => (
                              <option key={k} value={k}>{v.label}</option>
                            ))}
                          </select>
                          <input
                            style={{ ...styles.input, minWidth: 100, maxWidth: 160 }}
                            placeholder="返信..."
                            value={replyTexts[fb.id] || ''}
                            onChange={e => setReplyTexts(prev => ({ ...prev, [fb.id]: e.target.value }))}
                          />
                          <button style={styles.btnSm(COLOR.primary)} onClick={() => handleUpdateFeedback(fb)}>
                            更新
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filteredFeedback.length === 0 && (
                  <tr>
                    <td style={{ ...styles.td, textAlign: 'center', color: '#999' }} colSpan={8}>
                      該当する要望がありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ====== Tab 3: 監査ログ ====== */}
      {tab === 'audit' && (
        <div>
          <div style={styles.card}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>日時</th>
                  <th style={styles.th}>アクション</th>
                  <th style={styles.th}>対象</th>
                  <th style={styles.th}>詳細</th>
                </tr>
              </thead>
              <tbody>
                {[...auditLog].sort((a, b) => {
                  if (!a.created_at || !b.created_at) return 0;
                  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
                }).map((log, i) => (
                  <tr key={i}>
                    <td style={styles.td}>{fmtDate(log.created_at)}</td>
                    <td style={styles.td}>{log.action}</td>
                    <td style={styles.td}>{log.entity}</td>
                    <td style={{ ...styles.td, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {log.detail}
                    </td>
                  </tr>
                ))}
                {auditLog.length === 0 && (
                  <tr>
                    <td style={{ ...styles.td, textAlign: 'center', color: '#999' }} colSpan={4}>
                      監査ログがありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
