import React, { useEffect, useState } from 'react';
import { PageGuide } from '../components/PageGuide';

const api = (window as any).api;
const categories = ['着工前', '施工中', '完了', '是正前', '是正後', '検査', 'その他'];
const workTypes = ['基礎', '躯体', '屋根', '外壁', '内装', '設備', '外構', 'その他'];
const catColor: Record<string, string> = { '着工前': '#3498db', '施工中': '#e67e22', '完了': '#27ae60', '是正前': '#e74c3c', '是正後': '#9b59b6', '検査': '#7f8c8d', 'その他': '#95a5a6' };

export default function PhotoLedgerPage() {
  const [tab, setTab] = useState<'upload' | 'view' | 'pdf'>('upload');
  const [constructions, setConstructions] = useState<any[]>([]);
  const [photos, setPhotos] = useState<any[]>([]);

  // upload form
  const [cid, setCid] = useState<number | null>(null);
  const [category, setCategory] = useState('施工中');
  const [workType, setWorkType] = useState('その他');
  const [location, setLocation] = useState('');
  const [photoDate, setPhotoDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [photoData, setPhotoData] = useState<string | null>(null);

  // view filters
  const [viewCid, setViewCid] = useState<number | null>(null);
  const [viewCat, setViewCat] = useState('');
  const [viewType, setViewType] = useState('');

  // pdf
  const [pdfCid, setPdfCid] = useState<number | null>(null);
  const [pdfCat, setPdfCat] = useState('');
  const [pdfType, setPdfType] = useState('');

  const load = async () => {
    const c = await api.listConstructions();
    setConstructions(c);
  };
  useEffect(() => { load(); }, []);

  const loadPhotos = async () => {
    const filter: any = {};
    if (viewCid) filter.construction_id = viewCid;
    if (viewCat) filter.category = viewCat;
    if (viewType) filter.work_type = viewType;
    const p = await api.listPhotoLedger(filter);
    setPhotos(p);
  };
  useEffect(() => { if (tab === 'view') loadPhotos(); }, [tab, viewCid, viewCat, viewType]);

  const selectPhoto = async () => {
    const result = await api.selectImage();
    if (result) setPhotoData(result);
  };

  const submit = async () => {
    if (!cid) return alert('施工案件を選択してください');
    if (!photoData) return alert('写真を選択してください');
    await api.addPhotoLedgerEntry({ construction_id: cid, photo_data: photoData, category, work_type: workType, location, photo_date: photoDate, notes });
    setPhotoData(null); setLocation(''); setNotes('');
    alert('写真を登録しました');
  };

  const deletePhoto = async (id: number) => {
    if (!confirm('この写真を削除しますか？')) return;
    await api.deletePhotoLedgerEntry(id);
    loadPhotos();
  };

  // Group photos by work_type
  const grouped = photos.reduce((acc: Record<string, any[]>, p: any) => {
    const key = p.work_type || 'その他';
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {} as Record<string, any[]>);

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>📷 現場写真台帳</h1>
        <PageGuide pageKey="photo-ledger" steps={[
          { icon: '📸', title: 'STEP 1：現場写真を登録', desc: '施工案件を選び、撮影日・カテゴリ・工種・撮影場所とともに写真をアップロードします。' },
          { icon: '🗂️', title: 'STEP 2：写真を閲覧・管理', desc: '案件・カテゴリ・工種で絞り込んで写真を一覧表示できます。', sub: '着工前・施工中・完了など工程別に整理されます' },
          { icon: '📄', title: 'STEP 3：写真台帳PDFを出力', desc: '案件ごとに写真台帳をPDF出力し、施主や元請けに提出できます。' },
        ]} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['upload', 'view', 'pdf'] as const).map(t => (
          <button key={t} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab(t)}>
            {t === 'upload' ? '写真登録' : t === 'view' ? '台帳ビュー' : 'PDF出力'}
          </button>
        ))}
      </div>

      {tab === 'upload' && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>写真登録</h3>
          <div className="form-row">
            <div className="form-group"><label>施工案件</label>
              <select value={cid || ''} onChange={e => setCid(e.target.value ? Number(e.target.value) : null)}>
                <option value="">（選択してください）</option>{constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="form-group"><label>撮影日</label><input type="date" value={photoDate} onChange={e => setPhotoDate(e.target.value)} /></div>
            <div className="form-group"><label>区分</label>
              <select value={category} onChange={e => setCategory(e.target.value)}>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group"><label>工種</label>
              <select value={workType} onChange={e => setWorkType(e.target.value)}>
                {workTypes.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>撮影場所</label><input value={location} onChange={e => setLocation(e.target.value)} placeholder="例: 1階リビング北側" /></div>
            <div className="form-group"><label>備考</label><input value={notes} onChange={e => setNotes(e.target.value)} placeholder="補足メモ" /></div>
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginTop: 8 }}>
            <div>
              <button className="btn btn-secondary" onClick={selectPhoto}>写真を選択</button>
              {photoData && (
                <div style={{ marginTop: 8, border: '2px solid #3498db', borderRadius: 8, overflow: 'hidden', width: 200, height: 150 }}>
                  <img src={photoData} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
              )}
            </div>
            <button className="btn btn-primary" onClick={submit} style={{ marginTop: 0 }}>登録</button>
          </div>
        </div>
      )}

      {tab === 'view' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <select value={viewCid || ''} onChange={e => setViewCid(e.target.value ? Number(e.target.value) : null)} style={{ padding: '6px 10px', borderRadius: 6 }}>
              <option value="">全案件</option>{constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <select value={viewCat} onChange={e => setViewCat(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6 }}>
              <option value="">全区分</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={viewType} onChange={e => setViewType(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6 }}>
              <option value="">全工種</option>{workTypes.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
            <span style={{ color: '#888', fontSize: 12, alignSelf: 'center' }}>{photos.length}枚</span>
          </div>

          {Object.keys(grouped).length === 0 && <div className="card" style={{ textAlign: 'center', color: '#999' }}>写真データなし</div>}
          {Object.entries(grouped).map(([type, pics]) => (
            <div key={type}>
              <h3 style={{ margin: '16px 0 8px', color: '#2e4057' }}>{type}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {(pics as any[]).map((p: any) => (
                  <div key={p.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    <div style={{ height: 180, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {p.photo_data ? <img src={p.photo_data} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#999' }}>写真なし</span>}
                    </div>
                    <div style={{ padding: 8 }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ background: catColor[p.category] || '#999', color: '#fff', padding: '1px 8px', borderRadius: 10, fontSize: 10 }}>{p.category}</span>
                        <span style={{ fontSize: 11, color: '#888' }}>{p.photo_date}</span>
                      </div>
                      {p.location && <div style={{ fontSize: 12 }}>{p.location}</div>}
                      {p.notes && <div style={{ fontSize: 11, color: '#666' }}>{p.notes}</div>}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                        <span style={{ fontSize: 10, color: '#aaa' }}>{p.construction_title}</span>
                        <button className="btn btn-sm btn-danger" onClick={() => deletePhoto(p.id)} style={{ fontSize: 10 }}>削除</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'pdf' && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>写真台帳PDF出力</h3>
          <p style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>A4縦・1ページ6枚の写真台帳を出力します。</p>
          <div className="form-row">
            <div className="form-group"><label>施工案件</label>
              <select value={pdfCid || ''} onChange={e => setPdfCid(e.target.value ? Number(e.target.value) : null)}>
                <option value="">全案件</option>{constructions.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="form-group"><label>区分</label>
              <select value={pdfCat} onChange={e => setPdfCat(e.target.value)}>
                <option value="">全区分</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group"><label>工種</label>
              <select value={pdfType} onChange={e => setPdfType(e.target.value)}>
                <option value="">全工種</option>{workTypes.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => api.generatePhotoLedgerPDF({ construction_id: pdfCid, category: pdfCat || undefined, work_type: pdfType || undefined })}>PDF出力</button>
        </div>
      )}
    </div>
  );
}
