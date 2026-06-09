import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { webApi } from './api-web';

// Electron なら window.api (preload) を使う。ブラウザなら fetch ベースの webApi を使う
if (!(window as any).api) {
  (window as any).api = webApi;
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

const root = createRoot(document.getElementById('root')!);
root.render(
  <>
    <div id="global-error" style={{
      display: 'none', position: 'fixed', top: 0, left: 0, right: 0,
      background: '#c0392b', color: '#fff', padding: '10px 20px',
      fontSize: 13, zIndex: 9999, textAlign: 'center',
    }} />
    <App />
  </>
);
