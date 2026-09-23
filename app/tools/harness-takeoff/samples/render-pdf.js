// 検証用図面の HTML を PDF にする（拾い出しは PDF をそのまま Claude に渡すため）。
//   npx electron render-pdf.js [<html>]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const src = process.argv.find((a) => a.endsWith('.html')) || path.join(__dirname, 'electrical-office.html');
const dest = src.replace(/\.html$/, '.pdf');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1200 });
  await win.loadFile(src);
  await new Promise((r) => setTimeout(r, 800));   // フォントの読み込み待ち
  const pdf = await win.webContents.printToPDF({
    pageSize: 'A3', landscape: true, printBackground: true, margins: { marginType: 'none' },
  });
  fs.writeFileSync(dest, pdf);
  console.log('書き出し: ' + dest + '（' + Math.round(pdf.length / 1024) + 'KB）');
  app.quit();
});
