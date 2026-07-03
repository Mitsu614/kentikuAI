import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { webApi } from './api-web';

// Electron なら window.api (preload) を使う。ブラウザなら fetch ベースの webApi を使う
if (!(window as any).api) {
  (window as any).api = webApi;
  (window as any).__isWeb = true; // ブラウザ(スマホ)モード → 未対応ページを隠すため
}

// グローバルエラーハンドラ
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason);
  if (msg.includes('No handler registered')) return; // IPC未登録は無視
  console.error('Unhandled:', msg);
  const el = document.getElementById('global-error');
  if (el) {
    el.textContent = 'エラー: ' + msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }
});

// レンダリング中のエラーで真っ白になるのを防ぐ。白画面の代わりに内容を表示し、復旧手段も出す。
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: any }> {
  constructor(props: any) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error: any) { return { error }; }
  componentDidCatch(error: any, info: any) { console.error('React render error:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 640, margin: '32px auto', color: '#333' }}>
          <h2 style={{ color: '#c0392b', fontSize: 18 }}>画面の表示でエラーが発生しました</h2>
          <p style={{ fontSize: 13, color: '#666', marginTop: 8 }}>下のボタンでキャッシュを消して再読み込みすると直ることが多いです。改善しない場合は、この内容をお知らせください。</p>
          <pre style={{ background: '#f6f6f6', padding: 12, borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 12 }}>{String(this.state.error?.message || this.state.error)}</pre>
          <button onClick={async () => {
            try {
              if ('serviceWorker' in navigator) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); }
              if ((window as any).caches) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); }
            } catch (_) {}
            setTimeout(() => location.reload(), 300);
          }} style={{ marginTop: 14, padding: '12px 24px', background: '#3a7bd5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 'bold' }}>
            キャッシュを消して再読み込み
          </button>
        </div>
      );
    }
    return this.props.children as any;
  }
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <>
    <div id="global-error" style={{
      display: 'none', position: 'fixed', top: 0, left: 0, right: 0,
      background: '#c0392b', color: '#fff', padding: '10px 20px',
      fontSize: 13, zIndex: 9999, textAlign: 'center',
    }} />
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </>
);
