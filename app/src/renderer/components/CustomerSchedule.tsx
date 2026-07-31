import React, { useState } from 'react';

/**
 * 「この工事、うちは何時間つぶれるのか」をお客様に見せるためのパネル。
 *
 * 見積金額と同じくらい施主が気にするのが時間なのに、これまで画面には
 * 業者向けの「工期: 約5日」しか出ていなかった。ここでは
 *   ・全体で何日/何時間か
 *   ・1日あたり職人が何時間いるか
 *   ・家の外で何時間待つ必要があるか
 *   ・水道やトイレがいつ使えないか
 * を大きく出して、そのままお客様に見せられる／送れるようにする。
 */

type Schedule = {
  totalLabel?: string;
  hoursPerDay?: string;
  onSiteTime?: string;
  visitDays?: number;
  outOfHome?: { required?: boolean; hours?: string; when?: string; reason?: string; note?: string } | null;
  attendance?: string;
  unusable?: string[];
  impacts?: string[];
  dayPlan?: { day?: string; time?: string; hours?: string; outOfHome?: string; work?: string }[];
};

/** お客様にLINE・メールでそのまま送れる文面を組み立てる */
export function scheduleToText(s: Schedule, workType?: string): string {
  const L: string[] = [];
  L.push(`【工事のお時間について】${workType ? ` ${workType}` : ''}`);
  if (s.totalLabel) L.push(`■ 全体の所要時間：${s.totalLabel}`);
  if (s.hoursPerDay) L.push(`■ 1日あたりの作業時間：${s.hoursPerDay}${s.onSiteTime ? `（${s.onSiteTime}）` : ''}`);
  else if (s.onSiteTime) L.push(`■ 作業時間帯：${s.onSiteTime}`);
  if (s.outOfHome?.required) {
    L.push(`■ お家の外でお待ちいただく時間：${s.outOfHome.hours || '—'}${s.outOfHome.when ? `（${s.outOfHome.when}）` : ''}`);
    if (s.outOfHome.reason) L.push(`　理由：${s.outOfHome.reason}`);
    if (s.outOfHome.note) L.push(`　※ ${s.outOfHome.note}`);
  } else {
    L.push('■ お家の外でお待ちいただく時間：ありません（ご在宅のままで大丈夫です）');
  }
  if (s.attendance) L.push(`■ 立ち会い：${s.attendance}`);
  if (s.unusable?.length) {
    L.push('■ 工事中に使えなくなるもの');
    s.unusable.forEach(u => L.push(`　・${u}`));
  }
  if (s.impacts?.length) {
    L.push('■ ご協力のお願い');
    s.impacts.forEach(i => L.push(`　・${i}`));
  }
  if (s.dayPlan?.length) {
    L.push('■ 当日の流れ');
    s.dayPlan.forEach(d => {
      const head = [d.day, d.time, d.hours ? `約${String(d.hours).replace(/^約/, '')}` : ''].filter(Boolean).join(' ');
      L.push(`　${head}　${d.work || ''}`);
      if (d.outOfHome) L.push(`　　└ 外でお待ちいただく時間：${d.outOfHome}`);
    });
  }
  return L.join('\n');
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: 'blue' | 'orange' | 'green' }) {
  const c = tone === 'orange' ? { bg: '#fff7ed', bd: '#fdba74', fg: '#c2410c' }
    : tone === 'green' ? { bg: '#f0fdf4', bd: '#86efac', fg: '#15803d' }
    : { bg: '#eff6ff', bd: '#93c5fd', fg: '#1d4ed8' };
  return (
    <div style={{ flex: '1 1 180px', minWidth: 170, background: c.bg, border: `2px solid ${c.bd}`, borderRadius: 12, padding: '12px 16px' }}>
      <div style={{ fontSize: 12, color: c.fg, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, color: '#1a2332', lineHeight: 1.3 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export default function CustomerSchedule({ schedule, workType, duration }: {
  schedule?: Schedule | null;
  workType?: string;
  duration?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!schedule) return null;
  const s = schedule;
  const out = s.outOfHome;

  const copy = async () => {
    const text = scheduleToText(s, workType);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // クリップボードが使えない環境（権限なし等）は選択用のテキストエリアで代替
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  return (
    <div className="card" style={{ marginTop: 16, border: '2px solid #3b82f6' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>⏱ お客様にお伝えする工事のお時間</h3>
        <button className="btn btn-secondary" onClick={copy} style={{ fontSize: 13 }}>
          {copied ? '✅ コピーしました' : '📋 この内容をコピー（LINE・メールにそのまま貼れます）'}
        </button>
      </div>
      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
        「うちは何時間つぶれるのか」は、金額の次に必ず聞かれます。この画面をそのままお客様にお見せください。
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Tile tone="blue" label="全体の所要時間" value={s.totalLabel || duration || '—'}
          sub={s.visitDays ? `職人が伺うのは ${s.visitDays}日` : undefined} />
        <Tile tone="green" label="1日あたりの作業時間" value={s.hoursPerDay || '—'} sub={s.onSiteTime || undefined} />
        <Tile tone="orange" label="お家の外で待つ時間"
          value={out?.required ? (out.hours || '要相談') : 'なし'}
          sub={out?.required ? (out.when || undefined) : 'ご在宅のままで大丈夫です'} />
      </div>

      {out?.required && (out.reason || out.note) && (
        <div style={{ marginTop: 12, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '10px 14px', fontSize: 13 }}>
          {out.reason && <div>🚪 <strong>外でお待ちいただく理由：</strong>{out.reason}</div>}
          {out.note && <div style={{ marginTop: 4, color: '#92400e' }}>💡 {out.note}</div>}
        </div>
      )}

      {s.attendance && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <strong style={{ color: '#334155' }}>🙋 立ち会い：</strong>{s.attendance}
        </div>
      )}

      {!!s.unusable?.length && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#b91c1c', marginBottom: 6 }}>🚫 工事中に使えなくなるもの</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {s.unusable.map((u, i) => (
              <span key={i} style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 8, padding: '6px 12px', fontSize: 13 }}>{u}</span>
            ))}
          </div>
        </div>
      )}

      {!!s.impacts?.length && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 6 }}>📌 ご協力のお願い</div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#475569' }}>
            {s.impacts.map((t, i) => <li key={i} style={{ marginBottom: 2 }}>{t}</li>)}
          </ul>
        </div>
      )}

      {!!s.dayPlan?.length && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 6 }}>📅 当日の流れ</div>
          <table className="data-table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ width: 80 }}>日</th>
                <th style={{ width: 130 }}>時間帯</th>
                <th style={{ width: 90 }}>作業時間</th>
                <th>やること</th>
                <th style={{ width: 150 }}>外で待つ時間</th>
              </tr>
            </thead>
            <tbody>
              {s.dayPlan.map((d, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 700 }}>{d.day || `${i + 1}日目`}</td>
                  <td>{d.time || '—'}</td>
                  <td>{d.hours || '—'}</td>
                  <td>{d.work || ''}</td>
                  <td style={{ color: d.outOfHome ? '#c2410c' : '#94a3b8' }}>{d.outOfHome || 'なし'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
