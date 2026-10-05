// 図面に付けた「色の印」を画素で測る。
//
// お客様（や拾い出しソフト）が図面の上に、拾う壁を色の線で、拾う床・天井を色の囲みで描いて渡すことがある。
// AIに「この線の長さ」を目で読ませると、低解像度の図面では折れ線をたどれず大きく外す
// （実測：物件Aの2F壁で -44〜-95%）。線そのものは画素として正確に取り出せるので、
// 長さ・面積は機械で数え、AIには縮尺と「どの印が何か」の判断だけを任せる。
//
// ここは Electron・fs に触らない純粋な関数だけ（ハーネスから直接叩けるように）。
//   ★ここを直したら tools/harness-takeoff/measure-marks.js を回すこと。
//
// 何を「印」とみなすか:
//   純色に近い 青・黄・緑・マゼンタ（拾い出しソフトの描画色）。
//   図面にもともとある色（水色の破線の円・赤の敷地線・濃紺の注記文字）は拾わない。
//   印の番号（#1 などの数字）は小さな塊なので、長さには入れない。

export type MarkColor = 'blue' | 'yellow' | 'green' | 'magenta' | 'orange' | 'brown';

export interface Rgba {
  width: number; height: number; data: Uint8Array | Uint8ClampedArray | number[]; channels?: number;
  /** Electron の nativeImage.toBitmap() は B,G,R,A の並び */
  bgr?: boolean;
}

export interface MarkPiece {
  color: MarkColor;
  /** 画素の数（太さ込み） */
  pixels: number;
  /** 芯線の長さ（画素） */
  lengthPx: number;
  /** 囲まれた内側の面積（画素）。線だけなら 0 */
  enclosedPx: number;
  /** 線の上の小さな四角（開口の印）の数 */
  openings: number;
  /** 開口の印の幅（画素。四角の長い辺＋線の太さ） */
  openingWidthsPx: number[];
  /** 同じ塊の標準の1.5倍以上の太さが続く区間（2本を重ねてなぞった可能性がある所） */
  thickRuns: { lengthPx: number; bbox: [number, number, number, number] }[];
  /** 芯線の端の数 */
  ends: number;
  /** 両側が印に囲まれた部屋になっていて、両面（2本分）と数えた芯線の画素数 */
  bothFacesPx: number;
  bbox: [number, number, number, number];
}

export interface MarkRegion {
  /** 面積（画素。線の芯まで含む） */
  areaPx: number;
  bbox: [number, number, number, number];
}

export interface MarkLabel {
  /** 番号の数字の塊（2桁の番号は数字2つが並んだ1つの塊にまとめる） */
  bbox: [number, number, number, number];
  color: MarkColor;
}

export interface MarkMeasure {
  width: number;
  height: number;
  pieces: MarkPiece[];
  /** 印に囲まれた範囲ごとの面積 */
  regions: MarkRegion[];
  /** 色を区別せず、印全体で囲まれた面積（入れ子を1つに数える） */
  unionEnclosedPx: number;
  /** opts.debug のとき：両面（2本分）と数えた芯線の画素の位置 */
  debugDouble?: number[];
  /** 印の番号（#1 など）の数字の位置。起点の丸い点は含めない */
  labels: MarkLabel[];
  totalLengthPx: number;
  totalEnclosedPx: number;
}

// 純色だけでなく、半透明で重ねた薄い印（(96,96,224) のような青、(96,224,96) のような緑）も拾う。
// 「その色だけが突き抜けて明るく、残り2色が揃って低い」ものを印とする。
//   水色 (96,224,224) は緑と青が両方高いので青にも緑にもならない。赤い敷地線 (224,64,64) は対象外。
//   濃紺の注記文字 (0,0,128) は明るさが足りないので拾わない。
export function classify(r: number, g: number, b: number): MarkColor | null {
  const hi = 180, gap = 80, even = 45;
  if (b >= hi && b - Math.max(r, g) >= gap && Math.abs(r - g) <= even) return 'blue';
  if (g >= hi && g - Math.max(r, b) >= gap && Math.abs(r - b) <= even) return 'green';
  if (r >= hi && g >= hi && Math.min(r, g) - b >= 100 && Math.abs(r - g) <= even) return 'yellow';
  if (r >= hi && b >= hi && Math.min(r, b) - g >= gap && Math.abs(r - b) <= even) return 'magenta';
  // オレンジ (240,120,60)・濃い茶 (120,60,0)。床の色分けの塗り（ベージュ (220,160,120)・茶の塗り (120,100,80)）は拾わない
  if (r >= 200 && g >= 80 && g <= 170 && b <= 100 && r - b >= 150) return 'orange';
  if (r >= 90 && r <= 170 && g >= 30 && g <= 110 && b <= 45 && r - g >= 45) return 'brown';
  return null;
}

/** 囲みの判定だけに使う、ゆるい青系（濃紺の注記文字・半透明の印）。
 *  拾い出しソフトは印の上に測った長さ（例「1162 mm」）を濃紺で重ねて描くことがあり、
 *  その下の線が大きく途切れる。囲みの壁としてだけ数え、長さには入れない */
export function isBarrier(r: number, g: number, b: number): boolean {
  return b >= 100 && b - Math.max(r, g) >= 60 && Math.abs(r - g) <= 45;
}

/** 印の画素を色ごとに取り出す（0=印でない、1..4=色） */
function markMap(img: Rgba): Uint8Array {
  const ch = img.channels || 4;
  const { width: W, height: H, data } = img;
  const out = new Uint8Array(W * H);
  const code: Record<MarkColor, number> = { blue: 1, yellow: 2, green: 3, magenta: 4, orange: 5, brown: 6 };
  const ri = img.bgr ? 2 : 0, bi = img.bgr ? 0 : 2;
  for (let i = 0; i < W * H; i++) {
    const c = classify(data[i * ch + ri], data[i * ch + 1], data[i * ch + bi]);
    if (c) out[i] = code[c];
  }
  return out;
}

/** 8近傍の連結成分 */
function components(mask: Uint8Array, W: number, H: number): { idx: number[]; color: number; bbox: [number, number, number, number] }[] {
  const seen = new Uint8Array(W * H);
  const out: { idx: number[]; color: number; bbox: [number, number, number, number] }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    const color = mask[s];
    const idx: number[] = [];
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop() as number;
      idx.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (!seen[q] && mask[q] === color) { seen[q] = 1; stack.push(q); }
      }
    }
    out.push({ idx, color, bbox: [x0, y0, x1, y1] });
  }
  return out;
}

/** Zhang-Suen の細線化。bin は 0/1、その場で書き換える */
function thin(bin: Uint8Array, W: number, H: number) {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : bin[y * W + x]);
  let changed = true;
  const del: number[] = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!bin[y * W + x]) continue;
        const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
        const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let A = 0; for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
        if (A !== 1) continue;
        if (step === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
        del.push(y * W + x);
      }
      if (del.length) { changed = true; for (const i of del) bin[i] = 0; }
    }
  }
}

/** 芯線の長さ。縦横の隣は1、斜めの隣は√2（縦横でつながっている所は斜めを数えない）。
 *  weight があれば、つないだ2画素の重みの平均を掛ける（2＝間仕切りの両面） */
function skeletonLength(bin: Uint8Array, W: number, H: number, weight?: Uint8Array): number {
  let len = 0;
  const wt = (a: number, b: number) => (weight ? (weight[a] + weight[b]) / 2 : 1);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : bin[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!bin[y * W + x]) continue;
    const i = y * W + x;
    if (at(x + 1, y)) len += wt(i, i + 1);
    if (at(x, y + 1)) len += wt(i, i + W);
    if (at(x + 1, y + 1) && !at(x + 1, y) && !at(x, y + 1)) len += Math.SQRT2 * wt(i, i + W + 1);
    if (at(x - 1, y + 1) && !at(x - 1, y) && !at(x, y + 1)) len += Math.SQRT2 * wt(i, i + W - 1);
  }
  return len;
}

/** 塊の中の小さな穴（開口の印の四角など）を塗りつぶす。塗った穴の数を返す。
 *  四角のまま細線化すると、周りを一周ぶん長さに数えてしまう */
function fillSmallHoles(bin: Uint8Array, W: number, H: number, bbox: [number, number, number, number], maxHole: number, widths?: number[]): number {
  const [x0, y0, x1, y1] = bbox;
  const w = x1 - x0 + 3, h = y1 - y0 + 3;
  const lab = new Int32Array(w * h);              // 0=未, -1=外, >0=穴の番号
  const at = (x: number, y: number) => { const gx = x + x0 - 1, gy = y + y0 - 1; return gx >= 0 && gy >= 0 && gx < W && gy < H && bin[gy * W + gx] === 1; };
  const flood = (sx: number, sy: number, id: number) => {
    const st = [sy * w + sx]; lab[sy * w + sx] = id; const cells = [sy * w + sx];
    while (st.length) {
      const p = st.pop() as number; const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (lab[q] || at(nx, ny)) continue;
        lab[q] = id; st.push(q); cells.push(q);
      }
    }
    return cells;
  };
  flood(0, 0, -1);
  let id = 0, filled = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lab[y * w + x] || at(x, y)) continue;
    const cells = flood(x, y, ++id);
    if (cells.length <= maxHole) {
      filled++;
      if (widths) {
        let ax = w, bx = 0, ay = h, by = 0;
        for (const c of cells) { const cx = c % w, cy = (c / w) | 0; if (cx < ax) ax = cx; if (cx > bx) bx = cx; if (cy < ay) ay = cy; if (cy > by) by = cy; }
        widths.push(Math.max(bx - ax, by - ay) + 1);   // 四角の長い辺＝開口の幅（内法）
      }
      for (const c of cells) { const cx = c % w, cy = (c / w) | 0; bin[(cy + y0 - 1) * W + (cx + x0 - 1)] = 1; }
    }
  }
  return filled;
}

/** 各画素から塊の外までの距離（チャムファー 3-4。単位は画素×3） */
function distanceMap(bin: Uint8Array, W: number, H: number): Uint16Array {
  const INF = 60000, d = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = bin[i] ? INF : 0;
  const g = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], g(x - 1, y) + 3, g(x, y - 1) + 3, g(x - 1, y - 1) + 4, g(x + 1, y - 1) + 4);
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], g(x + 1, y) + 3, g(x, y + 1) + 3, g(x + 1, y + 1) + 4, g(x - 1, y + 1) + 4);
  }
  return d;
}

/** 芯線の端（隣が1つだけの画素）の数 */
function endpoints(bin: Uint8Array, W: number, H: number): number {
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!bin[y * W + x]) continue;
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && bin[ny * W + nx]) k++;
    }
    if (k === 1) n++;
  }
  return n;
}

/** 正方形の構造要素で太らせる（途切れた囲みをつなぐため） */
function dilate(bin: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (r <= 0) return bin;
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!bin[y * W + x]) continue;
    for (let d = -r; d <= r; d++) { const nx = x + d; if (nx >= 0 && nx < W) tmp[y * W + nx] = 1; }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!tmp[y * W + x]) continue;
    for (let d = -r; d <= r; d++) { const ny = y + d; if (ny >= 0 && ny < H) out[ny * W + x] = 1; }
  }
  return out;
}

/** 図面全体で、印に囲まれた内側の画素（外周からたどり着けず、印でもない所）を返す */
function interiorMask(wall: Uint8Array, W: number, H: number): Uint8Array {
  const outside = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (q: number) => { if (!outside[q] && !wall[q]) { outside[q] = 1; stack.push(q); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) {
    const p = stack.pop() as number;
    const x = p % W, y = (p / W) | 0;
    if (x > 0) push(p - 1); if (x < W - 1) push(p + 1);
    if (y > 0) push(p - W); if (y < H - 1) push(p + W);
  }
  const inner = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (!outside[i] && !wall[i]) inner[i] = 1;
  return inner;
}

/** 線に囲まれた内側（外からたどり着けない、線でもない画素）を数える */
function enclosedArea(bin: Uint8Array, W: number, H: number, bbox: [number, number, number, number]): number {
  const [x0, y0, x1, y1] = bbox;
  const w = x1 - x0 + 3, h = y1 - y0 + 3;               // 1画素の余白を付けて、外周から塗る
  const outside = new Uint8Array(w * h);
  const wall = (x: number, y: number) => {
    const gx = x + x0 - 1, gy = y + y0 - 1;
    return gx >= 0 && gy >= 0 && gx < W && gy < H && bin[gy * W + gx] === 1;
  };
  const stack = [0];
  outside[0] = 1;
  while (stack.length) {
    const p = stack.pop() as number;
    const x = p % w, y = (p / w) | 0;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of nb) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (outside[q] || wall(nx, ny)) continue;
      outside[q] = 1; stack.push(q);
    }
  }
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!outside[y * w + x] && !wall(x, y)) n++;
  return n;
}

/**
 * 印を測る。
 * @param minSide これより小さい塊は番号の数字などとみなして捨てる（画素）
 */
export function measureMarks(img: Rgba, opts: { minSide?: number; bridge?: number; maxHole?: number; bothFaces?: boolean; lineFrac?: number; debug?: boolean; roomBridge?: number; thickDouble?: boolean; doubleRatio?: number; minRun?: number } = {}): MarkMeasure {
  const W = img.width, H = img.height;
  const minSide = opts.minSide ?? Math.max(14, Math.round(Math.max(W, H) / 60));
  // 囲みの途切れ（注記の文字が線に重なった所など）をつなぐ幅。画像の大きさに比例させる
  const bridge = opts.bridge ?? Math.max(2, Math.round(Math.max(W, H) / 200));
  const map = markMap(img);
  const comps = components(map, W, H);
  const names: MarkColor[] = ['blue', 'blue', 'yellow', 'green', 'magenta', 'orange', 'brown'];
  const pieces: MarkPiece[] = [];
  const pending: { c: { idx: number[]; color: number; bbox: [number, number, number, number] }; bin: Uint8Array; dist: Uint16Array; lw: number; lh: number; enclosedPx: number; openings: number; openingWidths: number[] }[] = [];
  for (const c of comps) {
    const [x0, y0, x1, y1] = c.bbox;
    if (Math.max(x1 - x0, y1 - y0) + 1 < minSide) continue;       // 番号・点
    // 塊の周り（1画素の余白つき）だけの小さな配列で処理する。画像全体をなめると大きな図面で遅い
    const lw = x1 - x0 + 3, lh = y1 - y0 + 3;
    const bin = new Uint8Array(lw * lh);
    for (const i of c.idx) bin[(((i / W) | 0) - y0 + 1) * lw + (i % W - x0 + 1)] = 1;
    const lb: [number, number, number, number] = [1, 1, lw - 2, lh - 2];
    // 塊ごとの囲み（参考値）。合計の面積は下で図面全体からまとめて出す
    const enclosedPx = enclosedArea(bin, lw, lh, lb);
    // 開口の印（線の上の小さな四角）は塗りつぶしてから細線化する。穴の大きさの上限は画像に比例
    const maxHole = opts.maxHole ?? Math.round((Math.max(W, H) / 100) ** 2);
    const openingWidths: number[] = [];
    const openings = fillSmallHoles(bin, lw, lh, lb, maxHole, openingWidths);
    const dist = distanceMap(bin, lw, lh);
    thin(bin, lw, lh);
    pending.push({ c, bin, dist, lw, lh, enclosedPx, openings, openingWidths });
  }

  // ★同じ所を2回なぞった線（間仕切り壁の表と裏）は画素では1本に重なり、見分けられない。
  //   線の太さで見分ける案は試したが、描き方で最初から太い線（廊下の半透明の線など）があり、
  //   物件A2F・物件B2Fで50m以上を誤って2本扱いしたので採らない（2026-09-30 実測）。
  const widths: number[] = [];
  for (const q of pending) for (let i = 0; i < q.lw * q.lh; i++) if (q.bin[i]) widths.push((2 * q.dist[i]) / 3);
  widths.sort((a, b) => a - b);
  const w0 = widths.length ? widths[Math.floor(widths.length * 0.5)] : 0;   // 標準の太さ
  // ── 囲みの面積は図面全体でまとめて出す ──
  //   1つの囲み（廊下など）が、注記の文字や別の印との接ぎ目で2つ以上の塊に分かれていることがある。
  //   塊ごとに途切れをつなぐと、塊と塊の間の途切れはつなげない（実測：物件B3Fの廊下が丸ごと抜けた）。
  //   印を全部まとめて少し太らせ → 内側を見つけ → 内側を太らせた幅だけ広げ戻す（元の印の上には広げない）。
  const all = new Uint8Array(W * H);
  const kept = new Set<number>();
  comps.forEach((c, k) => { const [x0, y0, x1, y1] = c.bbox; if (Math.max(x1 - x0, y1 - y0) + 1 >= minSide) kept.add(k); });
  comps.forEach((c, k) => { if (kept.has(k)) for (const i of c.idx) all[i] = 1; });
  {
    const ch = img.channels || 4, d = img.data, ri = img.bgr ? 2 : 0, bi = img.bgr ? 0 : 2;
    for (let i = 0; i < W * H; i++) if (!all[i] && isBarrier(d[i * ch + ri], d[i * ch + 1], d[i * ch + bi])) all[i] = 1;
  }
  // 印の画素（長さを測ったもの）。面積からはこれだけを除く。注記の文字は内側にあれば面積に数える
  const markOnly = new Uint8Array(W * H);
  comps.forEach((c, k) => { if (kept.has(k)) for (const i of c.idx) markOnly[i] = 1; });
  const countRegion = (walls: Uint8Array, r: number, exclude: Uint8Array = markOnly) => {
    // 外からたどり着けない所（壁そのものを含む）。太らせたなら、同じ幅だけ削って元の大きさに戻す
    const inner = interiorMask(walls, W, H);
    const region = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) region[i] = inner[i] || walls[i] ? 1 : 0;
    if (r > 0) {
      const inv = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) inv[i] = region[i] ? 0 : 1;
      const grown = dilate(inv, W, H, r);
      for (let i = 0; i < W * H; i++) region[i] = grown[i] ? 0 : 1;
    }
    // 囲まれていない線（壁の線だけの印）は region に入るが内側が無い。内側を持つ所だけ数える
    let n = 0, innerN = 0;
    for (let i = 0; i < W * H; i++) { if (inner[i]) innerN++; if (region[i] && !exclude[i]) n++; }
    return { n: innerN > 0 ? n : 0, inner, innerN };
  };
  const raw = countRegion(all, 0);
  const bridged = bridge > 0 ? countRegion(dilate(all, W, H, bridge), bridge) : { n: 0, inner: new Uint8Array(0), innerN: 0 };
  const best = bridged.n > raw.n ? bridged : raw;
  // 囲みの面積に、印の線の画素のうち何割を足すか。お客様の囲みの辺は線の中心より少し内側にあり、
  //   線の縁のにじみ（印と判定されない画素）は内側に数えられている。半分（0.5）だと小さい部屋ほど多めに出た。
  //   2026-10-05、調整用12件（物件A・物件B・物件C・物件Dの床・天井）で 0.3 が全件 ±5%、
  //   確認用5件（物件E・物件F・物件G・物件H）で 4/5 が ±5%（物件Hは別の原因で +7.6%）。
  //   ★芯線で囲む方式（線の中心＝辺とみなす）も試したが、多めに出て悪化したので採らない。
  const lineFrac = opts.lineFrac ?? 0.3;
  const lineHalf = pending.reduce((s, q) => s + q.c.idx.length, 0) * lineFrac;   // 線の芯までを面積に含める
  const unionEnclosedPx = best.n > 0 ? best.n + lineHalf : 0;
  // ── 色ごとの囲み ──
  //   拾い出しソフトでは、色の違う囲みが入れ子になることがある（建物全体の囲みの中に部屋の囲み）。
  //   お客様の表はそれぞれの囲みの面積を足しているので、色ごとに内側を数えて足す（同じ色どうしの入れ子は1つに数える）。
  let perColorPx = 0;
  const colorsPresent = new Set<number>();
  comps.forEach((c, k) => { if (kept.has(k)) colorsPresent.add(c.color); });
  if (colorsPresent.size > 1) {
    const ch = img.channels || 4, dd = img.data, ri = img.bgr ? 2 : 0, bi = img.bgr ? 0 : 2;
    for (const col of colorsPresent) {
      const mine = new Uint8Array(W * H);
      let px = 0;
      comps.forEach((c, k) => { if (kept.has(k) && c.color === col) for (const i of c.idx) { mine[i] = 1; px++; } });
      const walls = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) walls[i] = mine[i] || (!markOnly[i] && isBarrier(dd[i * ch + ri], dd[i * ch + 1], dd[i * ch + bi])) ? 1 : 0;
      const r0 = countRegion(walls, 0, mine);
      const r1 = bridge > 0 ? countRegion(dilate(walls, W, H, bridge), bridge, mine) : { n: 0 };
      const n = Math.max(r0.n, r1.n);
      if (n > 0) perColorPx += n + px * lineFrac;
    }
  }
  const totalEnclosedPx = colorsPresent.size > 1 ? Math.max(unionEnclosedPx, perColorPx) : unionEnclosedPx;

  // 囲みごとの面積（内側の画素の割合で、合計を按分する）
  const regions: MarkRegion[] = [];
  if (best.innerN > 0) {
    for (const g of components(best.inner, W, H)) {
      if (g.idx.length < minSide * 2) continue;             // 線の隙間にできた小さな袋
      regions.push({ areaPx: Math.round(totalEnclosedPx * g.idx.length / best.innerN), bbox: g.bbox });
    }
  }
  // ── 線の長さ（間仕切りの両面） ──
  //   部屋ごとに一周なぞった印では、隣り合う2部屋の間仕切りは表と裏で2回なぞられ、画素では1本に重なる。
  //   線の両側がどちらも「印に囲まれた部屋」なら両面（2本分）、片側だけ・囲み無しなら1本分と数える。
  //   囲みは上で出した図面全体の内側（best.inner）を部屋ごとに分けたもの。
  const roomId = new Int32Array(W * H);
  // 部屋の判定用の囲み。部屋ごとの印がドアの所で途切れていると囲みにならないので、
  //   opts.roomBridge（画素）があれば、それだけ太らせて途切れをつないだ囲みで部屋を数える
  const roomSrc = opts.roomBridge ? countRegion(dilate(all, W, H, opts.roomBridge), opts.roomBridge) : best;
  if (roomSrc.innerN > 0) {
    let rid = 0;
    for (const g of components(roomSrc.inner, W, H)) {
      if (g.idx.length < minSide * 2) continue;
      rid++; for (const i of g.idx) roomId[i] = rid;
    }
  }
  const debugDouble: number[] = [];
  const reach = Math.ceil(w0 / 2 + (opts.roomBridge ? opts.roomBridge : best === bridged ? bridge : 0) + 2);
   // 線の芯から部屋の内側まで届く距離
  for (const q of pending) {
    const { c, bin, lw, lh, enclosedPx, openings, openingWidths } = q;
    const [x0, y0] = c.bbox;
    const weight = new Uint8Array(lw * lh);
    let doubledPx = 0;
    for (let ly = 0; ly < lh; ly++) for (let lx = 0; lx < lw; lx++) {
      const li = ly * lw + lx;
      if (!bin[li]) continue;
      const gx = lx + x0 - 1, gy = ly + y0 - 1;
      const seen = new Set<number>();
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const r = roomId[ny * W + nx]; if (r) seen.add(r);
      }
      weight[li] = seen.size >= 2 && opts.bothFaces !== false ? 2 : 1;
    }
    // ── 太さで見る2回なぞり ──
    //   重ねてなぞった線は1〜2画素ずれて重なり、約2倍の太さになる（物件A1Fの間仕切り・廊下の線で実見）。
    //   ただし半透明で最初から太く描く線（物件Bの廊下）もあるので、図面全体ではなく
    //   「同じ塊の中の、同じ濃さ（不透明／半透明）の線」の標準の太さと比べる。端の丸い点のような一瞬の太りは数えない。
    const thickRuns: { lengthPx: number; bbox: [number, number, number, number] }[] = [];
    {
      const ch = img.channels || 4, dd = img.data, ri = img.bgr ? 2 : 0, bi = img.bgr ? 0 : 2;
      const shadeAt = (gx: number, gy: number) => {
        const i = gy * W + gx;
        const r = dd[i * ch + ri], g = dd[i * ch + 1], b = dd[i * ch + bi];
        const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
        return lo >= 60 ? 1 : (hi - lo < 120 ? 1 : 0);   // 1=半透明（薄い）, 0=不透明
      };
      // 太さ＝その画素を通る縦の連続と横の連続の短いほう（壁の線はほぼ縦か横なので、これが線の太さになる）
      const mark = new Uint8Array(lw * lh);
      for (const gi of c.idx) mark[(((gi / W) | 0) - y0 + 1) * lw + (gi % W - x0 + 1)] = 1;
      const hRun = new Uint16Array(lw * lh), vRun = new Uint16Array(lw * lh);
      for (let ly = 0; ly < lh; ly++) { let lx = 0; while (lx < lw) { if (!mark[ly * lw + lx]) { lx++; continue; } const s0 = lx; while (lx < lw && mark[ly * lw + lx]) lx++; for (let k = s0; k < lx; k++) hRun[ly * lw + k] = lx - s0; } }
      for (let lx = 0; lx < lw; lx++) { let ly = 0; while (ly < lh) { if (!mark[ly * lw + lx]) { ly++; continue; } const s0 = ly; while (ly < lh && mark[ly * lw + lx]) ly++; for (let k = s0; k < ly; k++) vRun[k * lw + lx] = ly - s0; } }
      const wid = new Float32Array(lw * lh);
      const shade = new Uint8Array(lw * lh);
      const byShade: number[][] = [[], []];
      for (let ly = 0; ly < lh; ly++) for (let lx = 0; lx < lw; lx++) {
        const li = ly * lw + lx;
        if (!bin[li]) continue;
        wid[li] = Math.min(hRun[li] || 0, vRun[li] || 0);
        shade[li] = shadeAt(lx + x0 - 1, ly + y0 - 1);
        byShade[shade[li]].push(wid[li]);
      }
      const med = byShade.map((v) => { const t = [...v].sort((a, b) => a - b); return t.length ? t[Math.floor(t.length / 2)] : 0; });
      const thick = new Uint8Array(lw * lh);
      for (let li = 0; li < lw * lh; li++) {
        if (!bin[li]) continue;
        const m0 = med[shade[li]];
        if (m0 > 0 && wid[li] >= m0 * (opts.doubleRatio ?? 1.5)) thick[li] = 1;
      }
      const minRun = opts.minRun ?? Math.max(8, Math.round(Math.max(W, H) / 100));
      for (const run of components(thick, lw, lh)) {
        if (run.idx.length < minRun) continue;
        const [a0, b0, a1, b1] = run.bbox;
        thickRuns.push({ lengthPx: run.idx.length, bbox: [a0 + x0 - 1, b0 + y0 - 1, a1 + x0 - 1, b1 + y0 - 1] });
        // ★既定では2本分に数えない。物件A1Fでは当たるが（-12%→-4%）、隣の線が並んで太く見えるだけの図面
        //   （物件B・物件G・物件C）で +6〜+12% に崩れた（2026-10-05）。AIへの手がかりとして文面に載せても、
        //   AIは使わず結果は変わらなかったので載せていない。thickRuns は記録だけ
        if (opts.thickDouble) for (const li of run.idx) weight[li] = 2;
      }
    }
    for (let li = 0; li < lw * lh; li++) if (weight[li] === 2) {
      doubledPx++;
      if (opts.debug) debugDouble.push((((li / lw) | 0) + y0 - 1) * W + (li % lw) + x0 - 1);
    }
    const ends = endpoints(bin, lw, lh);
    // 細線化で両端が線の太さの半分ずつ縮むので、端ごとに足し戻す
    const lengthPx = skeletonLength(bin, lw, lh, weight) + ends * (w0 / 2);
    pieces.push({ color: names[c.color], pixels: c.idx.length, lengthPx, enclosedPx, openings, ends, bothFacesPx: doubledPx, openingWidthsPx: openingWidths.map((v) => v + w0), thickRuns, bbox: c.bbox });
  }

  // ── 番号の数字を数える ──
  //   線より小さい塊のうち、起点の丸い点（縦横が同じくらいで中まで塗りつぶし）でないものを数字とみなし、
  //   すぐ横に並ぶ数字（10, 11 …）は1つの番号にまとめる
  const labH = Math.max(6, Math.round(Math.max(W, H) / 120));      // 数字の高さの下限の目安
  const digits: { bbox: [number, number, number, number]; color: number }[] = [];
  for (const c of comps) {
    const [x0, y0, x1, y1] = c.bbox;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.max(bw, bh) >= minSide) continue;                 // 線
    if (bh < labH) continue;                                   // 小さすぎる（点のかけら・注記のにじみ）
    const fill = c.idx.length / (bw * bh);
    const round = Math.abs(bw - bh) <= Math.max(2, bh * 0.25);
    if (round && fill > 0.62) continue;                        // 起点の丸い点
    digits.push({ bbox: c.bbox, color: c.color });
  }
  digits.sort((a, b) => a.bbox[0] - b.bbox[0]);
  const labels: MarkLabel[] = [];
  const used = new Array(digits.length).fill(false);
  for (let i = 0; i < digits.length; i++) {
    if (used[i]) continue;
    const b: [number, number, number, number] = [...digits[i].bbox] as any;
    used[i] = true;
    for (let j = i + 1; j < digits.length; j++) {
      if (used[j]) continue;
      const d = digits[j].bbox;
      const h = b[3] - b[1] + 1;
      const sameRow = Math.abs((d[1] + d[3]) / 2 - (b[1] + b[3]) / 2) <= h * 0.35;
      if (sameRow && d[0] - b[2] <= Math.max(3, h * 0.4) && d[0] >= b[0]) {
        b[2] = Math.max(b[2], d[2]); b[1] = Math.min(b[1], d[1]); b[3] = Math.max(b[3], d[3]); used[j] = true;
      }
    }
    labels.push({ bbox: b, color: names[digits[i].color] });
  }
  return {
    width: W, height: H,
    pieces,
    regions,
    labels,
    totalLengthPx: pieces.reduce((s, p) => s + p.lengthPx, 0),
    totalEnclosedPx,
    unionEnclosedPx,
    ...(opts.debug ? { debugDouble } : {}),
  };
}

/** 用紙の大きさ（mm）と縮尺と画像の幅から、1画素が実物の何mmか。用紙ごと書き出した画像のときだけ使える */
export function mmPerPixelFromSheet(imageLongPx: number, sheet: 'A1' | 'A2' | 'A3' | 'A4', scaleDenominator: number): number {
  const long = { A1: 841, A2: 594, A3: 420, A4: 297 }[sheet];
  return (long * scaleDenominator) / imageLongPx;
}

/** 印がある図面か（線がある程度の長さある、または囲みがある） */
export function hasMarks(m: MarkMeasure): boolean {
  const long = Math.max(m.width, m.height);
  return m.totalLengthPx >= long * 0.1 || m.regions.length > 0;
}

function where(b: [number, number, number, number], W: number, H: number): string {
  const cx = (b[0] + b[2]) / 2 / W, cy = (b[1] + b[3]) / 2 / H;
  const col = cx < 1 / 3 ? '左' : cx < 2 / 3 ? '中' : '右';
  const row = cy < 1 / 3 ? '上' : cy < 2 / 3 ? '中' : '下';
  const name = row === '中' && col === '中' ? '中央' : `${col === '中' ? '' : col}${row === '中' ? '' : row}` || '中央';
  return `${name}（x${b[0]}〜${b[2]}, y${b[1]}〜${b[3]}）`;
}

const COLOR_JA: Record<MarkColor, string> = { blue: '青', yellow: '黄', green: '緑', magenta: '紫', orange: 'オレンジ', brown: '茶' };

/**
 * 機械で測った印の一覧を、拾い出しのAIに渡す文面にする。
 * ★AIには「長さ・面積を目で測り直すな。番号との対応と、重なって見えない線の判断だけをしろ」と渡す。
 *   縮尺（1画素が何mmか）はAIが図面の表記（用紙・縮尺）から出す。こちらで決め打ちしない
 */
export function describeMarks(m: MarkMeasure, label = ''): string {
  const long = Math.max(m.width, m.height);
  const lines = m.pieces.filter((p) => p.lengthPx >= long * 0.01);
  const out: string[] = [];
  out.push(`## ★図面の色の印を、機械が画素で測った結果${label ? `（${label}）` : ''}★`);
  out.push('この図面には、拾う範囲が色の線（壁など）・色の囲み（床・天井など）で示されている。**印の付いた範囲だけを拾え。印の無い壁・室は拾うな。**');
  out.push(`画像は ${m.width}×${m.height} 画素。1画素の実寸は「用紙の長辺(mm) × 縮尺の分母 ÷ ${long}」で出せ`
    + `（用紙の大きさと縮尺は図面の表記を読め。例: A3(長辺420mm)・1/200 なら 420×200÷${long}＝${(420 * 200 / long).toFixed(1)}mm）。`
    + `面積は1画素の実寸の2乗を掛けろ。`);
  if (lines.length) {
    out.push('### 印の線（壁などを示す線。1本＝つながった1つの塊）');
    lines.forEach((p, k) => out.push(`- 線${k + 1}: ${COLOR_JA[p.color]}・長さ ${Math.round(p.lengthPx)}画素・端${p.ends}つ・${where(p.bbox, m.width, m.height)}`
      + (p.bothFacesPx ? `・うち両側が印で囲まれた部屋の間仕切り ${Math.round(p.bothFacesPx)}画素は、表と裏の2本分として長さに含めてある` : '')
      + (p.openings ? `・線の上の小さな四角（開口の印）${p.openings}つ（幅 ${p.openingWidthsPx.map((w) => Math.round(w)).join('・')}画素）` : '')));
    out.push(`線の合計: ${Math.round(m.totalLengthPx)}画素`);
  }
  if (m.regions.length) {
    out.push('### 印に囲まれた範囲（床・天井などを示す囲み）');
    m.regions.forEach((r, k) => out.push(`- 囲み${k + 1}: 面積 ${r.areaPx}画素（線の芯まで含む）・${where(r.bbox, m.width, m.height)}`));
    out.push(`囲みの合計: ${Math.round(m.totalEnclosedPx)}画素`);
  }
  if (m.labels.length) {
    out.push(`### 印の番号らしい数字の位置（${m.labels.length}個。機械の目安で、数え違いが1〜2個ありうる。実際の番号は図で読め）`);
    out.push(m.labels.map((l) => `(${Math.round((l.bbox[0] + l.bbox[2]) / 2)},${Math.round((l.bbox[1] + l.bbox[3]) / 2)})`).join(' '));
  }
  out.push('### この結果の使い方（必ず守れ）');
  out.push('1. **印の線の長さ・囲みの面積は、上の画素の値をmmに直して使え。目で測り直すな。**formula に「線3 1,234画素×73.0mm＝90.08m」のように書け。');
  out.push('   線の長さは**開口を引く前**の長さだ。**線の上の小さな四角は、お客様が「引く」と決めた開口の印**だ。'
    + '四角ごとに「幅（上の画素×1画素の実寸）× 高さ2,100mm」を、その線の面積から引け（図面に建具の高さが書いてあればそれを使え）。'
    + '**四角の無い所は、図面に扉が描いてあっても引くな**（お客様がそこは引かないと決めている）。');
  out.push('2. 図の番号（#1 など）ごとに行を立てる。1本の線（塊）に複数の番号の壁がつながっていて、番号ごとの長さに分けられないときは、'
    + 'その塊を1行にまとめ、name に含まれる番号を全部書け（例「#4・#5・#6 …」）。**見えている線から出した行の合計は、線の合計に一致させろ。**');
  out.push('3. **まず図の番号を全部読み、一覧にしてから行を立てろ。**番号の数より行（番号）が少なければ、線が見つからない番号がある。それが次の場合だ。');
  out.push('   番号と起点の丸（●）があるのに、その番号の線が別の線と完全に重なって見えないことがある。これは間仕切りの両面を同じ線の上になぞったものだ。'
    + 'その番号の壁は、重なっている相手の区間と同じ長さで1行出せ（線の合計とは別に、その上に足す。ただし上で「2本分として長さに含めてある」線の区間は、もう足してあるので足すな）。assumption に「#◯の線と重なる裏面」と書け。**番号の数と行の数を突き合わせ、番号を落とすな。**');
  out.push('4. 囲みは、その囲みの番号の床・天井として出せ。囲みの面積の合計は上の合計に一致させろ。');
  out.push('5. 図面の寸法線と大きく食い違うとき（2割以上）は、縮尺の読み違いを疑って warnings に書け。');
  return out.join('\n');
}
