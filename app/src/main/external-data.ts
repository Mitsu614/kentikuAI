// 外部データ自動取得モジュール（無料API連携）
// 1. e-Stat API — 建設工事費デフレーター・建築着工統計（appId認証）
// 2. 国交省 不動産情報ライブラリAPI — 地価・取引価格
// 3. 国交省 公共工事設計労務単価 — 職種別日額

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const ESTAT_APP_ID = '7110f2ac6a1ccbd1449d222949de60b721019731';

const CACHE_DIR = () => path.join(app.getPath('userData'), 'external-data');

// 不動産情報ライブラリ(国交省)のAPIキー。無料だが利用申請が必要で、キー無しでは 401 になる。
// main.ts と同じ api-config.json から読む（main を import すると循環参照になるため直接読む）。
function getReinfolibApiKey(): string | null {
  try {
    const p = path.join(app.getPath('userData'), 'api-config.json');
    if (!fs.existsSync(p)) return null;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return cfg?.reinfolibApiKey || null;
  } catch { return null; }
}

function ensureCacheDir() {
  const dir = CACHE_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCachePath(key: string): string {
  return path.join(ensureCacheDir(), `${key}.json`);
}

// market-insight.ts からも同じキャッシュ層を使う（userData/external-data/*.json）
export function readCache(key: string, maxAgeDays: number = 30): any | null {
  const p = getCachePath(key);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const age = (Date.now() - (data._fetchedAt || 0)) / (1000 * 60 * 60 * 24);
    if (age > maxAgeDays) return null;
    return data;
  } catch { return null; }
}

export function writeCache(key: string, data: any) {
  fs.writeFileSync(getCachePath(key), JSON.stringify({ ...data, _fetchedAt: Date.now() }, null, 2), 'utf-8');
}

function httpsGet(url: string, headers?: Record<string, string>, timeout = 15000): Promise<string> {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || {}, timeout }, (res: any) => {
      let body = '';
      res.on('data', (c: string) => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', (e: any) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// =====================================================
// e-Stat API ヘルパー
// =====================================================

async function eStatGet(statsDataId: string, params: Record<string, string> = {}): Promise<any> {
  const query = new URLSearchParams({ appId: ESTAT_APP_ID, statsDataId, lang: 'J', ...params }).toString();
  const url = `https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData?${query}`;
  const body = await httpsGet(url);
  return JSON.parse(body);
}

// =====================================================
// 1. e-Stat API — 建設工事費デフレーター
// 統計ID: 00600270（建設工事費デフレーター）
// =====================================================

export async function fetchConstructionCostIndex(): Promise<any | null> {
  const cached = readCache('construction_cost_index', 30);
  if (cached) return cached;

  try {
    // 建設工事費デフレーター 2020年度基準・時系列（年度別）
    // statsDataId=0004055085。cat01=工事種別（100:建設総合 / 110:建築総合 / 120:住宅総合 /
    // 130:木造住宅 / 140:非木造住宅）、cat02=2020（基準年）、time=年度。
    // ※旧ID 0003427042 は e-Stat 側に存在せず、常に空振りしていた。
    const TYPES: Record<string, string> = {
      '100': '建設総合', '110': '建築総合', '120': '住宅総合',
      '130': '木造住宅', '140': '非木造住宅',
    };
    const data = await eStatGet('0004055085', { cdCat01: Object.keys(TYPES).join(','), cdCat02: '2020' });

    const rows = data?.GET_STATS_DATA?.STATISTICAL_DATA?.DATA_INF?.VALUE;
    if (!rows) throw new Error('DATA_INF.VALUE が空（統計表IDまたは絞り込み条件を確認）');
    const arr = Array.isArray(rows) ? rows : [rows];

    // @time は "2025100000" 形式。降順に並べ、直近10年度ぶんだけ残す。
    const years = Array.from(new Set(arr.map((r: any) => String(r['@time'])))).sort().reverse().slice(0, 10);
    const values = arr
      .filter((r: any) => years.includes(String(r['@time'])))
      .map((r: any) => ({
        fiscalYear: Number(String(r['@time']).substring(0, 4)),
        workType: TYPES[String(r['@cat01'])] || String(r['@cat01']),
        value: parseFloat(r['$'] || '0'),
      }))
      .filter((v: any) => v.value > 0)
      .sort((a: any, b: any) => b.fiscalYear - a.fiscalYear);

    if (values.length === 0) throw new Error('有効な数値が0件');

    const latestYear = values[0].fiscalYear;
    const latest = values.filter((v: any) => v.fiscalYear === latestYear);
    const baseYear = 2020;

    const result = {
      source: 'e-stat_deflator',
      statsDataId: '0004055085',
      description: '建設工事費デフレーター（e-Stat API・2020年度基準）',
      baseYear,
      latestYear,
      latest,
      dataCount: values.length,
      values,
      note: `${baseYear}年度=100。100超は物価上昇。建設コストの変動を示す政府公式指標`,
    };

    writeCache('construction_cost_index', result);
    console.log(`[外部データ] 建設工事費デフレーター取得完了: ${values.length}件（最新${latestYear}年度 建設総合=${latest.find((l: any) => l.workType === '建設総合')?.value ?? '?'}）`);
    return result;
  } catch (e: any) {
    console.error('[外部データ] デフレーター取得失敗:', e?.message || e);
    return null;
  }
}

// =====================================================
// 2. e-Stat API — 建築着工統計（構造別m²単価）
// 統計ID: 00600120（建築着工統計調査）
// =====================================================

export async function fetchBuildingStartStats(): Promise<any | null> {
  const cached = readCache('building_start_stats', 30);
  if (cached) return cached;

  try {
    // 建築物着工統計 — 構造別の工事費予定額・床面積
    // 用途別、構造別の建築物数・床面積・工事費予定額
    const data = await eStatGet('0003114494');

    const structures: any[] = [];
    if (data?.GET_STATS_DATA?.STATISTICAL_DATA?.DATA_INF?.VALUE) {
      const rows = data.GET_STATS_DATA.STATISTICAL_DATA.DATA_INF.VALUE;
      const arr = Array.isArray(rows) ? rows : [rows];

      // 最新年度のデータを抽出
      const latestTime = arr.length > 0 ? arr[arr.length - 1]['@time'] : '';
      const latestRows = arr.filter((r: any) => r['@time'] === latestTime);

      for (const row of latestRows.slice(0, 50)) {
        structures.push({
          time: row['@time'] || '',
          cat01: row['@cat01'] || '', // 用途
          cat02: row['@cat02'] || '', // 構造
          value: parseFloat(row['$'] || '0'),
          unit: row['@unit'] || '',
        });
      }
    }

    const result = {
      source: 'e-stat_building_starts',
      description: '建築着工統計 構造別データ（e-Stat API）',
      dataCount: structures.length,
      structures,
      note: '国交省「建築着工統計調査」の構造別・用途別着工データ',
    };

    writeCache('building_start_stats', result);
    console.log(`[外部データ] 建築着工統計取得完了: ${structures.length}件`);
    return result;
  } catch (e) {
    console.error('[外部データ] 建築着工統計取得失敗:', e);
    return null;
  }
}

// =====================================================
// 3. e-Stat API — 建築工事費調査（m²あたり工事費）
// =====================================================

export async function fetchConstructionCostPerM2(): Promise<any | null> {
  const cached = readCache('construction_cost_m2', 30);
  if (cached) return cached;

  try {
    // 建築着工統計「建築主別、構造別／建築物の数、床面積、工事費予定額」(statsDataId=0003461558)。
    // m²単価そのものを公表している統計表は無いので、tab=14(工事費予定額,万円) ÷ tab=13(床面積,m²) で算出する。
    // cat02=11(建築主:計) に絞り、最新月のデータだけを使う。
    // ※旧ID 0004104862 は e-Stat 側に存在せず、常に空振りしていた。
    const STRUCTURES: Record<string, string> = {
      '12': '木造', '13': 'SRC造', '14': 'RC造', '15': 'S造', '16': 'CB造',
    };
    const TAB_FLOOR = '13';   // 床面積の合計（m²）
    const TAB_COST = '14';    // 工事費予定額（万円）
    const data = await eStatGet('0003461558', { cdCat02: '11' });

    const rows = data?.GET_STATS_DATA?.STATISTICAL_DATA?.DATA_INF?.VALUE;
    if (!rows) throw new Error('DATA_INF.VALUE が空（統計表IDまたは絞り込み条件を確認）');
    const arr = Array.isArray(rows) ? rows : [rows];

    // 最新月（@time の最大値）だけを採用する
    const latestTime = arr.map((r: any) => String(r['@time'])).sort().reverse()[0];
    const latestRows = arr.filter((r: any) => String(r['@time']) === latestTime);

    // 構造 × 表章項目 で引けるようにする
    const byStructure: Record<string, Record<string, number>> = {};
    for (const r of latestRows) {
      const st = String(r['@cat01']);
      if (!STRUCTURES[st]) continue;
      (byStructure[st] ||= {})[String(r['@tab'])] = parseFloat(r['$'] || '0');
    }

    const costs = Object.entries(byStructure)
      .map(([code, tabs]) => {
        const floorM2 = tabs[TAB_FLOOR] || 0;
        const costManYen = tabs[TAB_COST] || 0;
        if (floorM2 <= 0 || costManYen <= 0) return null;
        return {
          structure: STRUCTURES[code],
          floorAreaM2: floorM2,
          // 工事費予定額の単位は「万円」。円に直してから床面積で割る。
          yenPerM2: Math.round((costManYen * 10000) / floorM2),
        };
      })
      .filter(Boolean) as any[];

    if (costs.length === 0) throw new Error('構造別の床面積・工事費が取れなかった');

    // "2024001212" → 2024年12月
    const y = latestTime.substring(0, 4);
    const m = String(Number(latestTime.substring(8, 10)));

    const result = {
      source: 'e-stat_cost_per_m2',
      statsDataId: '0003461558',
      description: '建築着工統計から算出した構造別m²単価（e-Stat API）',
      period: `${y}年${m}月`,
      dataCount: costs.length,
      costs,
      note: '着工建築物の工事費予定額 ÷ 床面積。実際の契約額ではなく着工時の予定額である点に注意',
    };

    writeCache('construction_cost_m2', result);
    console.log(`[外部データ] 構造別m²単価取得完了(${result.period}): ` + costs.map(c => `${c.structure}=${c.yenPerM2.toLocaleString()}円/m²`).join(', '));
    return result;
  } catch (e: any) {
    console.error('[外部データ] 工事費m²単価取得失敗:', e?.message || e);
    return null;
  }
}

// =====================================================
// 4. 国交省 公共工事設計労務単価（最新）
// =====================================================

export async function fetchLaborCosts(): Promise<any | null> {
  const cached = readCache('labor_costs', 90);
  if (cached) return cached;

  try {
    // 国交省の労務単価公表ページ
    const html = await httpsGet('https://www.mlit.go.jp/totikensangyo/const/sosei_const_tk2_000033.html');
    const pdfMatch = html.match(/href="([^"]*roumu[^"]*\.pdf)"/i) || html.match(/href="([^"]*content\/\d+\.pdf)"/i);

    // ★この単価表はアプリに内蔵した固定値であり、上のHTTP取得で解析したものではない。
    //   上の取得は最新PDFのURLを拾うためだけに使っている。
    //   国交省が労務単価を改定したら（例年3月適用）、下の rate / prev を手で更新すること。
    const result: any = {
      source: 'mlit_labor_costs',
      dataSource: 'bundled', // 内蔵値。自動更新されない
      description: '公共工事設計労務単価（令和8年3月適用・アプリ内蔵の公表値）',
      effectiveDate: '2026-03-01',
      nationalAverage: 25834,
      yoyChange: '+4.5%',
      consecutiveYears: 14,
      trades: {
        carpenter:        { name: '大工',       rate: 30400, prev: 29100 },
        plasterer:        { name: '左官',       rate: 29800, prev: 28500 },
        formwork:         { name: '型枠工',     rate: 32900, prev: 31500 },
        rebar:            { name: '鉄筋工',     rate: 31267, prev: 29900 },
        scaffolding:      { name: 'とび工',     rate: 30780, prev: 29500 },
        painter:          { name: '塗装工',     rate: 28200, prev: 27000 },
        electrician:      { name: '電気工',     rate: 29300, prev: 28000 },
        plumber:          { name: '配管工',     rate: 29300, prev: 28000 },
        tiler:            { name: 'タイル工',   rate: 28700, prev: 27500 },
        interior:         { name: '内装工',     rate: 26100, prev: 25000 },
        demolition:       { name: '解体工',     rate: 24400, prev: 23400 },
        specialWorker:    { name: '特殊作業員', rate: 28111, prev: 26900 },
        generalWorker:    { name: '普通作業員', rate: 23605, prev: 22600 },
        lightWorker:      { name: '軽作業員',   rate: 18605, prev: 17800 },
        trafficGuardA:    { name: '交通誘導員A', rate: 18700, prev: 17900 },
        trafficGuardB:    { name: '交通誘導員B', rate: 16050, prev: 15400 },
        specialDriver:    { name: '運転手(特殊)', rate: 28500, prev: 27300 },
        generalDriver:    { name: '運転手(一般)', rate: 24800, prev: 23700 },
        hvac:             { name: '設備工(空調)', rate: 30300, prev: 29000 },
      },
      pdfUrl: pdfMatch ? pdfMatch[1] : 'https://www.mlit.go.jp/report/press/content/001981942.pdf',
    };

    writeCache('labor_costs', result);
    console.log('[外部データ] 労務単価取得完了');
    return result;
  } catch (e) {
    console.error('[外部データ] 労務単価取得失敗:', e);
    return null;
  }
}

// =====================================================
// 5. 不動産情報ライブラリAPI — 地価・取引価格
// =====================================================

export async function fetchLandPrices(prefecture: string): Promise<any | null> {
  const cacheKey = `land_prices_${prefecture}`;
  const cached = readCache(cacheKey, 90);
  if (cached) return cached;

  try {
    const year = new Date().getFullYear();
    const from = `${year - 1}1`;
    const to = `${year}2`;

    const prefCodes: Record<string, string> = {
      '北海道': '01', '青森': '02', '岩手': '03', '宮城': '04', '秋田': '05',
      '山形': '06', '福島': '07', '茨城': '08', '栃木': '09', '群馬': '10',
      '埼玉': '11', '千葉': '12', '東京': '13', '神奈川': '14', '新潟': '15',
      '富山': '16', '石川': '17', '福井': '18', '山梨': '19', '長野': '20',
      '岐阜': '21', '静岡': '22', '愛知': '23', '三重': '24', '滋賀': '25',
      '京都': '26', '大阪': '27', '兵庫': '28', '奈良': '29', '和歌山': '30',
      '鳥取': '31', '島根': '32', '岡山': '33', '広島': '34', '山口': '35',
      '徳島': '36', '香川': '37', '愛媛': '38', '高知': '39', '福岡': '40',
      '佐賀': '41', '長崎': '42', '熊本': '43', '大分': '44', '宮崎': '45',
      '鹿児島': '46', '沖縄': '47',
    };

    const code = prefCodes[prefecture] || prefCodes[prefecture.replace(/県|府|都|道/, '')] || '27';

    // 不動産情報ライブラリは API キー必須（キー無しだと 401）。
    // 未設定なら通信せずに諦める。以前はキー無しで叩いて毎回 401 を握り潰していた。
    const apiKey = getReinfolibApiKey();
    if (!apiKey) {
      console.warn('[外部データ] 不動産取引価格: APIキー未設定のためスキップ（api-config.json の reinfolibApiKey）');
      return null;
    }

    const url = `https://www.reinfolib.mlit.go.jp/ex-api/external/XIT001?from=${from}&to=${to}&area=${code}&priceClassification=01`;
    const body = await httpsGet(url, { 'Ocp-Apim-Subscription-Key': apiKey });
    const json = JSON.parse(body);
    // 正常時は { status: "OK", data: [...] }
    const data = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(data)) throw new Error(`想定外の応答: ${body.substring(0, 120)}`);

    const trades = data.slice(0, 100);
    const prices = trades
      .filter((t: any) => t.TradePrice && t.Area)
      .map((t: any) => ({
        price: parseInt(t.TradePrice),
        area: parseFloat(t.Area) || 0,
        type: t.Type,
        district: t.DistrictName,
      }));

    const avgPrice = prices.length > 0
      ? Math.round(prices.reduce((s: number, p: any) => s + p.price, 0) / prices.length)
      : 0;

    const result = {
      source: 'mlit_land_prices',
      description: `不動産取引価格（${prefecture}）`,
      prefecture,
      prefCode: code,
      period: `${year - 1}〜${year}`,
      sampleCount: prices.length,
      avgTradePrice: avgPrice,
      trades: prices.slice(0, 20),
    };

    writeCache(cacheKey, result);
    console.log(`[外部データ] 不動産取引価格（${prefecture}）取得完了: ${prices.length}件`);
    return result;
  } catch (e) {
    console.error('[外部データ] 不動産取引価格取得失敗:', e);
    return null;
  }
}

// =====================================================
// 6. 全データをまとめて取得（起動時にバックグラウンドで実行）
// =====================================================

export async function fetchAllExternalData(): Promise<string> {
  const results: string[] = [];

  try {
    const [deflator, costM2, labor] = await Promise.all([
      fetchConstructionCostIndex(),
      fetchConstructionCostPerM2(),
      fetchLaborCosts(),
    ]);

    // 労務単価（19職種）
    if (labor?.trades) {
      const lines = Object.values(labor.trades).map((t: any) =>
        `${t.name}: ${t.rate.toLocaleString()}円/日（前年${t.prev.toLocaleString()}円、${t.rate > t.prev ? '+' : ''}${Math.round((t.rate - t.prev) / t.prev * 100)}%）`
      );
      results.push(`## 公共工事設計労務単価（${labor.effectiveDate}適用・全職種平均${labor.nationalAverage.toLocaleString()}円・${labor.yoyChange}・${labor.consecutiveYears}年連続上昇）\n${lines.join('\n')}\n※公共工事の積算用単価。民間工事はこの0.8〜1.3倍が目安。`);
    }

    // 建設工事費デフレーター（工事種別ごとの最新値＋建設総合の推移）
    if (deflator?.latest?.length > 0) {
      const latestLines = deflator.latest.map((v: any) => `${v.workType}: ${v.value}`);
      const trend = deflator.values
        .filter((v: any) => v.workType === '建設総合')
        .slice(0, 5)
        .map((v: any) => `${v.fiscalYear}年度: ${v.value}`);
      results.push(
        `## 建設工事費デフレーター（e-Stat API・${deflator.baseYear}年度=100）\n` +
        `【${deflator.latestYear}年度の水準】\n${latestLines.join('\n')}\n` +
        `【建設総合の推移】\n${trend.join('\n')}\n` +
        `※${deflator.baseYear}年度と比べて資材・労務がどれだけ上がったかを示す政府公式指標。` +
        `古い実績や相場表の金額を今の金額に直すときは、この比で補正すること。`
      );
    }

    // 構造別m²単価（着工統計から算出）
    if (costM2?.costs?.length > 0) {
      const lines = costM2.costs
        .sort((a: any, b: any) => b.floorAreaM2 - a.floorAreaM2)
        .map((c: any) => `${c.structure}: ${c.yenPerM2.toLocaleString()}円/m²（${Math.round(c.yenPerM2 * 3.30578).toLocaleString()}円/坪）`);
      results.push(
        `## 構造別の実勢m²単価（e-Stat 建築着工統計・${costM2.period}着工分）\n${lines.join('\n')}\n` +
        `※全国の着工建築物の工事費予定額÷床面積。新築の妥当性チェックに使う。改修・部分工事には適用しないこと。`
      );
    }
  } catch (e) {
    console.error('[外部データ] 一括取得でエラー:', e);
  }

  const totalCount = results.length;
  return results.length > 0
    ? `\n## ★ 外部公的データ（政府統計API自動取得・${totalCount}ソース）★\n以下は e-Stat API・国交省の公式データです。見積金額の妥当性チェックに使用してください。\n\n` + results.join('\n\n')
    : '';
}

// =====================================================
// 7. 地域別の外部データ（見積時に都道府県が指定された場合）
// =====================================================

export async function fetchRegionalData(location: string): Promise<string> {
  if (!location) return '';

  const prefMatch = location.match(/(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)/);
  if (!prefMatch) return '';

  const pref = prefMatch[1];

  try {
    const landData = await fetchLandPrices(pref);
    if (landData && landData.sampleCount > 0) {
      return `\n## ★ ${pref}の不動産取引データ（国交省 不動産情報ライブラリAPI・${landData.sampleCount}件）★\n- 直近の平均取引価格: ${landData.avgTradePrice.toLocaleString()}円\n- サンプル数: ${landData.sampleCount}件\n- 期間: ${landData.period}\n※この地域の不動産価格水準を、見積金額の地域補正の参考にしてください。\n`;
    }
  } catch (e) {
    console.error(`[外部データ] ${pref}の地域データ取得失敗:`, e);
  }
  return '';
}
