import React, { useState } from 'react';

export default function OcrPage() {
  const [images, setImages] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [imported, setImported] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');

  const addImage = async () => {
    const img = await window.api.selectImage();
    if (img) setImages(prev => [...prev, img]);
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
  };

  const importOne = async (index: number) => {
    const r = results[index];
    if (!r || r._error) return;
    try {
      await (window as any).api.importOcrResult(r);
      setImported(prev => new Set(prev).add(index));
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
      <div className="page-header">
        <h1>紙の書類を電子化</h1>
      </div>

      {/* アップロード */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>📸 見積書・請求書の写真をアップロード</h3>
        <p style={{ color: '#888', fontSize: 13, marginBottom: 12 }}>
          紙の見積書・請求書をスマホで撮影またはスキャンして、AIが内容を自動で読み取ります。<br/>
          複数枚まとめて処理できます。手書きでもOK。
        </p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          {images.map((img, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <img src={img} style={{ width: 120, height: 160, objectFit: 'cover', borderRadius: 8, border: '1px solid #ddd' }} />
              <button onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                style={{ position: 'absolute', top: -6, right: -6, background: '#e74c3c', color: '#fff', border: 'none', borderRadius: '50%', width: 20, height: 20, cursor: 'pointer', fontSize: 11 }}>×</button>
              <div style={{ textAlign: 'center', fontSize: 10, color: '#888' }}>{i + 1}枚目</div>
            </div>
          ))}
          <div onClick={addImage} style={{
            width: 120, height: 160, border: '2px dashed #ccc', borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            color: '#aaa', fontSize: 32, transition: 'all 0.2s',
          }}
            onMouseOver={e => (e.currentTarget.style.borderColor = '#3a7bd5')}
            onMouseOut={e => (e.currentTarget.style.borderColor = '#ccc')}
          >+</div>
        </div>

        {images.length > 0 && (
          <button className="btn btn-primary" onClick={processAll} disabled={processing} style={{ fontSize: 16, padding: '12px 32px' }}>
            {processing ? `🔄 読み取り中...（${images.length}枚）` : `📖 ${images.length}枚をAIで読み取り`}
          </button>
        )}
      </div>

      {error && <div style={{ background: '#fdecea', color: '#c0392b', padding: '10px 16px', borderRadius: 8, marginTop: 12 }}>{error}</div>}

      {/* 読み取り結果 */}
      {results.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2>読み取り結果 ({results.filter(r => !r._error).length}/{results.length}件 成功)</h2>
            <button className="btn btn-success" onClick={importAll} style={{ fontSize: 14, padding: '8px 24px' }}>
              ✅ 全件をシステムに取り込み
            </button>
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
                          color: r.documentType === '請求書' ? '#e65100' : '#1976d2' }}>
                        {r.documentType || '書類'}
                      </span>
                      <strong style={{ marginLeft: 8, fontSize: 16 }}>{r.title || '（件名なし）'}</strong>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 22, fontWeight: 'bold', color: '#1a2332' }}>{fmt(r.total)}</div>
                      <div style={{ fontSize: 11, color: '#888' }}>税抜 {fmt(r.subtotal)} + 税 {fmt(r.taxAmount)}</div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 13 }}>
                    <div><span style={{ color: '#888' }}>宛先:</span> {r.clientName || '-'}</div>
                    <div><span style={{ color: '#888' }}>発行元:</span> {r.issuerName || '-'}</div>
                    <div><span style={{ color: '#888' }}>発行日:</span> {r.issueDate || '-'}</div>
                  </div>

                  {r.items && r.items.length > 0 && (
                    <table className="data-table" style={{ marginTop: 12 }}>
                      <thead>
                        <tr><th>項目</th><th>数量</th><th>単位</th><th style={{ textAlign: 'right' }}>単価</th><th style={{ textAlign: 'right' }}>金額</th></tr>
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
                  )}

                  {r.notes && <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>備考: {r.notes}</div>}

                  <div style={{ marginTop: 12 }}>
                    {imported.has(i) ? (
                      <span style={{ color: '#27ae60', fontWeight: 'bold' }}>✅ 取り込み済み</span>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={() => importOne(i)}>この書類を取り込む</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
