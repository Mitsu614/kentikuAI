import React, { useEffect, useState } from 'react';

/* ────────── 型定義 ────────── */
interface FeedbackItem {
  id?: number;
  category: string;
  title: string;
  description: string;
  priority: string;
  status?: string;
  created_at?: string;
}

interface OutcomeItem {
  id?: number;
  construction_id: number;
  construction_name?: string;
  result: 'won' | 'lost' | 'pending';
  actual_amount?: number;
  win_reason?: string;
  loss_reason?: string;
  competitor?: string;
  feedback_notes?: string;
}

interface OutcomeStats {
  total: number;
  won: number;
  lost: number;
  pending: number;
  winRate: number;
}

interface Construction {
  id: number;
  name: string;
  customer_name?: string;
  total_selling?: number;
  [key: string]: any;
}

/* ────────── 定数 ────────── */
const CATEGORIES = ['機能追加', '使いやすさ改善', 'バグ報告', '料金・プラン', 'その他'];
const PRIORITIES = ['低', '通常', '高', '緊急'];
const STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  new:       { label: '🆕 新規',     bg: '#e3f2fd', color: '#1565c0' },
  reviewing: { label: '🔍 検討中',   bg: '#fff8e1', color: '#e67e22' },
  planned:   { label: '📋 対応予定', bg: '#e8f5e9', color: '#2e7d32' },
  completed: { label: '✅ 対応済',   bg: '#e0f2f1', color: '#00796b' },
  rejected:  { label: '❌ 見送り',   bg: '#fce4ec', color: '#c62828' },
};
const PRIORITY_BADGE: Record<string, { emoji: string; color: string }> = {
  '低':   { emoji: '🟢', color: '#27ae60' },
  '通常': { emoji: '🔵', color: '#3a7bd5' },
  '高':   { emoji: '🟠', color: '#e67e22' },
  '緊急': { emoji: '🔴', color: '#e74c3c' },
};
const WIN_REASONS  = ['価格', '品質', '信頼', '提案力', 'その他'];
const LOSS_REASONS = ['価格が高い', '競合に負けた', '案件中止', '仕様不一致', 'その他'];

/* ────────── コンポーネント ────────── */
export default function FeedbackPage() {
  const [activeTab, setActiveTab] = useState<'feedback' | 'outcome'>('feedback');

  /* --- Feedback state --- */
  const [feedbackList, setFeedbackList] = useState<FeedbackItem[]>([]);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('通常');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState('');

  /* --- Outcome state --- */
  const [stats, setStats] = useState<OutcomeStats>({ total: 0, won: 0, lost: 0, pending: 0, winRate: 0 });
  const [constructions, setConstructions] = useState<Construction[]>([]);
  const [outcomes, setOutcomes] = useState<OutcomeItem[]>([]);
  const [similarEstimates, setSimilarEstimates] = useState<any[]>([]);
  const [selectedConstruction, setSelectedConstruction] = useState<Construction | null>(null);

  /* --- Modal state --- */
  const [modal, setModal] = useState<{ type: 'won' | 'lost'; construction: Construction } | null>(null);
  const [modalAmount, setModalAmount] = useState('');
  const [modalWinReason, setModalWinReason] = useState(WIN_REASONS[0]);
  const [modalLossReason, setModalLossReason] = useState(LOSS_REASONS[0]);
  const [modalCompetitor, setModalCompetitor] = useState('');
  const [modalNotes, setModalNotes] = useState('');

  /* ─── データ読込 ─── */
  useEffect(() => { loadFeedback(); loadOutcomeData(); }, []);

  const loadFeedback = async () => {
    try {
      const list = await (window as any).api.listFeedback();
      setFeedbackList(Array.isArray(list) ? list : []);
    } catch { setFeedbackList([]); }
  };

  const loadOutcomeData = async () => {
    try {
      const [s, c, o] = await Promise.all([
        (window as any).api.getOutcomeStats().catch(() => ({ total: 0, won: 0, lost: 0, pending: 0, winRate: 0 })),
        (window as any).api.listConstructions().catch(() => []),
        (window as any).api.listOutcomes?.().catch(() => []),
      ]);
      setStats(s);
      setConstructions(Array.isArray(c) ? c : []);
      setOutcomes(Array.isArray(o) ? o : []);
    } catch {}
  };

  /* ─── Feedback送信 ─── */
  const handleSubmitFeedback = async () => {
    if (!title.trim()) { setToast('タイトルを入力してください'); setTimeout(() => setToast(''), 3000); return; }
    setSubmitting(true);
    try {
      await (window as any).api.createFeedback({ category, title: title.trim(), description: description.trim(), priority });
      setTitle(''); setDescription(''); setPriority('通常'); setCategory(CATEGORIES[0]);
      setToast('要望を送信しました。ご意見ありがとうございます！');
      await loadFeedback();
    } catch (e: any) {
      setToast('送信に失敗しました: ' + (e.message || e));
    }
    setSubmitting(false);
    setTimeout(() => setToast(''), 4000);
  };

  /* ─── Outcome登録 ─── */
  const openOutcomeModal = (construction: Construction, type: 'won' | 'lost') => {
    setModal({ type, construction });
    setModalAmount(String(construction.total_selling || ''));
    setModalWinReason(WIN_REASONS[0]);
    setModalLossReason(LOSS_REASONS[0]);
    setModalCompetitor('');
    setModalNotes('');
  };

  const handleMarkPending = async (construction: Construction) => {
    try {
      const existing = outcomes.find(o => o.construction_id === construction.id);
      if (existing?.id) {
        await (window as any).api.updateOutcome({ id: existing.id, construction_id: construction.id, result: 'pending', feedback_notes: '' });
      } else {
        await (window as any).api.createOutcome({ construction_id: construction.id, result: 'pending' });
      }
      await loadOutcomeData();
    } catch {}
  };

  const handleSubmitOutcome = async () => {
    if (!modal) return;
    const data: any = {
      construction_id: modal.construction.id,
      result: modal.type,
      feedback_notes: modalNotes,
    };
    if (modal.type === 'won') {
      data.actual_amount = Number(modalAmount) || 0;
      data.win_reason = modalWinReason;
    } else {
      data.loss_reason = modalLossReason;
      data.competitor = modalCompetitor;
    }
    try {
      const existing = outcomes.find(o => o.construction_id === modal.construction.id);
      if (existing?.id) {
        await (window as any).api.updateOutcome({ ...data, id: existing.id });
      } else {
        await (window as any).api.createOutcome(data);
      }
      setModal(null);
      await loadOutcomeData();
    } catch (e: any) {
      alert('登録に失敗しました: ' + (e.message || e));
    }
  };

  /* ─── 類似見積 ─── */
  const handleSelectConstruction = async (c: Construction) => {
    setSelectedConstruction(c);
    try {
      const similar = await (window as any).api.getSimilarEstimates(c.name);
      setSimilarEstimates(Array.isArray(similar) ? similar : []);
    } catch { setSimilarEstimates([]); }
  };

  const getOutcomeForConstruction = (id: number) => outcomes.find(o => o.construction_id === id);
  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

  /* ────────── スタイル定義 ────────── */
  const s = {
    container: { padding: 0 } as React.CSSProperties,
    tabs: { display: 'flex', gap: 0, marginBottom: 24, borderBottom: '2px solid #e0e0e0' } as React.CSSProperties,
    tab: (active: boolean): React.CSSProperties => ({
      padding: '14px 32px', fontSize: 16, fontWeight: active ? 700 : 500, cursor: 'pointer',
      background: active ? '#fff' : 'transparent', color: active ? '#3a7bd5' : '#666',
      borderBottom: active ? '3px solid #3a7bd5' : '3px solid transparent',
      borderTop: 'none', borderLeft: 'none', borderRight: 'none',
      transition: 'all 0.2s',
    }),
    card: { background: '#fff', borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.08)' } as React.CSSProperties,
    label: { display: 'block', fontWeight: 600, marginBottom: 6, fontSize: 14, color: '#333' } as React.CSSProperties,
    input: { width: '100%', padding: '12px 14px', fontSize: 15, border: '1px solid #ddd', borderRadius: 8, boxSizing: 'border-box' as const } as React.CSSProperties,
    select: { width: '100%', padding: '12px 14px', fontSize: 15, border: '1px solid #ddd', borderRadius: 8, boxSizing: 'border-box' as const } as React.CSSProperties,
    textarea: { width: '100%', padding: '12px 14px', fontSize: 15, border: '1px solid #ddd', borderRadius: 8, minHeight: 120, resize: 'vertical' as const, boxSizing: 'border-box' as const } as React.CSSProperties,
    btnPrimary: { minHeight: 48, fontSize: 16, padding: '12px 32px', background: '#3a7bd5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, transition: 'opacity 0.2s' } as React.CSSProperties,
    btnSuccess: { minHeight: 48, fontSize: 16, padding: '10px 20px', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 } as React.CSSProperties,
    btnDanger: { minHeight: 48, fontSize: 16, padding: '10px 20px', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 } as React.CSSProperties,
    btnOutline: { minHeight: 48, fontSize: 16, padding: '10px 20px', background: '#fff', color: '#3a7bd5', border: '2px solid #3a7bd5', borderRadius: 8, cursor: 'pointer', fontWeight: 600 } as React.CSSProperties,
    statsCard: (bg: string, color: string): React.CSSProperties => ({
      flex: 1, background: bg, borderRadius: 12, padding: '20px 16px', textAlign: 'center', minWidth: 120,
      boxShadow: '0 2px 8px rgba(0,0,0,0.06)', color,
    }),
    badge: (bg: string, color: string): React.CSSProperties => ({
      display: 'inline-block', padding: '4px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600,
      background: bg, color,
    }),
    overlay: { position: 'fixed' as const, top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
    modal: { background: '#fff', borderRadius: 16, padding: 32, width: '100%', maxWidth: 520, maxHeight: '80vh', overflowY: 'auto' as const, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' } as React.CSSProperties,
    toast: { position: 'fixed' as const, bottom: 32, left: '50%', transform: 'translateX(-50%)', background: '#27ae60', color: '#fff', padding: '14px 32px', borderRadius: 12, fontSize: 16, fontWeight: 600, zIndex: 10000, boxShadow: '0 4px 16px rgba(0,0,0,0.2)' },
  };

  /* ────────── 描画 ────────── */
  return (
    <div style={s.container}>
      <div className="page-header">
        <h1>📝 改善要望・受注管理</h1>
      </div>

      {/* タブ */}
      <div style={s.tabs}>
        <button style={s.tab(activeTab === 'feedback')} onClick={() => setActiveTab('feedback')}>
          💡 改善要望
        </button>
        <button style={s.tab(activeTab === 'outcome')} onClick={() => setActiveTab('outcome')}>
          📊 受注・失注管理
        </button>
      </div>

      {/* ═══════════ Tab 1: 改善要望 ═══════════ */}
      {activeTab === 'feedback' && (
        <div>
          {/* 送信フォーム */}
          <div style={s.card}>
            <h2 style={{ marginTop: 0, marginBottom: 20, fontSize: 20 }}>📮 改善要望を送信</h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={s.label}>📂 カテゴリ</label>
                <select style={s.select} value={category} onChange={e => setCategory(e.target.value)}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={s.label}>⚡ 優先度</label>
                <select style={s.select} value={priority} onChange={e => setPriority(e.target.value)}>
                  {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_BADGE[p].emoji} {p}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={s.label}>📌 タイトル <span style={{ color: '#e74c3c' }}>*必須</span></label>
              <input style={s.input} placeholder="例: 見積書にメモ欄を追加してほしい" value={title} onChange={e => setTitle(e.target.value)} />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={s.label}>📝 詳細説明</label>
              <textarea style={s.textarea} placeholder="具体的な内容を記入してください…" value={description} onChange={e => setDescription(e.target.value)} />
            </div>

            <button style={{ ...s.btnPrimary, opacity: submitting ? 0.6 : 1 }} disabled={submitting} onClick={handleSubmitFeedback}>
              {submitting ? '送信中…' : '📤 要望を送信する'}
            </button>
          </div>

          {/* 送信履歴 */}
          <div style={s.card}>
            <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 20 }}>📋 送信済みの要望一覧</h2>
            {feedbackList.length === 0 ? (
              <p style={{ color: '#999', textAlign: 'center', padding: 32 }}>まだ要望がありません</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {feedbackList.map((fb, i) => {
                  const st = STATUS_BADGE[fb.status || 'new'] || STATUS_BADGE.new;
                  const pr = PRIORITY_BADGE[fb.priority] || PRIORITY_BADGE['通常'];
                  return (
                    <div key={fb.id || i} style={{ border: '1px solid #eee', borderRadius: 10, padding: 16, background: '#fafafa' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={s.badge(st.bg, st.color)}>{st.label}</span>
                          <span style={{ fontSize: 13, color: pr.color, fontWeight: 600 }}>{pr.emoji} {fb.priority}</span>
                          <span style={{ fontSize: 12, color: '#999', background: '#f0f0f0', padding: '2px 8px', borderRadius: 12 }}>{fb.category}</span>
                        </div>
                        {fb.created_at && <span style={{ fontSize: 12, color: '#aaa' }}>{new Date(fb.created_at).toLocaleDateString('ja-JP')}</span>}
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>{fb.title}</div>
                      {fb.description && <div style={{ fontSize: 14, color: '#555', lineHeight: 1.6 }}>{fb.description}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ Tab 2: 受注・失注管理 ═══════════ */}
      {activeTab === 'outcome' && (
        <div>
          {/* 統計カード */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
            <div style={s.statsCard('#e3f2fd', '#1565c0')}>
              <div style={{ fontSize: 14, marginBottom: 4 }}>📋 見積総数</div>
              <div style={{ fontSize: 32, fontWeight: 700 }}>{stats.total}</div>
            </div>
            <div style={s.statsCard('#e8f5e9', '#2e7d32')}>
              <div style={{ fontSize: 14, marginBottom: 4 }}>🎉 受注</div>
              <div style={{ fontSize: 32, fontWeight: 700 }}>{stats.won}</div>
            </div>
            <div style={s.statsCard('#fce4ec', '#c62828')}>
              <div style={{ fontSize: 14, marginBottom: 4 }}>😞 失注</div>
              <div style={{ fontSize: 32, fontWeight: 700 }}>{stats.lost}</div>
            </div>
            <div style={s.statsCard('#fff8e1', '#e67e22')}>
              <div style={{ fontSize: 14, marginBottom: 4 }}>📈 受注率</div>
              <div style={{ fontSize: 32, fontWeight: 700 }}>{stats.winRate ?? 0}%</div>
            </div>
          </div>

          {/* 工事一覧 */}
          <div style={s.card}>
            <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 20 }}>🏗️ 工事別 受注・失注ステータス</h2>
            {constructions.length === 0 ? (
              <p style={{ color: '#999', textAlign: 'center', padding: 32 }}>工事データがありません</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {constructions.map(c => {
                  const outcome = getOutcomeForConstruction(c.id);
                  const result = outcome?.result || null;
                  return (
                    <div key={c.id} style={{
                      border: '1px solid #eee', borderRadius: 10, padding: 16, background: '#fafafa',
                      borderLeft: result === 'won' ? '4px solid #27ae60' : result === 'lost' ? '4px solid #e74c3c' : result === 'pending' ? '4px solid #f39c12' : '4px solid #ddd',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4, cursor: 'pointer', color: '#3a7bd5' }}
                               onClick={() => handleSelectConstruction(c)}>
                            {c.name}
                          </div>
                          <div style={{ fontSize: 13, color: '#888' }}>
                            {c.customer_name && <span>👤 {c.customer_name}　</span>}
                            {c.total_selling != null && <span>💰 {fmt(c.total_selling)}</span>}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          {result && (
                            <span style={s.badge(
                              result === 'won' ? '#e8f5e9' : result === 'lost' ? '#fce4ec' : '#fff8e1',
                              result === 'won' ? '#2e7d32' : result === 'lost' ? '#c62828' : '#e67e22',
                            )}>
                              {result === 'won' ? '🎉 受注' : result === 'lost' ? '😞 失注' : '🔄 商談中'}
                            </span>
                          )}
                          <button style={{ ...s.btnSuccess, padding: '8px 14px', minHeight: 40, fontSize: 14 }}
                                  onClick={() => openOutcomeModal(c, 'won')}>受注</button>
                          <button style={{ ...s.btnDanger, padding: '8px 14px', minHeight: 40, fontSize: 14 }}
                                  onClick={() => openOutcomeModal(c, 'lost')}>失注</button>
                          <button style={{ ...s.btnOutline, padding: '8px 14px', minHeight: 40, fontSize: 14 }}
                                  onClick={() => handleMarkPending(c)}>商談中</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 類似見積セクション */}
          {selectedConstruction && (
            <div style={s.card}>
              <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 20 }}>
                🔍 「{selectedConstruction.name}」の類似見積
              </h2>
              {similarEstimates.length === 0 ? (
                <p style={{ color: '#999', textAlign: 'center', padding: 24 }}>類似見積が見つかりませんでした</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {similarEstimates.map((est, i) => (
                    <div key={i} style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 14, background: '#f9f9ff' }}>
                      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{est.name || est.work_type || `見積${i + 1}`}</div>
                      <div style={{ fontSize: 13, color: '#666' }}>
                        {est.total_selling != null && <span>💰 {fmt(est.total_selling)}　</span>}
                        {est.result && <span>結果: {est.result === 'won' ? '🎉受注' : est.result === 'lost' ? '😞失注' : '🔄商談中'}　</span>}
                        {est.win_rate != null && <span>受注率: {est.win_rate}%</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══════════ モーダル ═══════════ */}
      {modal && (
        <div style={s.overlay} onClick={() => setModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginTop: 0, marginBottom: 20, fontSize: 20 }}>
              {modal.type === 'won' ? '🎉 受注登録' : '😞 失注登録'} — {modal.construction.name}
            </h2>

            {modal.type === 'won' && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <label style={s.label}>💰 受注金額</label>
                  <input style={s.input} type="number" placeholder="例: 5000000" value={modalAmount} onChange={e => setModalAmount(e.target.value)} />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={s.label}>🏆 受注理由</label>
                  <select style={s.select} value={modalWinReason} onChange={e => setModalWinReason(e.target.value)}>
                    {WIN_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              </>
            )}

            {modal.type === 'lost' && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <label style={s.label}>📉 失注理由</label>
                  <select style={s.select} value={modalLossReason} onChange={e => setModalLossReason(e.target.value)}>
                    {LOSS_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={s.label}>🏢 競合名</label>
                  <input style={s.input} placeholder="競合会社名（任意）" value={modalCompetitor} onChange={e => setModalCompetitor(e.target.value)} />
                </div>
              </>
            )}

            <div style={{ marginBottom: 24 }}>
              <label style={s.label}>📝 備考・フィードバック</label>
              <textarea style={s.textarea} placeholder="自由記入…" value={modalNotes} onChange={e => setModalNotes(e.target.value)} />
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button style={{ ...s.btnOutline, background: '#f5f5f5', color: '#666', border: '1px solid #ddd' }} onClick={() => setModal(null)}>
                キャンセル
              </button>
              <button style={modal.type === 'won' ? s.btnSuccess : s.btnDanger} onClick={handleSubmitOutcome}>
                {modal.type === 'won' ? '🎉 受注として登録' : '😞 失注として登録'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ トースト ═══════════ */}
      {toast && (
        <div style={{
          ...s.toast,
          background: toast.includes('失敗') || toast.includes('入力') ? '#e74c3c' : '#27ae60',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}
