// 差し込み後のHTMLを、PDFとPNGにする（目で確かめる用）。
//   npx electron tools/harness-estimate-template/render.js "<filled.html>"
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const src = process.argv.find((a) => a.endsWith('.html'));
if (!src) { console.error('HTMLのパスを渡してください'); process.exit(1); }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { defaultEncoding: 'utf-8' } });
  await win.loadFile(src);
  await new Promise((r) => setTimeout(r, 800));
  const pdf = await win.webContents.printToPDF({ printBackground: true, margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 } });
  fs.writeFileSync(src.replace(/\.html$/, '.pdf'), pdf);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(src.replace(/\.html$/, '.png'), img.toPNG());
  console.log('PDF/PNG を書き出しました: ' + src.replace(/\.html$/, '.pdf'));
  app.quit();
});
