import React, { useEffect, useState, useMemo } from 'react';
import { PageGuide } from '../components/PageGuide';

const api = (window as any).api;

export default function GanttPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [constructions, setConstructions] = useState<any[]>([]);
  const [filterCid, setFilterCid] = useState<number | null>(null);
  const [viewMonths, setViewMonths] = useState(3);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  // 折りたたんでいる案件（フォルダ）。案件IDの集合。案件なしは 0 で持つ。
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  // form
  const today = new Date().toISOString().split('T')[0];
  const [taskName, setTaskName] = useState('');
  const [cid, setCid] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [prog, setProg] = useState(0);
  const [assignee, setAssignee] = useState('');
  const [color, setColor] = useState('#3498db');

  const load = async () => {
    const [t, c] = await Promise.all([api.listGanttTasks(filterCid ? { construction_id: filterCid } : {}), api.listConstructions()]);
    setTasks(t);
    setConstructions(c);
  };
  useEffect(() => { load(); }, [filterCid]);

  const save = async () => {
    if (!taskName.trim()) return alert('タスク名を入力してください');
    if (editing) {
      await api.updateGanttTask({ id: editing.id, construction_id: cid, task_name: taskName, assignee, start_date: startDate, end_date: endDate, progress: prog, color, dependencies: '', sort_order: 0 });
    } else {
      await api.createGanttTask({ construction_id: cid, task_name: taskName, assignee, start_date: startDate, end_date: endDate, progress: prog, color });
    }
    resetForm();
    load();
  };

  const resetForm = () => {
    setTaskName(''); setCid(null); setStartDate(today); setEndDate(today); setProg(0); setAssignee(''); setColor('#3498db');
    setEditing(null); setShowForm(false);
  };

  const editTask = (t: any) => {
    setTaskName(t.task_name); setCid(t.construction_id); setStartDate(t.start_date); setEndDate(t.end_date);
    setProg(t.progress); setAssignee(t.assignee || ''); setColor(t.color || '#3498db');
    setEditing(t); setShowForm(true);
  };

  const deleteTask = async (id: number) => {
    if (!confirm('削除しますか？')) return;
    await api.deleteGanttTask(id);
    load();
  };

  const deleteGroup = async (g: any) => {
    if (!confirm(`「${g.title}」の工程 ${g.tasks.length}件をまとめて削除しますか？`)) return;
    for (const t of g.tasks) await api.deleteGanttTask(t.id);
    load();
  };

  // ── 案件ごとのフォルダにまとめる ──
  //   工程表は案件が増えるほど一本の長い表になって、どれがどの現場か分からなくなる。
  //   案件を1つのフォルダにして、開け閉めできるようにする。
  const groups = useMemo(() => {
    const map = new Map<number, any>();
    for (const t of tasks) {
      const key = t.construction_id || 0;
      if (!map.has(key)) {
        map.set(key, { key, title: t.construction_title || (key === 0 ? '案件なし' : `案件 #${key}`), tasks: [] });
      }
      map.get(key).tasks.push(t);
    }
    const list = Array.from(map.values());
    for (const g of list) {
      g.tasks.sort((a: any, b: any) => (a.sort_order - b.sort_order) || String(a.start_date).localeCompare(String(b.start_date)));
      g.start = g.tasks.reduce((m: string, t: any) => (!m || t.start_date < m ? t.start_date : m), '');
      g.end = g.tasks.reduce((m: string, t: any) => (!m || t.end_date > m ? t.end_date : m), '');
      g.progress = Math.round(g.tasks.reduce((s: number, t: any) => s + (t.progress || 0), 0) / g.tasks.length);
      g.delayed = g.tasks.filter((t: any) => t.progress < 100 && t.end_date < today).length;
    }
    // 着手が早い現場を上に。案件なしは一番下。
    list.sort((a, b) => (a.key === 0 ? 1 : b.key === 0 ? -1 : String(a.start).localeCompare(String(b.start))));
    return list;
  }, [tasks, today]);

  // 左の一覧と右のバーで行がずれないよう、フォルダ行とタスク行を1本の配列にしてから描く
  const rows = useMemo(() => {
    const out: any[] = [];
    for (const g of groups) {
      out.push({ type: 'folder', g });
      if (!collapsed.has(g.key)) for (const t of g.tasks) out.push({ type: 'task', t });
    }
    return out;
  }, [groups, collapsed]);

  const toggle = (key: number) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Gantt chart calculations
  const { chartStart, dayCount, dayWidth } = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + viewMonths, 0);
    const days = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
    const w = viewMonths <= 1 ? 28 : viewMonths <= 3 ? 10 : 5;
    return { chartStart: start, dayCount: days, dayWidth: w };
  }, [viewMonths]);

  const daysBetween = (a: Date, b: Date) => Math.ceil((b.getTime() - a.getTime()) / 86400000);
  const todayOffset = daysBetween(chartStart, new Date());

  // Week headers
  const weeks = useMemo(() => {
    const result: { label: string; offset: number; width: number }[] = [];
    const d = new Date(chartStart);
    while (d.getTime() < chartStart.getTime() + dayCount * 86400000) {
      const daysLeft = Math.min(7 - d.getDay(), dayCount - daysBetween(chartStart, d));
      result.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, offset: daysBetween(chartStart, d) * dayWidth, width: Math.max(daysLeft, 1) * dayWidth });
      d.setDate(d.getDate() + daysLeft);
    }
    return result;
  }, [chartStart, dayCount, dayWidth]);

  const barGeom = (start: string, end: string) => {
    const s = new Date(start);
    const e = new Date(end);
    return {
      left: daysBetween(chartStart, s) * dayWidth,
      width: Math.max((daysBetween(s, e) + 1) * dayWidth, dayWidth),
    };
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>📊 工程表</h1>
        <PageGuide pageKey="gantt" steps={[
          { icon: '📁', title: 'STEP 1：案件ごとのフォルダ', desc: '工程は案件ごとにまとまっています。📁をクリックすると開け閉めできます。', sub: 'AI見積から自動登録すると、職人さんの予定がここに入ります' },
          { icon: '📅', title: 'STEP 2：タスクを足す', desc: '「+ タスク追加」から工程名・担当者・開始日・終了日を入力します。' },
          { icon: '✏️', title: 'STEP 3：進捗を更新', desc: 'タスクをクリックして進捗率を更新し、工程の遅れを早期に把握できます。' },
        ]} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={filterCid || ''} onChange={e => setFilterCid(e.target.value ? Number(e.target.value) : null)} style={{ padding: '6px 10px', borderRadius: 6 }}>
          <option value="">全案件</option>
          {constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        {[1, 3, 6].map(m => (
          <button key={m} className={`btn btn-sm ${viewMonths === m ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setViewMonths(m)}>{m}ヶ月</button>
        ))}
        <button className="btn btn-primary" onClick={() => { resetForm(); setShowForm(true); }}>+ タスク追加</button>
        {groups.length > 1 && (
          <>
            <button className="btn btn-sm btn-secondary" onClick={() => setCollapsed(new Set(groups.map(g => g.key)))}>すべて閉じる</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setCollapsed(new Set())}>すべて開く</button>
          </>
        )}
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>{editing ? 'タスク編集' : 'タスク追加'}</h3>
          <div className="form-row">
            <div className="form-group"><label>タスク名</label><input value={taskName} onChange={e => setTaskName(e.target.value)} placeholder="例: 基礎工事" /></div>
            <div className="form-group"><label>施工案件</label>
              <select value={cid || ''} onChange={e => setCid(e.target.value ? Number(e.target.value) : null)}>
                <option value="">（任意）</option>{constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="form-group"><label>担当者</label><input value={assignee} onChange={e => setAssignee(e.target.value)} placeholder="例: 田中" /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>開始日</label><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
            <div className="form-group"><label>終了日</label><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></div>
            <div className="form-group"><label>進捗: {prog}%</label><input type="range" min={0} max={100} step={5} value={prog} onChange={e => setProg(Number(e.target.value))} /></div>
            <div className="form-group"><label>色</label><input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ width: 50, height: 32 }} /></div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={save}>{editing ? '更新' : '追加'}</button>
            <button className="btn btn-secondary" onClick={resetForm}>キャンセル</button>
          </div>
        </div>
      )}

      {/* Gantt Chart */}
      <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
        <div style={{ display: 'flex' }}>
          {/* Left labels */}
          <div style={{ minWidth: 300, borderRight: '2px solid #ddd', flexShrink: 0 }}>
            <div style={{ height: 36, background: '#2e4057', color: '#fff', padding: '8px 12px', fontSize: 11, fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
              <span>案件 / タスク</span><span>操作</span>
            </div>
            {rows.map((row: any, i: number) => {
              if (row.type === 'folder') {
                const g = row.g;
                const isOpen = !collapsed.has(g.key);
                return (
                  <div key={'g' + g.key} onClick={() => toggle(g.key)}
                    style={{ height: 40, display: 'flex', alignItems: 'center', padding: '0 8px', borderBottom: '1px solid #dfe6ee', background: '#eef2f7', fontSize: 12, gap: 6, cursor: 'pointer' }}>
                    <span style={{ fontSize: 11, color: '#5b6678', width: 12 }}>{isOpen ? '▾' : '▸'}</span>
                    <span>📁</span>
                    <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <strong style={{ color: '#1a2b4a' }}>{g.title}</strong>
                      <span style={{ color: '#7a8697', fontSize: 10, marginLeft: 6 }}>{g.tasks.length}件</span>
                      {g.delayed > 0 && <span style={{ color: '#c0392b', fontSize: 10, marginLeft: 6 }}>遅延{g.delayed}</span>}
                    </div>
                    <span style={{ fontSize: 10, color: g.progress >= 100 ? '#27ae60' : '#5b6678', minWidth: 28 }}>{g.progress}%</span>
                    <button onClick={e => { e.stopPropagation(); deleteGroup(g); }}
                      title="この案件の工程をまとめて削除"
                      style={{ background: '#fde8e8', border: '1px solid #f5c6cb', borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '2px 6px' }}>🗑️</button>
                  </div>
                );
              }
              const t = row.t;
              const isDelayed = t.progress < 100 && t.end_date < today;
              return (
                <div key={t.id} style={{ height: 40, display: 'flex', alignItems: 'center', padding: '0 8px 0 26px', borderBottom: '1px solid #eee', fontSize: 12, background: isDelayed ? '#fde8e8' : 'transparent', gap: 6 }}>
                  {isDelayed && <span>⚠️</span>}
                  <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <strong>{t.task_name}</strong>
                    {t.assignee && <span style={{ color: '#888', fontSize: 10, marginLeft: 4 }}>{t.assignee}</span>}
                  </div>
                  <span style={{ fontSize: 10, color: t.progress >= 100 ? '#27ae60' : '#888', minWidth: 28 }}>{t.progress}%</span>
                  <button onClick={() => editTask(t)} style={{ background: '#f0f0f0', border: '1px solid #ddd', borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '2px 6px' }}>✏️</button>
                  <button onClick={() => deleteTask(t.id)} style={{ background: '#fde8e8', border: '1px solid #f5c6cb', borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '2px 6px' }}>🗑️</button>
                </div>
              );
            })}
            {rows.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>タスクなし</div>}
          </div>

          {/* Right chart */}
          <div style={{ overflow: 'auto', flex: 1 }}>
            <div style={{ minWidth: dayCount * dayWidth, position: 'relative' }}>
              {/* Week headers */}
              <div style={{ height: 36, background: '#2e4057', display: 'flex', position: 'relative' }}>
                {weeks.map((w, i) => (
                  <div key={i} style={{ position: 'absolute', left: w.offset, width: w.width, color: '#fff', fontSize: 9, padding: '10px 2px', borderLeft: '1px solid #3a5068', textAlign: 'center', overflow: 'hidden' }}>
                    {w.label}
                  </div>
                ))}
              </div>

              {/* Task bars */}
              {rows.map((row: any) => {
                if (row.type === 'folder') {
                  const g = row.g;
                  const { left, width } = barGeom(g.start, g.end);
                  return (
                    <div key={'g' + g.key} style={{ height: 40, position: 'relative', borderBottom: '1px solid #dfe6ee', background: '#eef2f7' }}>
                      <div style={{ position: 'absolute', left, top: 14, width, height: 12, background: '#c3d0e0', borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ width: `${g.progress}%`, height: '100%', background: '#1a2b4a', borderRadius: 6 }} />
                      </div>
                    </div>
                  );
                }
                const t = row.t;
                const { left, width } = barGeom(t.start_date, t.end_date);
                const isDelayed = t.progress < 100 && t.end_date < today;
                const barColor = isDelayed ? '#e74c3c' : t.progress >= 100 ? '#27ae60' : (t.color || '#3498db');
                return (
                  <div key={t.id} style={{ height: 40, position: 'relative', borderBottom: '1px solid #f0f0f0' }}>
                    <div style={{ position: 'absolute', left, top: 8, width, height: 24, background: '#e0e0e0', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${t.progress}%`, height: '100%', background: barColor, borderRadius: 4, transition: 'width 0.3s' }} />
                      <span style={{ position: 'absolute', left: 4, top: 4, fontSize: 10, color: '#333', fontWeight: 'bold' }}>
                        {t.assignee && `${t.assignee} `}{t.progress}%
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Today line */}
              {todayOffset >= 0 && todayOffset <= dayCount && (
                <div style={{ position: 'absolute', top: 36, left: todayOffset * dayWidth, width: 2, height: rows.length * 40, background: '#e74c3c', zIndex: 10, pointerEvents: 'none' }}>
                  <div style={{ position: 'absolute', top: 2, left: 4, fontSize: 9, color: '#e74c3c', fontWeight: 'bold', whiteSpace: 'nowrap' }}>今日</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Summary */}
      {tasks.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <div className="card" style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 'bold', color: '#2e4057' }}>{groups.length}</div>
            <div style={{ fontSize: 12, color: '#888' }}>案件</div>
          </div>
          <div className="card" style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 'bold', color: '#2e4057' }}>{tasks.length}</div>
            <div style={{ fontSize: 12, color: '#888' }}>総タスク</div>
          </div>
          <div className="card" style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 'bold', color: '#27ae60' }}>{tasks.filter((t: any) => t.progress >= 100).length}</div>
            <div style={{ fontSize: 12, color: '#888' }}>完了</div>
          </div>
          <div className="card" style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 'bold', color: '#e74c3c' }}>{tasks.filter((t: any) => t.progress < 100 && t.end_date < today).length}</div>
            <div style={{ fontSize: 12, color: '#888' }}>遅延</div>
          </div>
          <div className="card" style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 'bold', color: '#3498db' }}>{tasks.length > 0 ? Math.round(tasks.reduce((s: number, t: any) => s + t.progress, 0) / tasks.length) : 0}%</div>
            <div style={{ fontSize: 12, color: '#888' }}>平均進捗</div>
          </div>
        </div>
      )}
    </div>
  );
}
