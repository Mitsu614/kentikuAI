import React, { useEffect, useState } from 'react';
import { NDA_VERSION, NDA_ARTICLES, ndaPreamble } from '../nda-text';

// 秘密保持契約（図面・見積書の受け渡し）への同意欄。お客様（テナント1以外）の設定画面に出す。
//   全文を読める → お名前を入れる → チェック → 「同意する」。記録はサーバーに残る。
//   同意済みなら、いつ・誰が・どの版に同意したかを出す。版が変わったら同意し直してもらう。
export default function NdaCard() {
  const api = (window as any).api;
  const [tenant, setTenant] = useState<number | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [company, setCompany] = useState('');
  const [signer, setSigner] = useState('');
  const [title, setTitle] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showText, setShowText] = useState(false);

  const load = async () => {
    try {
      const r = await api.ndaStatus?.();
      setStatus(r?.agreed || null);
      if (r?.company) setCompany(r.company);
    } catch (_) {}
  };
  useEffect(() => {
    api.currentTenant?.().then((t: number) => setTenant(t)).catch(() => {});
    load();
  }, []);
  if (tenant === null || tenant === 1) return null;   // オーナー（中野工務店）には出さない

  const agreedCurrent = status && status.version === NDA_VERSION;
  const agree = async () => {
    setErr('');
    if (!signer.trim()) { setErr('同意される方のお名前を入れてください'); return; }
    if (!checked) { setErr('内容をご確認のうえ、チェックを入れてください'); return; }
    setBusy(true);
    const r = await api.ndaAgree(NDA_VERSION, signer.trim(), title.trim());
    setBusy(false);
    if (!r?.ok) { setErr(r?.error || '同意を記録できませんでした'); return; }
    setChecked(false);
    load();
  };
  const fmt = (s: string) => (s ? new Date(s).toLocaleString('ja-JP') : '');

  return (
    <div className="card" style={{ border: agreedCurrent ? '1px solid #c8e6c9' : '2px solid #2e6fbf' }}>
      <h3 style={{ marginBottom: 6 }}>🤝 秘密保持契約（図面・見積書の受け渡し）</h3>
      <p style={{ fontSize: 13, color: '#555', lineHeight: 1.8, marginBottom: 10 }}>
        導入のお手伝いで、御社の図面や過去の見積書をお預かりするときの約束です。
        お預かりした資料を<b>ほかに漏らさない・目的以外に使わない</b>こと、<b>御社の金額を他社の見積に使わない</b>ことを、当社（有限会社中野工務店）がお約束します。
      </p>

      {agreedCurrent ? (
        <div style={{ background: '#e8f5e9', borderRadius: 6, padding: '10px 12px', fontSize: 13, color: '#1b5e20' }}>
          ✓ 同意済み　{fmt(status.at)}　{status.signer}{status.title ? `（${status.title}）` : ''} 様　／　{status.version}
        </div>
      ) : status ? (
        <div style={{ background: '#fff3e0', borderRadius: 6, padding: '8px 12px', fontSize: 12.5, color: '#8a4b00', marginBottom: 8 }}>
          契約書の内容が新しくなりました（前回の同意：{status.version}）。お手数ですが、あらためてご確認ください。
        </div>
      ) : null}

      <button type="button" onClick={() => setShowText(v => !v)}
        style={{ border: 'none', background: 'none', color: '#2e6fbf', cursor: 'pointer', fontSize: 13, padding: 0, margin: '10px 0 6px' }}>
        {showText ? '▲ 契約書を閉じる' : '▼ 契約書の全文を読む'}
      </button>
      {(showText || !agreedCurrent) && (
        <div style={{ maxHeight: showText ? 'none' : 220, overflowY: 'auto', border: '1px solid #e0e6ec', borderRadius: 6, padding: '12px 16px', background: '#fafbfc', fontSize: 12.5, lineHeight: 1.8, fontFamily: '"Yu Mincho","游明朝",serif' }}>
          <div style={{ textAlign: 'center', fontWeight: 'bold', fontSize: 15, letterSpacing: '0.2em', marginBottom: 8 }}>秘密保持契約書</div>
          <p style={{ margin: '0 0 8px' }}>{ndaPreamble(company)}</p>
          {NDA_ARTICLES.map(a => (
            <div key={a.title} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 'bold' }}>{a.title}</div>
              {a.body && <div style={{ textIndent: '1em' }}>{a.body}</div>}
              {a.items && (
                <ol style={{ margin: '2px 0 0 1.6em', padding: 0 }}>
                  {a.items.map((t, i) => (
                    <li key={i}>
                      {t}
                      {i === a.items!.length - 1 && a.sub && (
                        <ul style={{ margin: '2px 0 0 1.2em', padding: 0 }}>{a.sub.map(x => <li key={x}>{x}</li>)}</ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
          <div style={{ textAlign: 'right', color: '#607d8b', marginTop: 6 }}>{NDA_VERSION}</div>
        </div>
      )}

      {!agreedCurrent && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={signer} onChange={e => setSigner(e.target.value)} placeholder="同意される方のお名前（必須）"
              style={{ flex: '1 1 12rem', padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13 }} />
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="役職（任意）例: 代表取締役"
              style={{ flex: '1 1 10rem', padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13 }} />
          </div>
          <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} style={{ marginTop: 4 }} />
            <span>上の秘密保持契約書の内容を確認し、{company ? `${company}として` : '会社として'}同意します。</span>
          </label>
          {err && <div style={{ color: '#c0392b', fontSize: 13 }}>{err}</div>}
          <div>
            <button className="btn btn-primary btn-sm" disabled={!checked || !signer.trim() || busy} onClick={agree}>
              {busy ? '記録しています…' : '同意する'}
            </button>
            <span style={{ fontSize: 11.5, color: '#888', marginLeft: 10 }}>同意すると、日時・お名前・契約書の版が記録され、当社にも通知されます。</span>
          </div>
        </div>
      )}
    </div>
  );
}
