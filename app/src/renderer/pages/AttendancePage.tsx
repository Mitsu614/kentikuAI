import React, { useEffect, useState } from 'react';

const api = (window as any).api;
const fmt = (n: number) => '¥' + Math.round(n).toLocaleString();

export default function AttendancePage() {
  const [tab, setTab] = useState<'daily' | 'workers' | 'summary'>('daily');
  const [workers, setWorkers] = useState<any[]>([]);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [constructions, setConstructions] = useState<any[]>([]);
  const [summary, setSummary] = useState<any[]>([]);

  // 日報入力
  const [workDate, setWorkDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedConstruction, setSelectedConstruction] = useState<number | null>(null);
  const [selectedWorkers, setSelectedWorkers] = useState<number[]>([]);
  const [hours, setHours] = useState(8);
  const [dailyNotes, setDailyNotes] = useState('');

  // 作業者フォーム
  const [wName, setWName] = useState('');
  const [wRate, setWRate] = useState(25000);
  const [wRole, setWRole] = useState('作業員');
  const [editingWorker, setEditingWorker] = useState<any>(null);

  // フィルタ
  const [filterMonth, setFilterMonth] = useState(new Date().toISOString().slice(0, 7));

  const load = async () => {
    const [w, c] = await Promise.all([api.listWorkers(), api.listConstructions()]);
    setWorkers(w);
    setConstructions(c);
    const att = await api.listAttendance({ month: filterMonth });
    setAttendance(att);
    const s = await api.getAttendanceSummary({});
    setSummary(s);
  };
  useEffect(() => { load(); }, [filterMonth]);

  const addAttendance = async () => {
    if (selectedWorkers.length === 0) return alert('作業者を選択してください');
    for (const wid of selectedWorkers) {
      await api.createAttendance({ construction_id: selectedConstruction, worker_id: wid, work_date: workDate, hours, notes: dailyNotes });
    }
    setSelectedWorkers([]);
    setDailyNotes('');
    load();
  };

  const deleteAttendance = async (id: number) => {
    if (!confirm('削除しますか？')) return;
    await api.deleteAttendance(id);
    load();
  };

  const saveWorker = async () => {
    if (!wName.trim()) return;
    if (editingWorker) {
      await api.updateWorker({ id: editingWorker.id, name: wName, daily_rate: wRate, role: wRole, notes: '' });
    } else {
      await api.createWorker({ name: wName, daily_rate: wRate, role: wRole });
    }
    setWName(''); setWRate(25000); setWRole('作業員'); setEditingWorker(null);
    load();
  };

  const deleteWorker = async (id: number) => {
    if (!confirm('この作業者を削除しますか？')) return;
    await api.deleteWorker(id);
    load();
  };

  return (
    <div>
      <div className="page-header">
        <h1>📋 出面管理</h1>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['daily', 'workers', 'summary'] as const).map(t => (
          <button key={t} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab(t)}>
            {t === 'daily' ? '日報入力' : t === 'workers' ? '作業者管理' : '工数集計'}
          </button>
        ))}
      </div>

      {tab === 'daily' && (
        <>
          <div className="card">
            <h3 style={{ marginBottom: 12 }}>出面登録</h3>
            <div className="form-row">
              <div className="form-group">
                <label>日付</label>
                <input type="date" value={workDate} onChange={e => setWorkDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label>施工案件</label>
                <select value={selectedConstruction || ''} onChange={e => setSelectedConstruction(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">（選択してください）</option>
                  {constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>作業時間</label>
                <input type="number" value={hours} onChange={e => setHours(Number(e.target.value))} min={0.5} max={24} step={0.5} style={{ width: 80 }} />
              </div>
            </div>
            <div className="form-group">
              <label>作業者（複数選択可）</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                {workers.map((w: any) => (
                  <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: selectedWorkers.includes(w.id) ? '#e8f5e9' : '#f5f5f5', borderRadius: 6, cursor: 'pointer', border: selectedWorkers.includes(w.id) ? '2px solid #27ae60' : '2px solid transparent' }}>
                    <input type="checkbox" checked={selectedWorkers.includes(w.id)}
                      onChange={e => setSelectedWorkers(e.target.checked ? [...selectedWorkers, w.id] : selectedWorkers.filter(id => id !== w.id))} />
                    {w.name}（{w.role}・{fmt(w.daily_rate)}/日）
                  </label>
                ))}
                {workers.length === 0 && <span style={{ color: '#999' }}>作業者を先に登録してください</span>}
              </div>
            </div>
            <div className="form-group">
              <label>作業内容メモ</label>
              <input value={dailyNotes} onChange={e => setDailyNotes(e.target.value)} placeholder="例: 足場設置、2階部分" />
            </div>
            <button className="btn btn-primary" onClick={addAttendance}>登録</button>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3>出面一覧</h3>
              <input type="month" value={filterMonth} onChange={e => setFilterMonth(e.target.value)} />
            </div>
            <table className="data-table">
              <thead>
                <tr><th>日付</th><th>作業者</th><th>職種</th><th>施工案件</th><th style={{ textAlign: 'center' }}>時間</th><th style={{ textAlign: 'right' }}>日当</th><th>メモ</th><th></th></tr>
              </thead>
              <tbody>
                {attendance.map((a: any) => (
                  <tr key={a.id}>
                    <td>{a.work_date}</td>
                    <td>{a.worker_name}</td>
                    <td>{a.worker_role}</td>
                    <td>{a.construction_title || '—'}</td>
                    <td style={{ textAlign: 'center' }}>{a.hours}h</td>
                    <td style={{ textAlign: 'right' }}>{fmt(a.daily_rate * a.hours / 8)}</td>
                    <td style={{ color: '#888', fontSize: 12 }}>{a.notes}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => deleteAttendance(a.id)}>削除</button></td>
                  </tr>
                ))}
                {attendance.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', color: '#999' }}>データなし</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'workers' && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{editingWorker ? '作業者編集' : '作業者登録'}</h3>
          <div className="form-row">
            <div className="form-group">
              <label>名前</label>
              <input value={wName} onChange={e => setWName(e.target.value)} placeholder="例: 田中太郎" />
            </div>
            <div className="form-group">
              <label>職種</label>
              <select value={wRole} onChange={e => setWRole(e.target.value)}>
                {['作業員', '大工', '左官', 'とび工', '鉄筋工', '型枠工', '塗装工', '電気工', '配管工', '内装工', '解体工', '設備工', '重機オペ', '現場監督', 'ガードマン'].map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>日当（円）</label>
              <input type="number" value={wRate} onChange={e => setWRate(Number(e.target.value))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={saveWorker}>{editingWorker ? '更新' : '登録'}</button>
            {editingWorker && <button className="btn btn-secondary" onClick={() => { setEditingWorker(null); setWName(''); setWRate(25000); setWRole('作業員'); }}>キャンセル</button>}
          </div>

          <table className="data-table" style={{ marginTop: 16 }}>
            <thead>
              <tr><th>名前</th><th>職種</th><th style={{ textAlign: 'right' }}>日当</th><th></th></tr>
            </thead>
            <tbody>
              {workers.map((w: any) => (
                <tr key={w.id}>
                  <td><strong>{w.name}</strong></td>
                  <td>{w.role}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(w.daily_rate)}</td>
                  <td style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => { setEditingWorker(w); setWName(w.name); setWRate(w.daily_rate); setWRole(w.role); }}>編集</button>
                    <button className="btn btn-sm btn-danger" onClick={() => deleteWorker(w.id)}>削除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'summary' && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>工数集計（見積 vs 実績）</h3>
          <table className="data-table">
            <thead>
              <tr><th>施工案件</th><th style={{ textAlign: 'right' }}>見積人件費</th><th style={{ textAlign: 'right' }}>実績人件費</th><th style={{ textAlign: 'right' }}>差額</th><th style={{ textAlign: 'center' }}>出面数</th><th style={{ textAlign: 'center' }}>状況</th></tr>
            </thead>
            <tbody>
              {summary.map((s: any) => {
                const isOver = s.diff < 0;
                return (
                  <tr key={s.id}>
                    <td><strong>{s.title}</strong></td>
                    <td style={{ textAlign: 'right' }}>{fmt(s.estimated_labor || 0)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(s.actual_labor)}</td>
                    <td style={{ textAlign: 'right', color: isOver ? '#e74c3c' : '#27ae60', fontWeight: 'bold' }}>{s.diff >= 0 ? '+' : ''}{fmt(s.diff)}</td>
                    <td style={{ textAlign: 'center' }}>{s.attendance_count}件</td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 'bold', background: isOver ? '#fde8e8' : '#e8f5e9', color: isOver ? '#e74c3c' : '#27ae60' }}>
                        {isOver ? '超過' : '予算内'}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {summary.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: '#999' }}>データなし</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
