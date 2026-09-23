// 目視確認用に PNG も出す（記号が重なっていないか等を人が見るため）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const src = path.join(__dirname, 'electrical-office.html');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 2380, height: 1683, webPreferences: { zoomFactor: 1 } });
  await win.loadFile(src);
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'electrical-office.png'), img.toPNG());
  console.log('PNG 書き出し');
  app.quit();
});
