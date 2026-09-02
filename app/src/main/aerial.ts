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

// 相手は公共のタイルサーバー。名乗って、待ちすぎない。
const UA = 'kenchiku-boost/1.0 (+https://github.com/Mitsu614/kentikuAI)';
const TIMEOUT_MS = 12000;

async function get(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': UA },
    // タイムアウトが無いと、サーバーが黙ったときに画面が固まったままになる
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

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

/** タイル座標（小数を含む）→ 緯度経度。lonLatToTile の逆 */
export function tileToLonLat(x: number, y: number, z: number) {
  const n = Math.pow(2, z);
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lon, lat };
}

/**
 * 画像内のピクセル位置 → 緯度経度。
 * 広い範囲で建物を選んでもらったあと、その建物に寄って測り直すために要る。
 */
export function pixelToLonLat(
  centerLat: number, centerLon: number, z: number, sizePx: number, x: number, y: number,
) {
  const t = lonLatToTile(centerLon, centerLat, z);
  const half = sizePx / 2;
  // 画像左上のタイル座標（タイル1枚 = 256px）
  const originX = t.x - half / TILE;
  const originY = t.y - half / TILE;
  return tileToLonLat(originX + x / TILE, originY + y / TILE, z);
}

/** その緯度・ズームでの 1px あたりの地上距離(m)。赤道z=0で156543.03になる */
export function metersPerPixel(lat: number, z: number): number {
  return (EARTH_CIRC * Math.cos((lat * Math.PI) / 180)) / (TILE * Math.pow(2, z));
}

export type AddressLevel = 'building' | 'block' | 'chome' | 'area';
export type GeoHit = { lon: number; lat: number; title: string; level: AddressLevel; precise: boolean };

/**
 * 住所がどこまで解決できたかを見分ける。
 *
 * 番地まで無いと区・町の中心点が返り、**まったく別の建物**を測ってしまう。
 * 実際に「大阪府大阪市都島区」で試したとき、区の中心にあった建物を1349㎡と読んだ。
 * 数字は出るので、言われないと気づけない。
 *
 * 丁目だけでも足りない。丁目は数百m四方あり、航空写真の視野(z=18で124m)より広い。
 * **番まで解決できて初めて、写した範囲に目的の建物が入っていると言える。**
 *
 * 実測した地理院ジオコーダの返り（2026-09-02）:
 *   大阪府大阪市都島区              → 地域
 *   大阪府大阪市都島区中野町          → 地域
 *   大阪府大阪市都島区中野町1丁目      → 丁目
 *   大阪府大阪市都島区中野町1-2       → 街区（一丁目２番）
 *   大阪府大阪市都島区中野町1-2-3     → 建物（一丁目２番３号）
 */
const NUM = '[0-9０-９一二三四五六七八九十]+';
export function addressLevel(title: string): AddressLevel {
  const s = String(title || '');
  if (new RegExp(`${NUM}号`).test(s)) return 'building';
  if (new RegExp(`${NUM}(番地|番)`).test(s)) return 'block';
  if (new RegExp(`${NUM}丁目`).test(s)) return 'chome';
  return 'area';
}
/** 面積を確定させてよい粒度か。番まで解決できていることを求める */
export const isPreciseAddress = (title: string): boolean => {
  const lv = addressLevel(title);
  return lv === 'building' || lv === 'block';
};
export const LEVEL_LABEL: Record<AddressLevel, string> = {
  building: '建物（何号まで）',
  block: '街区（何番まで）',
  chome: '丁目まで',
  area: '町・区まで',
};

/** 住所 → 緯度経度。国土地理院の住所検索を使う（キー不要） */
export async function geocode(address: string): Promise<GeoHit | null> {
  const q = encodeURIComponent(String(address || '').trim());
  if (!q) return null;
  const res = await get(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${q}`);
  if (!res.ok) throw new Error(`住所の検索に失敗しました (${res.status})`);
  const arr: any[] = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const c = arr[0]?.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return null;
  const title = String(arr[0]?.properties?.title || address);
  const level = addressLevel(title);
  return { lon: Number(c[0]), lat: Number(c[1]), title, level, precise: isPreciseAddress(title) };
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
          const r = await get(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${tx}/${ty}.jpg`);
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
    // scaleFactor を明示する。省略すると高DPI環境で 1 以外になり、getSize()（論理px）と
    // toBitmap()（物理px）がズレて、敷き詰めの行送りが狂う＝画像が崩れる。
    const img = nativeImage.createFromBuffer(buf, { scaleFactor: 1 });
    const { width, height } = img.getSize();
    if (width !== TILE || height !== TILE) continue;
    const px = img.toBitmap();   // BGRA
    // 論理サイズと実バイト数が食い違っていたら、敷き詰めずに捨てる（崩れた画像を渡さない）
    if (px.length !== TILE * TILE * 4) continue;
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

// ★地理院の空中写真タイルは z=18 までしか無い。
//   実測（2026-09-02・都心/郊外/地方の3地点、seamlessphoto と ort の両方）:
//     z15○ z16○ z17○ z18○ z19× z20×
//   ここを 20 にしていたため、戸建て・小工場では全タイルが404になり、
//   航空写真の経路がまるごと失敗していた。実機で回して初めて分かった。
export const MAX_ZOOM = 18;

/**
 * 建物の大きさに合わせて、ズームとタイル枚数を選ぶ。
 *
 * z は 18 が上限で、そこで 1px ≈ 0.49m。戸建て（一辺10m＝約20px）には粗いが、
 * これ以上細かい公開タイルが無いので、解像度は上げられない。
 * 代わりに**視野をタイル枚数で調整する**。小さい建物なら枚数を減らして
 * 余計な隣家を写さず、大きい倉庫なら枚数を増やして全体を収める。
 */
export function pickView(lat: number, expectAreaM2?: number): { z: number; grid: number } {
  const z = MAX_ZOOM;
  const mpp = metersPerPixel(lat, z);
  const side = expectAreaM2 && expectAreaM2 > 0 ? Math.sqrt(expectAreaM2) : 20;
  // 建物の一辺の6倍を目安にする。
  // ★1タイル(124m四方)だと、住所の解決点が街区の代表点＝道路上に落ちたとき、
  //   目的の建物が枠の外に出ることがある。利用者が自分の建物を探して選ぶ画面なので、
  //   まず「見つけられる」ことを優先し、広めに出す。狭めたいときは画面から切り替えられる。
  const want = Math.max(300, side * 6);
  for (const grid of [1, 3, 5, 7]) {
    if (mpp * TILE * grid >= want) return { z, grid };
  }
  return { z, grid: 7 };
}

/** 旧シグネチャ（ズームだけ返す）。既存の呼び出しを壊さないために残す */
export function pickZoom(lat: number, expectAreaM2?: number, _grid = 3): number {
  return pickView(lat, expectAreaM2).z;
}
