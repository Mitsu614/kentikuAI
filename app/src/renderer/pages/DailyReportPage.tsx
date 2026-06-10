import React, { useEffect, useState } from 'react';

const api = (window as any).api;
const weatherIcons: Record<string, string> = { '晴れ': '☀️', '曇り': '☁️', '雨': '🌧️', '雪': '❄️' };

export default function DailyReportPage() {
  const [tab, setTab] = useState<'input' | 'list' | 'pdf'>('input');
  const [constructions, setConstructions] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [filterMonth, setFilterMonth] = useState(new Date().toISOString().slice(0, 7));

  // form
  const [reportDate, setReportDate] = useState(new Date().toISOString().split('T')[0]);
  const [constructionId, setConstructionId] = useState<number | null>(null);
  const [weather, setWeather] = useState('晴れ');
  const [tempMin, setTempMin] = useState<number | ''>('');
  const [tempMax, setTempMax] = useState<number | ''>('');
  const [progress, setProgress] = useState(0);
  const [workContent, setWorkContent] = useState('');
  const [safetyNotes, setSafetyNotes] = useState('');
  const [tomorrowPlan, setTomorrowPlan] = useState('');

  // pdf
  const [pdfStart, setPdfStart] = useState(new Date().toISOString().slice(0, 7) + '-01');
  const [pdfEnd, setPdfEnd] = useState(new Date().toISOString().split('T')[0]);
  const [pdfConstructionId, setPdfConstructionId] = useState<number | null>(null);

  const load = async () => {
    const c = await api.listConstructions();
    setConstructions(c);
    const r = await api.listDailyReports({ month: filterMonth });
    setReports(r);
  };
  useEffect(() => { load(); }, [filterMonth]);

  const submit = async () => {
    if (!constructionId) return alert('施工案件を選択してください');
    await api.createDailyReport({
      construction_id: constructionId, report_date: reportDate, weather,
      temp_min: tempMin === '' ? null : tempMin, temp_max: tempMax === '' ? null : tempMax,
      progress, work_content: workContent, safety_notes: safetyNotes, tomorrow_plan: tomorrowPlan,
    });
    setWorkContent(''); setSafetyNotes(''); setTomorrowPlan('');
    load();
    alert('日報を登録しました');
  };

  const deleteReport = async (id: number) => {
    if (!confirm('この日報を削除しますか？')) return;
    await api.deleteDailyReport(id);
    load();
  };

  const generatePDF = async () => {
    await api.generateDailyReportPDF({ startDate: pdfStart, endDate: pdfEnd, construction_id: pdfConstructionId });
  };

  return (
    <div>
      <div className="page-header"><h1>📓 作業日報</h1></div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['input', 'list', 'pdf'] as const).map(t => (
          <button key={t} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab(t)}>
            {t === 'input' ? '日報入力' : t === 'list' ? '日報一覧' : 'PDF出力'}
          </button>
        ))}
      </div>

      {tab === 'input' && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>日報入力</h3>
          <div className="form-row">
            <div className="form-group">
              <label>日付</label>
              <input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} />
            </div>
            <div className="form-group">
              <label>施工案件</label>
              <select value={constructionId || ''} onChange={e => setConstructionId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">（選択してください）</option>
                {constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>天候</label>
              <select value={weather} onChange={e => setWeather(e.target.value)}>
                {Object.keys(weatherIcons).map(w => <option key={w} value={w}>{weatherIcons[w]} {w}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>最低気温 (℃)</label>
              <input type="number" value={tempMin} onChange={e => setTempMin(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 80 }} />
            </div>
            <div className="form-group">
              <label>最高気温 (℃)</label>
              <input type="number" value={tempMax} onChange={e => setTempMax(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 80 }} />
            </div>
            <div className="form-group">
              <label>進捗率: {progress}%</label>
              <input type="range" min={0} max={100} step={5} value={progress} onChange={e => setProgress(Number(e.target.value))} />
            </div>
          </div>
          <div className="form-group">
            <label>作業内容</label>
            <textarea rows={3} value={workContent} onChange={e => setWorkContent(e.target.value)} placeholder="本日の作業内容を記入" style={{ width: '100%' }} />
          </div>
          <div className="form-row">
            <div className="form-group" style={{ flex: 1 }}>
              <label>安全事項・特記事項</label>
              <textarea rows={2} value={safetyNotes} onChange={e => setSafetyNotes(e.target.value)} placeholder="ヒヤリハット、安全注意点など" style={{ width: '100%' }} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>明日の予定</label>
              <textarea rows={2} value={tomorrowPlan} onChange={e => setTomorrowPlan(e.target.value)} placeholder="翌日の作業予定" style={{ width: '100%' }} />
            </div>
          </div>
          <button className="btn btn-primary" onClick={submit}>日報を登録</button>
        </div>
      )}

      {tab === 'list' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <input type="month" value={filterMonth} onChange={e => setFilterMonth(e.target.value)} />
          </div>
          {reports.length === 0 && <div className="card" style={{ textAlign: 'center', color: '#999' }}>日報データなし</div>}
          {reports.map((r: any) => (
            <div key={r.id} className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: 24 }}>{weatherIcons[r.weather] || '🌤️'}</span>
                  <div>
                    <strong>{r.report_date}</strong>
                    <span style={{ marginLeft: 8, color: '#888' }}>{r.weather} {r.temp_min != null ? `${r.temp_min}〜${r.temp_max}℃` : ''}</span>
                  </div>
                  <span style={{ background: '#e8f0fe', color: '#1a73e8', padding: '2px 10px', borderRadius: 10, fontSize: 12 }}>
                    {r.construction_title || '—'}
                  </span>
                  <span style={{ background: r.progress >= 100 ? '#e8f5e9' : '#fff3e0', color: r.progress >= 100 ? '#27ae60' : '#e67e22', padding: '2px 10px', borderRadius: 10, fontSize: 12, fontWeight: 'bold' }}>
                    {r.progress}%
                  </span>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => deleteReport(r.id)}>削除</button>
              </div>
              {r.work_content && <div style={{ marginTop: 8, fontSize: 13, whiteSpace: 'pre-wrap' }}>{r.work_content}</div>}
              <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                {r.safety_notes && <div style={{ fontSize: 12, color: '#e74c3c' }}>⚠️ {r.safety_notes}</div>}
                {r.tomorrow_plan && <div style={{ fontSize: 12, color: '#3498db' }}>📌 明日: {r.tomorrow_plan}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'pdf' && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>日報PDF出力</h3>
          <div className="form-row">
            <div className="form-group">
              <label>開始日</label>
              <input type="date" value={pdfStart} onChange={e => setPdfStart(e.target.value)} />
            </div>
            <div className="form-group">
              <label>終了日</label>
              <input type="date" value={pdfEnd} onChange={e => setPdfEnd(e.target.value)} />
            </div>
            <div className="form-group">
              <label>施工案件（任意）</label>
              <select value={pdfConstructionId || ''} onChange={e => setPdfConstructionId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">全案件</option>
                {constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
          </div>
          <button className="btn btn-primary" onClick={generatePDF}>PDF出力</button>
        </div>
      )}
    </div>
  );
}
