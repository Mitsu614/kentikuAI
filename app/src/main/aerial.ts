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

// 目印の名前は OpenStreetMap から借りる。ODbL なので出典の明示が要る。
// 地理院タイルと同じく、画面に必ず出すこと。
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

// 相手は公共のタイルサーバー。名乗って、待ちすぎない。
const UA = 'kenchiku-boost/1.0 (+https://github.com/Mitsu614/kentikuAI)';
const TIMEOUT_MS = 12000;
// ★住所検索だけ長めに待つ。
//   実測（2026-09-03）: 1回目 10.7秒 / 2回目以降 0.1秒。冷えていると10秒を超え、
//   12秒の待ちに当たって「操作がタイムアウトしました」で落ちていた。
//   タイル取得は枚数ぶん並列に走るので、こちらは12秒のままでよい。
const GEOCODE_TIMEOUT_MS = 25000;
// 目印（Overpass）も同じ理由で長めに待つ。12秒では混雑時に取りこぼす。
// ここで諦めると目印が1つも出ないまま「壊れている」ように見える。
// 1つのIPで待つ上限。
//   短くしすぎると、混んでいるだけの生きたサーバーまで切ってしまう（実測4.5〜8.4秒）。
//   死んでいるIPは順送りで飛ばせるので、1つあたりは長めに待ってよい。
//   全体で1分を超えないように、下の呼び出し側で打ち切る。
const LANDMARK_TIMEOUT_MS = 12000;
// 目印の取得に使ってよい合計時間。これを超えたらやり直さない
const LANDMARK_BUDGET_MS = 50000;

// ★1回で諦めない。相手は公共のサーバーで、時間帯によって詰まる。
//   実際に住所検索が TimeoutError で落ち、画面には英語のまま出た（2026-09-03）。
//   タイルは1枚ずつ落としても穴が空くだけなので tries=1 で呼ぶ（枚数ぶん待たせない）。
async function get(url: string, tries = 2, timeoutMs = TIMEOUT_MS): Promise<Response> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, {
        headers: { 'User-Agent': UA },
        // タイムアウトが無いと、サーバーが黙ったときに画面が固まったままになる
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 700));
    }
  }
  throw last;
}

/** 通信が落ちた理由が「待ち時間切れ」かどうか */
function isTimeout(e: any): boolean {
  return e?.name === 'TimeoutError' || /abort|timeout/i.test(String(e?.message || ''));
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

/**
 * 緯度経度 → 画像内のピクセル位置。pixelToLonLat の逆。
 * 目印を写真の上の正しい場所に置くために要る。
 */
export function lonLatToPixel(
  centerLat: number, centerLon: number, z: number, sizePx: number, lat: number, lon: number,
) {
  const c = lonLatToTile(centerLon, centerLat, z);
  const t = lonLatToTile(lon, lat, z);
  const half = sizePx / 2;
  return { x: (t.x - c.x) * TILE + half, y: (t.y - c.y) * TILE + half };
}

/** その緯度・ズームでの 1px あたりの地上距離(m)。赤道z=0で156543.03になる */
export function metersPerPixel(lat: number, z: number): number {
  return (EARTH_CIRC * Math.cos((lat * Math.PI) / 180)) / (TILE * Math.pow(2, z));
}

export type AddressLevel = 'building' | 'block' | 'chome' | 'area';
export type GeoHit = {
  lon: number; lat: number; title: string; level: AddressLevel; precise: boolean;
  // 入力したのに住所の辞書に無く、無視された部分（例: 「柴原町」）。
  // ここが埋まっているときは、まったく別の場所を写している可能性が高い。
  unmatched?: string;
};

/**
 * 入力した住所のうち「町名・大字」にあたる部分を取り出す。
 *   鹿児島県鹿児島市柴原町5-40 → 柴原町
 *   大阪府大阪市都島区都島本通5-8-18 → 都島区都島本通
 * 都道府県・市区町村を落とし、残りの先頭にある数字でない部分を採る。
 */
export function townPart(input: string): string {
  const s = String(input || '').normalize('NFKC').replace(/[\s\u3000]/g, '');
  // ★施設の名前を住所として切り刻まない。
  //   「鹿児島市立柴原中学校」を住所として扱うと「立柴原中学校」という町名を
  //   でっち上げてしまい、警告の文面が意味不明になる（実際に出た）。
  if (isPlaceName(s)) return '';
  const m = s.match(/^(?:.{2,3}[都道府県])?(?:.+?[市区町村郡])?/);
  const rest = m ? s.slice(m[0].length) : s;
  const t = rest.match(/^[^0-9]+/);
  return t ? t[0] : '';
}

/** 入力が「住所」ではなく「施設・建物の名前」に見えるか */
export function isPlaceName(input: string): boolean {
  const s = String(input || '').normalize('NFKC').replace(/[\s\u3000]/g, '');
  if (!s) return false;
  return /(小学校|中学校|高等学校|高校|大学|学園|幼稚園|保育園|病院|医院|クリニック|診療所|市役所|区役所|町役場|村役場|支所|公民館|図書館|体育館|美術館|博物館|会館|ホール|センター|署|駅|空港|港|公園|神社|神宮|寺|大師|城|団地|マンション|ハイツ|コーポ|ビル|タワー|工場|倉庫|営業所|支店|本店|店|ホテル|旅館|スタジアム|競技場|球場)$/.test(s)
    || /(株式会社|有限会社|合同会社)/.test(s);
}

/**
 * 施設名で引いたとき、まったく関係ない候補を落とす。
 *   「柴原中学校」→ 調布市立神代中学校 のような曖昧一致が返ってくる（実測）。
 *   名前の「特徴のある部分」（一般的な語を除いた残り）が結果に含まれていなければ捨てる。
 */
export function nameCore(input: string): string {
  let s = String(input || '').normalize('NFKC').replace(/[\s\u3000]/g, '');
  s = s.replace(/^(?:.{2,3}[都道府県])/, '');
  s = s.replace(/(株式会社|有限会社|合同会社)/g, '');
  // 「◯◯市立」「◯◯町立」など、公立施設の頭だけを落とす。
  // ★「立」を必須にすること。これが無いと「ローソン鹿児島山下町店」の“町”に当たって
  //   名前ごと消えてしまう（実測で空になった）。
  s = s.replace(/^.+?[市区町村郡]立/, '');
  s = s.replace(/(小学校|中学校|高等学校|高校|大学|学園|幼稚園|保育園|病院|医院|クリニック|診療所|公民館|図書館|体育館|美術館|博物館|会館|ホール|センター|公園|神社|寺|団地|マンション|ビル|タワー|工場|倉庫|支店|本店|店|ホテル|旅館)$/, '');
  return s;
}

/** 比較用にそろえる（全角半角・空白の違いで取りこぼさない） */
function flat(s: string): string {
  return String(s || '').normalize('NFKC').replace(/[\s\u3000]/g, '');
}

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
  let res: Response;
  try {
    res = await get(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${q}`, 2, GEOCODE_TIMEOUT_MS);
  } catch (e: any) {
    // ここを素通しすると "TimeoutError: The operation was aborted due to timeout" が
    // そのまま画面に出る。何が起きたのか・どうすればいいのかを日本語で返す。
    throw new Error(isTimeout(e)
      ? 'ERROR: 住所の検索が時間内に終わりませんでした（国土地理院のサーバーが混み合っています）。少し待ってから、もう一度お試しください。'
      : 'ERROR: 住所の検索に接続できませんでした。通信環境をご確認ください。');
  }
  if (!res.ok) throw new Error(`ERROR: 住所の検索に失敗しました (${res.status})。少し待ってからもう一度お試しください。`);
  const arr: any[] = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const c = arr[0]?.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return null;
  const title = String(arr[0]?.properties?.title || address);
  // ★地理院の住所検索は、町名が辞書に無いと**黙って市区町村の中心**を返す。
  //   実測（2026-09-03）: 「鹿児島県鹿児島市柴原町5-40」→「鹿児島県鹿児島市」。
  //   数字も町名も落ちているのに1件ヒット扱いなので、言われないと気づけない。
  //   入力した町名が返ってきた住所に入っているかを見て、落ちていたら正直に伝える。
  const town = townPart(address);
  const dropped = town && !String(title).normalize('NFKC').includes(town) ? town : '';
  const level = dropped ? addressLevel(title) : addressLevel(title);
  return {
    lon: Number(c[0]), lat: Number(c[1]), title,
    level: dropped ? 'area' : level,
    precise: dropped ? false : isPreciseAddress(title),
    unmatched: dropped || undefined,
  };
}

/**
 * 中心の緯度経度まわりの航空写真タイルを grid×grid 枚まとめて取り、
 * 1枚のJPEGに並べたものと、確定したスケールを返す。
 *
 * ★タイルを繋ぐのに画像ライブラリを入れたくないので、Electron の
 *   nativeImage で合成する。sharp や canvas への依存を増やさない。
 */
// 重ねる地図の層。
//   ★第三者のサーバー（Overpass等）に頼ると、落ちている・混んでいるだけで
//     「どこに何があるか」が出せなくなる（実測で何度も0件になった）。
//     地理院の地図なら写真と同じサーバーなので、写真が出るなら必ず出る。
//     駅名・施設名・道路・建物の形が国の地図の基準で入っている。
export type AerialLayer = 'seamlessphoto' | 'std' | 'pale';
const LAYER_EXT: Record<AerialLayer, string> = { seamlessphoto: 'jpg', std: 'png', pale: 'png' };

export async function fetchAerial(
  lat: number, lon: number, z = 18, grid = 3, layer: AerialLayer = 'seamlessphoto',
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
          const r = await get(`https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${tx}/${ty}.${LAYER_EXT[layer]}`, 1);
          if (!r.ok) return { i, j, buf: null };
          return { i, j, buf: Buffer.from(await r.arrayBuffer()) };
        } catch (_) { return { i, j, buf: null }; }
      })());
    }
  }
  const tiles = await Promise.all(jobs);
  const missing = tiles.filter(x => !x.buf).length;
  if (missing === tiles.length) {
    throw new Error(layer === 'seamlessphoto'
      ? 'ERROR: その場所の航空写真が取得できませんでした。通信環境をご確認のうえ、少し待ってからもう一度お試しください。'
      : 'ERROR: その場所の地図が取得できませんでした。');
  }

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
    // 地図は線と文字が命なので、にじむJPEGにしない
    dataUrl: (layer === 'seamlessphoto' ? out.toJPEG(88) : out.toPNG()).toString('base64'),
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

// ★引く側の下限。z を1段下げるごとに、写る範囲は2倍・1pxの実寸も2倍になる。
//   実測（2026-09-03・大阪市都島区）: z18/16/14/12/10 すべて 200 で写真が返る。
//     z18 → 372m四方 / z16 → 1.5km / z14 → 6km / z12 → 24km / z10 → 95km（grid=3のとき）
//   タイルを増やすより z を下げるほうが、通信も画像の大きさも増えないので軽い。
export const MIN_ZOOM = 10;

/**
 * 建物の大きさに合わせて、ズームとタイル枚数を選ぶ。
 *
 * z は 18 が上限で、そこで 1px ≈ 0.49m。戸建て（一辺10m＝約20px）には粗いが、
 * これ以上細かい公開タイルが無いので、解像度は上げられない。
 * 代わりに**視野をタイル枚数で調整する**。小さい建物なら枚数を減らして
 * 余計な隣家を写さず、大きい倉庫なら枚数を増やして全体を収める。
 */
export function pickView(
  lat: number, expectAreaM2?: number, level?: AddressLevel,
): { z: number; grid: number } {
  const z = MAX_ZOOM;
  const mpp = metersPerPixel(lat, z);
  const side = expectAreaM2 && expectAreaM2 > 0 ? Math.sqrt(expectAreaM2) : 20;
  // ★住所がどこまで解決できたかで、最初の寄り具合を変える。
  //   号まで当たっているなら誤差は街区の中（数十m）に収まるので、寄って出したほうが
  //   建物が大きく写り、輪郭を合わせやすい。丁目までしか当たっていないなら、
  //   数百m先にいる可能性があるので広く出して「探せる」ことを優先する。
  //   （以前は常に広く出していたので、号まで入れた人にも小さな写真を見せていた）
  const byLevel = level === 'building' ? 150
    : level === 'block' ? 300
    : level === 'chome' ? 700
    : level === 'area' ? 1200
    : 300;
  const want = Math.max(byLevel, side * 6);
  for (const grid of [1, 3, 5, 7]) {
    if (mpp * TILE * grid >= want) return { z, grid };
  }
  return { z, grid: 7 };
}

/** 旧シグネチャ（ズームだけ返す）。既存の呼び出しを壊さないために残す */
export function pickZoom(lat: number, expectAreaM2?: number, _grid = 3): number {
  return pickView(lat, expectAreaM2).z;
}


// ── 写真の上に置く目印（どこに何があるか）────────────────────────────
//
// なぜ要るか:
//   航空写真は真上からの絵なので、慣れていないと自分の現場がどれか分からない。
//   「〇〇小学校の裏」「コンビニの向かい」で場所を掴むのが、現場の人の見つけ方。
//   地図アプリと同じように名前が出ていれば、建物を選ぶ手が止まらない。
//
// どこから取るか:
//   OpenStreetMap（Overpass API）。キー不要・無料。名前は name:ja があればそれを使う。
//   ★ODbL なので出典（OSM_ATTRIBUTION）を画面に出すこと。
//   ★公共の共有サーバーなので、負荷をかけない：写真を出したときに1回だけ・上限あり・
//     落ちても黙って何も出さない（目印が無くても測定はできる）。
export type Landmark = { x: number; y: number; name: string; kind: string };

// ★宛先のIPを順に試すPOST。
//   overpass-api.de は複数のIPを返すが、片方が死んでいることがある。
//   実測（2026-09-03）: 65.109.112.52 は287msで接続、162.55.144.139 は8秒でタイムアウト。
//   fetch は生きている方へ乗り換えてくれず、10秒の接続待ちで諦める
//   → 目印が1件も出ないまま「壊れている」ように見えていた（22秒かけて0件）。
//   curl が既定でやっていること（複数アドレスへの順次接続）を、こちらで行う。
// 目印の取得先。1つに頼らない。
//   実測（2026-09-03）: 本家 overpass-api.de は接続不能、kumi.systems は5.4秒で応答。
//   ・overpass.osm.ch は応答するが日本のデータを持たない（0件を返す）ので入れない。
//     「つながったのに0件」はいちばん困る形の失敗なので、範囲外のミラーは混ぜない。
//   ・overpass.osm.jp は証明書が期限切れ（2026-09-03時点）。
const OVERPASS_HOSTS = [
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.private.coffee',
];
// 前回つながった接続先。次からはそこへ直行する（毎回の待ちを無くす）
let lastGoodHost = '';

// ★一度つながったIPを覚えておく。
//   死んでいるIPが先に返ってくるので、覚えていないと毎回そこで20秒待たされる。
//   起動中だけ持てばよい（次の起動で状況が変わっていても、順に試すので問題ない）。
const lastGoodAddress: Record<string, string> = {};

async function postJsonAnyAddress(
  host: string, path: string, body: string, timeoutMs: number,
): Promise<any | null> {
  const https = require('https');
  // ★lookup（OSのリゾルバ）を使うこと。resolve4 はDNSサーバーへ直接聞きに行くため、
  //   環境によっては空を返す（実測: この端末では resolve4 が0件、lookup は2件）。
  let addrs: string[] = [];
  try {
    const hits = await require('dns').promises.lookup(host, { all: true, family: 4 });
    addrs = (hits || []).map((h: any) => h.address).filter(Boolean);
  } catch (_) { addrs = []; }
  if (!addrs.length) addrs = [host];   // 名前解決できなければホスト名のまま1回だけ試す
  // 前回つながったIPを先頭へ回す
  const good = lastGoodAddress[host];
  if (good && addrs.includes(good)) addrs = [good, ...addrs.filter(a => a !== good)];

  for (const addr of addrs) {
    const got = await new Promise<any | null>((resolve) => {
      const req = https.request({
        host: addr,
        servername: host,        // 証明書の検証はホスト名で行う
        port: 443, path, method: 'POST',
        headers: {
          Host: host,
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,      // 死んでいるIPを早めに見切って次へ移る
      }, (res: any) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
    if (got) { lastGoodAddress[host] = addr; return got; }
  }
  return null;
}

// 目印になりやすい順。現場を探すときの手がかりになるものを上に置く。
const KIND_SCORE: Record<string, number> = {
  station: 100, school: 90, hospital: 88, city_hall: 86, post_office: 80,
  police: 78, fire_station: 78, university: 85, college: 80, kindergarten: 70,
  supermarket: 76, convenience: 74, fuel: 72, bank: 70, park: 68,
  temple: 66, shrine: 66, library: 66, hall: 64, factory: 62, hotel: 62,
};

// 表示する名前を組み立てる。
//   OSMは「屋号」と「支店名」を別のタグに入れている（実測・梅田）:
//     name=ファミリーマート / branch=大阪駅前第四ビル店
//   name だけを出すと「ファミリーマート」が並ぶだけで目印にならない。
//   正式名称（official_name）があればそちらを優先する（例: 大阪市立◯◯小学校）。
function landmarkName(tags: any): string {
  const t = tags || {};
  const base = String(t['official_name:ja'] || t['name:ja'] || t.official_name || t.name || '').trim();
  if (!base) return '';
  const branch = String(t['branch:ja'] || t.branch || '').trim();
  if (!branch || base.includes(branch)) return base;
  return base + branch;   // 「ローソン」＋「梅田店」＝「ローソン梅田店」
}

// 名前の付いた建物の種類。ふつうの住宅に名前は付かないので、
// 名前のある building はそれだけで目印になりやすい。
// 町名・字名。住宅地ではこれがいちばん確かな手がかりになる
const PLACE_SCORE: Record<string, number> = {
  city: 95, town: 92, village: 88, suburb: 80, quarter: 74, neighbourhood: 70,
  hamlet: 68, locality: 60, isolated_dwelling: 40,
};

const BUILDING_SCORE: Record<string, number> = {
  public: 84, civic: 84, government: 84, hospital: 88, school: 90, university: 85,
  retail: 76, commercial: 74, office: 72, hotel: 70, industrial: 64, warehouse: 60,
  train_station: 100, transportation: 90, stadium: 88, church: 70, temple: 70,
  apartments: 55, residential: 45, house: 20, detached: 20, garage: 10, roof: 10,
};

function landmarkKind(tags: any): { kind: string; score: number } {
  const t = tags || {};
  // ★記事や辞書に載っているもの＝世に知られているもの。いちばん強い手がかり。
  //   これが無いと「大丸」「大阪四季劇場」が整骨院に負けて、表示から落ちる。
  const famous = (t.wikidata || t.wikipedia) ? 70 : 0;
  if (t.railway === 'station' || t.public_transport === 'station') {
    return { kind: 'station', score: KIND_SCORE.station + famous };
  }
  if (t.building && BUILDING_SCORE[String(t.building)] != null && !t.amenity && !t.shop) {
    return { kind: String(t.building), score: BUILDING_SCORE[String(t.building)] + famous };
  }
  if (t.historic) return { kind: String(t.historic), score: 72 + famous };
  if (t.place) {
    return { kind: String(t.place), score: (PLACE_SCORE[String(t.place)] ?? 60) + famous };
  }
  // 川・水路。地形は変わらないので、場所を合わせる手がかりとして強い
  if (t.waterway) return { kind: String(t.waterway), score: 66 + famous };
  // 通りの名前。店の少ない住宅地では、これしか出ないことがある
  if (t.highway) return { kind: 'street', score: 46 + famous };
  const direct = t.amenity || t.shop || t.leisure || t.tourism || t.office || t.building || t.place;
  const key = String(direct || '');
  if (KIND_SCORE[key] != null) return { kind: key, score: KIND_SCORE[key] + famous };
  if (t.amenity) return { kind: String(t.amenity), score: 55 + famous };
  if (t.shop) return { kind: String(t.shop), score: 50 + famous };
  if (t.tourism || t.leisure) return { kind: String(t.tourism || t.leisure), score: 52 + famous };
  if (t.office) return { kind: String(t.office), score: 48 + famous };
  if (t.place) return { kind: String(t.place), score: 58 + famous };
  // 名前の付いた建物。種類が分からなくても、名前がある時点で目印になる
  return { kind: 'building', score: (t.building ? 58 : 40) + famous };
}

export async function fetchLandmarks(
  centerLat: number, centerLon: number, z: number, sizePx: number, limit = 32,
): Promise<Landmark[]> {
  // 写真の四隅から範囲を出す（南西→北東）
  const nw = pixelToLonLat(centerLat, centerLon, z, sizePx, 0, 0);
  const se = pixelToLonLat(centerLat, centerLon, z, sizePx, sizePx, sizePx);
  const s = Math.min(nw.lat, se.lat), n = Math.max(nw.lat, se.lat);
  const w = Math.min(nw.lon, se.lon), e = Math.max(nw.lon, se.lon);
  const bbox = `${s},${w},${n},${e}`;
  // ★上限は多めに取る。Overpass は重要度で並べてくれないので、ここで切ると
  //   「大丸」「大阪四季劇場」のような目印が入る前に打ち切られ、整骨院やカフェばかりが残る
  //   （実測・梅田: 上限120では有名どころが落ち、400にして初めて出てきた）。
  //   並べ替えと間引きは、全部受け取ってからこちらで行う。
  // ★拾う範囲は広く取る。工務店の現場は駅前ではなく住宅地にある。
  //   店も施設も少ない場所では、町名（○○三丁目）や通りの名前が唯一の手がかりになる。
  //   拾いすぎたぶんは、下の点数と間引きで落とせばいい。
  const q = `[out:json][timeout:25];(` +
    `nwr["name"]["wikidata"](${bbox});` +          // 記事のあるもの＝世に知られているもの
    `nwr["name"]["amenity"](${bbox});` +
    `nwr["name"]["shop"](${bbox});` +
    `nwr["name"]["leisure"](${bbox});` +
    `nwr["name"]["tourism"](${bbox});` +
    `nwr["name"]["historic"](${bbox});` +
    `nwr["name"]["office"](${bbox});` +
    `nwr["name"]["craft"](${bbox});` +
    `nwr["name"]["healthcare"](${bbox});` +
    `nwr["name"]["man_made"](${bbox});` +
    `nwr["name"]["waterway"](${bbox});` +
    `nwr["name"]["railway"="station"](${bbox});` +
    `nwr["name"]["public_transport"="station"](${bbox});` +
    `nwr["name"]["building"](${bbox});` +
    `node["name"]["place"](${bbox});` +            // 町名・字名
    `way["name"]["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|pedestrian|living_street|unclassified)$"](${bbox});` +
    `);out center 300;`;

  // 混んでいると 504 を返すことがある（実測: 1回目504・11秒 → 2回目200・1.9秒）。
  // 死んでいるIPは postJsonAnyAddress が飛ばすので、ここでのやり直しは混雑対策。
  const body = 'data=' + encodeURIComponent(q);
  const started = Date.now();
  // 前回つながった先を先頭に、順に試す。1つが落ちていても目印が消えないようにする。
  const hosts = lastGoodHost
    ? [lastGoodHost, ...OVERPASS_HOSTS.filter(h => h !== lastGoodHost)]
    : [...OVERPASS_HOSTS];
  let json: any = null;
  for (const host of hosts) {
    if (Date.now() - started > LANDMARK_BUDGET_MS) break;   // 全体で1分を超えない
    json = await postJsonAnyAddress(host, '/api/interpreter', body, LANDMARK_TIMEOUT_MS);
    if (json) { lastGoodHost = host; break; }
  }
  if (!json) return [];

  const els: any[] = Array.isArray(json?.elements) ? json.elements : [];
  const out: (Landmark & { score: number })[] = [];
  for (const el of els) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const tags = el.tags || {};
    const name = landmarkName(tags);
    if (!name || name.length > 32) continue;
    const p = lonLatToPixel(centerLat, centerLon, z, sizePx, lat, lon);
    // 写真の外・端すぎるものは置かない（ラベルが切れる）
    if (p.x < 8 || p.y < 8 || p.x > sizePx - 8 || p.y > sizePx - 8) continue;
    const k = landmarkKind(tags);
    out.push({ x: Math.round(p.x), y: Math.round(p.y), name, kind: k.kind, score: k.score });
  }
  // 目印になりやすい順に採る。
  // ★近すぎるものは捨てる。商店街のように密集した場所では札が重なって、
  //   どれがどの建物か分からなくなる（写真が読めなくなるほうが害が大きい）。
  out.sort((a, b) => b.score - a.score);
  // 札どうしの最小の間隔。狭くするほど数が出るが、重なると読めなくなる。
  // 「有名どころだけ」より「知っている店が1つでも見つかる」ほうが現場を探しやすいので、
  // 重ならない限りは出す方針に寄せる。
  const MIN_GAP = Math.max(28, sizePx / 22);
  const kept: typeof out = [];
  for (const m of out) {
    if (kept.length >= limit) break;
    // 近すぎる札は捨てる（重なって読めなくなる）
    if (kept.some(k => Math.hypot(k.x - m.x, k.y - m.y) < MIN_GAP)) continue;
    // ★同じ名前でも、離れていれば別の店。近いものだけ二重登録とみなして捨てる。
    //   名前で一律に1つへ絞ると、コンビニが2軒あっても1軒しか出ない。
    if (kept.some(k => k.name === m.name && Math.hypot(k.x - m.x, k.y - m.y) < MIN_GAP * 3)) continue;
    kept.push(m);
  }
  return kept.map(({ x, y, name, kind }) => ({ x, y, name, kind }));
}


// ── 建物名で場所を探す ──────────────────────────────────────────
//
// なぜ要るか:
//   現場が「○○小学校の体育館」「△△マンション」としか分からないことがある。
//   住所を調べ直してから入れるのは手間だし、番地を間違えると別の建物を測る。
//   名前でそのまま引けるようにする。
//
// どこから取るか:
//   ・国土地理院の住所検索 … 日本の住所はこちらが強い（丁目・番地）
//   ・Nominatim（OpenStreetMap）… 施設名・店名・建物名はこちら
//   両方に投げて、住所側を先に並べる。名前は候補として選んでもらう
//   （同じ名前の施設は各地にあるので、こちらで1つに決めない）。
//   ★Nominatim は 1秒1リクエストまで・User-Agent 必須（連絡先入り）。
export type PlaceHit = {
  lat: number; lon: number;
  title: string;      // 表示する名前
  detail: string;     // 住所など、見分けるための補足
  source: 'gsi' | 'osm';
  level?: AddressLevel;
  precise?: boolean;
  unmatched?: string; // 入力したのに無視された町名
};

async function searchGsi(q: string): Promise<PlaceHit[]> {
  try {
    const res = await get(
      `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`,
      1, GEOCODE_TIMEOUT_MS,
    );
    if (!res.ok) return [];
    const arr: any[] = await res.json();
    if (!Array.isArray(arr)) return [];
    const town = townPart(q);
    return arr.slice(0, 5).map((a) => {
      const c = a?.geometry?.coordinates || [];
      const title = String(a?.properties?.title || q);
      // 入力した町名が返ってきた住所に無い＝辞書に無くて市の中心に落ちている
      const dropped = town && !title.normalize('NFKC').includes(town) ? town : '';
      return {
        lat: Number(c[1]), lon: Number(c[0]),
        title,
        detail: dropped ? `住所（「${dropped}」は見つかりませんでした）` : '住所',
        source: 'gsi' as const,
        level: dropped ? ('area' as AddressLevel) : addressLevel(title),
        precise: dropped ? false : isPreciseAddress(title),
        unmatched: dropped || undefined,
      };
    }).filter(h => isFinite(h.lat) && isFinite(h.lon));
  } catch (_) { return []; }
}

async function searchOsm(q: string): Promise<PlaceHit[]> {
  try {
    const url = 'https://nominatim.openstreetmap.org/search'
      + `?q=${encodeURIComponent(q)}&format=jsonv2&countrycodes=jp&limit=6&accept-language=ja`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const arr: any[] = await res.json();
    if (!Array.isArray(arr)) return [];
    // 特徴のある部分が含まれていない候補は、まったく別の施設なので捨てる
    const core = nameCore(q);
    const relevant = (core && core.length >= 2)
      ? arr.filter((a: any) => flat(String(a?.name || a?.display_name || '')).includes(core))
      : arr;
    return relevant.map((a) => {
      const full = String(a?.display_name || '');
      const head = String(a?.name || full.split(',')[0] || '').trim();
      // 表示は「名前」、補足は住所側（先頭の名前を除いた残り）
      const rest = full.split(',').slice(1).map((x: string) => x.trim()).filter(Boolean);
      return {
        lat: Number(a?.lat), lon: Number(a?.lon),
        title: head || full,
        detail: rest.reverse().slice(0, 4).join(' ') || '建物・施設',
        source: 'osm' as const,
      };
    }).filter(h => isFinite(h.lat) && isFinite(h.lon) && h.title);
  } catch (_) { return []; }
}

/** 住所でも建物名でも引ける検索。候補を返し、どれを測るかは人が決める */
export async function searchPlaces(query: string): Promise<PlaceHit[]> {
  const q = String(query || '').trim();
  if (!q) return [];
  const [gsi, osm] = await Promise.all([searchGsi(q), searchOsm(q)]);

  // ★入力した町名が住所の辞書に無かったとき、その町名が**実在する場所**を探して候補に足す。
  //   実測（2026-09-03）: 「鹿児島県鹿児島市柴原町5-40」と入れると、地理院は黙って
  //   「鹿児島県鹿児島市」（市の中心）を返す。しかし柴原町は大阪府豊中市にしかない。
  //   市の中心を黙って見せるより、「その町はここにありますが、こちらですか？」と
  //   並べたほうが、間違いに気づける。
  const dropped = gsi.length && gsi[0].unmatched ? gsi[0].unmatched : '';
  let alt: PlaceHit[] = [];
  if (dropped) {
    // 町名＋番地だけで引き直す（都道府県・市区町村を外す）
    const nums = String(q).normalize('NFKC').replace(/[\s　]/g, '')
      .slice(String(q).normalize('NFKC').replace(/[\s　]/g, '').indexOf(dropped) + dropped.length);
    alt = (await searchGsi(dropped + nums)).map(h => ({
      ...h, detail: `「${dropped}」で探した結果`,
    }));
  }

  const out: PlaceHit[] = [];
  const seen = new Set<string>();
  for (const h of [...gsi, ...alt, ...osm]) {
    // 近すぎる候補（同じ場所を指す別ソース）は1つにまとめる
    const key = `${h.lat.toFixed(4)},${h.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= 8) break;
  }
  return out;
}
