// 遮熱シート（山下さん）見積 正規化モデル — ハーネス用の純ロジック
// main.ts の reconcileEstimateTotal 内で遮熱シート工事に当てる3補正を、AI・Electron無しで再現する:
//   ① stripHeatshieldDoubleCounted   … スカイ工法の㎡単価コミの費目（運搬・現場管理・養生・法定福利）を別行から除去
//   ② collapseHeatshieldRoofToMatKou … 材料+施工費を「材工共」1行にまとめ、人件費を別立てしない
//   ③ fixHeatshieldOverhead          … 諸経費を現場固定10万に補正（総額の12%で膨らませない）
//
// ★実装との乖離を防ぐため、除去パターンと諸経費上限は main.ts のソースから抽出して使う。

const fs = require('fs');
const path = require('path');

const MAIN_TS = path.join(__dirname, '..', '..', 'src', 'main', 'main.ts');

// main.ts から HEATSHIELD_BAKED_IN の正規表現本体と HEATSHIELD_OVERHEAD_CAP を抜く（実装と同じ値で回す）
function loadImplConstants() {
  const src = fs.readFileSync(MAIN_TS, 'utf8');
  const bakedM = src.match(/const HEATSHIELD_BAKED_IN\s*=\s*\/([^\n]+?)\/;/);
  const capM = src.match(/const HEATSHIELD_OVERHEAD_CAP\s*=\s*(\d+);/);
  if (!bakedM) throw new Error('main.ts に HEATSHIELD_BAKED_IN が見つかりません（実装が変わった？）');
  if (!capM) throw new Error('main.ts に HEATSHIELD_OVERHEAD_CAP が見つかりません（実装が変わった？）');
  return { bakedIn: new RegExp(bakedM[1]), overheadCap: Number(capM[1]) };
}

// classifyBreakdownItem の写し（main.ts:552〜）。category があればそれ、無ければ名前で判定。
function classify(item) {
  const cat = String(item?.category || '');
  if (cat === '材料' || cat === '施工費' || cat === '仮設' || cat === '経費') return cat;
  const name = String(item?.item || '');
  if (/現場管理費|福利厚生|諸経費|一般管理|法定福利/.test(name)) return '経費';
  if (/仮設|足場|養生|仮囲い|誘導員|重機回送/.test(name)) return '仮設';
  if (/施工費|人工|人件費|労務|手間/.test(name)) return '施工費';
  return '材料';
}

const HEATSHIELD_MARKUP = 1.11;

// 規模別アンカー（main.ts の heatshieldUnitPrice/Safety/Scaffold と同じ）。振り子を止めるため単価・固定費を決め打ち。
function unitPrice(qty) { return qty <= 100 ? 6500 : qty <= 300 ? 6000 : qty <= 1000 ? 5500 : 4800; }
function safety(qty) { return qty <= 100 ? 50000 : 100000; }
function scaffold(qty) { return qty <= 100 ? 80000 : qty <= 1000 ? 120000 : 180000; }

// 生の breakdown（AI出力）を、遮熱シート正規化にかけて {breakdown, total, steps} を返す。
function normalizeHeatshield(rawBreakdown, quantityM2) {
  const steps = [];
  let bd = rawBreakdown.map(b => ({ ...b }));

  // ① 二重計上除去
  const { bakedIn, overheadCap } = loadImplConstants();
  const removed = bd.filter(b => bakedIn.test(String(b.item || '')));
  if (removed.length) {
    bd = bd.filter(b => !bakedIn.test(String(b.item || '')));
    steps.push({ step: '①除去', detail: removed.map(r => `${r.item}(¥${(+r.cost || 0).toLocaleString()})`).join(' / '),
      removedYen: removed.reduce((s, r) => s + (+r.cost || 0), 0) });
  }

  // ② 材料+施工費 → 材工共1行（人件費を別立てしない）
  const isBody = b => { const c = classify(b); return c === '材料' || c === '施工費'; };
  const body = bd.filter(isBody);
  if (body.length >= 2) {
    const cost = body.reduce((s, b) => s + (+b.cost || 0), 0);
    const merged = { category: '材料', item: '遮熱シート スカイ工法（材工共）', quantity: quantityM2 || 1,
      unitPrice: quantityM2 ? Math.round(cost / quantityM2) : cost, cost };
    bd = [merged, ...bd.filter(b => !isBody(b))];
    steps.push({ step: '②材工共まとめ', detail: `材料+施工費 ${body.length}行 → 1行 ¥${cost.toLocaleString()}（人件費の別行なし）` });
  }

  // ③ 見積書は「材工共・安全・足場・諸経費」の4費目だけで再構成（細かく分けない・追加行も出さない）。
  //    端数調整は別行を作らず、税抜総額を10万円単位で切り捨てた差額を材工共に吸収する。
  const q = quantityM2 || 0;
  if (q > 0) {
    const u = unitPrice(q);
    bd = [
      { category: '材料', item: '遮熱シート スカイ工法（材工共）', quantity: q, unitPrice: u, cost: Math.round(q * u) },
      { category: '仮設', item: '安全対策費（親綱設置・墜落防止）', quantity: 1, unitPrice: safety(q), cost: safety(q) },
      { category: '仮設', item: '昇降用足場（外部昇降階段）', quantity: 1, unitPrice: scaffold(q), cost: scaffold(q) },
      { category: '経費', item: '諸経費', quantity: 1, unitPrice: overhead(q), cost: overhead(q) },
    ];
    const raw = bd.reduce((s, b) => s + (+b.cost || 0), 0);
    const rem = raw - Math.floor(raw / overheadCap) * overheadCap;   // overheadCap(=10万)を丸め単位に流用
    if (rem > 0) { bd[0].cost = bd[0].cost - rem; bd[0].unitPrice = Math.round(bd[0].cost / q); }   // 材工共に端数吸収
    steps.push({ step: '④4費目で確定', detail: `材工共¥${bd[0].cost.toLocaleString()}(${q}×約¥${bd[0].unitPrice.toLocaleString()})・安全¥${safety(q).toLocaleString()}・足場¥${scaffold(q).toLocaleString()}・諸経費¥${overhead(q).toLocaleString()}／端数-¥${rem.toLocaleString()}を材工共に吸収` });
  }

  const total = bd.reduce((s, b) => s + (+b.cost || 0), 0);
  return { breakdown: bd, total, steps };
}

function overhead(qty) { return qty <= 100 ? 60000 : 100000; }

module.exports = { normalizeHeatshield, classify, HEATSHIELD_MARKUP, loadImplConstants };
