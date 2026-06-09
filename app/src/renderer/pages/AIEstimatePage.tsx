import React, { useState, useEffect, useRef } from 'react';

export default function AIEstimatePage({ onNavigateToConstruction }: { onNavigateToConstruction?: (id: number) => void }) {
  const [imageData, setImageData] = useState<string | null>(null);
  const [beforeImage, setBeforeImage] = useState<string | null>(null);
  const [afterImage, setAfterImage] = useState<string | null>(null);
  const [mode, setMode] = useState<'single' | 'beforeafter'>('single');
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

      // 自動で物件・施工・請求書を作成
      setCreating(true);
      try {
        const mainImage = mode === 'beforeafter' ? (afterImage || beforeImage) : imageData;
        const created = await (window as any).api.autoCreateFromEstimate({ result: res, imageBase64: mainImage, comment, location });
        setAutoCreated(created);
        // 実際の売価でresultを更新
        if (created.sellingPrice) {
          res.estimatedTotal = created.sellingPrice;
          setResult({ ...res });
        }
      } catch (e: any) {
        console.error('auto create error:', e);
      }
      setCreating(false);
      // ログに追加（DBから再読込）
      try {
        const logs = await (window as any).api.getEstimateLog();
        if (logs && logs.length > 0) {
          setEstimateLog(logs.map((l: any) => {
            let parsed = null;
            try { parsed = JSON.parse(l.ai_json); } catch (_) {}
            return { id: l.id, time: l.created_at?.split(' ')[1]?.substring(0, 5) || '', date: l.created_at?.split(' ')[0] || '', workType: l.work_type || '不明', total: l.ai_total || 0, result: parsed, image: l.generated_image || null, uploadedImage: l.uploaded_image || null };
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
          await (window as any).api.saveEstimateImage({
            logId: selectedLog || undefined,
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
              return { id: l.id, time: l.created_at?.split(' ')[1]?.substring(0, 5) || '', date: l.created_at?.split(' ')[0] || '', workType: l.work_type || '不明', total: l.ai_total || 0, result: parsed, image: l.generated_image || null, uploadedImage: l.uploaded_image || null };
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

  const loadFromLog = (logItem: any) => {
    const r = logItem.result ? { ...logItem.result } : null;
    // ログの金額（実際の売価）で上書き
    if (r && logItem.total) r.estimatedTotal = logItem.total;
    setResult(r);
    setGeneratedImage(logItem.image || null);
    if (logItem.uploadedImage) setImageData(logItem.uploadedImage);
    setSelectedLog(logItem.id);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  };

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
      <div className="page-header">
        <h1>AI 見積もり</h1>
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
        </div>
      </div>

      {/* 画像アップロードエリア */}
      {mode === 'single' ? (
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
      )}

      {/* コメント欄 + 場所 + 解析ボタン */}
      {!result && (
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
              width: '100%', minHeight: 120, padding: 12, border: '1px solid #ddd',
              borderRadius: 8, fontSize: 14, lineHeight: 1.7, resize: 'vertical',
              fontFamily: 'inherit',
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
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              boxShadow: '0 3px 12px rgba(39,174,96,0.3)',
              cursor: 'pointer',
            }} onClick={() => onNavigateToConstruction && autoCreated.constructionId && onNavigateToConstruction(autoCreated.constructionId)}>
              <div>
                <strong>✅ 自動登録完了!</strong>
                <span style={{ marginLeft: 12, fontSize: 13, opacity: 0.9 }}>
                  物件・施工・材料明細・請求書（下書き）をまとめて作成しました
                </span>
              </div>
              <div style={{ fontSize: 12, background: 'rgba(255,255,255,0.2)', padding: '4px 12px', borderRadius: 6 }}>
                👉 見積詳細を見る
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

          {/* お見積金額 */}
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <div className="card" style={{ display: 'inline-block', padding: '24px 60px', background: '#f0fff4', border: '3px solid #27ae60' }}>
              <div style={{ fontSize: 14, color: '#888', marginBottom: 4 }}>お見積金額（税抜・利益込）</div>
              <div style={{ fontSize: 36, fontWeight: 'bold', color: '#27ae60' }}>{fmt(result.estimatedTotal)}</div>
            </div>
          </div>

          {/* 内訳 */}
          {result.breakdown && result.breakdown.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3 style={{ marginBottom: 12 }}>費用内訳</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>項目</th>
                    <th style={{ textAlign: 'right' }}>概算金額</th>
                    <th>備考</th>
                  </tr>
                </thead>
                <tbody>
                  {result.breakdown.map((b: any, i: number) => (
                    <tr key={i}>
                      <td>{b.item}</td>
                      <td style={{ textAlign: 'right' }}><strong>{fmt(b.cost)}</strong></td>
                      <td style={{ color: '#888', fontSize: 12 }}>{b.note}</td>
                    </tr>
                  ))}
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

          {/* 再解析ボタ�� */}
          <div className="card" style={{ marginTop: 16, textAlign: 'center', background: '#f8f9fa' }}>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>内容を修正して再解析できます</p>
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
                style={{ flex: 1, minHeight: 60, padding: 10, border: '1px solid #ddd', borderRadius: 8, fontSize: 13, resize: 'vertical' }}
              />
              <button className="btn btn-primary" onClick={analyze} disabled={analyzing} style={{ height: 60 }}>
                {analyzing ? '解析中...' : '🔄 再解析'}
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
