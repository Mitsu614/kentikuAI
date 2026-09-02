// 住所から航空写真を取り、1ピクセル何メートルかを確定させる。
//
// なぜ要るか:
//   写真から面積を読ませると、AIは「屋根材の働き幅333mm」のような規格寸法を
//   物差しにしてスケールを逆算する。その物差しが違えば面積は全部ずれる。
//   実測33回で平均誤差46%、同じ写真で3.7倍違う答えが出た（app/tools/harness-area/）。
//   斜め・航空写真からの目測はとくに悪く、平均誤差52.6%。
//
//   航空写真タイルなら**縮尺が確定している**。こちらから「1px = 0.49m」と渡せば、
//   AIは輪郭を読むだけでよく、いちばん外れやすい「スケールの推定」工程が消える。
//
// 出典表示:
//   国土地理院の地図タイルは出典の明示が必要（利用規約）。
//   画面と見積書に「地理院タイル（国土地理院）」と出すこと。ATTRIBUTION を使う。

export const ATTRIBUTION = '地理院タイル（国土地理院）';

const EARTH_CIRC = 2 * Math.PI * 6378137;   // 赤道一周 40075016.686 m
const TILE = 256;

/** Web メルカトルのタイル座標（小数を含む） */
export function lonLatToTile(lon: number, lat: number, z: number) {
  const n = Math.pow(2, z);
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

/** その緯度・ズームでの 1px あたりの地上距離(m)。赤道z=0で156543.03になる */
export function metersPerPixel(lat: number, z: number): number {
  return (EARTH_CIRC * Math.cos((lat * Math.PI) / 180)) / (TILE * Math.pow(2, z));
}

export type GeoHit = { lon: number; lat: number; title: string };

/** 住所 → 緯度経度。国土地理院の住所検索を使う（キー不要） */
export async function geocode(address: string): Promise<GeoHit | null> {
  const q = encodeURIComponent(String(address || '').trim());
  if (!q) return null;
  const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${q}`);
  if (!res.ok) throw new Error(`住所の検索に失敗しました (${res.status})`);
  const arr: any[] = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const c = arr[0]?.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return null;
  return { lon: Number(c[0]), lat: Number(c[1]), title: String(arr[0]?.properties?.title || address) };
}

/**
 * 中心の緯度経度まわりの航空写真タイルを grid×grid 枚まとめて取り、
 * 1枚のJPEGに並べたものと、確定したスケールを返す。
 *
 * ★タイルを繋ぐのに画像ライブラリを入れたくないので、Electron の
 *   nativeImage で合成する。sharp や canvas への依存を増やさない。
 */
export async function fetchAerial(
  lat: number, lon: number, z = 18, grid = 3,
): Promise<{ dataUrl: string; mPerPx: number; widthM: number; sizePx: number; z: number; missing: number }> {
  const { nativeImage } = require('electron');
  const t = lonLatToTile(lon, lat, z);
  const cx = Math.floor(t.x), cy = Math.floor(t.y);
  const half = Math.floor(grid / 2);

  const jobs: Promise<{ i: number; j: number; buf: Buffer | null }>[] = [];
  for (let j = -half; j <= half; j++) {
    for (let i = -half; i <= half; i++) {
      const tx = cx + i, ty = cy + j;
      jobs.push((async () => {
        try {
          const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${tx}/${ty}.jpg`);
          if (!r.ok) return { i, j, buf: null };
          return { i, j, buf: Buffer.from(await r.arrayBuffer()) };
        } catch (_) { return { i, j, buf: null }; }
      })());
    }
  }
  const tiles = await Promise.all(jobs);
  const missing = tiles.filter(x => !x.buf).length;
  if (missing === tiles.length) throw new Error('その場所の航空写真が取得できませんでした。');

  // 並べる。nativeImage には合成APIが無いので、生のRGBAを自前で敷き詰める。
  const size = TILE * grid;
  const canvas = Buffer.alloc(size * size * 4, 0);
  for (const { i, j, buf } of tiles) {
    if (!buf) continue;
    const img = nativeImage.createFromBuffer(buf);
    const { width, height } = img.getSize();
    if (width !== TILE || height !== TILE) continue;
    const px = img.toBitmap();   // BGRA
    const ox = (i + half) * TILE, oy = (j + half) * TILE;
    for (let y = 0; y < TILE; y++) {
      const src = y * TILE * 4;
      const dst = ((oy + y) * size + ox) * 4;
      px.copy(canvas, dst, src, src + TILE * 4);
    }
  }
  const out = nativeImage.createFromBitmap(canvas, { width: size, height: size });
  const mPerPx = metersPerPixel(lat, z);
  return {
    dataUrl: out.toJPEG(88).toString('base64'),
    mPerPx,
    widthM: mPerPx * size,
    sizePx: size,
    z,
    missing,
  };
}

/**
 * 建物の大きさに合わせてズームを選ぶ。
 * 大きすぎる倉庫が枠に収まらないと輪郭が読めないので、収まる最大の倍率にする。
 */
export function pickZoom(lat: number, expectAreaM2?: number, grid = 3): number {
  // 想定面積から一辺を見積もり、その3倍が視野に入るようにする
  const side = expectAreaM2 && expectAreaM2 > 0 ? Math.sqrt(expectAreaM2) : 30;
  const want = Math.max(60, side * 3);
  for (const z of [20, 19, 18, 17, 16]) {
    if (metersPerPixel(lat, z) * TILE * grid >= want) return z;
  }
  return 16;
}
