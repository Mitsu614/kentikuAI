// 見積書の「様式（フォーマット）」を、お客様からもらったPDFに合わせる仕組み。
//
// なぜ要るか:
//   見積書の見た目は会社ごとに決まっている（元請に出す様式が指定されている、
//   長年その罫線で出している、社判の位置が決まっている）。標準様式しか出せないと
//   「結局これを手で打ち直す」ことになり、見積が出せても書類は自社様式のままになる。
//
// やり方（★ここが肝）:
//   様式PDFを**1回だけ**AIに読ませて「同じ見た目のHTMLテンプレート」を書かせ、保存する。
//   以後の見積書は、そのテンプレートに数字を差し込むだけ（AIを毎回呼ばない）。
//   - 毎回AIに描かせると、同じ会社の見積書なのに毎回レイアウトが変わる（そして崩れる）。
//   - 様式PDFを背景画像に敷いて数字を重ねる方式は、明細の行数が変わると必ずズレる。
//   テンプレートは人が直せるHTMLなので、AIの出来が甘い箇所は手で直せる。
//
// 差し込み口（プレースホルダ）は下の PLACEHOLDERS が正。AIにもこの一覧を渡す。

const ITEM_BLOCK = /\{\{#items\}\}([\s\S]*?)\{\{\/items\}\}/g;
const BLANK_BLOCK = /\{\{#blank_rows\}\}([\s\S]*?)\{\{\/blank_rows\}\}/g;

/** テンプレートで使える差し込み口。設定画面の説明とAIへの指示の両方でこれを使う。 */
export const PLACEHOLDERS = {
  会社: ['company_name', 'company_address', 'company_tel', 'company_fax', 'company_email',
    'company_registration', 'company_logo', 'company_seal'],
  宛先: ['client_name', 'client_address'],
  書類: ['doc_title', 'quote_no', 'issue_date', 'valid_until', 'subject', 'site_name',
    'construction_period', 'payment_terms', 'note'],
  金額: ['total_with_tax', 'total_with_tax_plain', 'subtotal', 'tax', 'tax_rate', 'item_count'],
  明細: ['no', 'name', 'spec', 'qty', 'unit', 'unit_price', 'amount', 'remark'],
};

export type TemplateData = {
  [k: string]: any;
  items: Record<string, string | number>[];
};

function escapeHtml(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * AIが書いたHTMLを、そのまま画面に読ませても安全な形にする。
 * 見積書テンプレートに必要なのは「文字・表・罫線・画像(data:)」だけ。
 * スクリプト・外部読み込み・イベント属性は、あっても意味が無いので落とす。
 */
export function sanitizeTemplate(html: string): string {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  s = s.replace(/<object[\s\S]*?<\/object>/gi, '');
  s = s.replace(/<embed[\s\S]*?>/gi, '');
  s = s.replace(/<link\b[^>]*>/gi, '');                    // 外部CSS
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');  // onclick 等
  s = s.replace(/javascript:/gi, '');
  // 外部の画像・フォントは読み込ませない（オフラインで崩れる／情報が外に出る）
  s = s.replace(/(src|href)\s*=\s*("|')\s*https?:\/\/[^"']*\2/gi, '$1=$2$2');
  s = s.replace(/@import[^;]+;/gi, '');
  s = s.replace(/url\(\s*['"]?https?:\/\/[^)]*\)/gi, 'none');
  return s;
}

/**
 * テンプレートに値を差し込む。
 * - {{#items}} … {{/items}} … 明細の行。中の {{name}} 等が1行ぶんずつ置き換わる
 * - {{#blank_rows}} … {{/blank_rows}} … 明細が少ないときに罫線を埋める空行
 *   （日本の見積書は行数を固定して罫線を引くので、これが無いと表の下が抜ける）
 * - {{key}} … 値を1つ差し込む。**HTMLエスケープする**
 * - {{{key}}} … エスケープしない（ロゴ・角印の data URL を img src に入れる用）
 */
export function renderTemplate(template: string, data: TemplateData, blankRows = 0): string {
  const items = Array.isArray(data.items) ? data.items : [];

  let out = String(template || '');

  out = out.replace(ITEM_BLOCK, (_m, body: string) =>
    items.map((it, i) => fillOne(body, { no: i + 1, ...it })).join(''));

  out = out.replace(BLANK_BLOCK, (_m, body: string) => {
    const n = Math.max(0, blankRows - items.length);
    return Array.from({ length: n }, () => fillOne(body, {})).join('');
  });

  // 「値があるときだけ出す」ブロック。
  // AIは備考欄などを {{#note}} … {{/note}} と書いてくることがあり、
  // これを解釈しないと **タグの文字がそのまま見積書に印字される**（実際に起きた）。
  // {{^note}} … {{/note}} はその逆（値が無いときだけ出す）。入れ子には対応しない。
  out = out.replace(/\{\{#\s*([a-z_0-9]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/gi,
    (_m, key: string, body: string) => (hasValue(data[key]) ? body : ''));
  out = out.replace(/\{\{\^\s*([a-z_0-9]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/gi,
    (_m, key: string, body: string) => (hasValue(data[key]) ? '' : body));

  return fillOne(out, data);
}

function hasValue(v: any): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim() !== '';
}

function fillOne(tpl: string, values: Record<string, any>): string {
  return String(tpl)
    .replace(/\{\{\{\s*([a-z_0-9]+)\s*\}\}\}/gi, (_m, k) => String(values[k] ?? ''))
    // 備考は改行込みで入ってくる。HTMLでは改行が潰れるので <br> に直す
    // （備考が1行に繋がって読めない、という壊れ方をする）。
    .replace(/\{\{\s*([a-z_0-9]+)\s*\}\}/gi, (_m, k) => escapeHtml(values[k] ?? '').replace(/\r?\n/g, '<br>'));
}

/** 使われている差し込み口を拾う（設定画面で「この様式は何を差し込むか」を見せるため） */
export function usedPlaceholders(template: string): string[] {
  const set = new Set<string>();
  String(template || '').replace(/\{\{\{?\s*#?\/?([a-z_0-9]+)\s*\}?\}\}/gi, (_m, k) => { set.add(String(k)); return ''; });
  return [...set];
}

/**
 * テンプレートとして成立しているかを確かめる。
 * AIの出力をそのまま保存すると、明細の繰り返しが無い（1行しか出ない）様式が紛れ込む。
 * 金額の差し込みが無い様式も、見積書として使えない。
 */
export function validateTemplate(html: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const s = String(html || '');
  if (!/\{\{#items\}\}[\s\S]*\{\{\/items\}\}/.test(s)) {
    problems.push('明細の繰り返し（{{#items}} … {{/items}}）がありません。明細が1行しか出ません。');
  }
  if (!/\{\{\s*(total_with_tax|subtotal)\s*\}\}/.test(s)) {
    problems.push('合計金額の差し込み（{{total_with_tax}} / {{subtotal}}）がありません。');
  }
  if (!/\{\{\s*client_name\s*\}\}/.test(s)) {
    problems.push('宛名の差し込み（{{client_name}}）がありません。');
  }
  if (!/<table[\s\S]*<\/table>/i.test(s)) {
    problems.push('明細の表（<table>）がありません。');
  }
  if (s.length > 200000) problems.push('テンプレートが大きすぎます（20万字超）。');
  return { ok: problems.length === 0, problems };
}

/** 様式PDFを読ませるときの指示。★ここを変えたら、作り直した様式で出力も変わる。 */
export function templatePrompt(): string {
  const list = (a: string[]) => a.map((k) => '{{' + k + '}}').join(' ');
  return `あなたは日本の建設業の書類を作るエンジニアです。
添付は、ある会社が実際に使っている**見積書の様式**です。この様式と**同じ見た目**で印刷できる
**HTMLのテンプレート**を1つ作ってください。数字や会社名は、下の差し込み口に置き換えます。

## 何より大事なこと
- **見た目をそっくりに**すること。罫線の位置・枠の太さ・項目の並び・見出しの文言・
  表の列の順番と幅・合計欄の位置・社判(角印)の位置・備考欄の位置を、添付のとおりに再現する。
- 添付に書かれている**見出しの文言をそのまま使う**こと（「御見積書」「御見積金額」「工事名」「摘要」等。
  勝手に言い換えない。「件名」と書いてあれば「件名」、「工事名称」なら「工事名称」）。
- **添付に載っていない欄を足さない。**逆に、載っている欄を省かない。
- 中身の数字・会社名・宛名は、**すべて差し込み口に置き換える**（サンプルの数字を焼き付けない）。

## 差し込み口（この名前だけを使う）
- 自社: ${list(PLACEHOLDERS.会社)}
  （company_logo と company_seal は画像のURLが入るので **<img src="{{{company_logo}}}">** のように
   三重カッコで書くこと。無いときは空になるので、img が空でも崩れない作りにする）
- 宛先: ${list(PLACEHOLDERS.宛先)}
- 書類: ${list(PLACEHOLDERS.書類)}
- 金額: ${list(PLACEHOLDERS.金額)}
  （total_with_tax・subtotal・tax・unit_price・amount は「¥1,234,567」の形で入る。
   total_with_tax_plain は「1,234,567」だけ。「金 ○○○ 円也」の欄にはこちらを使う）
- 明細の1行: ${list(PLACEHOLDERS.明細)}

## 明細の書き方（★ここを外すと使えない）
- 明細の行は **{{#items}} … {{/items}}** で囲む。囲みの中に <tr> を1行だけ書く。
  その1行が、明細の数だけ繰り返される。
  例: {{#items}}<tr><td>{{no}}</td><td>{{name}}</td><td>{{qty}}</td><td>{{unit}}</td><td>{{unit_price}}</td><td>{{amount}}</td></tr>{{/items}}
- 添付の様式が**行数固定の罫線**（明細が少なくても枠が最後まで引いてある）なら、
  {{#items}} … {{/items}} の直後に **{{#blank_rows}}<tr>…空の行…</tr>{{/blank_rows}}** を置く。
  空行は自動で必要な数だけ入る。罫線の見た目を保つために必ず入れること。
- 添付の列が「品名/仕様/数量/単位/単価/金額/備考」のように違う組み合わせなら、
  **添付の列に合わせる**（使わない差し込み口は書かなくてよい）。

## 技術的な決まり
- **1つのHTMLファイルだけ**を返す。CSSは <style> に書く。外部ファイル・Webフォント・画像URLは使わない。
- JavaScript は書かない。
- A4縦（添付が横なら横）。@page { size: A4; margin: 0 } とし、body 側で余白を作る。
- フォントは font-family:'Yu Gothic','Meiryo',sans-serif を使う。
- 印刷して罫線が消えないよう、-webkit-print-color-adjust:exact; print-color-adjust:exact; を body に付ける。
- 金額欄は右寄せ、数量・単位は中央寄せ。

返すのは**HTMLだけ**。説明文・前置き・\`\`\` の囲みは書かないこと。`;
}

/** 見積書の中身から、差し込む値を作る */
export function buildTemplateData(args: {
  invoice: any; items: { name: string; spec?: string; qty: number | string; unit: string; unitPrice: number; amount: number; remark?: string }[];
  cfg: any; subtotal: number; tax: number; taxRate: number; totalWithTax: number; subject: string;
}): TemplateData {
  const { invoice, items, cfg, subtotal, tax, taxRate, totalWithTax, subject } = args;
  const yen = (n: number) => '¥' + Math.round(Number(n) || 0).toLocaleString();
  const plain = (n: number) => Math.round(Number(n) || 0).toLocaleString();

  return {
    // 自社
    company_name: cfg.companyName || '',
    company_address: cfg.companyAddress || '',
    company_tel: cfg.companyTel || '',
    company_fax: cfg.companyFax || '',
    company_email: cfg.companyEmail || '',
    company_registration: cfg.companyRegistration || '',
    company_logo: cfg.companyLogo || '',
    company_seal: cfg.companySeal || '',
    // 宛先
    client_name: invoice.client_name || '',
    client_address: invoice.client_address || '',
    // 書類
    doc_title: '御見積書',
    quote_no: 'EST-' + String(invoice.id ?? '').padStart(4, '0'),
    issue_date: invoice.issue_date || '',
    valid_until: invoice.valid_until || '発行日より30日間',
    subject,
    site_name: invoice.property_name || '',
    construction_period: invoice.construction_period || '',
    payment_terms: invoice.payment_terms || '',
    note: invoice.notes_clean || '',
    // 金額
    subtotal: yen(subtotal),
    tax: yen(tax),
    tax_rate: Math.round((taxRate || 0.1) * 100) + '%',
    total_with_tax: yen(totalWithTax),
    total_with_tax_plain: plain(totalWithTax),
    item_count: items.length,
    // 明細
    items: items.map((it, i) => ({
      no: i + 1,
      name: it.name,
      spec: it.spec || '',
      qty: it.qty,
      unit: it.unit,
      unit_price: yen(it.unitPrice),
      amount: yen(it.amount),
      remark: it.remark || '',
    })),
  };
}
