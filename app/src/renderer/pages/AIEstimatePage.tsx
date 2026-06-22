import React, { useState, useEffect, useRef } from 'react';
import { PageGuide } from '../components/PageGuide';

export default function AIEstimatePage({ onNavigateToConstruction }: { onNavigateToConstruction?: (id: number) => void }) {
  const [imageData, setImageData] = useState<string | null>(null);
  const [beforeImage, setBeforeImage] = useState<string | null>(null);
  const [afterImage, setAfterImage] = useState<string | null>(null);
  const [mode, setMode] = useState<'single' | 'beforeafter' | 'chat'>('single');
  const [location, setLocation] = useState('');
  const [comment, setComment] = useState('');
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
          };
        }));
      }
    }).catch(() => {});
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

  const canAnalyze = mode === 'single'
    ? (!!imageData || comment.trim().length > 0)
    : (!!beforeImage && !!afterImage) || comment.trim().length > 0;

  const analyze = async () => {
    if (!canAnalyze) return;
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
      const payload = mode === 'beforeafter'
        ? { imageBase64: null, beforeImage, afterImage, comment, location }
        : { imageBase64: imageData || null, comment, location };
      const res = await (window as any).api.analyzeImage(payload);
      setResult(res);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);

      // 確認後、物件・施工・請求書・発注書を自動作成
      if (confirm('見積もり結果から物件・施工・請求書・発注書（下書き）を自動作成しますか？')) {
        setCreating(true);
        try {
          const mainImage = mode === 'beforeafter' ? (afterImage || beforeImage) : imageData;
          const created = await (window as any).api.autoCreateFromEstimate({ result: res, imageBase64: mainImage, comment, location });
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
            return { id: l.id, time: l.created_at?.split(' ')[1]?.substring(0, 5) || '', date: l.created_at?.split(' ')[0] || '', workType: l.work_type || '不明', total: l.ai_total || 0, result: parsed, image: l.generated_image || null, uploadedImage: l.uploaded_image || null, constructionId: l.construction_id || null };
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
      const url = await (window as any).api.generateImage(
        sourceImg
          ? { prompt: result.imagePrompt, sourceImage: sourceImg }
          : result.imagePrompt
      );
      setGeneratedImage(url);
      // 施工写真として自動保存 + estimate_logにも保存
      if (url) {
        try {
          if (autoCreated?.constructionId) {
            await (window as any).api.addConstructionPhoto({
              constructionId: autoCreated.constructionId,
              photoData: url,
              label: 'after',
              notes: 'AI完成予想画像（自動保存）',
            });
          }
          const targetLogId = selectedLog || (estimateLog.length > 0 ? estimateLog[0].id : undefined);
          await (window as any).api.saveEstimateImage({
            logId: targetLogId,
            constructionId: autoCreated?.constructionId,
            imageData: url,
          });
        } catch (_) {}
        // ログ再読込
        try {
          const logs = await (window as any).api.getEstimateLog();
          if (logs) {
            setEstimateLog(logs.map((l: any) => {
              let parsed = null;
              try { parsed = JSON.parse(l.ai_json); } catch (_) {}
              return { id: l.id, time: l.created_at?.split(' ')[1]?.substring(0, 5) || '', date: l.created_at?.split(' ')[0] || '', workType: l.work_type || '不明', total: l.ai_total || 0, result: parsed, image: l.generated_image || null, uploadedImage: l.uploaded_image || null, constructionId: l.construction_id || null };
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
        <div className="card" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 200px)', minHeight: 400, background: '#e8ecf1', padding: 0, overflow: 'hidden' }}>
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
                        const created = await (window as any).api.autoCreateFromEstimate({ result: chatEstimate });
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
          <div style={{ borderTop: '2px solid #f0f0f0', padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'flex-end', background: '#fafafa' }}>
            <button onClick={async () => {
              const img = await window.api.selectImage();
              if (img) {
                setChatMessages(prev => [...prev, { role: 'user', content: '写真を添付しました', image: img }]);
                setChatLoading(true);
                setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
                try {
                  const res = await (window as any).api.aiChat({ messages: [...chatMessages, { role: 'user', content: 'この写真を見て見積もりしてください', image: img }] });
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
                    const res = await (window as any).api.aiChat({ messages: allMsgs });
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
              style={{
                border: '3px dashed #ccc', borderRadius: 12, padding: '60px 20px',
                cursor: 'pointer', color: '#aaa', transition: 'all 0.2s',
              }}
              onMouseOver={e => { (e.currentTarget as HTMLElement).style.borderColor = '#3a7bd5'; (e.currentTarget as HTMLElement).style.color = '#3a7bd5'; }}
              onMouseOut={e => { (e.currentTarget as HTMLElement).style.borderColor = '#ccc'; (e.currentTarget as HTMLElement).style.color = '#aaa'; }}
            >
              <div style={{ fontSize: 48, marginBottom: 12 }}>📷</div>
              <div style={{ fontSize: 18, fontWeight: 'bold' }}>写真・図面をアップロード</div>
              <div style={{ fontSize: 13, marginTop: 8, color: '#666' }}>現場写真 / 間取り図 / 平面図 / 設計図 / 立面図 OK</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>クリックして画像を選択（なくてもコメントだけで見積可能）</div>
            </div>
          ) : (
            <div>
              <img src={imageData} style={{ maxWidth: '100%', maxHeight: 350, borderRadius: 8, border: '1px solid #ddd' }} alt="uploaded" />
              <div style={{ marginTop: 12 }}>
                <button className="btn btn-secondary btn-sm" onClick={selectImage}>別の画像を選択</button>
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
                  style={{
                    border: '2px dashed #e74c3c', borderRadius: 8, padding: '40px 12px',
                    cursor: 'pointer', color: '#e74c3c', transition: 'all 0.2s', background: '#fef5f5',
                  }}
                >
                  <div style={{ fontSize: 32 }}>📷</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>施工前の写真を選択</div>
                </div>
              ) : (
                <div>
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
                  style={{
                    border: '2px dashed #27ae60', borderRadius: 8, padding: '40px 12px',
                    cursor: 'pointer', color: '#27ae60', transition: 'all 0.2s', background: '#f0fff4',
                  }}
                >
                  <div style={{ fontSize: 32 }}>📷</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>施工後の写真を選択</div>
                </div>
              ) : (
                <div>
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
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-primary" onClick={analyze} disabled={analyzing || !canAnalyze} style={{ fontSize: 16, padding: '12px 32px' }}>
              {analyzing ? '🔄 AI が解析中...' : '🤖 AI で見積もりを解析'}
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
            {elapsed < 5 ? '画像を解析しています' :
             elapsed < 10 ? '建物の種類・規模を特定中' :
             elapsed < 15 ? '相場データベースと照合中' :
             elapsed < 20 ? '材料費・人件費を積算中' :
             elapsed < 25 ? '粗利率を計算中' :
             'もう少しで完了します'}
          </div>
          {/* プログレスバー */}
          <div style={{ width: 300, height: 6, background: '#eee', borderRadius: 3, margin: '0 auto 12px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3,
              background: 'linear-gradient(90deg, #3a7bd5, #27ae60)',
              width: `${Math.min(95, elapsed * 3.5)}%`,
              transition: 'width 1s ease',
            }} />
          </div>
          <div style={{ fontSize: 24, fontWeight: 'bold', color: '#3a7bd5' }}>
            {elapsed}秒
            <span style={{ fontSize: 13, fontWeight: 'normal', color: '#aaa', marginLeft: 8 }}>
              / 目安 {elapsed < 15 ? '約25秒' : '残り約' + Math.max(1, 28 - elapsed) + '秒'}
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

          {/* お見積金額（編集可能） */}
          <div style={{ marginTop: 16 }}>
            <div className="card" style={{ background: '#f0fff4', border: '3px solid #27ae60', padding: '20px 24px' }}>
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 14, color: '#888', marginBottom: 4 }}>お見積金額（税抜・利益込）</div>
                <div style={{ fontSize: 36, fontWeight: 'bold', color: '#27ae60' }}>{fmt(result.estimatedTotal)}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div style={{ background: '#fff', borderRadius: 8, padding: 10, border: '1px solid #bbf7d0' }}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>材料費</div>
                  <input
                    type="number"
                    value={Math.round(result.estimatedMaterialCost || 0)}
                    onChange={e => {
                      const matCost = Number(e.target.value);
                      const laborCost = result.estimatedLaborCost || 0;
                      const totalCost = matCost + laborCost;
                      const markupRate = result.estimatedTotal && totalCost > 0 ? result.estimatedTotal / totalCost : 1.3;
                      setResult({ ...result, estimatedMaterialCost: matCost });
                    }}
                    style={{ width: '100%', padding: 6, fontSize: 15, fontWeight: 'bold', border: '1px solid #d1d5db', borderRadius: 6, textAlign: 'right' }}
                  />
                </div>
                <div style={{ background: '#fff', borderRadius: 8, padding: 10, border: '1px solid #bbf7d0' }}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>人件費</div>
                  <input
                    type="number"
                    value={Math.round(result.estimatedLaborCost || 0)}
                    onChange={e => {
                      const laborCost = Number(e.target.value);
                      setResult({ ...result, estimatedLaborCost: laborCost });
                    }}
                    style={{ width: '100%', padding: 6, fontSize: 15, fontWeight: 'bold', border: '1px solid #d1d5db', borderRadius: 6, textAlign: 'right' }}
                  />
                </div>
                <div style={{ background: '#fff', borderRadius: 8, padding: 10, border: '1px solid #bbf7d0' }}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>売上金額（税抜）</div>
                  <input
                    type="number"
                    value={Math.round(result.estimatedTotal || 0)}
                    onChange={e => setResult({ ...result, estimatedTotal: Number(e.target.value) })}
                    style={{ width: '100%', padding: 6, fontSize: 15, fontWeight: 'bold', border: '1px solid #d1d5db', borderRadius: 6, textAlign: 'right' }}
                  />
                </div>
              </div>
              {autoCreated && (
                <button className="btn btn-primary btn-sm" style={{ marginTop: 10, width: '100%' }} onClick={async () => {
                  try {
                    if (autoCreated.constructionId) {
                      const mats = await (window as any).api.listConstructionMaterials(autoCreated.constructionId);
                      const currentTotal = mats.reduce((s: number, m: any) => s + m.quantity * m.unit_price, 0);
                      if (currentTotal > 0 && result.estimatedMaterialCost) {
                        const ratio = result.estimatedMaterialCost / currentTotal;
                        for (const m of mats) {
                          await (window as any).api.updateConstructionMaterial({
                            id: m.id, materialId: m.material_id, name: m.material_name,
                            quantity: m.quantity, unit: m.unit || '式',
                            unitPrice: Math.round(m.unit_price * ratio),
                          });
                        }
                      }
                      const totalCost = (result.estimatedMaterialCost || 0) + (result.estimatedLaborCost || 0);
                      const markupRate = totalCost > 0 ? (result.estimatedTotal || 0) / totalCost : 1.3;
                      await (window as any).api.updateConstruction({
                        id: autoCreated.constructionId,
                        propertyId: autoCreated.propertyId,
                        title: result.workType || '工事',
                        constructionDate: new Date().toISOString().split('T')[0],
                        laborCost: result.estimatedLaborCost || 0,
                        markupRate: Math.round(markupRate * 100) / 100,
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
                <span style={{ fontSize: 11, color: '#888' }}>項目をクリック → 発注書PDF出力</span>
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
                    <tr key={i} style={{ cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f0f7ff'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}
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
                    >
                      <td>{b.item}</td>
                      <td style={{ textAlign: 'right' }}><strong>{fmt(b.cost)}</strong></td>
                      <td style={{ color: '#888', fontSize: 12 }}>{b.note}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ fontSize: 11, color: '#3498db', fontWeight: 'bold' }}>📄 出力</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 人工内訳 */}
          {result.manDaysBreakdown && result.manDaysBreakdown.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3 style={{ marginBottom: 12 }}>工数内訳</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>職種</th>
                    <th style={{ textAlign: 'center' }}>人数</th>
                    <th style={{ textAlign: 'center' }}>日数</th>
                    <th style={{ textAlign: 'center' }}>人工</th>
                    <th style={{ textAlign: 'right' }}>日額単価</th>
                    <th style={{ textAlign: 'right' }}>小計</th>
                  </tr>
                </thead>
                <tbody>
                  {result.manDaysBreakdown.map((m: any, i: number) => (
                    <tr key={i}>
                      <td>{m.trade}</td>
                      <td style={{ textAlign: 'center' }}>{m.workers}人</td>
                      <td style={{ textAlign: 'center' }}>{m.days}日</td>
                      <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{m.manDays}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(m.dailyRate)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{fmt(m.manDays * m.dailyRate)}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid #333', fontWeight: 'bold' }}>
                    <td>合計</td>
                    <td></td>
                    <td></td>
                    <td style={{ textAlign: 'center' }}>{result.totalManDays}人工</td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}>{fmt(result.manDaysBreakdown.reduce((s: number, m: any) => s + m.manDays * m.dailyRate, 0))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* 入力したコメント表示 */}
          {comment && (
            <div className="card" style={{ marginTop: 16, background: '#f0f4ff', border: '1px solid #b8d0ff' }}>
              <h3 style={{ marginBottom: 8 }}>📝 入力した工事内容</h3>
              <p style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{comment}</p>
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
              <button className="btn btn-primary" onClick={analyze} disabled={analyzing} style={{ height: 60 }}>
                {analyzing ? '解析中...' : '🔄 再解析'}
              </button>
              <button className="btn" onClick={() => {
                const r = result;
                setChatMessages([
                  { role: 'assistant', content: `先ほどの見積結果を確認しました。\n\n工事種別: ${r.workType}\n売価: ¥${Math.round(r.estimatedTotal||0).toLocaleString()}\n材料費: ¥${Math.round(r.estimatedMaterialCost||0).toLocaleString()}\n人件費: ¥${Math.round(r.estimatedLaborCost||0).toLocaleString()}\n${r.breakdown ? '内訳:\n' + r.breakdown.map((b:any)=>`  ${b.item}: ¥${Math.round(b.cost||0).toLocaleString()}`).join('\n') : ''}\n\nこの見積について、何でもご質問ください。\n例：「材料をもっと安いものに変えたい」「工期を短くしたい」「追加で○○もやりたい」` },
                ]);
                setChatEstimate(null);
                setResult(null);
                setMode('chat');
                setTimeout(() => chatInputRef.current?.focus(), 100);
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
                  <div style={{ fontSize: 11, color: '#888' }}>{log.date || ''} {log.time || ''}</div>
                  <div style={{ fontSize: 12, fontWeight: 'bold', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.uploadedImage ? '📷' : ''}{log.image ? '🖼' : ''} {log.workType}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 'bold', color: '#27ae60', marginTop: 2 }}>
                    {fmt(log.total)}
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
