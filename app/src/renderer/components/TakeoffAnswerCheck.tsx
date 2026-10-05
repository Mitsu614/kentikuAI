import React, { useMemo, useState } from 'react';
import { groupTakeoffItems, matchAnswers, AnswerRow, AnswerMatch } from '../../main/takeoff-answer';

// 図面の答え合わせ。
// お客様の「正解」（自社で拾った数量）と、AIの拾い出しを部位×材料×単位ごとに並べて判定する。
//   ・正解は取り込める：Excel・CSV はその場で読む（単位を使わない）。PDF・写真はAIが書き写す（1ファイル1単位）
//   ・取り込んだ行は自動でAIの行にひも付けるが、どれに結んだかを一覧で見せ、人が選び直せる。
//     自信の無いひも付け・単位違いは「要確認」。勝手に結んだままにしない
//   ・AIの数量は拾い出し直後の値（aiQuantity）。表で直した後の値ではなく、AIがそもそも何と言ったかで比べる
//   ・同じ材料が部屋ごとに何行もあるときは合計して比べる（お客様の表も部屋ごと・合計のどちらもあるため）
//   ・手で打った数字は、取り込んだ数字より優先する。空欄に戻せば取り込んだ数字に戻る
//   ・0 を入れた行は「御社は拾わない＝AIだけ（余計）」。AIに無い正解の行は「拾い漏れ」
//   ・「学習に使う」はお客様が押したときだけ。送るのは部位名・単位・数量だけ（金額・図面は送らない）

type Kind = 'ok' | 'warn' | 'bad' | 'extra' | 'none';
const LABEL: Record<Kind, string> = { ok: '✅ 一致', warn: '⚠ ずれ大', bad: '❌ 拾い漏れ', extra: '❓ AIだけ', none: '未入力' };
const COLOR: Record<Kind, string> = { ok: '#2e7d32', warn: '#ef6c00', bad: '#c62828', extra: '#5e35b1', none: '#90a4ae' };
const BG: Record<Kind, string> = { ok: '#e8f5e9', warn: '#fff3e0', bad: '#ffebee', extra: '#ede7f6', none: '#f5f7f9' };

const MISS = '__miss';
const SKIP = '__skip';

export interface AnswerFeedbackRow {
  itemKey: string; unit: string; aiQuantity: number; actualQuantity: number; note?: string;
}

interface Imported { row: AnswerRow; auto: AnswerMatch; assign: string }

const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString();

export default function TakeoffAnswerCheck({ items, onSend }: {
  items: any[];
  onSend: (rows: AnswerFeedbackRow[]) => Promise<number> | number;
}) {
  const groups = useMemo(() => groupTakeoffItems(items), [items]);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [imported, setImported] = useState<Imported[]>([]);
  const [importing, setImporting] = useState(false);
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const [mapOpen, setMapOpen] = useState(false);
  const [extras, setExtras] = useState<{ name: string; unit: string; qty: string }[]>([]);
  const [tol, setTol] = useState(10);
  const [openWhy, setOpenWhy] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [sentN, setSentN] = useState<number | null>(null);

  const importAnswer = async () => {
    setImporting(true);
    try {
      const res = await (window as any).api.importTakeoffAnswer();
      if (res?.canceled) return;
      setImportNotes(res?.notes || []);
      const rows: AnswerRow[] = res?.rows || [];
      if (rows.length) {
        const auto = matchAnswers(groups, rows);
        const add = rows.map((row, k) => ({ row, auto: auto[k], assign: auto[k].key ?? MISS }));
        setImported(p => [...p, ...add]);
        if (add.some(a => a.auto.needsCheck)) setMapOpen(true);
        setSentN(null);
      }
    } catch (e: any) {
      setImportNotes([`読み込めませんでした: ${e?.message || e}`]);
    } finally {
      setImporting(false);
    }
  };

  const rows = useMemo(() => {
    const importedSum = new Map<string, { sum: number; n: number }>();
    imported.forEach(x => {
      if (x.assign === MISS || x.assign === SKIP) return;
      const v = importedSum.get(x.assign) || { sum: 0, n: 0 };
      importedSum.set(x.assign, { sum: v.sum + x.row.qty, n: v.n + 1 });
    });
    const main = groups.map(g => {
      const raw = manual[g.key];
      const imp = importedSum.get(g.key);
      let t: number | null = null; let from: 'manual' | 'import' | null = null;
      if (raw !== undefined && raw !== '' && !isNaN(Number(raw))) { t = Number(raw); from = 'manual'; }
      else if (imp) { t = Math.round(imp.sum * 1000) / 1000; from = 'import'; }
      const a = g.ai;
      let kind: Kind = 'none'; let diff: number | null = null;
      if (t === null) kind = 'none';
      else if (t === 0) kind = 'extra';
      else if (!(a > 0)) kind = 'bad';
      else { diff = (a - t) / t * 100; kind = Math.abs(diff) <= tol ? 'ok' : 'warn'; }
      return { g, t, a, kind, diff, from, impN: imp?.n || 0 };
    });
    const missImported = imported.filter(x => x.assign === MISS);
    const missManual = extras.filter(e => e.name.trim() && Number(e.qty) > 0);
    return { main, missImported, missCount: missImported.length + missManual.length };
  }, [groups, manual, imported, extras, tol]);

  const cnt: Record<Kind, number> = { ok: 0, warn: 0, bad: 0, extra: 0, none: 0 };
  rows.main.forEach(r => cnt[r.kind]++);
  cnt.bad += rows.missCount;
  const graded = cnt.ok + cnt.warn + cnt.bad + cnt.extra;
  const learnable = rows.main.filter(r => r.t !== null && r.t > 0 && r.a > 0);
  const needCheck = imported.filter(x => x.auto.needsCheck && x.assign === (x.auto.key ?? MISS)).length;
  // 材料名の無い「部位×部屋」の行（拾い出しソフトの書き出し）は部位ごとにまとめて選び直せるようにする
  const bulkParts = [...imported.filter(x => x.row.byRoom).reduce((m, x) => {
    const p = x.row.part || ''; m.set(p, (m.get(p) || 0) + 1); return m;
  }, new Map<string, number>())].filter(([, n]) => n >= 2);

  const send = async () => {
    const payload: AnswerFeedbackRow[] = learnable.map(r => {
      const f = r.g.idxs.map(i => items[i]?.formula).filter(Boolean).join(' / ');
      return {
        itemKey: r.g.name,
        unit: r.g.unit || '',
        aiQuantity: r.a,
        actualQuantity: r.t as number,
        note: `答え合わせ${r.from === 'import' ? '（正解取り込み）' : ''}${f ? ' / ' + f.slice(0, 100) : ''}`,
      };
    });
    const n = await onSend(payload);
    setConfirming(false);
    setSentN(typeof n === 'number' ? n : payload.length);
  };

  const groupLabel = (key: string) => {
    const g = groups.find(x => x.key === key);
    return g ? `${g.part ? g.part + '｜' : ''}${g.name}（${g.unit || '—'}）` : key;
  };

  const cell: React.CSSProperties = { padding: '5px 8px', borderBottom: '1px solid #eceff1', verticalAlign: 'top' };
  const num: React.CSSProperties = { ...cell, textAlign: 'right', fontFamily: 'monospace', whiteSpace: 'nowrap' };
  const inp: React.CSSProperties = { width: 80, padding: '3px 6px', textAlign: 'right', border: '1px solid #cfd8dc', borderRadius: 5, fontSize: 12 };
  const chip = (text: string, color: string, bg: string): React.ReactNode => (
    <span style={{ background: bg, color, fontSize: 10.5, borderRadius: 4, padding: '0 5px', marginLeft: 4, whiteSpace: 'nowrap' }}>{text}</span>
  );

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

      {/* 正解の取り込み */}
      <div style={{ background: '#f5f8fc', border: '1px solid #d8e2ec', borderRadius: 8, padding: '10px 12px', margin: '8px 0 10px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={importing} onClick={importAnswer}>
            {importing ? '読み込み中…' : '📥 御社の拾い出し表を取り込む（Excel・CSV・PDF・写真）'}
          </button>
          {imported.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => { setImported([]); setImportNotes([]); setSentN(null); }}>取り込んだ正解を消す</button>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: '#607d8b', marginTop: 6, lineHeight: 1.7 }}>
          Excel・CSV は単位を使いません（「品名・名称」と「数量」の見出しがあれば読めます）。PDF・写真はAIが表を書き写すため、1ファイル1単位です。<br />
          読み込んだ行は、AIの拾い出しの同じ材料に自動でひも付けます。部屋ごとの行は合計して比べます。
        </div>
        {importNotes.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: '#33475b' }}>
            {importNotes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
        {imported.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <button type="button" onClick={() => setMapOpen(o => !o)}
              style={{ border: 'none', background: 'none', color: '#2e6fbf', cursor: 'pointer', fontSize: 12, padding: 0 }}>
              {mapOpen ? '▲' : '▼'} 取り込んだ正解のひも付けを確かめる（{imported.length}行
              {needCheck > 0 && <b style={{ color: COLOR.warn }}>・要確認 {needCheck}行</b>}）
            </button>
          </div>
        )}
        {mapOpen && imported.length > 0 && bulkParts.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, fontSize: 12 }}>
            {bulkParts.map(([part, n]) => (
              <div key={part}>
                「{part}」の行（{n}行）をまとめて：{' '}
                <select value="" onChange={e => {
                  const v = e.target.value; if (!v) return;
                  setImported(p => p.map(y => (y.row.byRoom && (y.row.part || '') === part ? { ...y, assign: v } : y)));
                  setSentN(null);
                }} style={{ fontSize: 11.5, padding: '2px 4px', border: '1px solid #cfd8dc', borderRadius: 4, maxWidth: 300 }}>
                  <option value="">選ぶ…</option>
                  {groups.map(g => <option key={g.key} value={g.key}>{groupLabel(g.key)}</option>)}
                  <option value={MISS}>AIに無い（拾い漏れ）</option>
                  <option value={SKIP}>比べない</option>
                </select>
              </div>
            ))}
          </div>
        )}
        {mapOpen && imported.length > 0 && (
          <div style={{ overflowX: 'auto', marginTop: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, minWidth: 680, background: '#fff' }}>
              <thead>
                <tr style={{ background: '#eef2f6', color: '#546e7a', textAlign: 'left' }}>
                  <th style={cell}>読んだ場所</th><th style={cell}>御社の表の項目</th>
                  <th style={{ ...cell, textAlign: 'right' }}>数量</th><th style={cell}>ひも付け先（AIの行）</th>
                </tr>
              </thead>
              <tbody>
                {imported.map((x, k) => {
                  const warn = x.auto.needsCheck && x.assign === (x.auto.key ?? MISS);
                  return (
                    <tr key={k} style={{ boxShadow: warn ? `inset 3px 0 ${COLOR.warn}` : undefined }}>
                      <td style={{ ...cell, color: '#90a4ae', whiteSpace: 'nowrap' }}>{x.row.src || '—'}</td>
                      <td style={cell}>
                        {x.row.part && <span style={{ color: '#607d8b' }}>{x.row.part}｜</span>}{x.row.name}
                        {x.row.room && chip(x.row.room, '#546e7a', '#eceff1')}
                      </td>
                      <td style={num}>{fmt(x.row.qty)} <span style={{ color: '#90a4ae' }}>{x.row.unit}</span></td>
                      <td style={cell}>
                        <select value={x.assign}
                          onChange={e => { const v = e.target.value; setImported(p => p.map((y, j) => j === k ? { ...y, assign: v } : y)); setSentN(null); }}
                          style={{ maxWidth: 300, fontSize: 11.5, padding: '2px 4px', border: '1px solid #cfd8dc', borderRadius: 4 }}>
                          {x.auto.suggestKey && <option value={x.auto.suggestKey}>★候補 {groupLabel(x.auto.suggestKey)}</option>}
                          {groups.map(g => <option key={g.key} value={g.key}>{groupLabel(g.key)}</option>)}
                          <option value={MISS}>AIに無い（拾い漏れ）</option>
                          <option value={SKIP}>比べない</option>
                        </select>
                        <div style={{ fontSize: 10.5, color: warn ? COLOR.warn : '#90a4ae', marginTop: 2 }}>
                          {x.assign === (x.auto.key ?? MISS) ? x.auto.why : '手で選び直しました'}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ fontSize: 11.5, color: '#607d8b', margin: '0 0 10px', lineHeight: 1.7 }}>
        「御社の数量」は手でも直せます（手で打った数字が優先。空欄に戻すと取り込んだ数字に戻ります）。比べるのは画面の中だけです。<br />
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
            {rows.main.map(r => {
              const its = r.g.idxs.map(i => items[i]);
              const hasWhy = its.some(it => it?.formula);
              return (
                <React.Fragment key={r.g.key}>
                  <tr style={{ boxShadow: r.kind === 'none' || r.kind === 'ok' ? undefined : `inset 3px 0 ${COLOR[r.kind]}` }}>
                    <td style={{ ...cell, color: '#607d8b' }}>{r.g.part || '—'}</td>
                    <td style={cell}>{r.g.name}{r.g.idxs.length > 1 && chip(`${r.g.idxs.length}行の合計`, '#546e7a', '#eceff1')}</td>
                    <td style={num}>
                      <input type="number" min={0} step="any"
                        value={manual[r.g.key] ?? ''}
                        placeholder={r.from === 'import' ? String(r.t) : '—'}
                        onChange={e => { const v = e.target.value; setManual(p => ({ ...p, [r.g.key]: v })); setSentN(null); }}
                        style={{ ...inp, ...(r.from === 'import' ? { background: '#eef4fc', borderColor: '#9dbbe0' } : {}) }} />{' '}
                      <span style={{ color: '#90a4ae' }}>{r.g.unit}</span>
                      {r.from === 'import' && <div>{chip(`取り込み ${r.impN}行`, '#2e6fbf', '#eef4fc')}</div>}
                    </td>
                    <td style={num}>{r.a > 0 ? fmt(r.a) : '—'} <span style={{ color: '#90a4ae' }}>{r.g.unit}</span></td>
                    <td style={{ ...num, color: COLOR[r.kind] }}>
                      {r.diff !== null ? `${r.diff > 0 ? '+' : ''}${r.diff.toFixed(1)}%` : r.kind === 'extra' ? '余計' : r.kind === 'bad' ? '拾い漏れ' : ''}
                    </td>
                    <td style={cell}>
                      <span style={{ background: BG[r.kind], color: COLOR[r.kind], fontWeight: 'bold', fontSize: 11, borderRadius: 4, padding: '1px 7px', whiteSpace: 'nowrap' }}>{LABEL[r.kind]}</span>
                    </td>
                    <td style={cell}>
                      {hasWhy && (
                        <button type="button" onClick={() => setOpenWhy(p => { const n = new Set(p); n.has(r.g.key) ? n.delete(r.g.key) : n.add(r.g.key); return n; })}
                          style={{ border: 'none', background: 'none', color: '#2e6fbf', cursor: 'pointer', fontSize: 11.5, whiteSpace: 'nowrap' }}>
                          根拠 {openWhy.has(r.g.key) ? '▲' : '▼'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {openWhy.has(r.g.key) && (
                    <tr><td colSpan={7} style={{ ...cell, background: '#f5f8fc', fontSize: 11.5 }}>
                      {its.filter(it => it?.formula).map((it, k) => (
                        <div key={k}>
                          {it.room ? <b>{it.room}：</b> : null}AIの計算式：<code>{it.formula}</code>{it.source ? `　／　出典：${it.source}` : ''}
                        </div>
                      ))}
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
            {rows.missImported.map((x, k) => (
              <tr key={'m' + k} style={{ boxShadow: `inset 3px 0 ${COLOR.bad}` }}>
                <td style={{ ...cell, color: '#607d8b' }}>{x.row.part || '（AI無し）'}</td>
                <td style={cell}>{x.row.name}{x.row.room && chip(x.row.room, '#546e7a', '#eceff1')}{chip('取り込み', '#2e6fbf', '#eef4fc')}</td>
                <td style={num}>{fmt(x.row.qty)} <span style={{ color: '#90a4ae' }}>{x.row.unit}</span></td>
                <td style={num}>—</td>
                <td style={{ ...num, color: COLOR.bad }}>拾い漏れ</td>
                <td style={cell}><span style={{ background: BG.bad, color: COLOR.bad, fontWeight: 'bold', fontSize: 11, borderRadius: 4, padding: '1px 7px' }}>{LABEL.bad}</span></td>
                <td style={{ ...cell, fontSize: 10.5, color: '#90a4ae' }}>{x.auto.suggestKey ? '単位違いの候補あり' : ''}</td>
              </tr>
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
            {needCheck > 0 && <div style={{ color: COLOR.warn, marginTop: 4 }}>※ ひも付けが「要確認」の行が {needCheck} 行あります。先に確かめてから送るのがおすすめです。</div>}
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
