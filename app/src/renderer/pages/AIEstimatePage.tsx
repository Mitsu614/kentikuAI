import React, { useState, useEffect, useRef } from 'react';
import { PageGuide } from '../components/PageGuide';

// 消費税率。AIが出す金額はすべて税抜（原価・粗利の計算がしやすいため）。表示のときだけ税込を併記する。
const TAX_RATE = 0.1;

// 金額・人数などの数値入力欄。
// ・クリック（フォーカス）で中身を全選択 → そのまま打てば丸ごと置き換わる
// ・入力中は空欄にもできる（0 に強制で戻さない）。空欄は 0 として親へ渡す
// ・確定（blur）時に数値へ丸める
function NumInput({ value, onValue, style, min }: {
  value: number;
  onValue: (n: number) => void;
  style?: React.CSSProperties;
  min?: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const display = text !== null ? text : String(Math.round(value || 0));
  return (
    <input
      type="number"
      min={min}
      value={display}
      onFocus={e => e.currentTarget.select()}
      onChange={e => {
        setText(e.target.value);
        onValue(e.target.value === '' ? 0 : Number(e.target.value) || 0);
      }}
      onBlur={() => setText(null)}
      style={style}
    />
  );
}

export default function AIEstimatePage({ onNavigateToConstruction }: { onNavigateToConstruction?: (id: number) => void }) {
  const [imageData, setImageData] = useState<string | null>(null);
  const [beforeImage, setBeforeImage] = useState<string | null>(null);
  const [afterImage, setAfterImage] = useState<string | null>(null);
  const [mode, setMode] = useState<'single' | 'beforeafter' | 'chat'>('single');
  const [dragTarget, setDragTarget] = useState<null | 'single' | 'before' | 'after'>(null);
  const [location, setLocation] = useState('');
  const [comment, setComment] = useState('');
  const [area, setArea] = useState(''); // 面積・数量の実測値（AIの推定より優先させる）
  // お客様(施主)の情報 — 提案(recommendations)のパーソナライズにのみ使う。金額には影響させない。
  const [clientName, setClientName] = useState('');
  const [clientJob, setClientJob] = useState('');
  const [clientHobby, setClientHobby] = useState('');
  const [clientAge, setClientAge] = useState('');
  const [clientPriorities, setClientPriorities] = useState<string[]>([]);
  const [profileLoaded, setProfileLoaded] = useState(''); // 直近に自動読込した顧客名（UI表示用）

  // 顧客名を確定したら、保存済みの職業・趣味を自動で読み込む
  const loadCustomerProfile = async () => {
    const nm = clientName.trim();
    if (!nm) return;
    try {
      const p = await (window as any).api.findCustomerByName(nm);
      if (p && (p.job || p.hobby)) {
        if (p.job) setClientJob(p.job);
        if (p.hobby) setClientHobby(p.hobby);
        setProfileLoaded(nm);
      }
    } catch (_) {}
  };
  const [reArea, setReArea] = useState(''); // 結果画面での「AIが前提にした面積」修正→再計算用
  const [analyzing, setAnalyzing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<any>(null);
  const elapsedRef = useRef(0);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [autoCreated, setAutoCreated] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [estimateLog, setEstimateLog] = useState<any[]>([]);
  const [selectedLog, setSelectedLog] = useState<number | null>(null);
  const [logPO, setLogPO] = useState<any>(null);
  const [poLoading, setPOLoading] = useState(false);
  const [logInvoice, setLogInvoice] = useState<any>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatEstimate, setChatEstimate] = useState<any>(null);
  const [chatSessionId, setChatSessionId] = useState<number | null>(null);
  const [chatSessions, setChatSessions] = useState<any[]>([]);
  // 「後からの相談」= 既存見積についてのチャットのとき、元見積ログ/施工に紐づける（別ログを chat_followup として残す）
  const [chatSourceLogId, setChatSourceLogId] = useState<number | null>(null);
  const [chatConstructionId, setChatConstructionId] = useState<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // DB からログ読み込み
  useEffect(() => {
    (window as any).api.getEstimateLog?.().then((logs: any[]) => {
      if (logs && logs.length > 0) {
        setEstimateLog(logs.map((l: any) => {
          let parsed = null;
          try { parsed = JSON.parse(l.ai_json); } catch (_) {}
          return {
            id: l.id,
            time: l.created_at?.split(' ')[1]?.substring(0, 5) || '',
            date: l.created_at?.split(' ')[0] || '',
            workType: l.work_type || '不明',
            total: l.ai_total || 0,
            result: parsed,
            image: l.generated_image || null,
            uploadedImage: l.uploaded_image || null,
            constructionId: l.construction_id || null,
            source: l.source || 'photo',
            sourceLogId: l.source_log_id || null,
          };
        }));
      }
    }).catch(() => {});
    // チャットセッション一覧を読み込み
    (window as any).api.listChatSessions?.().then((sessions: any[]) => {
      if (sessions) setChatSessions(sessions);
    }).catch(() => {});
  }, []);

  // チャットメッセージが更新されたら自動保存（ユーザー送信時 or AI応答時）
  useEffect(() => {
    if (chatMessages.length <= 1) return; // 初期メッセージのみはスキップ
    const hasUserMsg = chatMessages.some((m: any) => m.role === 'user');
    if (!hasUserMsg) return; // ユーザーが何も打っていない場合はスキップ
    const timer = setTimeout(async () => {
      try {
        const title = chatMessages.find((m: any) => m.role === 'user')?.content?.substring(0, 30) || 'チャット相談';
        const id = await (window as any).api.saveChatSession({
          id: chatSessionId || undefined,
          title,
          messages: chatMessages,
          constructionId: autoCreated?.constructionId || undefined,
          estimateLogId: selectedLog || undefined,
        });
        if (!chatSessionId) setChatSessionId(id);
        const sessions = await (window as any).api.listChatSessions();
        if (sessions) setChatSessions(sessions);
      } catch (_) {}
    }, 3000);
    return () => clearTimeout(timer);
  }, [chatMessages]);

  // Electron既定ではウィンドウにファイルをドロップすると開こうとして画面が壊れる。
  // ドロップゾーン外に落とした場合の事故を防ぐため、既定動作を無効化する。
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const selectImage = async () => {
    const img = await window.api.selectImage();
    if (img) {
      setImageData(img);
      setResult(null);
      setGeneratedImage(null);
      setError('');
      setAutoCreated(null);
    }
  };

  const selectBeforeImage = async () => {
    const img = await window.api.selectImage();
    if (img) { setBeforeImage(img); setResult(null); setError(''); setAutoCreated(null); }
  };

  const selectAfterImage = async () => {
    const img = await window.api.selectImage();
    if (img) { setAfterImage(img); setResult(null); setError(''); setAutoCreated(null); }
  };

  // ── ドラッグ&ドロップで画像を取り込む ──
  const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });

  const applyDroppedImage = (dataUrl: string, target: 'single' | 'before' | 'after') => {
    if (target === 'single') { setImageData(dataUrl); setGeneratedImage(null); }
    else if (target === 'before') setBeforeImage(dataUrl);
    else setAfterImage(dataUrl);
    setResult(null);
    setError('');
    setAutoCreated(null);
  };

  const handleDrop = async (e: React.DragEvent, target: 'single' | 'before' | 'after') => {
    e.preventDefault();
    setDragTarget(null);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('画像ファイル（JPG/PNG等）をドロップしてください'); return; }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      applyDroppedImage(dataUrl, target);
    } catch (err: any) {
      setError(err?.message || '画像の読み込みに失敗しました');
    }
  };

  // ドロップゾーンに付与する共通プロップ（onDragOver/Leave/Drop）
  const dropZoneProps = (target: 'single' | 'before' | 'after') => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (dragTarget !== target) setDragTarget(target); },
    onDragLeave: (e: React.DragEvent) => { e.preventDefault(); setDragTarget(t => (t === target ? null : t)); },
    onDrop: (e: React.DragEvent) => handleDrop(e, target),
  });

  const canAnalyze = mode === 'single'
    ? (!!imageData || comment.trim().length > 0)
    : (!!beforeImage && !!afterImage) || comment.trim().length > 0;

  // 見積前の面積確認。面積を間違えたまま本見積を回すと「再計算」でクレジットを二重に使うため、
  // 実測値が未入力かつ写真がある場合だけ、先にAIの推定面積を提示して直してもらう。
  const [areaCheck, setAreaCheck] = useState<{
    assumedArea: string; basis: string; confidence: string;
    scaleRef?: string; roofAreaM2?: number; developFactor?: number; quantityM2?: number;
    coversWholeRoof?: boolean; missingPart?: string; needsDimension?: string;
    isEstimate?: boolean; rangeMinM2?: number; rangeMaxM2?: number;
  } | null>(null);
  const [checkingArea, setCheckingArea] = useState(false);
  const [confirmArea, setConfirmArea] = useState('');

  // 管理者限定: 見積が参照する実績・業種プロンプトを他テナントのものに切り替える（検証用）。
  // 非管理者では isAdmin=false が返り、セレクタ自体が描画されない。
  const [estTenants, setEstTenants] = useState<{ id: number; name: string; industryType: string; isolated: boolean }[]>([]);
  const [estTenantId, setEstTenantId] = useState<number | ''>('');
  useEffect(() => {
    (async () => {
      try {
        const res = await (window as any).api.listEstimateTenants();
        if (res?.isAdmin) {
          setEstTenants(res.tenants || []);
          setEstTenantId(res.current || '');
        }
      } catch (_) { /* 旧ビルドでは未実装 */ }
    })();
  }, []);
  const changeEstTenant = async (v: string) => {
    const id = v ? Number(v) : null;
    const res = await (window as any).api.setEstimateTenant(id);
    if (res?.success) setEstTenantId(id || '');
    else setError(res?.error || 'テナントを切り替えられませんでした');
  };

  const startEstimate = async () => {
    if (!canAnalyze) return;
    const mainImage = mode === 'beforeafter' ? (afterImage || beforeImage) : imageData;
    // 実測値を入れてあるなら聞く必要はない。写真が無ければ読み取れない。
    if (area.trim() || !mainImage) { analyze(); return; }
    setCheckingArea(true);
    setError('');
    try {
      const res = await (window as any).api.estimateArea({ imageBase64: mainImage, comment });
      setAreaCheck(res);
      setConfirmArea(res?.assumedArea || '');
    } catch (e: any) {
      // 事前確認に失敗しても見積自体は止めない（上限到達・読み取り失敗など）
      console.warn('面積の事前確認をスキップ:', e?.message || e);
      analyze();
    } finally {
      setCheckingArea(false);
    }
  };

  const analyze = async (areaOverride?: string) => {
    if (!canAnalyze) return;
    setAreaCheck(null);
    // 結果画面から「この面積で再計算」した場合は上書き値を使い、入力欄にも反映
    const areaVal = areaOverride !== undefined ? areaOverride : area;
    if (areaOverride !== undefined) setArea(areaOverride);
    setAnalyzing(true);
    setError('');
    setResult(null);
    setAutoCreated(null);
    setElapsed(0);
    elapsedRef.current = 0;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
    }, 1000);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    try {
      const clientAttrs = (clientJob || clientHobby || clientAge || clientPriorities.length > 0)
        ? { job: clientJob, hobby: clientHobby, age: clientAge, priorities: clientPriorities }
        : null;
      // 職業・趣味を入れてあれば顧客DBに登録（顧客名がキー。次回同じ名前で自動読込される）
      if (clientName.trim() && (clientJob.trim() || clientHobby.trim())) {
        try { await (window as any).api.upsertCustomerProfile({ name: clientName.trim(), job: clientJob, hobby: clientHobby }); } catch (_) {}
      }
      const payload = mode === 'beforeafter'
        ? { imageBase64: null, beforeImage, afterImage, comment, location, area: areaVal, clientAttrs }
        : { imageBase64: imageData || null, comment, location, area: areaVal, clientAttrs };
      const res = await (window as any).api.analyzeImage(payload);
      setResult(res);
      setReArea(res?.assumedArea || ''); // 「AIが前提にした面積」を修正欄の初期値に
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);

      // 確認後、物件・施工・請求書・発注書を自動作成
      if (confirm('見積もり結果から物件・施工・請求書・発注書（下書き）を自動作成しますか？')) {
        setCreating(true);
        try {
          const mainImage = mode === 'beforeafter' ? (afterImage || beforeImage) : imageData;
          const created = await (window as any).api.autoCreateFromEstimate({ result: res, imageBase64: mainImage, comment, location, area: areaVal });
          setAutoCreated(created);
          if (created.sellingPrice) {
            res.estimatedTotal = created.sellingPrice;
            setResult({ ...res });
          }
          // 発注書も自動作成
          if (created.constructionId) {
            try {
              await (window as any).api.createPOFromConstruction(created.constructionId);
            } catch (_) {}
          }
        } catch (e: any) {
          console.error('auto create error:', e);
        }
        setCreating(false);

        // 金額修正の確認 → あれば編集ガイドへスクロール
        const wantEdit = confirm('登録完了しました。金額に修正はありますか？\n\n「OK」→ 修正画面へ\n「キャンセル」→ そのまま確定');
        if (wantEdit) {
          setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 200);
        }
      }
      // ログに追加（DBから再読込）
      try {
        const logs = await (window as any).api.getEstimateLog();
        if (logs && logs.length > 0) {
          setEstimateLog(logs.map((l: any) => {
            let parsed = null;
            try { parsed = JSON.parse(l.ai_json); } catch (_) {}
            return { id: l.id, time: l.created_at?.split(' ')[1]?.substring(0, 5) || '', date: l.created_at?.split(' ')[0] || '', workType: l.work_type || '不明', total: l.ai_total || 0, result: parsed, image: l.generated_image || null, uploadedImage: l.uploaded_image || null, constructionId: l.construction_id || null, source: l.source || 'photo', sourceLogId: l.source_log_id || null };
          }));
          // 最新のログをselectedに
          setSelectedLog(logs[0].id);
        }
      } catch (_) {}
    } catch (e: any) {
      setError(e.message || 'AI解析に失敗しました');
    }
    clearInterval(timerRef.current);
    setAnalyzing(false);
  };

  const [genElapsed, setGenElapsed] = useState(0);
  const genTimerRef = useRef<any>(null);
  const genElapsedRef = useRef(0);

  // 最新値をrefで保持（クロージャ問題回避）
  const autoCreatedRef = useRef(autoCreated);
  autoCreatedRef.current = autoCreated;
  const selectedLogRef = useRef(selectedLog);
  selectedLogRef.current = selectedLog;
  const estimateLogRef = useRef(estimateLog);
  estimateLogRef.current = estimateLog;

  const generateImage = async () => {
    if (!result?.imagePrompt) return;
    setGenerating(true);
    setError('');
    setGenElapsed(0);
    genElapsedRef.current = 0;
    genTimerRef.current = setInterval(() => { genElapsedRef.current++; setGenElapsed(genElapsedRef.current); }, 1000);
    try {
      // 元画像がある場合は編集モード（95%維持）、ない場合は生成モード
      const sourceImg = mode === 'beforeafter' ? (afterImage || beforeImage) : imageData;
      const ac = autoCreatedRef.current;
      const sl = selectedLogRef.current;
      const el = estimateLogRef.current;
      const saveTargetLogId = ac?.estimateLogId || sl || (el.length > 0 ? el[0].id : undefined);
      const saveTargetConstructionId = ac?.constructionId || undefined;
      const url = await (window as any).api.generateImage(
        sourceImg
          ? { prompt: result.imagePrompt, sourceImage: sourceImg, targetLogId: saveTargetLogId, targetConstructionId: saveTargetConstructionId }
          : { prompt: result.imagePrompt, targetLogId: saveTargetLogId, targetConstructionId: saveTargetConstructionId }
      );
      setGeneratedImage(url);
      // 施工写真として自動保存 + estimate_logにも保存
      if (url) {
        try {
          const ac = autoCreatedRef.current;
          const sl = selectedLogRef.current;
          const el = estimateLogRef.current;
          if (ac?.constructionId) {
            await (window as any).api.addConstructionPhoto({
              constructionId: ac.constructionId,
              photoData: url,
              label: 'after',
              notes: 'AI完成予想画像（自動保存）',
            });
          }
          const targetLogId = ac?.estimateLogId || sl || (el.length > 0 ? el[0].id : undefined);
          await (window as any).api.saveEstimateImage({
            logId: targetLogId,
            constructionId: ac?.constructionId,
            imageData: url,
          });
        } catch (e) { console.error('[saveEstimateImage] ERROR:', e); }
        // ログ再読込
        try {
          const logs = await (window as any).api.getEstimateLog();
          if (logs) {
            setEstimateLog(logs.map((l: any) => {
              let parsed = null;
              try { parsed = JSON.parse(l.ai_json); } catch (_) {}
              return { id: l.id, time: l.created_at?.split(' ')[1]?.substring(0, 5) || '', date: l.created_at?.split(' ')[0] || '', workType: l.work_type || '不明', total: l.ai_total || 0, result: parsed, image: l.generated_image || null, uploadedImage: l.uploaded_image || null, constructionId: l.construction_id || null, source: l.source || 'photo', sourceLogId: l.source_log_id || null };
            }));
          }
        } catch (_) {}
      }
    } catch (e: any) {
      setError(e.message || '画像生成に失敗しました');
    }
    clearInterval(genTimerRef.current);
    setGenerating(false);
  };

  const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();
  const confidenceColor: any = { '高': '#27ae60', '中': '#f39c12', '低': '#e74c3c' };

  const loadFromLog = async (logItem: any) => {
    const r = logItem.result ? { ...logItem.result } : null;
    // ログの金額（実際の売価）で上書き
    if (r && logItem.total) r.estimatedTotal = logItem.total;
    setResult(r);
    setReArea(r?.assumedArea || '');
    setGeneratedImage(logItem.image || null);
    if (logItem.uploadedImage) setImageData(logItem.uploadedImage);
    setSelectedLog(logItem.id);
    setLogPO(null);
    setLogInvoice(null);
    // constructionIdがあれば金額編集・保存できるようにする
    if (logItem.constructionId) {
      setAutoCreated({ constructionId: logItem.constructionId, propertyId: null });
    } else {
      setAutoCreated(null);
    }
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    // 関連する発注書・請求書を取得
    if (logItem.constructionId) {
      setPOLoading(true);
      setInvoiceLoading(true);
      try {
        const [po, inv] = await Promise.all([
          (window as any).api.getPOByConstruction(logItem.constructionId),
          (window as any).api.getInvoiceByConstruction(logItem.constructionId),
        ]);
        setLogPO(po);
        setLogInvoice(inv);
      } catch (_) {}
      setPOLoading(false);
      setInvoiceLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>AI 見積もり</h1>
        <PageGuide pageKey="ai-estimate" steps={[
          { icon: '📸', title: 'STEP 1：現場写真をアップロード', desc: '施工前の写真や図面を選択してください。テキストだけでの見積もりも可能です。', sub: 'ビフォーアフターモードで2枚の写真から見積もることもできます' },
          { icon: '🤖', title: 'STEP 2：AIが自動で見積作成', desc: 'AIが写真を解析し、材料・数量・単価・人件費を自動算出します。', sub: '過去の実績データを学習し、精度が向上していきます' },
          { icon: '📋', title: 'STEP 3：施工案件として登録', desc: '見積結果をワンクリックで施工案件に登録。請求書や発注書も自動生成できます。' },
        ]} />
      </div>

      {/* モード切替 */}
      <div className="card" style={{ padding: '12px 20px' }}>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button
            className={`btn ${mode === 'single' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('single')}
            style={{ padding: '8px 20px', fontSize: 13 }}
          >
            📷 写真・図面で見積
          </button>
          <button
            className={`btn ${mode === 'beforeafter' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('beforeafter')}
            style={{ padding: '8px 20px', fontSize: 13 }}
          >
            🔄 ビフォーアフターで見積
          </button>
          <button
            className={`btn ${mode === 'chat' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setMode('chat'); if (chatMessages.length === 0) setChatMessages([{ role: 'assistant', content: 'こんにちは！建築見積のAIアシスタントです。\n\nどんな工事の見積もりをしたいですか？\n例：「キッチンリフォーム」「外壁塗装」「3階建てマンションの足場」\n\n写真があれば添付もできます。' }]); setTimeout(() => chatInputRef.current?.focus(), 100); }}
            style={{ padding: '8px 20px', fontSize: 13 }}
          >
            💬 チャットで見積
          </button>
        </div>
      </div>

      {/* チャットモード */}
      {mode === 'chat' && (
        <div className="card" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 200px)', minHeight: 400, background: '#e8ecf1', padding: 0, overflow: 'hidden', position: 'relative' }}>
          {/* チャットセッション履歴バー */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', background: '#fff', borderBottom: '1px solid #e2e8f0', overflowX: 'auto', flexShrink: 0 }}>
            <button onClick={() => { setChatMessages([{ role: 'assistant', content: 'こんにちは！建築見積のAIアシスタントです。\n\nどんな工事の見積もりをしたいですか？' }]); setChatSessionId(null); setChatEstimate(null); setChatSourceLogId(null); setChatConstructionId(null); }} style={{ padding: '4px 10px', fontSize: 11, background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600 }}>+ 新規</button>
            {chatSessions.slice(0, 8).map((s: any) => (
              <button key={s.id} onClick={async () => {
                const session = await (window as any).api.getChatSession(s.id);
                if (session) {
                  setChatMessages(session.messages || []);
                  setChatSessionId(s.id);
                  setChatEstimate(null);
                  setChatConstructionId(session.construction_id || null);
                  setChatSourceLogId(session.estimate_log_id || null);
                  if (session.construction_id) setAutoCreated({ constructionId: session.construction_id, propertyId: null });
                }
              }} style={{
                padding: '4px 10px', fontSize: 11, border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer',
                background: chatSessionId === s.id ? '#dbeafe' : '#f8fafc', whiteSpace: 'nowrap', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis',
                fontWeight: chatSessionId === s.id ? 600 : 400, color: '#475569',
              }}>
                {s.construction_title ? '🔗' : ''}{s.title || 'チャット'}
              </button>
            ))}
          </div>
          {/* チャット履歴 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {chatMessages.map((msg, i) => (
              <div key={i} style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '75%',
                display: 'flex',
                flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                alignItems: 'flex-end',
                gap: 8,
              }}>
                {msg.role !== 'user' && (
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                    background: 'linear-gradient(135deg, #3a7bd5, #27ae60)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontSize: 16, fontWeight: 'bold',
                  }}>AI</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 2 }}>
                  <div style={{
                    padding: '12px 16px',
                    borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                    background: msg.role === 'user' ? 'linear-gradient(135deg, #3a7bd5, #2a6bc5)' : '#fff',
                    color: msg.role === 'user' ? '#fff' : '#333',
                    fontSize: 15,
                    lineHeight: 1.7,
                    whiteSpace: 'pre-wrap',
                    boxShadow: msg.role === 'user' ? '0 2px 8px rgba(58,123,213,0.3)' : '0 1px 4px rgba(0,0,0,0.1)',
                    border: msg.role === 'user' ? 'none' : '1px solid #e8e8e8',
                  }}>
                    {msg.image && <img src={msg.image} style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 10, marginBottom: 8, display: 'block' }} alt="" />}
                    {msg.content}
                  </div>
                  <span style={{ fontSize: 11, color: '#aaa', padding: '0 4px' }}>
                    {new Date().getHours()}:{String(new Date().getMinutes()).padStart(2, '0')}
                  </span>
                </div>
              </div>
            ))}
            {chatLoading && (
              <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                  background: 'linear-gradient(135deg, #3a7bd5, #27ae60)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 16, fontWeight: 'bold',
                }}>AI</div>
                <div style={{
                  padding: '14px 20px', borderRadius: '18px 18px 18px 4px',
                  background: '#fff', border: '1px solid #e8e8e8',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
                  fontSize: 15, color: '#888',
                  display: 'flex', gap: 6, alignItems: 'center',
                }}>
                  <span style={{ animation: 'pulse 1.4s infinite', width: 8, height: 8, borderRadius: '50%', background: '#aaa', display: 'inline-block' }} />
                  <span style={{ animation: 'pulse 1.4s infinite 0.2s', width: 8, height: 8, borderRadius: '50%', background: '#aaa', display: 'inline-block' }} />
                  <span style={{ animation: 'pulse 1.4s infinite 0.4s', width: 8, height: 8, borderRadius: '50%', background: '#aaa', display: 'inline-block' }} />
                </div>
              </div>
            )}
            {chatEstimate && (
              <div style={{ alignSelf: 'flex-start', maxWidth: '90%', padding: '12px 16px', borderRadius: 12, background: '#f0fff4', border: '2px solid #27ae60', fontSize: 13 }}>
                <div style={{ fontWeight: 'bold', color: '#27ae60', marginBottom: 6 }}>見積結果</div>
                <div style={{ fontSize: 11, marginBottom: 4 }}>工事種別: {chatEstimate.workType}</div>
                <div style={{ fontSize: 20, fontWeight: 'bold', color: '#27ae60', margin: '6px 0' }}>¥{Math.round(chatEstimate.estimatedTotal || 0).toLocaleString()}</div>
                {chatEstimate.breakdown && chatEstimate.breakdown.map((b: any, j: number) => (
                  <div key={j} style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #e0e0e0', padding: '2px 0' }}>
                    <span>{b.item}</span>
                    <span style={{ fontWeight: 'bold' }}>¥{Math.round(b.cost || 0).toLocaleString()}</span>
                  </div>
                ))}
                <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => {
                    setResult(chatEstimate);
                    setMode('single');
                    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
                  }} style={{ fontSize: 11 }}>見積詳細を見る</button>
                  <button className="btn btn-sm" style={{ fontSize: 11, background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }} onClick={async () => {
                    if (confirm('この見積から物件・施工・請求書・発注書を自動作成しますか？')) {
                      try {
                        const chatImage = [...chatMessages].reverse().find(m => m.image)?.image || null;
                        const created = await (window as any).api.autoCreateFromEstimate({ result: chatEstimate, imageBase64: chatImage });
                        setAutoCreated(created);
                        setResult(chatEstimate);
                        setMode('single');
                        const wantEdit = confirm('登録完了しました。金額に修正はありますか？\n\n「OK」→ 修正画面へ\n「キャンセル」→ そのまま確定');
                        if (wantEdit) {
                          setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 200);
                        }
                      } catch (e: any) { alert('エラー: ' + e.message); }
                    }
                  }}>一括登録</button>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          {/* 入力エリア */}
          <div style={{ borderTop: '2px solid #f0f0f0', padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'flex-end', background: '#fafafa', flexShrink: 0, position: 'relative', zIndex: 10 }}>
            <button onClick={async () => {
              const img = await window.api.selectImage();
              if (img) {
                setChatMessages(prev => [...prev, { role: 'user', content: '写真を添付しました', image: img }]);
                setChatLoading(true);
                setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
                try {
                  const res = await (window as any).api.aiChat({ messages: [...chatMessages, { role: 'user', content: 'この写真を見て見積もりしてください', image: img }], constructionId: chatConstructionId || undefined, sourceLogId: chatSourceLogId || undefined });
                  setChatMessages(prev => [...prev, { role: 'assistant', content: res.text }]);
                  if (res.estimate) setChatEstimate(res.estimate);
                } catch (e: any) { setChatMessages(prev => [...prev, { role: 'assistant', content: 'エラー: ' + e.message }]); }
                setChatLoading(false);
                setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
              }
            }} style={{ fontSize: 20, padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', borderRadius: '50%', transition: 'background 0.2s' }}>📷</button>
            <textarea
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={async e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!chatInput.trim() || chatLoading) return;
                  const userMsg = chatInput.trim();
                  setChatInput('');
                  setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
                  setChatLoading(true);
                  setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
                  try {
                    const allMsgs = [...chatMessages, { role: 'user', content: userMsg }].filter(m => m.role !== 'system');
                    const res = await (window as any).api.aiChat({ messages: allMsgs, constructionId: chatConstructionId || undefined, sourceLogId: chatSourceLogId || undefined });
                    setChatMessages(prev => [...prev, { role: 'assistant', content: res.text }]);
                    if (res.estimate) setChatEstimate(res.estimate);
                  } catch (e: any) { setChatMessages(prev => [...prev, { role: 'assistant', content: 'エラー: ' + e.message }]); }
                  setChatLoading(false);
                  setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
                }
              }}
              ref={chatInputRef}
              placeholder="工事の内容を入力... (Enter で送信、Shift+Enter で改行)"
              style={{ flex: 1, minHeight: 48, maxHeight: 120, padding: '12px 16px', border: '2px solid #e2e8f0', borderRadius: 24, fontSize: 16, resize: 'none', fontFamily: 'inherit', lineHeight: 1.5, outline: 'none', transition: 'border-color 0.2s', color: '#1e293b', background: '#fff', WebkitUserSelect: 'text', userSelect: 'text' }}
              onFocus={e => { e.target.style.borderColor = '#3b82f6'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.1)'; }}
              onBlur={e => { e.target.style.borderColor = '#e2e8f0'; e.target.style.boxShadow = 'none'; }}
            />
            <button className="btn btn-primary" disabled={chatLoading || !chatInput.trim()} onClick={async () => {
              if (!chatInput.trim() || chatLoading) return;
              const userMsg = chatInput.trim();
              setChatInput('');
              setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
              setChatLoading(true);
              setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
              try {
                const allMsgs = [...chatMessages, { role: 'user', content: userMsg }].filter(m => m.role !== 'system');
                const res = await (window as any).api.aiChat({ messages: allMsgs });
                setChatMessages(prev => [...prev, { role: 'assistant', content: res.text }]);
                if (res.estimate) setChatEstimate(res.estimate);
              } catch (e: any) { setChatMessages(prev => [...prev, { role: 'assistant', content: 'エラー: ' + e.message }]); }
              setChatLoading(false);
              setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
            }} style={{ padding: '12px 24px', fontSize: 16, borderRadius: 24, minHeight: 48 }}>送信</button>
          </div>
        </div>
      )}

      {/* 画像アップロードエリア（チャットモード以外） */}
      {mode !== 'chat' && (mode === 'single' ? (
        <div className="card" style={{ textAlign: 'center', marginTop: 12 }}>
          {!imageData ? (
            <div
              onClick={selectImage}
              {...dropZoneProps('single')}
              style={{
                border: `3px dashed ${dragTarget === 'single' ? '#3a7bd5' : '#ccc'}`, borderRadius: 12, padding: '60px 20px',
                cursor: 'pointer', color: dragTarget === 'single' ? '#3a7bd5' : '#aaa', transition: 'all 0.2s',
                background: dragTarget === 'single' ? '#eef4fc' : 'transparent',
              }}
              onMouseOver={e => { if (dragTarget) return; (e.currentTarget as HTMLElement).style.borderColor = '#3a7bd5'; (e.currentTarget as HTMLElement).style.color = '#3a7bd5'; }}
              onMouseOut={e => { if (dragTarget) return; (e.currentTarget as HTMLElement).style.borderColor = '#ccc'; (e.currentTarget as HTMLElement).style.color = '#aaa'; }}
            >
              <div style={{ fontSize: 48, marginBottom: 12 }}>{dragTarget === 'single' ? '📥' : '📷'}</div>
              <div style={{ fontSize: 18, fontWeight: 'bold' }}>{dragTarget === 'single' ? 'ここにドロップ' : '写真・図面をドラッグ&ドロップ'}</div>
              <div style={{ fontSize: 13, marginTop: 8, color: '#666' }}>現場写真 / 間取り図 / 平面図 / 設計図 / 立面図 OK</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>ドラッグ&ドロップ、またはクリックして選択（なくてもコメントだけで見積可能）</div>
            </div>
          ) : (
            <div {...dropZoneProps('single')} style={{ borderRadius: 8, outline: dragTarget === 'single' ? '3px dashed #3a7bd5' : 'none', outlineOffset: 4 }}>
              <img src={imageData} style={{ maxWidth: '100%', maxHeight: 350, borderRadius: 8, border: '1px solid #ddd' }} alt="uploaded" />
              <div style={{ marginTop: 12 }}>
                <button className="btn btn-secondary btn-sm" onClick={selectImage}>別の画像を選択</button>
                <span style={{ fontSize: 11, color: '#aaa', marginLeft: 8 }}>ドロップで差し替えもOK</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginBottom: 12, textAlign: 'center' }}>🔄 ビフォー・アフター写真から工事内容を判定</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Before */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#e74c3c', marginBottom: 8 }}>Before（施工前）</div>
              {!beforeImage ? (
                <div
                  onClick={selectBeforeImage}
                  {...dropZoneProps('before')}
                  style={{
                    border: '2px dashed #e74c3c', borderRadius: 8, padding: '40px 12px',
                    cursor: 'pointer', color: '#e74c3c', transition: 'all 0.2s',
                    background: dragTarget === 'before' ? '#fcdcd8' : '#fef5f5',
                  }}
                >
                  <div style={{ fontSize: 32 }}>{dragTarget === 'before' ? '📥' : '📷'}</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>{dragTarget === 'before' ? 'ここにドロップ' : 'ドラッグ&ドロップ / クリックで選択'}</div>
                </div>
              ) : (
                <div {...dropZoneProps('before')} style={{ borderRadius: 8, outline: dragTarget === 'before' ? '3px dashed #e74c3c' : 'none', outlineOffset: 3 }}>
                  <img src={beforeImage} style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, border: '2px solid #e74c3c' }} alt="before" />
                  <div style={{ marginTop: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={selectBeforeImage} style={{ fontSize: 11 }}>変更</button>
                  </div>
                </div>
              )}
            </div>
            {/* After */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#27ae60', marginBottom: 8 }}>After（施工後）</div>
              {!afterImage ? (
                <div
                  onClick={selectAfterImage}
                  {...dropZoneProps('after')}
                  style={{
                    border: '2px dashed #27ae60', borderRadius: 8, padding: '40px 12px',
                    cursor: 'pointer', color: '#27ae60', transition: 'all 0.2s',
                    background: dragTarget === 'after' ? '#d6f5e0' : '#f0fff4',
                  }}
                >
                  <div style={{ fontSize: 32 }}>{dragTarget === 'after' ? '📥' : '📷'}</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>{dragTarget === 'after' ? 'ここにドロップ' : 'ドラッグ&ドロップ / クリックで選択'}</div>
                </div>
              ) : (
                <div {...dropZoneProps('after')} style={{ borderRadius: 8, outline: dragTarget === 'after' ? '3px dashed #27ae60' : 'none', outlineOffset: 3 }}>
                  <img src={afterImage} style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, border: '2px solid #27ae60' }} alt="after" />
                  <div style={{ marginTop: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={selectAfterImage} style={{ fontSize: 11 }}>変更</button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <p style={{ textAlign: 'center', fontSize: 12, color: '#888', marginTop: 12 }}>
            2枚の写真の差分からAIが工事内容を判定し、同様の工事の見積もりを算出します
          </p>
        </div>
      ))}

      {/* コメント欄 + 場所 + 解析ボタン（チャットモード以外） */}
      {mode !== 'chat' && !result && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 10 }}>📝 工事内容・補足情報</h3>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>📍 場所（現場住所・物件名）</label>
            <input
              type="text"
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="例: 大阪市北区梅田1-2-3 / ○○マンション302号室"
              style={{
                width: '100%', padding: '10px 12px', border: '1px solid #ddd',
                borderRadius: 8, fontSize: 14, fontFamily: 'inherit',
              }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>📐 面積・数量（実測値／わかる範囲でOK）</label>
            <input
              type="text"
              value={area}
              onChange={e => setArea(e.target.value)}
              placeholder="例: 屋根 450㎡（実測） / 外壁 320㎡ / 床 80㎡ ・ 20坪"
              style={{
                width: '100%', padding: '10px 12px', border: '1px solid #ddd',
                borderRadius: 8, fontSize: 14, fontFamily: 'inherit',
              }}
            />
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>実測値を入れると、写真・航空写真からの推定を使わず正確に計算します（信頼度アップ）。</div>
          </div>

          {/* お客様(施主)の情報 — 提案のパーソナライズ専用。金額には一切影響させない。 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>
              👤 お客様の情報（任意 — 提案の精度が上がります）
            </label>
            {/* 顧客名: 職業・趣味を入れて見積すると顧客DBに保存。次回同じ名前で自動読込。 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={clientName}
                onChange={e => { setClientName(e.target.value); setProfileLoaded(''); }}
                onBlur={loadCustomerProfile}
                placeholder="顧客名（例: 中野工務店 様）"
                style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }}
              />
              <input
                type="text"
                value={clientHobby}
                onChange={e => setClientHobby(e.target.value)}
                placeholder="趣味（例: ゴルフ・車・ガーデニング）"
                style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }}
              />
            </div>
            {profileLoaded && (
              <div style={{ fontSize: 11, color: '#2563eb', marginBottom: 8 }}>
                ✓「{profileLoaded}」様の登録済みプロフィールを読み込みました
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <select
                value={clientJob}
                onChange={e => setClientJob(e.target.value)}
                style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
              >
                <option value="">職業・立場（未選択）</option>
                {['会社経営者', '個人事業主', '会社員', '公務員', '医師・士業', '農林業・漁業', '不動産オーナー', '法人（管理会社）', '退職・年金生活', 'その他'].map(j => (
                  <option key={j} value={j}>{j}</option>
                ))}
              </select>
              <select
                value={clientAge}
                onChange={e => setClientAge(e.target.value)}
                style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff' }}
              >
                <option value="">年代（未選択）</option>
                {['20〜30代', '40代', '50代', '60代', '70代以上'].map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['価格重視', '見た目・デザイン', '耐久性・長持ち', '光熱費・省エネ', '工期の短さ', '近隣への配慮', '補助金を使いたい'].map(p => {
                const on = clientPriorities.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setClientPriorities(prev => on ? prev.filter(x => x !== p) : [...prev, p])}
                    style={{
                      padding: '6px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                      border: on ? '1px solid #2563eb' : '1px solid #ddd',
                      background: on ? '#eff6ff' : '#fff',
                      color: on ? '#1d4ed8' : '#555',
                      fontWeight: on ? 'bold' : 'normal',
                    }}
                  >{on ? '✓ ' : ''}{p}</button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
              提案（💡欄）のパーソナライズにのみ使います。<strong>見積金額には一切影響しません。</strong><br />
              顧客名＋職業/趣味を入れて見積すると顧客DBに保存され、次回同じ顧客名で自動的に読み込まれます。
            </div>
          </div>

          <label style={{ fontSize: 13, fontWeight: 'bold', color: '#555', display: 'block', marginBottom: 4 }}>🔨 工事内容</label>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="例:&#10;・キッチンとお風呂のリフォーム希望&#10;・築30年の木造2階建て&#10;・耐震補強も検討中&#10;・予算は500万円くらい&#10;・2階の洋室を和室に変更したい"
            style={{
              width: '100%', minHeight: 120, padding: 12, border: '1px solid #e2e8f0',
              borderRadius: 8, fontSize: 14, lineHeight: 1.7, resize: 'vertical',
              fontFamily: 'inherit', color: '#1e293b', background: '#fff',
              WebkitUserSelect: 'text', userSelect: 'text',
            }}
          />
          {/* 面積の事前確認。ここで直せば、見積後の「再計算」でクレジットを二重に使わずに済む */}
          {areaCheck && (
            <div className="card" style={{ marginTop: 12, background: '#eff6ff', border: '1px solid #93c5fd', padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: areaCheck.isEstimate ? '#b45309' : '#1e40af', marginBottom: 6 }}>
                {areaCheck.isEstimate
                  ? '📐 推測値です。屋根全体が写っていないため確定できません'
                  : `📐 写真から読み取った面積です。合っていますか？（信頼度: ${areaCheck.confidence}）`}
              </div>
              {areaCheck.isEstimate && (
                <div style={{ fontSize: 12, color: '#78350f', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '6px 8px', marginBottom: 8 }}>
                  {!!areaCheck.rangeMinM2 && !!areaCheck.rangeMaxM2 && (
                    <div style={{ marginBottom: 4 }}>
                      想定レンジ: <strong>{areaCheck.rangeMinM2}〜{areaCheck.rangeMaxM2}㎡</strong>（推測が入るぶん幅があります）
                    </div>
                  )}
                  {areaCheck.needsDimension && (
                    <div><strong>{areaCheck.needsDimension}</strong> が分かれば正確に計算できます。</div>
                  )}
                  {areaCheck.missingPart && <div style={{ marginTop: 4 }}>写っていない部分: {areaCheck.missingPart}</div>}
                  <div style={{ marginTop: 4 }}>このまま進めても構いません。分かる範囲で下の欄を直してください。</div>
                </div>
              )}
              <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>根拠: {areaCheck.basis}</div>
              {areaCheck.scaleRef && (
                <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>基準にした寸法: {areaCheck.scaleRef}</div>
              )}
              {/* 折板屋根は山谷があるぶん、実際に張る面積が屋根面積より大きい（展開係数） */}
              {!!areaCheck.roofAreaM2 && !!areaCheck.developFactor && areaCheck.developFactor > 1 && (
                <div style={{ fontSize: 12, color: '#1e40af', marginBottom: 8, background: '#dbeafe', padding: '4px 8px', borderRadius: 4 }}>
                  屋根面積 {areaCheck.roofAreaM2}㎡ × 展開係数 {areaCheck.developFactor}（山谷の凹凸ぶん）＝ 見積数量 {areaCheck.quantityM2}㎡
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={confirmArea}
                  onChange={e => setConfirmArea(e.target.value)}
                  placeholder="例: 屋根 48㎡"
                  style={{ flex: '1 1 220px', minWidth: 180, padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }}
                />
                <button className="btn btn-primary" disabled={analyzing || !confirmArea.trim()} onClick={() => analyze(confirmArea)} style={{ whiteSpace: 'nowrap' }}>
                  この面積で見積もる
                </button>
                <button className="btn" disabled={analyzing} onClick={() => analyze()} style={{ whiteSpace: 'nowrap' }}>
                  面積を指定せず見積もる
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                実測値に直してから見積もると、金額が正確になります。ここでの確認はクレジットを消費しません。
              </div>
            </div>
          )}

          {estTenants.length > 0 && (
            <div style={{ marginTop: 12, padding: 10, border: '1px dashed #94a3b8', borderRadius: 6, background: '#f8fafc' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>
                🔧 検証対象のテナント（管理者のみ表示）
              </div>
              <select value={estTenantId} onChange={e => changeEstTenant(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, minWidth: 280 }}>
                <option value="">管理者（自分）</option>
                {estTenants.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.industryType}{t.isolated ? '・隔離' : ''}）
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                選んだテナントの実績・業種プロンプトで見積もります。作成した物件・見積ログは管理者テナントに保存され、
                そのテナントの学習データは書き換わりません。
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-primary" onClick={startEstimate} disabled={analyzing || checkingArea || !canAnalyze} style={{ fontSize: 16, padding: '12px 32px' }}>
              {analyzing ? '🔄 AI が解析中...' : checkingArea ? '📐 面積を読み取り中...' : '🤖 AI で見積もりを解析'}
            </button>
            <span style={{ fontSize: 12, color: '#888' }}>
              {mode === 'beforeafter' ? 'ビフォーアフター写真から工事内容を判定します' :
               imageData ? '画像 + コメントからAIが見積もりを自動作成します' : 'コメントだけでもAI見積もりできます（画像は任意）'}
            </span>
          </div>
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <div style={{ background: '#fdecea', color: '#c0392b', padding: '12px 16px', borderRadius: 8, marginTop: 16 }}>
          {error}
        </div>
      )}

      {/* 解析中 */}
      {analyzing && (
        <div ref={resultRef} className="card" style={{ textAlign: 'center', padding: 40 }}>
          {/* 回転する¥マーク */}
          <div style={{ fontSize: 56, marginBottom: 16, display: 'inline-block', animation: 'spin 1.5s linear infinite' }}>¥</div>
          <style>{`@keyframes spin { 0% { transform: rotateY(0deg); } 100% { transform: rotateY(360deg); } }`}</style>
          <div style={{ fontSize: 18, fontWeight: 'bold', color: '#1a2332', marginBottom: 8 }}>AI が見積もりを算出中...</div>
          <div style={{ fontSize: 14, color: '#666', marginBottom: 12 }}>
            {elapsed < 10 ? '画像を解析しています' :
             elapsed < 20 ? '建物の種類・規模を特定中' :
             elapsed < 32 ? '相場データベースと照合中' :
             elapsed < 44 ? '材料費・人件費を積算中' :
             elapsed < 56 ? '粗利率・追加提案を計算中' :
             'もう少しで完了します'}
          </div>
          {/* プログレスバー（目安60秒） */}
          <div style={{ width: 300, height: 6, background: '#eee', borderRadius: 3, margin: '0 auto 12px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3,
              background: 'linear-gradient(90deg, #3a7bd5, #27ae60)',
              width: `${Math.min(95, elapsed / 60 * 95)}%`,
              transition: 'width 1s ease',
            }} />
          </div>
          <div style={{ fontSize: 24, fontWeight: 'bold', color: '#3a7bd5' }}>
            {elapsed}秒
            <span style={{ fontSize: 13, fontWeight: 'normal', color: '#aaa', marginLeft: 8 }}>
              / 目安 {elapsed < 45 ? '約60秒' : elapsed < 60 ? '残り約' + (60 - elapsed) + '秒' : 'もうすぐ完了します…'}
            </span>
          </div>
        </div>
      )}

      {/* 解析結果 */}
      {result && (
        <div ref={resultRef} style={{ marginTop: 16 }}>

          {/* 自動登録完了バナー */}
          {autoCreated && (
            <div style={{
              background: 'linear-gradient(135deg, #27ae60, #2ecc71)', color: '#fff',
              padding: '14px 20px', borderRadius: 10, marginBottom: 16,
              boxShadow: '0 3px 12px rgba(39,174,96,0.3)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <strong>✅ 自動登録完了!</strong>
                  <span style={{ marginLeft: 12, fontSize: 13, opacity: 0.9 }}>
                    物件・施工・材料明細・請求書・発注書（下書き）をまとめて作成しました
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ fontSize: 12, background: 'rgba(255,255,255,0.2)', padding: '4px 12px', borderRadius: 6, cursor: 'pointer' }}
                    onClick={() => onNavigateToConstruction && autoCreated.constructionId && onNavigateToConstruction(autoCreated.constructionId)}>
                    👉 見積詳細を見る
                  </div>
                  <div style={{ fontSize: 12, background: 'rgba(255,255,255,0.35)', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}
                    onClick={() => {
                      if (onNavigateToConstruction && autoCreated.constructionId) {
                        // purchase-ordersページへの遷移は親から制御
                      }
                      alert('発注書ページで業者名・納期を記入してPDF出力できます。');
                    }}>
                    📝 発注書を確認
                  </div>
                </div>
              </div>
            </div>
          )}

          {creating && (
            <div style={{ background: '#fff8e1', padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#e67e22' }}>
              ⏳ 物件・施工・請求書を自動登録中...
            </div>
          )}

          {/* ヘッダー */}
          <div className="card" style={{ background: 'linear-gradient(135deg, #1a2332, #2c3e50)', color: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 4 }}>AI 判定</div>
                <div
                  style={{ fontSize: 24, fontWeight: 'bold', cursor: autoCreated ? 'pointer' : 'default', textDecoration: autoCreated ? 'underline' : 'none' }}
                  onClick={() => autoCreated && onNavigateToConstruction && onNavigateToConstruction(autoCreated.constructionId)}
                >{result.workType}</div>
                <div style={{ fontSize: 14, marginTop: 8, opacity: 0.9 }}>{result.description}</div>
                <div style={{ fontSize: 13, marginTop: 4, opacity: 0.7 }}>推定規模: {result.estimatedScale}</div>
                {(result.estimatedDuration || result.totalManDays) && (
                  <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                    {result.estimatedDuration && (
                      <span style={{ background: '#e8f0fe', color: '#1a73e8', padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 'bold' }}>
                        工期: {result.estimatedDuration}
                      </span>
                    )}
                    {result.totalManDays && (
                      <span style={{ background: '#fef3e0', color: '#e67e22', padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 'bold' }}>
                        総工数: {result.totalManDays}人工
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{
                  background: confidenceColor[result.confidence] || '#888',
                  padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 'bold',
                }}>
                  信頼度: {result.confidence}
                </span>
                {result.similarWork && (
                  <div style={{ fontSize: 12, marginTop: 8, opacity: 0.8 }}>
                    類似実績: {result.similarWork}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* AIが前提にした面積 → その場で直して再計算（全自動が基本、気になる時だけ1箇所直す） */}
          {result.assumedArea && (
            <div className="card" style={{ marginTop: 12, background: '#fffbea', border: '1px solid #f0d98a', padding: '12px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#8a6d00', marginBottom: 6 }}>
                📐 AIが前提にした面積・数量{result.confidence === '低' ? '（写真からの推定です。実測と違えば直して再計算してください）' : ''}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={reArea}
                  onChange={e => setReArea(e.target.value)}
                  placeholder="例: 屋根 450㎡"
                  style={{ flex: '1 1 220px', minWidth: 180, padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }}
                />
                <button className="btn btn-primary" disabled={analyzing || !reArea.trim()} onClick={() => analyze(reArea)} style={{ whiteSpace: 'nowrap' }}>
                  {analyzing ? '🔄 再計算中...' : '🔄 この面積で再計算'}
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>実測値を入れて再計算すると、信頼度が上がり金額が正確になります。合っていればそのままでOKです。</div>
            </div>
          )}

          {/* お見積金額（編集可能） */}
          <div style={{ marginTop: 16 }}>
            <div className="card" style={{ background: '#f0fff4', border: '3px solid #27ae60', padding: '20px 24px' }}>
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 14, color: '#888', marginBottom: 4 }}>お見積金額（税抜・利益込）</div>
                <div style={{ fontSize: 36, fontWeight: 'bold', color: '#27ae60' }}>{fmt(result.estimatedTotal)}</div>
                {/* 消費税10%。端数は円未満切り捨て（請求書の慣行に合わせる） */}
                <div style={{ fontSize: 15, color: '#15803d', marginTop: 4 }}>
                  税込 <strong style={{ fontSize: 20 }}>{fmt(Math.floor((Number(result.estimatedTotal) || 0) * (1 + TAX_RATE)))}</strong>
                  <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>
                    （消費税 {fmt(Math.floor((Number(result.estimatedTotal) || 0) * TAX_RATE))}）
                  </span>
                </div>
              </div>
              {/* 材料費 + 人件費 + 経費 + 粗利 = 売上金額。原価を編集すると粗利が自動で追従する */}
              {(() => {
                const mat = Number(result.estimatedMaterialCost) || 0;
                const labor = Number(result.estimatedLaborCost) || 0;
                const exp = Number(result.estimatedExpenseCost) || 0;
                const total = Number(result.estimatedTotal) || 0;
                const profit = total - (mat + labor + exp);
                const rate = total > 0 ? Math.round((profit / total) * 1000) / 10 : 0;
                const tile = { background: '#fff', borderRadius: 8, padding: 10, border: '1px solid #bbf7d0' };
                const num = { width: '100%', padding: 6, fontSize: 15, fontWeight: 'bold', border: '1px solid #d1d5db', borderRadius: 6, textAlign: 'right' as const };
                return (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                      <div style={tile}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>材料費（原価）</div>
                        <NumInput value={mat} onValue={n => setResult({ ...result, estimatedMaterialCost: n })} style={num} />
                      </div>
                      <div style={tile}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>人件費（原価）</div>
                        <NumInput value={labor} onValue={n => setResult({ ...result, estimatedLaborCost: n })} style={num} />
                      </div>
                      <div style={tile}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>経費（仮設・現場管理・福利厚生）</div>
                        <NumInput value={exp} onValue={n => setResult({ ...result, estimatedExpenseCost: n })} style={num} />
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                      <div style={{ ...tile, background: profit < 0 ? '#fef2f2' : '#f0fdf4', border: `1px solid ${profit < 0 ? '#fecaca' : '#86efac'}` }}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>粗利（{rate}%）</div>
                        <div style={{ padding: 6, fontSize: 15, fontWeight: 'bold', textAlign: 'right', color: profit < 0 ? '#dc2626' : '#15803d' }}>
                          {fmt(profit)}
                        </div>
                      </div>
                      <div style={tile}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>売上金額（税抜）</div>
                        <NumInput value={total} onValue={n => setResult({ ...result, estimatedTotal: n })} style={num} />
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, textAlign: 'right' }}>
                          税込 {fmt(Math.floor(total * (1 + TAX_RATE)))}
                        </div>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: profit < 0 ? '#dc2626' : '#64748b', marginTop: 8, textAlign: 'center' }}>
                      材料費 {fmt(mat)} ＋ 人件費 {fmt(labor)} ＋ 経費 {fmt(exp)} ＋ 粗利 {fmt(profit)} ＝ 売上金額 {fmt(total)}（税込 {fmt(Math.floor(total * (1 + TAX_RATE)))}）
                      {profit < 0 && '　※原価が売上を超えています。金額を見直してください'}
                    </div>
                  </>
                );
              })()}
              {autoCreated && (
                <button className="btn btn-primary btn-sm" style={{ marginTop: 10, width: '100%' }} onClick={async () => {
                  try {
                    if (autoCreated.constructionId) {
                      // 各明細=粗利込みの最終価格。総額=内訳合計（掛率1・値引き行なし）。
                      // お見積金額を編集した場合は、各明細を比例配分して総額に合わせる。
                      const mats = await (window as any).api.listConstructionMaterials(autoCreated.constructionId);
                      const currentTotal = mats.reduce((s: number, m: any) => s + m.quantity * m.unit_price, 0);
                      const newTotal = result.estimatedTotal || currentTotal;
                      if (currentTotal > 0 && newTotal > 0 && Math.abs(newTotal - currentTotal) >= 1) {
                        const ratio = newTotal / currentTotal;
                        for (const m of mats) {
                          await (window as any).api.updateConstructionMaterial({
                            id: m.id, materialId: m.material_id, name: m.material_name,
                            quantity: m.quantity, unit: m.unit || '式',
                            unitPrice: Math.round(m.unit_price * ratio),
                          });
                        }
                      }
                      await (window as any).api.updateConstruction({
                        id: autoCreated.constructionId,
                        propertyId: autoCreated.propertyId,
                        title: result.workType || '工事',
                        constructionDate: new Date().toISOString().split('T')[0],
                        laborCost: 0,
                        markupRate: 1,
                        notes: '',
                        status: '見積中',
                      });
                    }
                    alert('金額を更新しました。AIの学習に反映されます。');
                  } catch (e: any) {
                    alert('更新に失敗しました: ' + (e.message || e));
                  }
                }}>修正を保存してAI学習に反映</button>
              )}
              <div style={{ fontSize: 11, color: '#888', marginTop: 6, textAlign: 'center' }}>
                金額を修正するとAIの学習精度が向上します{!autoCreated ? '（一括登録後に保存できます）' : ''}
              </div>
            </div>
          </div>

          {/* 内訳 */}
          {result.breakdown && result.breakdown.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>費用内訳</h3>
                <span style={{ fontSize: 11, color: '#888' }}>金額は直接修正できます（合計に自動反映）</span>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>項目</th>
                    <th style={{ textAlign: 'right' }}>概算金額</th>
                    <th>備考</th>
                    <th style={{ textAlign: 'center', width: 80 }}>発注書</th>
                  </tr>
                </thead>
                <tbody>
                  {result.breakdown.map((b: any, i: number) => (
                    <tr key={i}>
                      <td>{b.item}</td>
                      <td style={{ textAlign: 'right' }}>
                        <NumInput
                          value={b.cost || 0}
                          onValue={n => {
                            const next = [...result.breakdown];
                            next[i] = { ...next[i], cost: n };
                            // 内訳は粗利込みの最終提示額なので、合計＝内訳の総和にそろえる
                            const sum = next.reduce((s: number, r: any) => s + (Number(r.cost) || 0), 0);
                            setResult({ ...result, breakdown: next, estimatedTotal: sum });
                          }}
                          style={{
                            width: 130, padding: '6px 8px', textAlign: 'right', fontWeight: 'bold',
                            border: '1px solid #ddd', borderRadius: 6, fontSize: 14, fontFamily: 'inherit',
                          }}
                        />
                      </td>
                      <td style={{ color: '#888', fontSize: 12 }}>{b.note}</td>
                      <td style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          title="この項目で発注書PDFを出力"
                          onClick={async () => {
                            const today = new Date().toISOString().split('T')[0];
                            const po = {
                              id: 0,
                              vendor_name: '',
                              vendor_address: '',
                              issue_date: today,
                              delivery_date: '',
                              tax_rate: 0.1,
                              notes: '',
                              construction_title: result.workType || '',
                            };
                            const items = [{ name: b.item, quantity: 1, unit: '式', unit_price: b.cost || 0 }];
                            try {
                              await (window as any).api.generatePurchaseOrderPDF({ po, items });
                            } catch (e: any) {
                              alert('PDF生成に失敗: ' + (e.message || e));
                            }
                          }}
                          style={{
                            fontSize: 11, color: '#3498db', fontWeight: 'bold', cursor: 'pointer',
                            background: 'none', border: 'none', padding: '4px 6px',
                          }}
                        >📄 出力</button>
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background: '#f8f9fa' }}>
                    <td style={{ fontWeight: 'bold' }}>合計（内訳の総和）</td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold', paddingRight: 8 }}>
                      {fmt(result.breakdown.reduce((s: number, r: any) => s + (Number(r.cost) || 0), 0))}
                    </td>
                    <td colSpan={2} style={{ color: '#888', fontSize: 11 }}>
                      上の「合計」欄と連動します
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* 人工内訳 */}
          {result.manDaysBreakdown && result.manDaysBreakdown.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>工数内訳</h3>
                <span style={{ fontSize: 11, color: '#888' }}>人数・日数・日額は直接修正できます（人工と小計は自動計算）</span>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>職種</th>
                    <th style={{ textAlign: 'center' }}>人数</th>
                    <th style={{ textAlign: 'center' }}>日数</th>
                    <th style={{ textAlign: 'center' }}>人工</th>
                    <th style={{ textAlign: 'right' }}>日額</th>
                    <th style={{ textAlign: 'right' }}>小計</th>
                    <th style={{ textAlign: 'center', width: 80 }}>発注書</th>
                  </tr>
                </thead>
                <tbody>
                  {result.manDaysBreakdown.map((m: any, i: number) => {
                    const tradeName = (m.trade || '').replace(/[（(].*?レベル.*?[）)]/g, '').trim();
                    const subtotal = (Number(m.manDays) || 0) * (Number(m.dailyRate) || 0);
                    // 人数・日数を直すと人工(manDays)を再計算し、合計人工も揃える
                    const patchRow = (patch: any) => {
                      const next = [...result.manDaysBreakdown];
                      const row = { ...next[i], ...patch };
                      if ('workers' in patch || 'days' in patch) {
                        row.manDays = (Number(row.workers) || 0) * (Number(row.days) || 0);
                      }
                      next[i] = row;
                      const totalManDays = next.reduce((s: number, r: any) => s + (Number(r.manDays) || 0), 0);
                      setResult({ ...result, manDaysBreakdown: next, totalManDays });
                    };
                    const numStyle = {
                      width: 70, padding: '5px 6px', textAlign: 'center' as const,
                      border: '1px solid #ddd', borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
                    };
                    return (
                    <tr key={i}>
                      <td>
                        {tradeName}
                        {m.basis && <div style={{ fontSize: 11, color: '#888', fontWeight: 'normal', marginTop: 3, lineHeight: 1.5 }}>根拠: {m.basis}</div>}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <NumInput min={0} value={Number(m.workers) || 0}
                          onValue={n => patchRow({ workers: n })}
                          style={numStyle} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <NumInput min={0} value={Number(m.days) || 0}
                          onValue={n => patchRow({ days: n })}
                          style={numStyle} />
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{Number(m.manDays) || 0}</td>
                      <td style={{ textAlign: 'right' }}>
                        <NumInput min={0} value={Number(m.dailyRate) || 0}
                          onValue={n => patchRow({ dailyRate: n })}
                          style={{ ...numStyle, width: 100, textAlign: 'right' }} />
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{fmt(subtotal)}</td>
                      <td style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          title="この職種で発注書PDFを出力"
                          onClick={async () => {
                            const today = new Date().toISOString().split('T')[0];
                            const po = {
                              id: 0,
                              vendor_name: '',
                              vendor_address: '',
                              issue_date: today,
                              delivery_date: '',
                              tax_rate: 0.1,
                              notes: '',
                              construction_title: result.workType || '',
                            };
                            const items = [{ name: `${tradeName} ${m.workers}人×${m.days}日`, quantity: m.manDays, unit: '人工', unit_price: m.dailyRate || 0 }];
                            try {
                              await (window as any).api.generatePurchaseOrderPDF({ po, items });
                            } catch (e: any) {
                              alert('PDF生成に失敗: ' + (e.message || e));
                            }
                          }}
                          style={{
                            fontSize: 11, color: '#3498db', fontWeight: 'bold', cursor: 'pointer',
                            background: 'none', border: 'none', padding: '4px 6px',
                          }}
                        >📄 出力</button>
                      </td>
                    </tr>
                    );
                  })}
                  <tr style={{ borderTop: '2px solid #333', fontWeight: 'bold' }}>
                    <td>合計</td>
                    <td></td>
                    <td></td>
                    <td style={{ textAlign: 'center' }}>
                      {result.manDaysBreakdown.reduce((s: number, m: any) => s + (Number(m.manDays) || 0), 0)}人工
                    </td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}>
                      {fmt(result.manDaysBreakdown.reduce((s: number, m: any) => s + (Number(m.manDays) || 0) * (Number(m.dailyRate) || 0), 0))}
                    </td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: '#888', marginTop: 8, lineHeight: 1.6 }}>
                施工費 ＝ 各職種の（人工 × 日額）の合計。各行の「根拠」は 数量 ÷ 歩掛（1人が1日にこなす標準作業量）で日数を算出しています。数字の妥当性はここで検算できます。
              </div>
            </div>
          )}

          {/* 入力したコメント表示 */}
          {comment && (
            <div className="card" style={{ marginTop: 16, background: '#f0f4ff', border: '1px solid #b8d0ff' }}>
              <h3 style={{ marginBottom: 8 }}>📝 入力した工事内容</h3>
              <p style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{comment}</p>
            </div>
          )}

          {/* 葺き師への施工指示（遮熱シート工事のみ・現場用の指令ブロック） */}
          {result.installInstruction && (
            <div className="card" style={{ marginTop: 16, background: '#eef6ff', border: '2px solid #3a7bd5' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                <h3 style={{ margin: 0 }}>🧰 葺き師への施工指示（現場用）</h3>
                <button
                  className="btn"
                  style={{ fontSize: 12, padding: '4px 12px' }}
                  onClick={() => { try { navigator.clipboard?.writeText(String(result.installInstruction || '')); } catch (_) {} }}
                >📋 コピー</button>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap', background: '#fff', borderRadius: 8, padding: '12px 14px', border: '1px solid #cfe0ef', color: '#1e293b' }}>
                {result.installInstruction}
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>そのまま現場の職人へ共有できます（施工案件の備考にも自動で入ります）。</div>
            </div>
          )}

          {/* 提案 */}
          {result.recommendations && (
            <div className="card" style={{ marginTop: 16, background: '#fffbf0', border: '1px solid #f0d060' }}>
              <h3 style={{ marginBottom: 8 }}>💡 提案・注意点</h3>
              <p style={{ fontSize: 14, lineHeight: 1.7 }}>{result.recommendations}</p>
            </div>
          )}

          {/* 再解析・チャット相談 */}
          <div className="card" style={{ marginTop: 16, textAlign: 'center', background: '#f8f9fa' }}>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>内容を修正して再解析、またはチャットで詳細を相談できます</p>
            <div style={{ marginBottom: 8 }}>
              <input
                type="text"
                value={location}
                onChange={e => setLocation(e.target.value)}
                placeholder="📍 場所（現場住所・物件名）"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8, fontSize: 13 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'flex-end' }}>
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="追加の工事内容や修正点を入力..."
                style={{ flex: 1, minHeight: 60, padding: 10, border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, resize: 'vertical', color: '#1e293b', background: '#fff', WebkitUserSelect: 'text', userSelect: 'text' }}
              />
              <button className="btn btn-primary" onClick={() => analyze()} disabled={analyzing} style={{ height: 60 }}>
                {analyzing ? '解析中...' : '🔄 再解析'}
              </button>
              <button className="btn" onClick={() => {
                const r = result;
                setChatMessages([
                  { role: 'assistant', content: `先ほどの見積結果を確認しました。\n\n工事種別: ${r.workType}\n売価: ¥${Math.round(r.estimatedTotal||0).toLocaleString()}\n材料費: ¥${Math.round(r.estimatedMaterialCost||0).toLocaleString()}\n人件費: ¥${Math.round(r.estimatedLaborCost||0).toLocaleString()}\n${r.breakdown ? '内訳:\n' + r.breakdown.map((b:any)=>`  ${b.item}: ¥${Math.round(b.cost||0).toLocaleString()}`).join('\n') : ''}\n\nこの見積について、何でもご質問ください。\n例：「材料をもっと安いものに変えたい」「工期を短くしたい」「追加で○○もやりたい」` },
                ]);
                setChatEstimate(null);
                setChatSessionId(null);
                setResult(null);
                setMode('chat');
                // 入力欄にフォーカスを繰り返しかける
                const focusInterval = setInterval(() => {
                  if (chatInputRef.current) {
                    chatInputRef.current.focus();
                    chatInputRef.current.click();
                    clearInterval(focusInterval);
                  }
                }, 100);
                setTimeout(() => clearInterval(focusInterval), 3000);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }} style={{ height: 60, background: '#8e44ad', color: '#fff', border: 'none', borderRadius: 8, padding: '0 16px', cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>
                💬 チャットで相談
              </button>
            </div>
          </div>

          {/* 完成イメージ生成 */}
          <div className="card" style={{ marginTop: 16 }}>
            <h3 style={{ marginBottom: 12 }}>🎨 完成イメージを生成</h3>
            {!generatedImage ? (
              <div style={{ textAlign: 'center' }}>
                <p style={{ color: '#888', marginBottom: 12, fontSize: 13 }}>
                  AI がこの工事の完成イメージを生成します
                </p>
                <button className="btn btn-primary" onClick={generateImage} disabled={generating} style={{ fontSize: 16, padding: '12px 32px' }}>
                  {generating ? `🔄 画像を生成中... ${genElapsed}秒` : '🎨 完成イメージを生成'}
                </button>
              </div>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <img src={generatedImage} style={{ maxWidth: '100%', maxHeight: 500, borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }} alt="generated" />
                <div style={{ marginTop: 12 }}>
                  <button className="btn btn-secondary" onClick={generateImage} disabled={generating}>
                    {generating ? `🔄 再生成中... ${genElapsed}秒` : '🔄 別のイメージを生成'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 請求書セクション */}
          {invoiceLoading && (
            <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: 20, color: '#888' }}>
              ⏳ 請求書を読み込み中...
            </div>
          )}
          {logInvoice && logInvoice.invoice && (
            <div className="card" style={{ marginTop: 16, border: '2px solid #27ae60' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>💰 請求書</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 12, fontWeight: 'bold',
                    background: logInvoice.invoice.status === 'paid' ? '#e8fdf0' : logInvoice.invoice.status === 'sent' ? '#e8f4fd' : logInvoice.invoice.status === 'overdue' ? '#fde8e8' : '#f0f0f0',
                    color: logInvoice.invoice.status === 'paid' ? '#27ae60' : logInvoice.invoice.status === 'sent' ? '#3498db' : logInvoice.invoice.status === 'overdue' ? '#e74c3c' : '#999',
                  }}>
                    {logInvoice.invoice.status === 'draft' ? '下書き' : logInvoice.invoice.status === 'sent' ? '送付済' : logInvoice.invoice.status === 'paid' ? '入金済' : '期限超過'}
                  </span>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      try {
                        await (window as any).api.generatePDF({ invoice: logInvoice.invoice, materials: logInvoice.materials });
                      } catch (e: any) {
                        alert('PDF生成に失敗: ' + (e.message || e));
                      }
                    }}
                    style={{ fontSize: 12, padding: '6px 16px', background: '#27ae60' }}
                  >
                    📄 請求書PDF出力
                  </button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13, marginBottom: 12 }}>
                <div><span style={{ color: '#888' }}>請求先:</span> {logInvoice.invoice.client_name || '（未設定）'}</div>
                <div><span style={{ color: '#888' }}>発行日:</span> {logInvoice.invoice.issue_date || '—'}</div>
                <div><span style={{ color: '#888' }}>施工:</span> {logInvoice.invoice.construction_title || '—'}</div>
                <div><span style={{ color: '#888' }}>支払期限:</span> {logInvoice.invoice.due_date || '—'}</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 16, fontWeight: 'bold', color: '#27ae60' }}>
                請求金額: {fmt(logInvoice.invoice.amount || 0)}
                <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>
                  (税込 {fmt(Math.round((logInvoice.invoice.amount || 0) * (1 + (logInvoice.invoice.tax_rate || 0.1))))})
                </span>
              </div>
            </div>
          )}
          {!logInvoice && !invoiceLoading && selectedLog && estimateLog.find(l => l.id === selectedLog)?.constructionId && (
            <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: 16, background: '#f8f9fa' }}>
              <p style={{ color: '#888', fontSize: 13, marginBottom: 8 }}>この見積に紐づく請求書がありません</p>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const log = estimateLog.find(l => l.id === selectedLog);
                  if (!log?.constructionId) return;
                  setInvoiceLoading(true);
                  try {
                    const today = new Date().toISOString().split('T')[0];
                    await (window as any).api.createInvoice({
                      constructionId: log.constructionId,
                      clientName: '',
                      issueDate: today,
                      amount: log.total || 0,
                      status: 'draft',
                    });
                    const inv = await (window as any).api.getInvoiceByConstruction(log.constructionId);
                    setLogInvoice(inv);
                  } catch (e: any) {
                    alert('請求書作成に失敗: ' + (e.message || e));
                  }
                  setInvoiceLoading(false);
                }}
                style={{ fontSize: 12, background: '#27ae60', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: 6, cursor: 'pointer' }}
              >
                💰 請求書を作成
              </button>
            </div>
          )}

          {/* 発注書セクション */}
          {poLoading && (
            <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: 20, color: '#888' }}>
              ⏳ 発注書を読み込み中...
            </div>
          )}
          {logPO && (
            <div className="card" style={{ marginTop: 16, border: '2px solid #3498db' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>📝 発注書</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 12, fontWeight: 'bold',
                    background: logPO.status === 'draft' ? '#f0f0f0' : logPO.status === 'sent' ? '#e8f4fd' : logPO.status === 'delivered' ? '#e8fdf0' : '#fde8e8',
                    color: logPO.status === 'draft' ? '#999' : logPO.status === 'sent' ? '#3498db' : logPO.status === 'delivered' ? '#27ae60' : '#e74c3c',
                  }}>
                    {logPO.status === 'draft' ? '下書き' : logPO.status === 'sent' ? '発注済' : logPO.status === 'delivered' ? '納品済' : 'キャンセル'}
                  </span>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      try {
                        await (window as any).api.generatePurchaseOrderPDF({ po: logPO, items: logPO.items });
                      } catch (e: any) {
                        alert('PDF生成に失敗: ' + (e.message || e));
                      }
                    }}
                    style={{ fontSize: 12, padding: '6px 16px' }}
                  >
                    📄 PDF出力
                  </button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13, marginBottom: 12 }}>
                <div><span style={{ color: '#888' }}>発注先:</span> {logPO.vendor_name || '（未設定）'}</div>
                <div><span style={{ color: '#888' }}>発行日:</span> {logPO.issue_date || '—'}</div>
                <div><span style={{ color: '#888' }}>施工:</span> {logPO.construction_title || '—'}</div>
                <div><span style={{ color: '#888' }}>納期:</span> {logPO.delivery_date || '—'}</div>
              </div>
              {logPO.items && logPO.items.length > 0 && (
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>品名</th>
                      <th style={{ textAlign: 'center' }}>数量</th>
                      <th style={{ textAlign: 'center' }}>単位</th>
                      <th style={{ textAlign: 'right' }}>単価</th>
                      <th style={{ textAlign: 'right' }}>小計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logPO.items.map((item: any) => (
                      <tr key={item.id}>
                        <td>{item.name}</td>
                        <td style={{ textAlign: 'center' }}>{item.quantity}</td>
                        <td style={{ textAlign: 'center' }}>{item.unit || '式'}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(item.unit_price || 0)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{fmt((item.quantity || 1) * (item.unit_price || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div style={{ textAlign: 'right', marginTop: 8, fontSize: 16, fontWeight: 'bold', color: '#3498db' }}>
                合計: {fmt(logPO.amount || 0)}
                <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>
                  (税込 {fmt(Math.round((logPO.amount || 0) * (1 + (logPO.tax_rate || 0.1))))})
                </span>
              </div>
            </div>
          )}
          {!logPO && !poLoading && selectedLog && estimateLog.find(l => l.id === selectedLog)?.constructionId && (
            <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: 16, background: '#f8f9fa' }}>
              <p style={{ color: '#888', fontSize: 13, marginBottom: 8 }}>この見積に紐づく発注書がありません</p>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  const log = estimateLog.find(l => l.id === selectedLog);
                  if (!log?.constructionId) return;
                  setPOLoading(true);
                  try {
                    await (window as any).api.createPOFromConstruction(log.constructionId);
                    const po = await (window as any).api.getPOByConstruction(log.constructionId);
                    setLogPO(po);
                  } catch (e: any) {
                    alert('発注書作成に失敗: ' + (e.message || e));
                  }
                  setPOLoading(false);
                }}
                style={{ fontSize: 12 }}
              >
                📝 発注書を作成
              </button>
            </div>
          )}

        </div>
      )}
      </div>

      {/* 見積ログ（右サイドバー） */}
      {estimateLog.length > 0 && (
        <div style={{ width: 240, flexShrink: 0 }}>
          <div style={{ position: 'sticky', top: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 8, color: '#555' }}>見積履歴</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {estimateLog.map((log) => (
                <div
                  key={log.id}
                  onClick={() => loadFromLog(log)}
                  style={{
                    padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    border: selectedLog === log.id ? '2px solid #3a7bd5' : '1px solid #ddd',
                    background: selectedLog === log.id ? '#f0f7ff' : '#fff',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { if (selectedLog !== log.id) e.currentTarget.style.background = '#f8f9fa'; }}
                  onMouseLeave={e => { if (selectedLog !== log.id) e.currentTarget.style.background = '#fff'; }}
                >
                  {(log.image || log.uploadedImage) && (
                    <img src={log.image || log.uploadedImage} style={{ width: '100%', height: 60, objectFit: 'cover', borderRadius: 6, marginBottom: 6 }} alt="" />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ fontSize: 11, color: '#888', flex: 1 }}>{log.date || ''} {log.time || ''}</div>
                    {log.source === 'chat_followup' && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#7c3aed', background: '#f3e8ff', borderRadius: 4, padding: '1px 5px' }} title="既存見積についての相談から作成された見積">💬 相談</span>
                    )}
                    {log.source === 'chat' && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#2563eb', background: '#dbeafe', borderRadius: 4, padding: '1px 5px' }} title="チャットで作成した見積">💬 チャット</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 'bold', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.uploadedImage ? '📷' : ''}{log.image ? '🖼' : ''} {log.workType}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                    <div style={{ fontSize: 14, fontWeight: 'bold', color: '#27ae60' }}>
                      {fmt(log.total)}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm('この見積履歴を削除しますか？')) {
                          (window as any).api.deleteEstimateLog?.(log.id).then(() => {
                            setEstimateLog(prev => prev.filter(l => l.id !== log.id));
                            if (selectedLog === log.id) {
                              setSelectedLog(null);
                              setResult(null);
                              setGeneratedImage(null);
                            }
                          });
                        }
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: '#ccc', fontSize: 14, padding: '2px 4px', borderRadius: 4,
                      }}
                      onMouseEnter={e => e.currentTarget.style.color = '#e74c3c'}
                      onMouseLeave={e => e.currentTarget.style.color = '#ccc'}
                      title="削除"
                    >
                      x
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
