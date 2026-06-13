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
  try { return new Date(s).toLocaleDateString('ja-JP'); } catch { return s; }
};

/* ────────── コンポーネント ────────── */
export default function AdminPage() {
  const [tab, setTab] = useState<TabKey>('tenants');
  const [toast, setToast] = useState('');

  /* --- テナント --- */
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [planChanges, setPlanChanges] = useState<Record<number, string>>({});

  /* --- 改善要望 --- */
  const [feedbackList, setFeedbackList] = useState<FeedbackItem[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState('all');
  const [replyTexts, setReplyTexts] = useState<Record<number, string>>({});
  const [statusChanges, setStatusChanges] = useState<Record<number, string>>({});

  /* --- 監査ログ --- */
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);

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
      const [list, userList] = await Promise.all([
        (window as any).api.listTenants(),
        (window as any).api.listUsers(),
      ]);
      setTenants(list || []);
      setUsers(userList || []);
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

  useEffect(() => {
    setLoading(true);
    Promise.all([loadTenants(), loadFeedback(), loadAuditLog()])
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

      <h1 style={styles.h1}>管理者ダッシュボード</h1>

      {/* タブバー */}
      <div style={styles.tabBar}>
        {TABS.map(t => (
          <button key={t.key} style={styles.tabBtn(tab === t.key)} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: '#999', fontSize: 14 }}>読み込み中...</p>}

      {/* ====== Tab 1: テナント管理 ====== */}
      {tab === 'tenants' && (
        <div>
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
                      <td style={styles.td}>{t.plan_limit != null ? t.plan_limit.toLocaleString() : '-'}</td>
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
                          <button style={styles.btnSm(COLOR.danger)} onClick={() => handleDeleteTenant(t)}>
                            削除
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
