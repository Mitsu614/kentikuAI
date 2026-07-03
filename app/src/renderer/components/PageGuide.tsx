import React, { useState, useEffect } from 'react';

interface Step {
  icon: string;
  title: string;
  desc: string;
  sub?: string;
}

interface PageGuideProps {
  pageKey: string;
  steps: Step[];
}

export function PageGuide({ pageKey, steps }: PageGuideProps) {
  const storageKey = `guide_seen_${pageKey}`;
  const [show, setShow] = useState(() => {
    try { return !localStorage.getItem(storageKey); } catch { return true; }
  });
  const [step, setStep] = useState(0);

  const close = () => {
    setShow(false);
    try { localStorage.setItem(storageKey, '1'); } catch {}
  };

  const reopen = () => {
    setStep(0);
    setShow(true);
  };

  const colors = ['#3a7bd5', '#e67e22', '#27ae60', '#9b59b6', '#e74c3c'];
  const color = colors[step % colors.length];
  const s = steps[step];

  return (
    <>
      {/* 「使い方を見る」ボタン */}
      <button onClick={reopen}
        style={{ background: '#f0f7ff', border: '1px solid #d0e3f7', borderRadius: 8, padding: '6px 14px',
          fontSize: 13, color: '#3a7bd5', cursor: 'pointer', fontWeight: 'bold' }}>
        使い方を見る
      </button>

      {/* ポップアップ */}
      {show && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: 460, overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}>
            {/* プログレスバー */}
            <div style={{ display: 'flex', gap: 4, padding: '16px 24px 0' }}>
              {steps.map((_, idx) => (
                <div key={idx} style={{ flex: 1, height: 4, borderRadius: 2, background: idx <= step ? color : '#e0e0e0', transition: 'background 0.3s' }} />
              ))}
            </div>

            {/* コンテンツ */}
            <div style={{ padding: '32px 32px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: 64, marginBottom: 16 }}>{s.icon}</div>
              <div style={{ fontSize: 22, fontWeight: 'bold', color: '#1a2332', marginBottom: 12 }}>{s.title}</div>
              <div style={{ fontSize: 15, color: '#333', lineHeight: 1.7, marginBottom: 8 }}>{s.desc}</div>
              {s.sub && <div style={{ fontSize: 13, color: '#888', lineHeight: 1.6 }}>{s.sub}</div>}
            </div>

            {/* ボタン */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 24px 20px' }}>
              <button onClick={close} style={{ background: 'none', border: 'none', color: '#999', fontSize: 13, cursor: 'pointer', padding: '8px 12px' }}>
                スキップ
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                {step > 0 && (
                  <button onClick={() => setStep(step - 1)}
                    style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', fontSize: 14, cursor: 'pointer', color: '#666' }}>
                    戻る
                  </button>
                )}
                <button onClick={() => step < steps.length - 1 ? setStep(step + 1) : close()}
                  style={{ padding: '10px 28px', borderRadius: 8, border: 'none', background: color, color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
                  {step < steps.length - 1 ? '次へ' : 'はじめる'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
