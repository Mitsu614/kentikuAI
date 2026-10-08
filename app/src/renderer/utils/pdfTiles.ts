// 大判（A2以上）の図面PDFのページを、高い解像度で縦横2×2に切った画像にする。
//
// なぜ要るか:
//   AIはPDFを1ページ1枚の画像に縮めて読む。A1の1/50平面詳細図だと、室名や寸法の小さな文字がつぶれ、
//   「室名が判読できない」「位置を推定した」で部屋を差引きにまとめてしまう（2026-10-08 実測：
//   名前のある室の5割にしか行が立たなかった）。ページを4つに切って拡大した画像を一緒に渡すと 76% に上がり、
//   確かさ「低」の行がほぼ消えた。A3以下の図面はPDFのままで十分読めているので切らない。
//
// 画面側（Chromium）で pdf.js を使って描く。本体（Node）にはPDFを描く仕組みが無いため。
// 失敗しても拾い出しは止めない（空の配列を返し、PDFだけで拾う）。

export type PdfTile = { fileIndex: number; label: string; data: string };

const MIN_LONG_PT = 1500;   // これ未満（A3=1191pt 以下）は切らない
const TILE_LONG_PX = 1568;  // AIが縮めずに受け取る長辺
const MAX_TILES = 40;       // 1回に渡す画像の上限（1回の依頼の大きさを抑える）

export async function pdfToTiles(files: { type?: string; data: string }[]): Promise<PdfTile[]> {
  const tiles: PdfTile[] = [];
  let pdfjs: any;
  try {
    pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';
  } catch (e) {
    console.error('pdf.js を読み込めませんでした（PDFのまま拾います）:', e);
    return [];
  }
  const POS = ['左上', '右上', '左下', '右下'];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    const raw = String(f.data || '');
    if (!(f.type === 'pdf' || raw.startsWith('data:application/pdf'))) continue;
    try {
      const bin = atob(raw.replace(/^data:application\/pdf;base64,/, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      for (let pn = 1; pn <= doc.numPages; pn++) {
        const page = await doc.getPage(pn);
        const base = page.getViewport({ scale: 1 });
        if (Math.max(base.width, base.height) < MIN_LONG_PT) continue;
        const w = base.width / 2, h = base.height / 2;
        const ov = 0.04 * Math.max(base.width, base.height);   // 境目の文字が切れないよう少し重ねる
        const cells = [[0, 0], [1, 0], [0, 1], [1, 1]];
        for (let k = 0; k < 4; k++) {
          if (tiles.length >= MAX_TILES) return tiles;
          const [cx, cy] = cells[k];
          const x0 = Math.max(0, cx * w - ov), y0 = Math.max(0, cy * h - ov);
          const x1 = Math.min(base.width, (cx + 1) * w + ov), y1 = Math.min(base.height, (cy + 1) * h + ov);
          const scale = TILE_LONG_PX / Math.max(x1 - x0, y1 - y0);
          const vp = page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round((x1 - x0) * scale);
          canvas.height = Math.round((y1 - y0) * scale);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          tiles.push({ fileIndex: fi, label: `${pn}ページ目・${POS[k]}`, data: canvas.toDataURL('image/jpeg', 0.85) });
        }
      }
      await doc.destroy();
    } catch (e) {
      console.error('PDFの拡大画像を作れませんでした（PDFのまま拾います）:', e);
    }
  }
  return tiles;
}
