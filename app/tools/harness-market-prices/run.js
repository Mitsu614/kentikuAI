// 相場ガードのハーネス — 「おかしな値上げ提案を、ちゃんと止められるか」を測る
//
//   node app/tools/harness-market-prices/run.js
//
// 何を測るか:
//   scripts/lib/price-guard.js に、AIが出しそうな危ない変更案を食わせて、
//   通してよいものだけが通り、危ないものが確実に止まることを確かめる。
//
// なぜ要るか:
//   相場は週1回・無人で書き換わる。全お客様の見積金額に直結し、とくに自社実績がまだ無い
//   新規のお客様は、ここの数字がそのまま見積になる。人の目が入らない以上、
//   歯止めが効いていることを機械で担保するしかない。
//   ★ガードを緩めるときは必ずここを回すこと。GitHub Actions も更新前にこれを走らせる。

const { applyEdits } = require('../../../scripts/lib/price-guard');

// 相場本文のつもりの小さな見本。実際の本文と同じ書き方（表・範囲つき単価）にしてある。
const TEXT = [
  '## 塗装工事',
  '| 項目 | 単価 |',
  '| 外壁塗装（シリコン3回塗り） | 2,000〜3,500円/㎡ |',
  '| 屋根塗装（シリコン） | 1,800〜3,000円/㎡ |',
  '| 足場 | 800〜1,200円/㎡ |',
  '',
  '## 労務単価（大阪・2025-2026年）',
  '- 大工 26,000円/人日',
  '- 電工 24,800円/人日',
  '- 塗装工 22,000円/人日',
  '',
  '## 備考',
  '足場は 800〜1,200円/㎡ が目安（同じ数字が本文に2回出てくる例）。',
].join('\n');

const SRC = 'https://www.mlit.go.jp/example';

const CASES = [
  {
    name: '妥当な値上げは通る',
    edits: [{ item: '外壁塗装', old: '2,000〜3,500円/㎡', new: '2,100〜3,600円/㎡', source: SRC, reason: '資材高' }],
    expect: r => r.applied.length === 1 && r.text.includes('2,100〜3,600円/㎡'),
    why: 'これが止まると、そもそも更新の意味が無い',
  },
  {
    name: '★15%を超える値上げは止まる',
    edits: [{ item: '大工', old: '26,000円/人日', new: '32,000円/人日', source: SRC, reason: '人手不足' }],
    expect: r => r.applied.length === 0 && /23\.1%/.test(r.held[0].reason),
    why: '無人で走る以上、大きく動かす判断は人がすべき',
  },
  {
    name: '★桁違いは止まる',
    edits: [{ item: '電工', old: '24,800円/人日', new: '248,000円/人日', source: SRC, reason: '' }],
    expect: r => r.applied.length === 0,
    why: '桁の打ち間違いがそのまま全社の見積に入る事故を防ぐ',
  },
  {
    name: '★根拠URLが無い変更は止まる',
    edits: [{ item: '塗装工', old: '22,000円/人日', new: '23,000円/人日', reason: '上がっている気がする' }],
    expect: r => r.applied.length === 0 && r.held[0].reason.includes('根拠URL'),
    why: 'たどれない数字は、後から検算も訂正もできない',
  },
  {
    name: '★本文に2箇所ある文字列は止まる',
    edits: [{ item: '足場', old: '800〜1,200円/㎡', new: '850〜1,250円/㎡', source: SRC, reason: '' }],
    expect: r => r.applied.length === 0 && r.held[0].reason.includes('2箇所'),
    why: '狙っていない場所を巻き込んで書き換えるのを防ぐ',
  },
  {
    name: '★数字の個数が変わる書き換えは止まる',
    edits: [{ item: '屋根塗装', old: '1,800〜3,000円/㎡', new: '2,400円/㎡', source: SRC, reason: '' }],
    expect: r => r.applied.length === 0 && r.held[0].reason.includes('個数'),
    why: '範囲を1点に潰されると、幅の情報が黙って消える',
  },
  {
    name: '★本文に無い文字列は止まる',
    edits: [{ item: '謎', old: '9,999円/㎡', new: '9,000円/㎡', source: SRC, reason: '' }],
    expect: r => r.applied.length === 0 && r.held[0].reason.includes('本文に無い'),
    why: 'AIが現行版を読み違えていることの証拠なので、他の提案も疑う材料になる',
  },
  {
    name: '★文章の書き換えは止まる',
    edits: [{ item: '見出し', old: '## 備考', new: '## 注意事項', source: SRC, reason: '' }],
    expect: r => r.applied.length === 0 && r.held[0].reason.includes('数字が無い'),
    why: 'ここは単価を直す口であって、文章を直す口ではない',
  },
  {
    name: '★件数の上限を超えたぶんは止まる',
    edits: Array.from({ length: 45 }, (_, i) => ({
      item: 'ダミー' + i, old: 'x', new: 'y', source: SRC,
    })),
    expect: r => r.applied.length === 0,
    why: '一度に大量に動かす提案は、全文書き換えと変わらない',
  },
  {
    name: '通るものと止まるものが混ざっても、通るものだけ入る',
    edits: [
      { item: '外壁塗装', old: '2,000〜3,500円/㎡', new: '2,050〜3,550円/㎡', source: SRC, reason: '' },
      { item: '大工', old: '26,000円/人日', new: '40,000円/人日', source: SRC, reason: '' },
    ],
    expect: r => r.applied.length === 1 && r.held.length === 1 && r.text.includes('2,050〜3,550円/㎡') && r.text.includes('26,000円/人日'),
    why: '1件の暴走で、まともな更新まで巻き添えにしない',
  },
];

let ok = 0, ng = 0;
console.log('\n相場ガードのハーネス — おかしな提案を止められるか');
console.log('（本番の price-guard.js を直接呼ぶ。API不使用・一瞬）\n');

for (const c of CASES) {
  let pass = false, err = '';
  let r = null;
  try { r = applyEdits(TEXT, c.edits); pass = !!c.expect(r); } catch (e) { err = e.message; }
  if (pass) { ok++; console.log(`  OK  ${c.name}`); }
  else {
    ng++;
    console.log(`  NG  ${c.name}${err ? ' (' + err + ')' : ''}`);
    console.log(`      なぜ見るか: ${c.why}`);
    if (r) console.log(`      実際: 適用${r.applied.length}件 / 保留${r.held.length}件 ${r.held[0] ? '（' + r.held[0].reason + '）' : ''}`);
  }
}

console.log(`\n──────── まとめ ────────`);
console.log(`合格: ${ok} / ${ok + ng}`);
if (ng > 0) console.log('\n★相場の自動更新に歯止めが効いていません。この状態で週次更新を走らせないこと。');
process.exit(ng > 0 ? 1 : 0);
