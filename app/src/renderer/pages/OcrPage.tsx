import React, { useState, useEffect } from 'react';

// クリックで説明を表示するヘルプアイコン
function Help({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block', marginLeft: 4 }}>
      <span onClick={() => setOpen(!open)}
        style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 18, borderRadius: '50%', background: open ? '#3a7bd5' : '#e0e0e0',
          color: open ? '#fff' : '#888', fontSize: 11, fontWeight: 'bold', userSelect: 'none' }}>?</span>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }} />
          <div style={{ position: 'absolute', top: 24, left: -8, zIndex: 1000, background: '#1a2332', color: '#fff',
            padding: '10px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.6, width: 280, boxShadow: '0 4px 16px rgba(0,0,0,0.2)' }}>
            {text}
          </div>
        </>
      )}
    </span>
  );
}

// 初回ガイドポップアップ
function GuidePopup({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const steps = [
    {
      icon: '📄',
      title: 'STEP 1：書類を選ぶ',
      desc: 'メールで届いたPDF請求書や、紙の書類を撮った写真を選択します。',
      sub: 'PDF・写真どちらでもOK。手書きでも読み取れます。',
      color: '#3a7bd5',
    },
    {
      icon: '🤖',
      title: 'STEP 2：AIが自動で読み取り',
      desc: 'AIが書類の内容（宛先・金額・明細など）を自動で認識します。',
      sub: '税込金額は自動で税抜に変換。AIストック1回分を消費します。',
      color: '#e67e22',
    },
    {
      icon: '🔗',
      title: 'STEP 3：施工に紐づけて学習',
      desc: '過去のAI見積と紐づけると、見積精度がどんどん向上します。',
      sub: 'AI見積 vs 実際の請求額を比較 → 全ユーザーの精度UP！',
      color: '#27ae60',
    },
  ];
  const s = steps[step];

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: 460, overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}>
        {/* プログレスバー */}
        <div style={{ display: 'flex', gap: 4, padding: '16px 24px 0' }}>
          {steps.map((_, idx) => (
            <div key={idx} style={{ flex: 1, height: 4, borderRadius: 2, background: idx <= step ? s.color : '#e0e0e0', transition: 'background 0.3s' }} />
          ))}
        </div>

        {/* コンテンツ */}
        <div style={{ padding: '32px 32px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>{s.icon}</div>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: '#1a2332', marginBottom: 12 }}>{s.title}</div>
          <div style={{ fontSize: 15, color: '#333', lineHeight: 1.7, marginBottom: 8 }}>{s.desc}</div>
          <div style={{ fontSize: 13, color: '#888', lineHeight: 1.6 }}>{s.sub}</div>
        </div>

        {/* ボタン */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 24px 20px' }}>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#999', fontSize: 13, cursor: 'pointer', padding: '8px 12px' }}>
            スキップ
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button onClick={() => setStep(step - 1)}
                style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', fontSize: 14, cursor: 'pointer', color: '#666' }}>
                戻る
              </button>
            )}
            <button onClick={() => step < steps.length - 1 ? setStep(step + 1) : onClose()}
              style={{ padding: '10px 28px', borderRadius: 8, border: 'none', background: s.color, color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
              {step < steps.length - 1 ? '次へ' : 'はじめる'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function OcrPage() {
  const [images, setImages] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [imported, setImported] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [constructions, setConstructions] = useState<any[]>([]);
  const [linkMap, setLinkMap] = useState<Record<number, number | null>>({});
  const [commentMap, setCommentMap] = useState<Record<number, string>>({});
  const [ocrLogs, setOcrLogs] = useState<any[]>([]);
  const [logComments, setLogComments] = useState<Record<number, string>>({});
  const [showGuide, setShowGuide] = useState(() => {
    try { return !localStorage.getItem('ocr_guide_seen'); } catch { return true; }
  });

  const loadLogs = () => (window as any).api.listOcrLog().then((rows: any[]) => {
    setOcrLogs(rows || []);
    const init: Record<number, string> = {};
    (rows || []).forEach((r: any) => { init[r.id] = r.comment || ''; });
    setLogComments(init);
  });

  useEffect(() => {
    window.api.listConstructions().then(setConstructions);
    loadLogs();
  }, []);

  const saveLogComment = async (id: number) => {
    await (window as any).api.setOcrLogComment(id, logComments[id] || '');
    loadLogs();
  };
  const deleteLog = async (id: number) => {
    if (!window.confirm('この読み取り履歴を削除しますか？')) return;
    await (window as any).api.deleteOcrLog(id);
    loadLogs();
  };
  const openPdf = async (id: number) => {
    try { await (window as any).api.openOcrPdf(id); }
    catch (e: any) { setError(e.message || 'PDFを開けませんでした'); }
  };

  const closeGuide = () => {
    setShowGuide(false);
    try { localStorage.setItem('ocr_guide_seen', '1'); } catch {}
  };

  const addImage = async () => {
    const img = await window.api.selectImage();
    if (img) setImages(prev => [...prev, img]);
  };

  const addPdf = async () => {
    setPdfLoading(true);
    setError('');
    try {
      const pages = await (window as any).api.selectPdf();
      if (pages && pages.length > 0) {
        setImages(prev => [...prev, ...pages.map((p: any) => p.data)]);
      }
    } catch (e: any) {
      setError(`PDF読み取りエラー: ${e.message}`);
    }
    setPdfLoading(false);
  };

  const processAll = async () => {
    setProcessing(true);
    setError('');
    const newResults: any[] = [];
    for (let i = 0; i < images.length; i++) {
      try {
        const r = await (window as any).api.ocrInvoice(images[i]);
        newResults.push({ ...r, _imgIndex: i });
      } catch (e: any) {
        newResults.push({ _error: e.message, _imgIndex: i });
      }
    }
    setResults(newResults);
    setProcessing(false);
    loadLogs(); // 読み取った時点でログに残る
  };

  const importOne = async (index: number) => {
    const r = results[index];
    if (!r || r._error) return;
    try {
      const linkedId = linkMap[index] || null;
      await (window as any).api.importOcrResult({ ...r, _linkConstructionId: linkedId, _comment: commentMap[index] || '', _ocrLogId: r._ocrLogId });
      setImported(prev => new Set(prev).add(index));
      window.api.listConstructions().then(setConstructions);
      loadLogs();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const importAll = async () => {
    for (let i = 0; i < results.length; i++) {
      if (!results[i]._error && !imported.has(i)) await importOne(i);
    }
  };

  const fmt = (n: number | null) => n != null ? '¥' + Math.round(n).toLocaleString() : '-';

  return (
    <div>
      {showGuide && <GuidePopup onClose={closeGuide} />}

      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>紙の書類を電子化</h1>
        <button onClick={() => setShowGuide(true)}
          style={{ background: '#f0f7ff', border: '1px solid #d0e3f7', borderRadius: 8, padding: '6px 14px',
            fontSize: 13, color: '#3a7bd5', cursor: 'pointer', fontWeight: 'bold' }}>
          使い方を見る
        </button>
      </div>

      {/* アップロード */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>📄 見積書・請求書を取り込み</h3>
        <p style={{ color: '#888', fontSize: 13, marginBottom: 12 }}>
          PDF・写真の見積書・請求書をAIが自動で読み取り、システムに取り込みます。<br/>
          PDF・画像どちらでもOK。複数ページのPDFにも対応。手書きでもOK。
        </p>

        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <button className="btn btn-primary" onClick={addPdf} disabled={pdfLoading}
            style={{ fontSize: 15, padding: '10px 24px' }}>
            {pdfLoading ? '📄 PDF読み込み中...' : '📄 PDFを選択'}
          </button>
          <Help text="メールで届いた請求書PDFや、スキャンしたPDFファイルを選択します。AIが内容を自動で読み取ります。" />
          <button className="btn btn-secondary" onClick={addImage}
            style={{ fontSize: 15, padding: '10px 24px' }}>
            📸 写真を選択
          </button>
          <Help text="紙の書類をスマホで撮影した写真を選択します。手書きの見積書でも読み取れます。" />
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          {images.map((img, i) => (
            <div key={i} style={{ position: 'relative' }}>
              {img.startsWith('data:application/pdf') ? (
                <div style={{ width: 120, height: 160, borderRadius: 8, border: '1px solid #ddd', background: '#f8f9fa',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 40 }}>📄</span>
                  <span style={{ fontSize: 11, color: '#666', marginTop: 4 }}>PDF</span>
                </div>
              ) : (
                <img src={img} style={{ width: 120, height: 160, objectFit: 'cover', borderRadius: 8, border: '1px solid #ddd' }} />
              )}
              <button onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                style={{ position: 'absolute', top: -6, right: -6, background: '#e74c3c', color: '#fff', border: 'none', borderRadius: '50%', width: 20, height: 20, cursor: 'pointer', fontSize: 11 }}>×</button>
              <div style={{ textAlign: 'center', fontSize: 10, color: '#888' }}>{i + 1}枚目</div>
            </div>
          ))}
        </div>

        {images.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-primary" onClick={processAll} disabled={processing} style={{ fontSize: 16, padding: '12px 32px' }}>
              {processing ? `🔄 読み取り中...（${images.length}枚）` : `📖 ${images.length}枚をAIで読み取り`}
            </button>
            <Help text="AIが書類の内容（宛先・発行元・明細・金額など）を自動で認識します。AIストックを1消費します。" />
          </div>
        )}
      </div>

      {error && <div style={{ background: '#fdecea', color: '#c0392b', padding: '10px 16px', borderRadius: 8, marginTop: 12 }}>{error}</div>}

      {/* 読み取り結果 */}
      {results.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2>読み取り結果 ({results.filter(r => !r._error).length}/{results.length}件 成功)</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn btn-success" onClick={importAll} style={{ fontSize: 14, padding: '8px 24px' }}>
                ✅ 全件をシステムに取り込み
              </button>
              <Help text="読み取った全ての書類を一括でシステムに登録します。施工紐づけを選択している場合は学習データも送信されます。" />
            </div>
          </div>

          {results.map((r, i) => (
            <div key={i} className="card" style={{
              marginBottom: 12,
              borderLeft: r._error ? '4px solid #e74c3c' : imported.has(i) ? '4px solid #27ae60' : '4px solid #3a7bd5',
              opacity: imported.has(i) ? 0.7 : 1,
            }}>
              {r._error ? (
                <div style={{ color: '#c0392b' }}>❌ 読み取り失敗: {r._error}</div>
              ) : (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span className={`tag ${r.documentType === '請求書' ? 'tag-orange' : 'tag-blue'}`}
                        style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 'bold',
                          background: r.documentType === '請求書' ? '#fff3e0' : '#e3f2fd',
                          color: r.documentType === '請求書' ? '#e65100' : '#1976d2', cursor: 'default' }}>
                        {r.documentType || '書類'}
                      </span>
                      <Help text="AIが書類の種類を自動判別します。見積書・請求書・納品書などを識別します。" />
                      <strong style={{ marginLeft: 8, fontSize: 16 }}>{r.title || '（件名なし）'}</strong>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                        <div style={{ fontSize: 22, fontWeight: 'bold', color: '#1a2332' }}>{fmt(r.total)}</div>
                        <Help text="税込の合計金額です。システムに取り込む際は自動で税抜に変換されます。AI見積との比較は税抜同士で行われるため、正確な学習データになります。" />
                      </div>
                      <div style={{ fontSize: 11, color: '#888' }}>税抜 {fmt(r.subtotal)} + 税 {fmt(r.taxAmount)}</div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 13 }}>
                    <div>
                      <span style={{ color: '#888' }}>宛先:</span> {r.clientName || '-'}
                      <Help text="請求先のお客様名です。取り込み時に請求書の宛先として登録されます。" />
                    </div>
                    <div>
                      <span style={{ color: '#888' }}>発行元:</span> {r.issuerName || '-'}
                      <Help text="この書類を発行した会社です。仕入先・外注先として施工の備考に記録されます。" />
                    </div>
                    <div>
                      <span style={{ color: '#888' }}>発行日:</span> {r.issueDate || '-'}
                      <Help text="書類の発行日です。施工日・請求日として登録されます。" />
                    </div>
                  </div>

                  {r.items && r.items.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 'bold' }}>明細</span>
                        <Help text="AIが読み取った項目の一覧です。各項目は材料マスタに登録され、人件費・施工費・労務費は労務費として自動分類されます。" />
                      </div>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>項目 <Help text="材料名や作業名です。材料マスタに自動登録されます。" /></th>
                            <th>数量</th>
                            <th>単位</th>
                            <th style={{ textAlign: 'right' }}>単価 <Help text="1単位あたりの価格です。材料マスタの単価として登録されます。" /></th>
                            <th style={{ textAlign: 'right' }}>金額 <Help text="数量×単価の合計金額です。" /></th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.items.map((item: any, j: number) => (
                            <tr key={j}>
                              <td>{item.name}</td>
                              <td>{item.quantity || 1}</td>
                              <td>{item.unit || '式'}</td>
                              <td style={{ textAlign: 'right' }}>{fmt(item.unitPrice)}</td>
                              <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{fmt(item.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {r.notes && <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>備考: {r.notes}</div>}

                  {/* 施工紐付け選択 */}
                  {!imported.has(i) && (
                    <div style={{ marginTop: 16, padding: 12, background: '#f0f7ff', borderRadius: 8, border: '1px solid #d0e3f7' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 'bold', color: '#1976d2' }}>
                          🔗 既存の施工に紐づけて学習データにする
                        </span>
                        <Help text="過去にAI見積で作成した施工を選ぶと、AI見積の金額と今回の実際の請求金額を比較し、学習データとしてクラウドに送信します。これにより次回以降のAI見積の精度が向上します。紐づけない場合は新しい物件・施工として登録されます。" />
                      </div>
                      <select
                        value={linkMap[i] ?? ''}
                        onChange={e => setLinkMap(prev => ({ ...prev, [i]: e.target.value ? Number(e.target.value) : null }))}
                        style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13 }}
                      >
                        <option value="">新規作成（紐づけなし）</option>
                        {constructions.map(c => (
                          <option key={c.id} value={c.id}>
                            {c.title || c.property_name || `施工#${c.id}`}
                            {c.construction_date ? ` (${c.construction_date})` : ''}
                            {c.selling_price ? ` - AI見積: ¥${Math.round(c.selling_price).toLocaleString()}` : ''}
                          </option>
                        ))}
                      </select>
                      {linkMap[i] && (
                        <div style={{ marginTop: 8, padding: 8, background: '#e8f5e9', borderRadius: 6, fontSize: 12, color: '#2e7d32' }}>
                          ✅ 取り込むと以下が自動で行われます：<br/>
                          ・AI見積の金額と実際の請求額（税抜）を比較<br/>
                          ・差分データをクラウドに送信<br/>
                          ・全ユーザーの見積精度が向上
                        </div>
                      )}
                    </div>
                  )}

                  {/* コメント欄（学習メモ＝紐づけ） */}
                  {!imported.has(i) && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 'bold' }}>📝 コメント（学習メモ・任意）</span>
                        <Help text="この書類に対するメモ（工法・金額の根拠・特殊事情など）を書くと、次回以降のAI見積の学習に反映されます。後から「読み取り履歴」で編集もできます。" />
                      </div>
                      <textarea
                        value={commentMap[i] || ''}
                        onChange={e => setCommentMap(prev => ({ ...prev, [i]: e.target.value }))}
                        placeholder="例: 屋根カバー工法の遮熱シート。金額は足場込み。次回も同じ単価で。"
                        style={{ width: '100%', minHeight: 56, padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
                      />
                    </div>
                  )}

                  <div style={{ marginTop: 12 }}>
                    {imported.has(i) ? (
                      <span style={{ color: '#27ae60', fontWeight: 'bold' }}>
                        ✅ {linkMap[i] ? '実績紐付け+学習データ送信済み' : '取り込み済み'}
                      </span>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button className="btn btn-primary btn-sm" onClick={() => importOne(i)}>
                          {linkMap[i] ? '🔗 紐づけて取り込む（学習に反映）' : 'この書類を取り込む'}
                        </button>
                        <Help text={linkMap[i]
                          ? '施工に紐づけて取り込みます。AI見積と実績の差分が学習データとして送信され、今後の見積精度向上に貢献します。'
                          : '新しい物件・施工・請求書として登録します。紐づけなしの場合、学習データは送信されません。'} />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 過去の読み取り履歴（呼び出し＋コメント＝紐づけ） */}
      <div className="card" style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>🗂 読み取り履歴（過去のPDF・コメント）</h2>
          <button onClick={loadLogs} className="btn btn-secondary btn-sm">🔄 更新</button>
        </div>
        <p style={{ color: '#888', fontSize: 13, marginBottom: 12 }}>
          過去に読み取った書類の一覧です。コメントを書いて保存すると、AIの見積学習に反映されます（＝紐づけメモ）。
          この更新以降に読み取ったものはPDF本体も保存され、「PDFを開く」で見返せます。
        </p>
        {ocrLogs.length === 0 ? (
          <div style={{ color: '#aaa', fontSize: 13 }}>まだ読み取り履歴はありません。</div>
        ) : (
          ocrLogs.map(log => (
            <div key={log.id} style={{ borderTop: '1px solid #eee', padding: '12px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: 13 }}>
                  <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 'bold',
                    background: log.document_type === '請求書' ? '#fff3e0' : '#e3f2fd',
                    color: log.document_type === '請求書' ? '#e65100' : '#1976d2' }}>
                    {log.document_type || '書類'}
                  </span>
                  <strong style={{ marginLeft: 8 }}>{log.title || '（件名なし）'}</strong>
                  {log.issuer_name && <span style={{ color: '#888', marginLeft: 8 }}>{log.issuer_name}</span>}
                  {log.issue_date && <span style={{ color: '#888', marginLeft: 8 }}>{log.issue_date}</span>}
                  {log.total != null && <span style={{ marginLeft: 8, fontWeight: 'bold' }}>{fmt(log.total)}</span>}
                  {log.imported
                    ? <span style={{ marginLeft: 8, color: '#27ae60', fontSize: 11 }}>取込済</span>
                    : <span style={{ marginLeft: 8, color: '#e67e22', fontSize: 11 }}>未取込</span>}
                  <span style={{ marginLeft: 8, color: '#bbb', fontSize: 11 }}>{(log.created_at || '').slice(0, 16)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {log.has_pdf
                    ? <button className="btn btn-secondary btn-sm" onClick={() => openPdf(log.id)}>📄 PDFを開く</button>
                    : <span style={{ fontSize: 11, color: '#bbb', alignSelf: 'center' }}>※旧データ（PDFなし）</span>}
                  <button className="btn btn-sm" style={{ color: '#c0392b', border: '1px solid #f0c0c0', background: '#fff' }} onClick={() => deleteLog(log.id)}>削除</button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-start' }}>
                <textarea
                  value={logComments[log.id] || ''}
                  onChange={e => setLogComments(prev => ({ ...prev, [log.id]: e.target.value }))}
                  placeholder="この書類へのメモ（工法・金額の根拠・特殊事情など）を書くと学習に反映されます"
                  style={{ flex: 1, minHeight: 48, padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
                />
                <button className="btn btn-primary btn-sm" onClick={() => saveLogComment(log.id)} style={{ whiteSpace: 'nowrap' }}>💾 保存して学習</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
