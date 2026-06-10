import React, { useEffect, useState } from 'react';

const api = (window as any).api;

export default function SafetyDocsPage() {
  const [tab, setTab] = useState<'workers' | 'education' | 'ky' | 'pdf'>('workers');
  const [workers, setWorkers] = useState<any[]>([]);
  const [constructions, setConstructions] = useState<any[]>([]);
  const [education, setEducation] = useState<any[]>([]);
  const [kyRecords, setKYRecords] = useState<any[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [filterCid, setFilterCid] = useState<number | null>(null);

  // safety info form
  const [si, setSi] = useState<any>({});

  // education form
  const [eduCid, setEduCid] = useState<number | null>(null);
  const [eduWorkerId, setEduWorkerId] = useState<number | null>(null);
  const [eduDate, setEduDate] = useState(new Date().toISOString().split('T')[0]);
  const [eduInstructor, setEduInstructor] = useState('');
  const [eduContent, setEduContent] = useState<string[]>([]);

  // KY form
  const [kyCid, setKyCid] = useState<number | null>(null);
  const [kyDate, setKyDate] = useState(new Date().toISOString().split('T')[0]);
  const [kyParticipants, setKyParticipants] = useState('');
  const [kyHazard, setKyHazard] = useState('');
  const [kyCounter, setKyCounter] = useState('');
  const [kyLeader, setKyLeader] = useState('');

  const load = async () => {
    const [w, c] = await Promise.all([api.listSafetyWorkers(), api.listConstructions()]);
    setWorkers(w);
    setConstructions(c);
    const ed = await api.listSafetyEducation(filterCid ? { construction_id: filterCid } : {});
    setEducation(ed);
    const ky = await api.listKYRecords(filterCid ? { construction_id: filterCid } : {});
    setKYRecords(ky);
  };
  useEffect(() => { load(); }, [filterCid]);

  const saveSafetyInfo = async (workerId: number) => {
    await api.updateSafetyInfo({ worker_id: workerId, ...si });
    setEditingId(null);
    setSi({});
    load();
  };

  const startEdit = (w: any) => {
    setEditingId(w.id);
    setSi({ blood_type: w.blood_type || '', emergency_contact: w.emergency_contact || '', emergency_tel: w.emergency_tel || '', health_check_date: w.health_check_date || '', insurance_type: w.insurance_type || '', certifications: w.certifications || '' });
  };

  const addEducation = async () => {
    if (!eduWorkerId) return alert('受講者を選択してください');
    await api.createSafetyEducation({ construction_id: eduCid, worker_id: eduWorkerId, education_date: eduDate, instructor: eduInstructor, content: eduContent.join(', ') });
    setEduWorkerId(null); setEduInstructor(''); setEduContent([]);
    load();
  };

  const toggleContent = (item: string) => {
    setEduContent(prev => prev.includes(item) ? prev.filter(c => c !== item) : [...prev, item]);
  };

  const addKY = async () => {
    if (!kyHazard.trim()) return alert('危険要因を入力してください');
    await api.createKYRecord({ construction_id: kyCid, activity_date: kyDate, participants: kyParticipants, hazard: kyHazard, countermeasures: kyCounter, leader: kyLeader });
    setKyHazard(''); setKyCounter(''); setKyParticipants(''); setKyLeader('');
    load();
  };

  const isExpired = (date: string) => {
    if (!date) return true;
    const d = new Date(date);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    return d < oneYearAgo;
  };

  // PDF form
  const [pdfType, setPdfType] = useState<'worker_list' | 'education' | 'ky'>('worker_list');
  const [pdfCid, setPdfCid] = useState<number | null>(null);

  return (
    <div>
      <div className="page-header"><h1>🦺 安全書類</h1></div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {([['workers', '作業員名簿'], ['education', '新規入場者教育'], ['ky', 'KY活動'], ['pdf', 'PDF出力']] as const).map(([k, label]) => (
          <button key={k} className={`btn ${tab === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab(k as any)}>{label}</button>
        ))}
      </div>

      {tab === 'workers' && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>作業員名簿（安全情報）</h3>
          <table className="data-table">
            <thead>
              <tr><th>氏名</th><th>職種</th><th>血液型</th><th>緊急連絡先</th><th>TEL</th><th>健康診断</th><th>保険</th><th>資格</th><th></th></tr>
            </thead>
            <tbody>
              {workers.map((w: any) => (
                editingId === w.id ? (
                  <tr key={w.id} style={{ background: '#fffde7' }}>
                    <td><strong>{w.name}</strong></td>
                    <td>{w.role}</td>
                    <td><select value={si.blood_type} onChange={e => setSi({ ...si, blood_type: e.target.value })} style={{ width: 60 }}>
                      <option value="">—</option>{['A', 'B', 'O', 'AB'].map(t => <option key={t} value={t}>{t}</option>)}
                    </select></td>
                    <td><input value={si.emergency_contact} onChange={e => setSi({ ...si, emergency_contact: e.target.value })} placeholder="名前" style={{ width: 90 }} /></td>
                    <td><input value={si.emergency_tel} onChange={e => setSi({ ...si, emergency_tel: e.target.value })} placeholder="電話" style={{ width: 110 }} /></td>
                    <td><input type="date" value={si.health_check_date} onChange={e => setSi({ ...si, health_check_date: e.target.value })} /></td>
                    <td><select value={si.insurance_type} onChange={e => setSi({ ...si, insurance_type: e.target.value })} style={{ width: 80 }}>
                      <option value="">—</option>{['社保', '国保', '建設国保', '組合保険'].map(t => <option key={t} value={t}>{t}</option>)}
                    </select></td>
                    <td><input value={si.certifications} onChange={e => setSi({ ...si, certifications: e.target.value })} placeholder="資格 (カンマ区切り)" style={{ width: 160 }} /></td>
                    <td style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-sm btn-primary" onClick={() => saveSafetyInfo(w.id)}>保存</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => setEditingId(null)}>×</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={w.id} style={{ background: isExpired(w.health_check_date) ? '#fff8e1' : 'transparent' }}>
                    <td><strong>{w.name}</strong></td>
                    <td>{w.role}</td>
                    <td style={{ textAlign: 'center' }}>{w.blood_type || '—'}</td>
                    <td>{w.emergency_contact || '—'}</td>
                    <td>{w.emergency_tel || '—'}</td>
                    <td style={{ color: isExpired(w.health_check_date) ? '#e67e22' : '#333' }}>
                      {w.health_check_date || '未登録'} {isExpired(w.health_check_date) && '⚠️'}
                    </td>
                    <td>{w.insurance_type || '—'}</td>
                    <td style={{ fontSize: 11 }}>{w.certifications || '—'}</td>
                    <td><button className="btn btn-sm btn-secondary" onClick={() => startEdit(w)}>編集</button></td>
                  </tr>
                )
              ))}
              {workers.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: '#999' }}>出面管理で先に作業者を登録してください</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'education' && (
        <div>
          <div className="card">
            <h3 style={{ marginBottom: 12 }}>新規入場者教育記録</h3>
            <div className="form-row">
              <div className="form-group"><label>施工案件</label>
                <select value={eduCid || ''} onChange={e => setEduCid(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">（選択）</option>{constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </div>
              <div className="form-group"><label>受講者</label>
                <select value={eduWorkerId || ''} onChange={e => setEduWorkerId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">（選択）</option>{workers.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
              <div className="form-group"><label>教育日</label><input type="date" value={eduDate} onChange={e => setEduDate(e.target.value)} /></div>
              <div className="form-group"><label>教育担当者</label><input value={eduInstructor} onChange={e => setEduInstructor(e.target.value)} /></div>
            </div>
            <div className="form-group">
              <label>教育内容</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                {['現場ルール', '危険箇所', '安全装備', '緊急連絡先', '資材置場', '搬入経路', '作業手順', 'その他'].map(item => (
                  <label key={item} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: eduContent.includes(item) ? '#e8f5e9' : '#f5f5f5', borderRadius: 6, cursor: 'pointer', border: eduContent.includes(item) ? '2px solid #27ae60' : '2px solid transparent' }}>
                    <input type="checkbox" checked={eduContent.includes(item)} onChange={() => toggleContent(item)} />{item}
                  </label>
                ))}
              </div>
            </div>
            <button className="btn btn-primary" onClick={addEducation}>登録</button>
          </div>
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3>教育記録一覧</h3>
              <select value={filterCid || ''} onChange={e => setFilterCid(e.target.value ? Number(e.target.value) : null)} style={{ padding: '4px 8px', borderRadius: 6 }}>
                <option value="">全案件</option>{constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <table className="data-table">
              <thead><tr><th>教育日</th><th>施工案件</th><th>受講者</th><th>教育担当</th><th>内容</th><th></th></tr></thead>
              <tbody>
                {education.map((e: any) => (
                  <tr key={e.id}>
                    <td>{e.education_date}</td><td>{e.construction_title || '—'}</td><td>{e.worker_name || '—'}</td>
                    <td>{e.instructor}</td><td style={{ fontSize: 11 }}>{e.content}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => { api.deleteSafetyEducation(e.id).then(load); }}>削除</button></td>
                  </tr>
                ))}
                {education.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: '#999' }}>データなし</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'ky' && (
        <div>
          <div className="card">
            <h3 style={{ marginBottom: 12 }}>KY活動記録（危険予知活動）</h3>
            <div className="form-row">
              <div className="form-group"><label>施工案件</label>
                <select value={kyCid || ''} onChange={e => setKyCid(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">（選択）</option>{constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </div>
              <div className="form-group"><label>実施日</label><input type="date" value={kyDate} onChange={e => setKyDate(e.target.value)} /></div>
              <div className="form-group"><label>リーダー</label><input value={kyLeader} onChange={e => setKyLeader(e.target.value)} /></div>
            </div>
            <div className="form-group"><label>参加者</label><input value={kyParticipants} onChange={e => setKyParticipants(e.target.value)} placeholder="例: 田中、佐藤、鈴木" /></div>
            <div className="form-group"><label>危険要因</label><textarea rows={2} value={kyHazard} onChange={e => setKyHazard(e.target.value)} placeholder="どんな危険があるか" style={{ width: '100%' }} /></div>
            <div className="form-group"><label>対策</label><textarea rows={2} value={kyCounter} onChange={e => setKyCounter(e.target.value)} placeholder="どう防ぐか" style={{ width: '100%' }} /></div>
            <button className="btn btn-primary" onClick={addKY}>登録</button>
          </div>
          <div className="card" style={{ marginTop: 16 }}>
            <h3 style={{ marginBottom: 12 }}>KY活動一覧</h3>
            <table className="data-table">
              <thead><tr><th>実施日</th><th>施工案件</th><th>リーダー</th><th>参加者</th><th>危険要因</th><th>対策</th><th></th></tr></thead>
              <tbody>
                {kyRecords.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.activity_date}</td><td>{r.construction_title || '—'}</td><td>{r.leader}</td>
                    <td style={{ fontSize: 11 }}>{r.participants}</td><td style={{ fontSize: 11 }}>{r.hazard}</td><td style={{ fontSize: 11 }}>{r.countermeasures}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => { api.deleteKYRecord(r.id).then(load); }}>削除</button></td>
                  </tr>
                ))}
                {kyRecords.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: '#999' }}>データなし</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'pdf' && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>安全書類PDF出力</h3>
          <div className="form-row">
            <div className="form-group"><label>書類種別</label>
              <select value={pdfType} onChange={e => setPdfType(e.target.value as any)}>
                <option value="worker_list">作業員名簿</option>
                <option value="education">新規入場者教育記録</option>
                <option value="ky">KY活動記録</option>
              </select>
            </div>
            <div className="form-group"><label>施工案件（任意）</label>
              <select value={pdfCid || ''} onChange={e => setPdfCid(e.target.value ? Number(e.target.value) : null)}>
                <option value="">全案件</option>{constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => api.generateSafetyPDF({ type: pdfType, construction_id: pdfCid })}>PDF出力</button>
        </div>
      )}
    </div>
  );
}
