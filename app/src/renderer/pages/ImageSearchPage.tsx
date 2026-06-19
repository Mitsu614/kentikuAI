import React, { useState, useRef } from 'react';
import { PageGuide } from '../components/PageGuide';

const QUICK_TAGS = [
  'キッチン リフォーム 完成', '浴室 リフォーム after', '耐震補強 施工事例',
  'LDK リノベーション', '外壁塗装 ビフォーアフター', '木造 新築 内装',
  '解体工事 現場', 'フローリング 張替え', 'クロス 張替え 施工例',
  'ユニットバス 設置', 'システムキッチン 対面', '屋根 葺き替え',
  'トイレ リフォーム', '和室 洋室 リフォーム', '間取り図 3LDK',
];

export default function ImageSearchPage() {
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const webviewRef = useRef<HTMLIFrameElement>(null);

  const search = (q?: string) => {
    const searchQuery = q || query;
    if (!searchQuery.trim()) return;
    setActiveQuery(searchQuery);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') search();
  };

  const googleUrl = activeQuery
    ? `https://www.google.com/search?q=${encodeURIComponent(activeQuery + ' 施工事例')}&tbm=isch`
    : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h1>画像検索</h1>
          <PageGuide pageKey="image-search" steps={[
            { icon: '🔍', title: 'STEP 1：検索ワードを入力', desc: '施工事例のキーワードを入力して検索します。', sub: 'クイックタグをクリックして素早く検索することもできます' },
            { icon: '🖼️', title: 'STEP 2：施工事例画像を閲覧', desc: 'Google画像検索で施工事例の写真を閲覧できます。お客様への提案資料に活用できます。' },
          ]} />
        </div>

        {/* 検索バー */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="検索ワードを入力（例: キッチン リフォーム 完成）"
            style={{
              flex: 1, padding: '10px 16px', border: '2px solid #ddd', borderRadius: 8,
              fontSize: 15, outline: 'none',
            }}
            onFocus={e => (e.target as HTMLInputElement).style.borderColor = '#3a7bd5'}
            onBlur={e => (e.target as HTMLInputElement).style.borderColor = '#ddd'}
          />
          <button className="btn btn-primary" onClick={() => search()} style={{ fontSize: 15, padding: '10px 24px' }}>
            🔍 検索
          </button>
        </div>

        {/* クイックタグ */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {QUICK_TAGS.map(tag => (
            <button
              key={tag}
              onClick={() => { setQuery(tag); search(tag); }}
              style={{
                padding: '4px 10px', border: '1px solid #ddd', borderRadius: 16,
                background: activeQuery === tag ? '#3a7bd5' : '#f8f9fa',
                color: activeQuery === tag ? '#fff' : '#555',
                fontSize: 12, cursor: 'pointer', transition: 'all 0.15s',
              }}
            >{tag}</button>
          ))}
        </div>
      </div>

      {/* 検索結果 */}
      {activeQuery ? (
        <div style={{ flex: 1, margin: '0 24px 16px', borderRadius: 8, overflow: 'hidden', border: '1px solid #ddd' }}>
          <webview
            ref={webviewRef as any}
            src={googleUrl}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🔍</div>
            <div style={{ fontSize: 16 }}>施工事例・完成写真を検索</div>
            <div style={{ fontSize: 13, marginTop: 8 }}>検索ワードを入力するか、タグをクリックしてください</div>
          </div>
        </div>
      )}
    </div>
  );
}
