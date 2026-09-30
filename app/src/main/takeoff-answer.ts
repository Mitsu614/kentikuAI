// 図面の答え合わせ — お客様の「正解」（自社で拾った数量表）を読み込んで、AIの拾い出しとひも付ける。
//
// ここは画面（TakeoffAnswerCheck）と main（takeoff:importAnswer）の両方から使う。
// Electron・fs に触らない純粋な関数だけを置く（ハーネスから直接叩けるように）。
//   ★ここを直したら tools/harness-takeoff-answer を回すこと。
//
// 方針:
//   ・正解の数字はお客様の表のまま。ここで足したり割ったりして「正解を作る」ことはしない
//     （同じ材料が部屋ごとに何行もあるときに合計するだけ）。[[推測で数量を作らない]]
//   ・ひも付けは「候補を出す」まで。単位が違うもの・名前が遠いものは勝手に結ばず、
//     画面で人が選び直せるようにする。自信のないひも付けには needsCheck を立てる。

export interface AnswerRow {
  name: string;
  unit: string;
  qty: number;
  part?: string;
  room?: string;
  /** どこから読んだか（例: 'Sheet1 12行目'、'2ページ'） */
  src?: string;
}

export interface TakeoffGroup {
  key: string;
  part: string;
  name: string;
  unit: string;
  /** AIが拾い出し直後に言った数量の合計（部屋ごとの行を足したもの） */
  ai: number;
  /** takeoff.items の添字 */
  idxs: number[];
}

export interface AnswerMatch {
  /** ひも付け先の group.key。null = AIに該当なし（拾い漏れ候補） */
  key: string | null;
  score: number;
  /** 自信が無いので人に見てほしい */
  needsCheck: boolean;
  /** 単位が違うので結ばなかったが、名前はこれが近い */
  suggestKey?: string;
  why: string;
}

const stripRoomPrefix = (s: string) => s.replace(/^【[^】]*】/, '');

export function normText(v: any): string {
  return stripRoomPrefix(String(v ?? '').normalize('NFKC'))
    .replace(/[\s　・,，、.。()（）［］\[\]「」『』_\-ー－―/／]+/g, '')
    .toLowerCase();
}

export function normUnit(v: any): string {
  const u = String(v ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  if (/^(m2|m²|㎡|平米|平方メートル|平方m)$/.test(u)) return '㎡';
  if (/^(m3|m³|㎥|立米|立方メートル)$/.test(u)) return '㎥';
  if (/^(m|ｍ|メートル|延長m|lm)$/.test(u)) return 'm';
  if (/^(箇所|ヶ所|か所|カ所|ケ所|ヵ所|所|ヶ|カ)$/.test(u)) return '箇所';
  if (/^(個|ヶ|コ|ケ)$/.test(u)) return '個';
  if (/^(台|基)$/.test(u)) return u;
  if (/^(式|一式)$/.test(u)) return '式';
  return u;
}

export function parseQty(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).normalize('NFKC').replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** 拾い出し結果の行を「部位×材料×単位」でまとめる。部屋ごとの行はここで足される */
export function groupTakeoffItems(items: any[]): TakeoffGroup[] {
  const map = new Map<string, TakeoffGroup>();
  (items || []).forEach((it, i) => {
    const name = stripRoomPrefix(String(it?.name || '')).trim();
    const part = String(it?.part || '').trim();
    const unit = String(it?.unit || '').trim();
    const key = `${normText(part)}|${normText(name)}|${normUnit(unit)}`;
    const ai = Number(it?.aiQuantity ?? it?.quantity) || 0;
    const g = map.get(key);
    if (g) { g.ai += ai; g.idxs.push(i); }
    else map.set(key, { key, part, name, unit, ai, idxs: [i] });
  });
  // 足し算で出る 0.1+0.2 のような端数を丸める（表示と比較のため。元の数量は触らない）
  return [...map.values()].map(g => ({ ...g, ai: Math.round(g.ai * 1000) / 1000 }));
}

function bigrams(s: string): string[] {
  if (s.length < 2) return s ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 名前の近さ 0〜1。片方がもう片方を丸ごと含むときは高めに出す */
export function nameSimilarity(a: string, b: string): number {
  const x = normText(a), y = normText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  const pool = [...B];
  let hit = 0;
  for (const g of A) { const k = pool.indexOf(g); if (k >= 0) { hit++; pool.splice(k, 1); } }
  const dice = (2 * hit) / (A.length + B.length);
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  if (shorter.length >= 2 && longer.includes(shorter)) return Math.max(dice, 0.8);
  return dice;
}

const AUTO_MIN = 0.45;   // これ未満は結ばない
const SURE_MIN = 0.75;   // これ未満で結んだものは「要確認」

/** 正解の各行を、いちばん近いAIのまとまりに結ぶ。単位が違うものは結ばず候補に回す */
export function matchAnswers(groups: TakeoffGroup[], answers: AnswerRow[]): AnswerMatch[] {
  return answers.map(a => {
    const aText = `${a.part || ''}${a.name}`;
    const aUnit = normUnit(a.unit);
    let best: { g: TakeoffGroup; s: number } | null = null;
    let bestAnyUnit: { g: TakeoffGroup; s: number } | null = null;
    for (const g of groups) {
      // 名前だけ・部位込み の高いほう（お客様の表は「天井クロス」のように部位を名前に含めがち）
      const s = Math.max(nameSimilarity(a.name, g.name), nameSimilarity(aText, `${g.part}${g.name}`));
      if (!bestAnyUnit || s > bestAnyUnit.s) bestAnyUnit = { g, s };
      const unitOk = !aUnit || !normUnit(g.unit) || aUnit === normUnit(g.unit);
      if (!unitOk) continue;
      if (!best || s > best.s) best = { g, s };
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    if (best && best.s >= AUTO_MIN) {
      const sure = best.s >= SURE_MIN;
      return {
        key: best.g.key, score: r2(best.s), needsCheck: !sure,
        why: sure ? '名前と単位が一致' : '名前が似ている（要確認）',
      };
    }
    if (bestAnyUnit && bestAnyUnit.s >= SURE_MIN) {
      return {
        key: null, score: r2(bestAnyUnit.s), needsCheck: true, suggestKey: bestAnyUnit.g.key,
        why: `名前は「${bestAnyUnit.g.name}」が近いが単位が違う（${a.unit || '—'} と ${bestAnyUnit.g.unit || '—'}）`,
      };
    }
    return { key: null, score: best ? r2(best.s) : 0, needsCheck: false, why: 'AIの拾い出しに該当なし' };
  });
}

const HEAD = {
  name: /^(品名|名称|材料名|材料|品目|項目|項目名|部材|部材名|名前|摘要|内容|工事項目|工種|細目)$/,
  qty: /^(数量|数|員数|設計数量|拾い数量|拾数量|拾い出し数量|実数量|数量計|合計数量)$/,
  unit: /^(単位)$/,
  part: /^(部位|区分|分類|種別|大項目|工種区分)$/,
  room: /^(室名|部屋|部屋名|室|場所|区画|階|階・室)$/,
  spec: /^(規格|仕様|品番|型番|寸法|規格寸法)$/,
};

const TOTAL_ROW = /^(小計|合計|総計|計|中計|累計|総合計)$|小計|合計/;

/** Excel・CSVの表（行×列の文字）から正解の行を取り出す。見出しの行は自動で探す */
export function parseAnswerGrid(grid: any[][], srcLabel = ''): { rows: AnswerRow[]; error?: string } {
  const n = (v: any) => String(v ?? '').normalize('NFKC').replace(/[\s　]+/g, '');
  const find = (row: any[], re: RegExp) => row.findIndex(c => re.test(n(c)));
  let h = -1; const c: Record<keyof typeof HEAD, number> = { name: -1, qty: -1, unit: -1, part: -1, room: -1, spec: -1 };
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const row = grid[i] || [];
    const q = find(row, HEAD.qty) >= 0 ? find(row, HEAD.qty) : row.findIndex(x => /数量/.test(n(x)));
    const nm = find(row, HEAD.name);
    if (q >= 0 && nm >= 0) {
      h = i; c.qty = q; c.name = nm;
      c.unit = find(row, HEAD.unit); c.part = find(row, HEAD.part);
      c.room = find(row, HEAD.room); c.spec = find(row, HEAD.spec);
      // 「工種」が名前の列として拾われ、別に「名称」列もあるなら、工種は部位として扱う
      const nm2 = row.findIndex((x, k) => k !== nm && /^(品名|名称|材料名|部材名|項目名)$/.test(n(x)));
      if (nm2 >= 0 && /^(工種|項目|大項目)$/.test(n(row[nm]))) { if (c.part < 0) c.part = nm; c.name = nm2; }
      break;
    }
  }
  if (h < 0) return { rows: [], error: '見出しの行が見つかりませんでした（「品名・名称」と「数量」の列が必要です）' };
  const rows: AnswerRow[] = [];
  let lastPart = '', lastRoom = '';
  for (let i = h + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    const cell = (k: number) => (k >= 0 ? String(row[k] ?? '').trim() : '');
    // 部位・室名は結合セルで1行目にしか書かれないことが多いので、空なら上を引き継ぐ
    const part = cell(c.part) || (c.part >= 0 ? lastPart : '');
    const room = cell(c.room) || (c.room >= 0 ? lastRoom : '');
    if (cell(c.part)) lastPart = cell(c.part);
    if (cell(c.room)) lastRoom = cell(c.room);
    const base = cell(c.name);
    const spec = cell(c.spec);
    const qty = parseQty(row[c.qty]);
    if (!base || qty === null || !(qty > 0)) continue;
    if (TOTAL_ROW.test(n(base))) continue;
    rows.push({
      name: spec && !base.includes(spec) ? `${base} ${spec}` : base,
      unit: cell(c.unit), qty, part: part || undefined, room: room || undefined,
      src: `${srcLabel ? srcLabel + ' ' : ''}${i + 1}行目`,
    });
  }
  if (rows.length === 0) return { rows, error: '数量の入った行がありませんでした' };
  return { rows };
}

/** AIに表を書き写させるときの指示。★写すだけ。計算・推測・補完はさせない */
export const ANSWER_READ_PROMPT = `この書類は、建築工事の「数量拾い出し表」または「内訳書・見積書」です。
書かれている数量を、表のとおりに書き写してください。

守ること:
- 書いてある数字をそのまま写す。計算し直したり、足したり、推測で埋めたりしない
- 数量が書かれていない行・読めない行は入れない
- 小計・合計・総計の行は入れない
- 金額・単価は要りません（書かないでください）
- 部位（壁・天井・床 など）や室名が見出しや左の列に書かれていれば、各行に入れる。無ければ null

次のJSONだけを返してください:
\`\`\`json
{ "rows": [ { "part": "部位 or null", "room": "室名 or null", "name": "品名・名称（規格があれば続けて）", "unit": "単位", "quantity": 数量(数値), "page": ページ番号(数値) } ] }
\`\`\``;

/** AIの返事（JSON）を AnswerRow に直す。数量が数値でない行は捨てる */
export function parseAnswerJson(text: string): AnswerRow[] {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let obj: any;
  try { obj = JSON.parse(m[1] || m[0]); } catch { return []; }
  const list: any[] = Array.isArray(obj?.rows) ? obj.rows : Array.isArray(obj) ? obj : [];
  const out: AnswerRow[] = [];
  for (const r of list) {
    const name = String(r?.name ?? '').trim();
    const qty = parseQty(r?.quantity);
    if (!name || qty === null || !(qty > 0)) continue;
    if (TOTAL_ROW.test(name.normalize('NFKC').replace(/\s+/g, ''))) continue;
    out.push({
      name, unit: String(r?.unit ?? '').trim(), qty,
      part: r?.part ? String(r.part).trim() : undefined,
      room: r?.room ? String(r.room).trim() : undefined,
      src: r?.page ? `${r.page}ページ` : undefined,
    });
  }
  return out;
}
