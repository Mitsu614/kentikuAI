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
  /** 材料名が無く「部位×部屋（壁名）の面積・長さ」だけの行（建築の電卓などの拾い出しソフトの書き出し）。
   *  名前ではなく部位でAIの行に結ぶ */
  byRoom?: boolean;
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
  return answers.map(a => a.byRoom ? matchByPart(groups, a) : matchByName(groups, a));
}

// 下地・準備の行。部位だけで結ぶとき「仕上げ」と取り違えないよう後回しにする
const PREP = /下地|ボード|pb|lgs|軽鉄|軽量鉄骨|胴縁|パテ|シーラー|撤去|養生|既存|剥が|はがし|処分/i;

/** 材料名の無い「部位×部屋の面積」の行。同じ部位・同じ単位のAIの行に結ぶ。
 *  候補が1つならそれ。複数あるときは名前が近いもの（食堂アクセント→アクセントクロス）、
 *  無ければ下地以外で数量の大きいもの（＝主な仕上げ）を仮に選び、要確認にする */
function matchByPart(groups: TakeoffGroup[], a: AnswerRow): AnswerMatch {
  const aUnit = normUnit(a.unit);
  const aPart = normText(a.part);
  const samePart = groups.filter(g => aPart && normText(g.part) === aPart);
  const cands = samePart.filter(g => !aUnit || normUnit(g.unit) === aUnit);
  if (!cands.length) {
    const s = samePart[0];
    return s
      ? { key: null, score: 0, needsCheck: true, suggestKey: s.key, why: `部位「${a.part}」はあるが単位が違う（${a.unit} と ${s.unit || '—'}）` }
      : { key: null, score: 0, needsCheck: false, why: `AIの拾い出しに部位「${a.part || '—'}」の行が無い` };
  }
  // 「食堂アクセント」のように、名前に材料の手がかりがあるときはそれを優先
  //   AIの材料名から「クロス・張り」などのありふれた語を外した芯（アクセントクロス→アクセント）が、
  //   正解の名前（食堂アクセント）に含まれていれば、その材料とみなす
  const an = normText(a.name);
  const named = cands
    .map(g => ({ g, core: materialCore(g.name) }))
    .filter(x => x.core.length >= 2 && an.includes(x.core))
    .sort((x, y) => y.core.length - x.core.length)[0];
  if (named) return { key: named.g.key, score: 0.9, needsCheck: false, why: `部位「${a.part}」・名前に「${named.g.name}」の手がかり` };
  // 逆に、芯のある材料（アクセントクロスなど）に、手がかりの無い行を結ばない
  const plain = cands.filter(g => materialCore(g.name).length < 2);
  const base = plain.length ? plain : cands;
  const finish = base.filter(g => !PREP.test(g.name));
  const pool = finish.length ? finish : base;
  const pick = [...pool].sort((x, y) => y.ai - x.ai)[0];
  if (cands.length === 1) return { key: pick.key, score: 1, needsCheck: false, why: `部位「${a.part}」の行は1つだけ` };
  return {
    key: pick.key, score: 0.5, needsCheck: true,
    why: `部位「${a.part}」の行が${cands.length}つあるため、主な仕上げ（${pick.name}）に仮に結んだ（要確認）`,
  };
}

function materialCore(name: string): string {
  return normText(name).replace(/(ビニル)?クロス|壁紙|張り?|貼り?|仕上げ?|塗装|塗り|工事|一般|標準|量産品?|1000番|sp/gi, '');
}

function matchByName(groups: TakeoffGroup[], a: AnswerRow): AnswerMatch {
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

// ── 拾い出しソフト（建築の電卓 など）の書き出し ──
// 見出しが「# / 部屋名 / 色 / 部屋面積 / 部屋外周 …」「# / 壁名 / 色 / 壁長 / 壁高 / 壁面積 / … / 減算後面積」の形で、
// 「数量」という列が無い。すぐ下の行に単位（(m²)・(mm)）が並ぶ。部位はシート名の末尾（…_床 / …_壁）で分かる。
// 合計行の下に開口の一覧（開口名・幅・高さ…）が続くことがあるので、合計行で読むのをやめる。
const CALC_NAME = /^(部屋名|壁名|天井名|名称|名前|部位名|項目名)$/;
// 使う数量の列。上ほど優先（壁は開口を引いた後の面積を正解とする）
const CALC_QTY: { re: RegExp; kind: 'area' | 'len' | 'count' }[] = [
  { re: /^減算後面積$/, kind: 'area' },
  { re: /^(仕上面積|施工面積|張り面積)$/, kind: 'area' },
  { re: /^(壁面積|天井面積|床面積|部屋面積|面積)$/, kind: 'area' },
  { re: /^(巾木長さ|幅木長さ|長さ|延長|周長)$/, kind: 'len' },
  { re: /^(個数|箇所数|数)$/, kind: 'count' },
];

export function partFromSheetName(name: string): string | undefined {
  const s = String(name || '').normalize('NFKC');
  const m = s.match(/[_＿\s]([^_＿\s]+)$/);
  const tail = m ? m[1] : s;
  if (/巾木|幅木/.test(tail)) return '巾木';
  if (/天井/.test(tail)) return '天井';
  if (/壁/.test(tail)) return '壁';
  if (/床/.test(tail)) return '床';
  return undefined;
}

function parseCalcGrid(grid: any[][], srcLabel: string, sheetName: string): AnswerRow[] | null {
  const n = (v: any) => String(v ?? '').normalize('NFKC').replace(/[\s　]+/g, '');
  for (let h = 0; h < Math.min(grid.length, 20); h++) {
    const head = (grid[h] || []).map(n);
    const cName = head.findIndex(c => CALC_NAME.test(c));
    if (cName < 0) continue;
    let cQty = -1; let kind: 'area' | 'len' | 'count' = 'area';
    for (const q of CALC_QTY) { const k = head.findIndex(c => q.re.test(c)); if (k >= 0) { cQty = k; kind = q.kind; break; } }
    if (cQty < 0) continue;
    // 単位の行（見出しのすぐ下）。書いてなければ見出しの種類から決める
    const unitRow = (grid[h + 1] || []).map(n);
    const unitHasParen = unitRow.some(c => /^\(.*\)$/.test(c));
    const rawUnit = unitHasParen ? (unitRow[cQty] || '').replace(/^\(|\)$/g, '') : '';
    let unit = kind === 'area' ? '㎡' : kind === 'len' ? 'm' : '箇所';
    let scale = 1;
    if (rawUnit) {
      const u = rawUnit.toLowerCase();
      if (u === 'mm') { unit = 'm'; scale = 1 / 1000; }
      else if (u === 'cm') { unit = 'm'; scale = 1 / 100; }
      else unit = normUnit(rawUnit) || unit;
    }
    // 単位の行は「(m²)」がずれて並ぶ書き出しもあるので、面積の列なら㎡・長さの列ならmを信じる
    if (kind === 'area') { unit = '㎡'; scale = 1; }
    // 部位はシート名の末尾（…_床 / …_壁）で決める。書いていない書き出し（「新しいフロア」「Sheet1」）は見出しで決める：
    //   壁名＝壁、天井名＝天井、部屋名＝床（建築の電卓の部屋の表は床。天井は「…_天井」のシートで別に出る）
    const nameHead = head[cName];
    const part = partFromSheetName(sheetName)
      || (/壁/.test(nameHead) ? '壁' : /天井/.test(nameHead) ? '天井' : /部屋|室/.test(nameHead) ? '床' : undefined);
    const rows: AnswerRow[] = [];
    for (let i = h + (unitHasParen ? 2 : 1); i < grid.length; i++) {
      const row = grid[i] || [];
      const first = n(row[0]);
      const name = String(row[cName] ?? '').trim();
      if (first === '合計' || /^(合計|総計|小計)$/.test(n(name))) break;   // この下は別の表（開口の一覧など）
      if (first === '#') break;
      const q = parseQty(row[cQty]);
      if (!name || q === null || !(q > 0)) continue;
      rows.push({
        name, unit, qty: Math.round(q * scale * 1000) / 1000,
        part, room: name, byRoom: true,
        src: `${srcLabel ? srcLabel + ' ' : ''}${i + 1}行目`,
      });
    }
    return rows;
  }
  return null;
}

/** Excel・CSVの表（行×列の文字）から正解の行を取り出す。見出しの行は自動で探す。
 *  sheetName はシート名（拾い出しソフトの書き出しでは、ここに部位が書いてある） */
export function parseAnswerGrid(grid: any[][], srcLabel = '', sheetName = ''): { rows: AnswerRow[]; error?: string } {
  const std = parseStdGrid(grid, srcLabel);
  if (std.rows.length || !std.headerMissing) return { rows: std.rows, error: std.error };
  const calc = parseCalcGrid(grid, srcLabel, sheetName);
  if (calc && calc.length) return { rows: calc };
  if (calc) return { rows: [], error: '数量の入った行がありませんでした' };
  return { rows: [], error: std.error };
}

function parseStdGrid(grid: any[][], srcLabel = ''): { rows: AnswerRow[]; error?: string; headerMissing?: boolean } {
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
  if (h < 0) return { rows: [], headerMissing: true, error: '見出しの行が見つかりませんでした（「品名・名称」と「数量」の列、または「部屋名・壁名」と「面積」の列が必要です）' };
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
