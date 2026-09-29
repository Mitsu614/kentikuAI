import React, { useMemo, useState } from 'react';

// 図面の答え合わせ。
// お客様が「自社で拾った数量」を入れると、AIの拾い出しと部位ごとに並べて判定する。
//   ・AIの数量は拾い出し直後の値（aiQuantity）。表で直した後の値ではなく、AIがそもそも何と言ったかで比べる
//   ・御社の数量が空欄の行は「未入力」で採点しない。0 を入れた行は「御社は拾わない＝AIだけ（余計）」
//   ・AIが拾っていない項目は下で足す＝「拾い漏れ」
//   ・比べるのは画面の中だけ。AIは呼ばないので単位は減らない
//   ・「学習に使う」はお客様が押したときだけ。送るのは部位名・単位・数量だけ（金額・図面は送らない）

type Kind = 'ok' | 'warn' | 'bad' | 'extra' | 'none';
const LABEL: Record<Kind, string> = { ok: '✅ 一致', warn: '⚠ ずれ大', bad: '❌ 拾い漏れ', extra: '❓ AIだけ', none: '未入力' };
const COLOR: Record<Kind, string> = { ok: '#2e7d32', warn: '#ef6c00', bad: '#c62828', extra: '#5e35b1', none: '#90a4ae' };
const BG: Record<Kind, string> = { ok: '#e8f5e9', warn: '#fff3e0', bad: '#ffebee', extra: '#ede7f6', none: '#f5f7f9' };

export interface AnswerFeedbackRow {
  itemKey: string; unit: string; aiQuantity: number; actualQuantity: number; note?: string;
}

export default function TakeoffAnswerCheck({ items, onSend }: {
  items: any[];
  onSend: (rows: AnswerFeedbackRow[]) => Promise<number> | number;
}) {
  const [truth, setTruth] = useState<Record<number, string>>({});
  const [extras, setExtras] = useState<{ name: string; unit: string; qty: string }[]>([]);
  const [tol, setTol] = useState(10);
  const [openWhy, setOpenWhy] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [sentN, setSentN] = useState<number | null>(null);

  const aiQty = (it: any) => Number(it?.aiQuantity ?? it?.quantity) || 0;

  const rows = useMemo(() => {
    const main = items.map((it, i) => {
      const raw = truth[i];
      const t = raw === undefined || raw === '' ? null : Number(raw);
      const a = aiQty(it);
      let kind: Kind = 'none'; let diff: number | null = null;
      if (t === null || isNaN(t)) kind = 'none';
      else if (t === 0) kind = 'extra';
      else if (!(a > 0)) kind = 'bad';
      else { diff = (a - t) / t * 100; kind = Math.abs(diff) <= tol ? 'ok' : 'warn'; }
      return { i, it, t, a, kind, diff };
    });
    const miss = extras
      .map((e, j) => ({ j, e, t: Number(e.qty) }))
      .filter(x => x.e.name.trim() && x.t > 0);
    return { main, miss };
  }, [items, truth, extras, tol]);

  const cnt: Record<Kind, number> = { ok: 0, warn: 0, bad: 0, extra: 0, none: 0 };
  rows.main.forEach(r => cnt[r.kind]++);
  cnt.bad += rows.miss.length;
  const graded = cnt.ok + cnt.warn + cnt.bad + cnt.extra;
  const learnable = rows.main.filter(r => r.t !== null && r.t > 0 && r.a > 0);

  const send = async () => {
    const payload: AnswerFeedbackRow[] = learnable.map(r => ({
      itemKey: String(r.it.name || '').replace(/^【[^】]*】/, '').trim(),
      unit: r.it.unit || '',
      aiQuantity: r.a,
      actualQuantity: r.t as number,
      note: `答え合わせ${r.it.formula ? ' / ' + String(r.it.formula).slice(0, 100) : ''}`,
    }));
    const n = await onSend(payload);
    setConfirming(false);
    setSentN(typeof n === 'number' ? n : payload.length);
  };

  const cell: React.CSSProperties = { padding: '5px 8px', borderBottom: '1px solid #eceff1', verticalAlign: 'top' };
  const num: React.CSSProperties = { ...cell, textAlign: 'right', fontFamily: 'monospace', whiteSpace: 'nowrap' };
  const inp: React.CSSProperties = { width: 80, padding: '3px 6px', textAlign: 'right', border: '1px solid #cfd8dc', borderRadius: 5, fontSize: 12 };

  return (
    <div style={{ marginTop: 12, border: '2px solid #2e6fbf', borderRadius: 10, padding: '12px 14px', background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: '#16324f' }}>🎯 御社の数量で答え合わせ</div>
        <label style={{ fontSize: 12, color: '#607d8b' }}>
          合格ライン ±<input type="number" min={1} max={50} value={tol}
            onChange={e => { const v = Number(e.target.value); if (v >= 1 && v <= 50) setTol(v); }}
            style={{ width: 48, margin: '0 3px', padding: '1px 4px', border: '1px solid #cfd8dc', borderRadius: 4 }} />%
        </label>
      </div>
      <div style={{ fontSize: 11.5, color: '#607d8b', margin: '4px 0 10px', lineHeight: 1.7 }}>
        「御社の数量」に、御社で拾った数量を入れてください。比べるのは画面の中だけで、AIの単位は使いません。<br />
        空欄の行は採点しません。御社では拾わない項目は <b>0</b> を入れてください（AIだけが拾った項目になります）。
      </div>

      {/* 総合 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', background: '#f5f8fc', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: '#607d8b' }}>合格ライン以内</div>
          <div style={{ fontSize: 24, fontWeight: 'bold', fontFamily: 'monospace', color: '#16324f' }}>
            {cnt.ok}<span style={{ fontSize: 13, color: '#607d8b' }}> / {graded} 項目</span>
          </div>
          <div style={{ fontSize: 11, color: '#607d8b' }}>一致率 <b>{graded ? Math.round(cnt.ok / graded * 100) : 0}%</b></div>
        </div>
        <div style={{ flex: '1 1 16rem', minWidth: 0 }}>
          <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: '#e3e8ee', marginBottom: 6 }}>
            {(['ok', 'warn', 'bad', 'extra'] as Kind[]).map(k => (
              <span key={k} style={{ width: graded ? `${cnt[k] / graded * 100}%` : 0, background: COLOR[k] }} />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11.5 }}>
            {(['ok', 'warn', 'bad', 'extra', 'none'] as Kind[]).map(k => (
              <span key={k} style={{ color: COLOR[k] }}>{LABEL[k]} <b>{cnt[k]}</b></span>
            ))}
          </div>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 620 }}>
          <thead>
            <tr style={{ background: '#eef2f6', color: '#546e7a', textAlign: 'left' }}>
              <th style={cell}>部位</th><th style={cell}>材料・工種</th>
              <th style={{ ...cell, textAlign: 'right' }}>御社の数量</th>
              <th style={{ ...cell, textAlign: 'right' }}>AIの数量</th>
              <th style={{ ...cell, textAlign: 'right' }}>ずれ</th>
              <th style={cell}>判定</th><th style={cell}></th>
            </tr>
          </thead>
          <tbody>
            {rows.main.map(r => (
              <React.Fragment key={r.i}>
                <tr style={{ boxShadow: r.kind === 'none' || r.kind === 'ok' ? undefined : `inset 3px 0 ${COLOR[r.kind]}` }}>
                  <td style={{ ...cell, color: '#607d8b' }}>{r.it.part || '—'}</td>
                  <td style={cell}>{r.it.name}</td>
                  <td style={num}>
                    <input type="number" min={0} step="any" value={truth[r.i] ?? ''} placeholder="—"
                      onChange={e => { const v = e.target.value; setTruth(p => ({ ...p, [r.i]: v })); setSentN(null); }}
                      style={inp} /> <span style={{ color: '#90a4ae' }}>{r.it.unit}</span>
                  </td>
                  <td style={num}>{r.a > 0 ? r.a.toLocaleString() : '—'} <span style={{ color: '#90a4ae' }}>{r.it.unit}</span></td>
                  <td style={{ ...num, color: COLOR[r.kind] }}>
                    {r.diff !== null ? `${r.diff > 0 ? '+' : ''}${r.diff.toFixed(1)}%` : r.kind === 'extra' ? '余計' : r.kind === 'bad' ? '拾い漏れ' : ''}
                  </td>
                  <td style={cell}>
                    <span style={{ background: BG[r.kind], color: COLOR[r.kind], fontWeight: 'bold', fontSize: 11, borderRadius: 4, padding: '1px 7px', whiteSpace: 'nowrap' }}>{LABEL[r.kind]}</span>
                  </td>
                  <td style={cell}>
                    {r.it.formula && (
                      <button type="button" onClick={() => setOpenWhy(p => { const n = new Set(p); n.has(r.i) ? n.delete(r.i) : n.add(r.i); return n; })}
                        style={{ border: 'none', background: 'none', color: '#2e6fbf', cursor: 'pointer', fontSize: 11.5, whiteSpace: 'nowrap' }}>
                        根拠 {openWhy.has(r.i) ? '▲' : '▼'}
                      </button>
                    )}
                  </td>
                </tr>
                {openWhy.has(r.i) && (
                  <tr><td colSpan={7} style={{ ...cell, background: '#f5f8fc', fontSize: 11.5 }}>
                    AIの計算式：<code>{r.it.formula}</code>{r.it.source ? `　／　出典：${r.it.source}` : ''}
                  </td></tr>
                )}
              </React.Fragment>
            ))}
            {extras.map((e, j) => (
              <tr key={'x' + j} style={{ boxShadow: `inset 3px 0 ${COLOR.bad}` }}>
                <td style={{ ...cell, color: '#607d8b' }}>（AI無し）</td>
                <td style={cell}>
                  <input value={e.name} placeholder="項目名（例: 軽鉄天井下地）"
                    onChange={ev => setExtras(p => p.map((x, k) => k === j ? { ...x, name: ev.target.value } : x))}
                    style={{ width: '100%', padding: '3px 6px', border: '1px solid #cfd8dc', borderRadius: 5, fontSize: 12 }} />
                </td>
                <td style={num}>
                  <input type="number" min={0} step="any" value={e.qty} placeholder="—"
                    onChange={ev => setExtras(p => p.map((x, k) => k === j ? { ...x, qty: ev.target.value } : x))} style={inp} />{' '}
                  <input value={e.unit} placeholder="単位"
                    onChange={ev => setExtras(p => p.map((x, k) => k === j ? { ...x, unit: ev.target.value } : x))}
                    style={{ width: 40, padding: '3px 4px', border: '1px solid #cfd8dc', borderRadius: 5, fontSize: 12 }} />
                </td>
                <td style={num}>—</td>
                <td style={{ ...num, color: COLOR.bad }}>拾い漏れ</td>
                <td style={cell}><span style={{ background: BG.bad, color: COLOR.bad, fontWeight: 'bold', fontSize: 11, borderRadius: 4, padding: '1px 7px' }}>{LABEL.bad}</span></td>
                <td style={cell}>
                  <button type="button" onClick={() => setExtras(p => p.filter((_, k) => k !== j))}
                    style={{ border: 'none', background: 'none', color: '#b0bec5', cursor: 'pointer', fontSize: 14 }}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => setExtras(p => [...p, { name: '', unit: '', qty: '' }])}
        style={{ marginTop: 6, border: '1px dashed #90a4ae', background: '#fff', color: '#546e7a', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
        ＋ AIが拾っていない項目を足す（拾い漏れ）
      </button>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!confirming && sentN === null && (
          <div>
            <button type="button" className="btn btn-primary btn-sm" disabled={learnable.length === 0} onClick={() => setConfirming(true)}>
              この結果を学習に使う（{learnable.length}項目）
            </button>
            {learnable.length === 0 && <span style={{ fontSize: 11.5, color: '#90a4ae', marginLeft: 8 }}>御社の数量を入れると押せます</span>}
          </div>
        )}
        {confirming && (
          <div style={{ background: '#eef4fc', borderRadius: 6, padding: '10px 12px', fontSize: 12.5 }}>
            御社の数量を「正解」として、<b>部位名・単位・数量だけ</b>を送ります。会社名・現場名・金額・図面そのものは送りません。
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={send}>送る</button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>やめる</button>
            </div>
          </div>
        )}
        {sentN !== null && sentN > 0 && (
          <div style={{ fontSize: 12.5, color: '#2e7d32', fontWeight: 'bold' }}>
            ✓ 学習に使いました（{sentN}項目）。次の拾い出しから反映されます。
          </div>
        )}
        {sentN === -1 && (
          <div style={{ fontSize: 12.5, color: '#546e7a' }}>
            御社は、数量も他社と共有しない設定になっているため、送っていません。答え合わせの結果は、この画面でご確認ください。
          </div>
        )}
        {sentN === 0 && (
          <div style={{ fontSize: 12.5, color: '#c62828' }}>
            送れませんでした。ネットの接続を確かめて、もう一度お試しください。
            <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setSentN(null)}>もう一度</button>
          </div>
        )}
      </div>
    </div>
  );
}
