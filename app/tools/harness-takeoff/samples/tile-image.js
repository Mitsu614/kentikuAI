// 図面を分割して拡大した画像を作る（人が数えるため）。
//   npx electron tools/harness-takeoff/samples/tile-image.js "<画像>" [列数] [倍率] [重なり]
//
// 低解像度の図面は、1枚のまま見ても記号が潰れて数えられない。
// 重なりを持たせて分割し、境目の器具を取りこぼさないようにする。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('.js'));
const src = args.find((a) => /\.(png|jpg|jpeg|webp)$/i.test(a));
const cols = Number(args[1]) || 3;
const scale = Number(args[2]) || 4;
const OVERLAP = args[3] !== undefined ? Number(args[3]) : 0.12;          // 隣のタイルと重ねる割合（境目の器具を数え落とさない）

if (!src) { console.error('画像のパスを渡してください'); process.exit(1); }
const outDir = path.join(__dirname, 'tiles');
fs.mkdirSync(outDir, { recursive: true });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body style="margin:0">');
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(src).toString('base64');

  const tiles = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cols = ${cols}, scale = ${scale}, ov = ${OVERLAP};
        const tw = img.width / cols, th = img.height / cols;
        const out = [];
        for (let r = 0; r < cols; r++) {
          for (let c = 0; c < cols; c++) {
            const sx = Math.max(0, tw * c - tw * ov);
            const sy = Math.max(0, th * r - th * ov);
            const sw = Math.min(img.width - sx, tw * (1 + ov * 2));
            const sh = Math.min(img.height - sy, th * (1 + ov * 2));
            const cv = document.createElement('canvas');
            cv.width = Math.round(sw * scale);
            cv.height = Math.round(sh * scale);
            const g = cv.getContext('2d');
            g.imageSmoothingEnabled = true;
            g.imageSmoothingQuality = 'high';
            g.fillStyle = '#fff';
            g.fillRect(0, 0, cv.width, cv.height);
            g.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
            out.push({ name: 'r' + (r + 1) + 'c' + (c + 1), w: cv.width, h: cv.height, url: cv.toDataURL('image/png') });
          }
        }
        resolve(out);
      };
      img.src = ${JSON.stringify(dataUrl)};
    })
  `);

  for (const t of tiles) {
    const p = path.join(outDir, t.name + '.png');
    fs.writeFileSync(p, Buffer.from(t.url.split(',')[1], 'base64'));
    console.log(t.name + '  ' + t.w + 'x' + t.h + '  → ' + p);
  }
  app.quit();
});
