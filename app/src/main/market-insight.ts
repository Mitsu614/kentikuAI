// 地域マーケット情報の取得（Anthropic web_search サーバーツール）
//
// 目的: 施主（施工してもらう側）の物件情報から、地域と工事種別だけを取り出して
//       全国のWeb情報を検索し、AI見積の recommendations の裏付けに使う。
//
// ★プライバシー境界★
// このモジュールから外部に出るのは「都道府県＋市区町村」「工事種別ラベル」だけ。
// 施主の氏名・番地・電話番号・コメント本文・写真は絶対に外へ出さない。
// 入口の sanitizeArea() / deriveWorkType() がその境界であり、ここを迂回して
// location や comment をそのまま検索クエリに渡してはならない。
//
// ★金額への影響★
// 検索結果は recommendations と妥当性チェックにのみ使う。単価の直接根拠にはしない
// （自社実績が最優先）。呼び出し側のプロンプトでもそう縛っている。

import { readCache, writeCache } from './external-data';

export interface MarketSource { title: string; url: string }
export interface MarketInsight { summary: string; sources: MarketSource[]; area: string; workType: string }

const PREF = '北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄';

/**
 * 住所から「都道府県＋市区町村」だけを取り出す。番地・建物名・部屋番号は捨てる。
 * 例: '大阪府大阪市中央区本町1-2-3 ○○ビル201' → '大阪府大阪市'
 */
export function sanitizeArea(location: string): string {
  if (!location) return '';
  // 全角数字を半角に寄せてから数字以降を切る
  const s = String(location).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const prefMatch = s.match(new RegExp(`(${PREF})(都|道|府|県)?`));
  const pref = prefMatch ? prefMatch[1] + (prefMatch[2] || '') : '';
  const rest = pref ? s.slice(s.indexOf(prefMatch![0]) + prefMatch![0].length) : s;
  // 数字が出る前の「◯◯市 / ◯◯区 / ◯◯町 / ◯◯村」まで（非貪欲＝最初の行政区画で止める）
  const cityMatch = rest.match(/^[^0-9]{1,12}?[市区町村]/);
  const city = cityMatch ? cityMatch[0] : '';
  return (pref + city).trim();
}

// コメント本文は外へ出さない。キーワードに一致したラベルだけを出す。
const WORK_KEYWORDS: [RegExp, string][] = [
  [/遮熱|サーモバリア|スカイ工法|屋根下工法/, '遮熱シート'],
  [/防水|ウレタン|シート防水|FRP/, '防水'],
  [/屋根|葺き替え|瓦|スレート|折板|カバー工法/, '屋根'],
  [/外壁|塗装|サイディング|吹付/, '外壁塗装'],
  [/電気|配線|コンセント|分電盤|照明|受電/, '電気設備'],
  [/足場|仮設/, '仮設・足場'],
  [/外構|駐車場|フェンス|ウッドデッキ|土間/, '外構'],
  [/給排水|配管|トイレ|キッチン|浴室|ユニットバス|洗面/, '水回り'],
  [/内装|クロス|フローリング|天井|間仕切/, '内装'],
  [/解体|撤去/, '解体'],
];

const INDUSTRY_DEFAULT: Record<string, string> = {
  heatshield: '遮熱シート',
  electrical: '電気設備',
  lease: '仮設・足場',
};

/** コメントと業種設定から、外に出しても安全な工事種別ラベルを1つ決める */
export function deriveWorkType(comment: string, industryType?: string): string {
  const text = String(comment || '');
  for (const [re, label] of WORK_KEYWORDS) if (re.test(text)) return label;
  return INDUSTRY_DEFAULT[industryType || ''] || '';
}

/** キャッシュキー用（地域×工事種別で1回だけ検索すれば十分。ファイル名に使うので英数字化） */
function cacheKey(area: string, workType: string): string {
  const hash = require('crypto').createHash('sha1').update(`${area}|${workType}`).digest('hex').slice(0, 16);
  return `market_${hash}`;
}

/** 応答から本文テキストと出典URLを取り出す */
function extractResult(content: any[]): { summary: string; sources: MarketSource[] } {
  const texts: string[] = [];
  const seen = new Map<string, string>(); // url -> title
  for (const block of content || []) {
    if (block.type === 'text') {
      if (block.text) texts.push(block.text);
      for (const c of block.citations || []) {
        if (c.url && !seen.has(c.url)) seen.set(c.url, c.title || c.url);
      }
    } else if (block.type === 'web_search_tool_result') {
      // 成功時は配列、失敗時は {error_code} のオブジェクト（例外は投げられない）
      if (Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.url && !seen.has(r.url)) seen.set(r.url, r.title || r.url);
        }
      } else if (block.content?.error_code) {
        console.error('[market] web_search エラー:', block.content.error_code);
      }
    }
  }
  return {
    summary: texts.join('\n').trim(),
    sources: [...seen].map(([url, title]) => ({ title, url })),
  };
}

const MAX_CONTINUATIONS = 3;

/**
 * 地域×工事種別の市場情報をWeb検索で集める。30日キャッシュ。
 * 失敗時は null を返し、見積本体は必ず続行させる（Web検索は補助情報でしかない）。
 */
export async function fetchMarketInsight(
  apiKey: string,
  opts: { location?: string; comment?: string; industryType?: string },
): Promise<MarketInsight | null> {
  const area = sanitizeArea(opts.location || '');
  const workType = deriveWorkType(opts.comment || '', opts.industryType);
  // 地域も工事種別も分からなければ検索しても一般論しか返らない。課金する価値がない。
  if (!area && !workType) return null;

  const key = cacheKey(area, workType);
  const cached = readCache(key, 30);
  if (cached?.summary) {
    console.log(`[market] キャッシュ命中: ${area || '全国'} / ${workType || '建築工事'}`);
    return { summary: cached.summary, sources: cached.sources || [], area, workType };
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const label = `${area || '日本国内'}の${workType || '建築工事'}`;
  const prompt = `あなたは建築見積の調査担当です。「${label}」について、いま日本のWebで確認できる情報を検索して、見積担当者が使える形でまとめてください。

調べること:
1. この工事種別の一般的な単価レンジ（㎡単価・m単価・一式など。複数ソースの幅で示す）
2. 直近の資材価格・労務単価の動向（上昇/横ばい/下落と、その理由）
3. この地域固有の事情で見積に効くもの（積雪・塩害・台風・強風・条例・アスベスト事前調査 等）
4. 施主に提案しうる関連工事や、実在する補助金・助成制度（自治体名と制度名が確認できたものだけ）

厳守:
- 検索で裏が取れた事実だけを書く。推測・一般論の水増しは書かない。確認できなければ「確認できず」と書く。
- 金額は必ず出典とセットで、いつ時点の情報かを添える。
- 全体で600字以内。見出し無しの箇条書き。装飾記号は使わない。
- 最後に1行「※この情報はWeb上の一般相場であり、自社の過去実績が優先されます」と書く。`;

  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];
  const messages: any[] = [{ role: 'user', content: prompt }];

  try {
    let response: any = null;
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      response = await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        tools,
        messages,
      } as any);
      // サーバーツールが内部ループ上限に達すると pause_turn。会話を戻して再送すると続きから再開する。
      if (response.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: response.content });
      if (i === MAX_CONTINUATIONS) console.warn('[market] pause_turn が続いたため打ち切り');
    }

    if (response?.stop_reason === 'refusal') {
      console.warn('[market] 安全性の理由で拒否されました');
      return null;
    }

    const { summary, sources } = extractResult(response?.content || []);
    if (!summary) return null;

    writeCache(key, { summary, sources, area, workType });
    console.log(`[market] Web検索で取得: ${label} (出典${sources.length}件)`);
    return { summary, sources, area, workType };
  } catch (e) {
    console.error('[market] Web検索に失敗（見積は続行）:', e);
    return null;
  }
}

/** 見積プロンプトに差し込むセクション文字列 */
export function buildMarketPrompt(insight: MarketInsight | null): string {
  if (!insight) return '';
  const label = `${insight.area || '日本国内'}の${insight.workType || '建築工事'}`;
  return `
## ★ Web検索で得た市場情報（${label}・参考情報）★
${insight.summary}

★この情報の使い方（厳守）★
- recommendations（追加提案・注意点）を書くときの裏付けにだけ使え。地域事情や補助金は具体的に書いてよい。
- breakdown の単価・金額の直接の根拠には絶対に使うな。金額は自社の過去実績が最優先。
- 上の情報と自社実績が食い違う場合は、自社実績を採用し、その旨を recommendations に一言添えろ。
`;
}
