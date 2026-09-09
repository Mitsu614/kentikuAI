// 相場データベースの週次更新。GitHub Actions から7日おきに走る。
//
//   node scripts/update-market-prices.js            … 調べて、ガードを通し、Supabaseへ入れる
//   node scripts/update-market-prices.js --dry-run  … 調べるところまで。書き込まない
//
// 流れ:
//   ① 今の相場本文を取る（Supabaseに版があればそれ、無ければアプリ同梱の cost-reference.ts）
//   ② Claude にWeb検索させ、「この単価をこう変えたい」という差分だけ出させる（全文は書き直させない）
//   ③ scripts/lib/price-guard.js のガードに通す。通ったものだけ本文へ適用
//   ④ 新しい版として Supabase に入れ、適用分と保留分をメールで知らせる
//
// 安全側の考え方:
//   相場は全お客様の見積金額に直結する。とくに自社実績がまだ無い新規のお客様は、
//   ここの数字がそのまま見積になる。だから「AIの出力を信じて本文を書き換える」ことはしない。
//   差分に限定し、±15%・根拠URL必須・件数上限のガードを通ったものだけを入れる。
//   ガードに落ちた提案は捨てずに保留として通知する（＝人が見て判断できる）。

const fs = require('fs');
const path = require('path');
const https = require('https');
const { applyEdits } = require('./lib/price-guard');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DRY = process.argv.includes('--dry-run');

const MODEL = 'claude-opus-5';

// ── Supabase ────────────────────────────────────────────────
function supabaseGet(table, query) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1/' + table + (query || ''));
    https.get({
      hostname: url.hostname, path: url.pathname + url.search,
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => (res.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error(res.statusCode + ': ' + data))));
    }).on('error', reject);
  });
}

function supabasePost(table, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1/' + table);
    const json = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: {
        apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', Prefer: 'return=representation',
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => (res.statusCode < 300 ? resolve(data ? JSON.parse(data) : null) : reject(new Error(res.statusCode + ': ' + data))));
    });
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

// 運営あて通知。アプリと同じ send-mail の口を使う（宛先も送信元もサーバー側が持っている）。
function sendMail(subject, text) {
  return new Promise(resolve => {
    const url = new URL(SUPABASE_URL + '/functions/v1/send-mail');
    const body = JSON.stringify({ token: 'github-actions', subject, text, toOwner: true });
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      timeout: 20000,
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Claude（Web検索つき）────────────────────────────────────
function callClaude(system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system,
      // 12回だと足りなかった（初回の実走で「検索回数の上限に達したため資材動向・解体坪単価・
      //   太陽光kW単価は照合できていない」とAI自身が報告した）。20回に上げる。
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 20 }],
      messages: [{ role: 'user', content: user }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 15 * 60 * 1000,
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 300) return reject(new Error('Claude ' + res.statusCode + ': ' + data.slice(0, 500)));
        const parsed = JSON.parse(data);
        const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        resolve({ text, usage: parsed.usage });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.write(body);
    req.end();
  });
}

// ── 同梱の相場（Supabaseに版がまだ無いときの出発点）──────────
function bundledReference() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'cost-reference.ts'), 'utf8');
  const i = src.indexOf('`');
  const j = src.lastIndexOf('`');
  if (i < 0 || j <= i) throw new Error('cost-reference.ts から本文を取り出せませんでした');
  return src.slice(i + 1, j);
}

const SYSTEM = `あなたは日本の建築積算の専門家です。大阪エリアを中心とした建築工事の相場を、公的統計・業界団体・専門メディアの一次情報にあたって確認します。
根拠が確認できないものは提案しません。憶測で数字を動かすことは、この仕事では最も避けるべきことです。`;

function buildUser(current) {
  return `以下は、AI見積が参照している相場データベースの現行版です。前回の更新から時間が経っており、実勢とずれている項目があるかもしれません。

Web検索で一次情報にあたり、**明確な根拠をもって変わったと言える項目だけ**を挙げてください。

## 守ること
1. 全文を書き直さないでください。「この文字列を、この文字列に置き換える」という差分だけを返します。
2. old は現行版に**そのまま1回だけ**出てくる文字列にしてください（前後を含めて一意になるように）。
3. 数字の個数を変えないでください（例「74.6〜78万円」→「75.2〜79万円」は可、「74.6〜78万円」→「76万円」は不可）。
4. 1つの数字の変化は**±15%以内**にしてください。それを超える確かな根拠があるときは、変更として出さず、末尾の note に文章で書いてください。
5. **根拠のURLが無い変更は出さないでください。**
6. 自信が無いものは出さないでください。0件でも構いません。「変更なし」は正しい答えです。
7. 労務単価は公共工事設計労務単価、資材は建設物価・積算資料や業界団体の公表値など、たどれる出典を優先してください。

## 出力（このJSONだけ。説明文は書かない）
\`\`\`json
{
  "edits": [
    {
      "item": "何の単価か（人が読む用）",
      "old": "現行版に出てくる文字列そのまま",
      "new": "置き換えたい文字列",
      "reason": "なぜ変わったか（1〜2文）",
      "source": "https://..."
    }
  ],
  "note": "全体の所見。±15%を超える動きに気づいた場合はここに書く。無ければ空文字。"
}
\`\`\`

## 現行版
${current}`;
}

function parseJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/(\{[\s\S]*\})/);
  if (!m) throw new Error('JSONが返ってきませんでした');
  return JSON.parse(m[1]);
}

// ── 本体 ────────────────────────────────────────────────────
async function main() {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY が設定されていません');
  if (!DRY && (!SUPABASE_URL || !SUPABASE_KEY)) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY が設定されていません');

  // ① 出発点
  let current = null;
  let version = 0;
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const rows = await supabaseGet('market_prices', '?select=version,content&order=version.desc&limit=1');
      if (rows && rows.length) { current = rows[0].content; version = rows[0].version; }
    } catch (e) {
      console.error('現行版の取得に失敗:', e.message);
    }
  }
  if (!current) {
    current = bundledReference();
    console.log('Supabaseに版がまだ無いので、アプリ同梱の相場を初版の出発点にします');
  }
  console.log(`現行版: v${version} / ${current.length.toLocaleString()}文字`);

  // ② 調べさせる
  const { text, usage } = await callClaude(SYSTEM, buildUser(current));
  const result = parseJson(text);
  const edits = Array.isArray(result.edits) ? result.edits : [];
  console.log(`提案 ${edits.length}件`);
  if (usage) console.log(`トークン: 入力${usage.input_tokens} / 出力${usage.output_tokens}`);

  // ③ ガード
  const { text: nextText, applied, held } = applyEdits(current, edits);
  console.log(`適用 ${applied.length}件 / 保留 ${held.length}件`);
  for (const a of applied) console.log(`  適用: ${a.item || ''}  ${a.old} → ${a.new}`);
  for (const h of held) console.log(`  保留: ${h.edit && h.edit.item || ''}  理由: ${h.reason}`);

  const lines = [
    `相場データベースの週次更新`,
    ``,
    `現行版: v${version}`,
    `提案: ${edits.length}件 / 適用: ${applied.length}件 / 保留: ${held.length}件`,
    ``,
    `── 適用した変更 ──`,
    ...(applied.length ? applied.map(a => `・${a.item || ''}\n  ${a.old} → ${a.new}\n  理由: ${a.reason || ''}\n  根拠: ${a.source || ''}`) : ['（なし）']),
    ``,
    `── 保留（自動では入れていません）──`,
    ...(held.length ? held.map(h => `・${(h.edit && h.edit.item) || ''}  ${(h.edit && h.edit.old) || ''} → ${(h.edit && h.edit.new) || ''}\n  保留の理由: ${h.reason}\n  根拠: ${(h.edit && h.edit.source) || ''}`) : ['（なし）']),
    ``,
    `── AIの所見 ──`,
    result.note || '（なし）',
    ``,
    `保留になった変更を入れたい場合は、app/src/main/cost-reference.ts を直すか、`,
    `ガードの上限（scripts/lib/price-guard.js）を見直してください。`,
  ];
  const summary = lines.join('\n');

  if (DRY) {
    console.log('\n--dry-run のため書き込みません\n');
    console.log(summary);
    return;
  }

  // ④ 新しい版として記録。変更が0件なら版は増やさない（同じ本文を積み上げても意味がない）
  if (applied.length === 0) {
    console.log('適用できる変更が無いため、版は増やしません');
    await sendMail('【建築ブースト】相場の週次更新: 変更なし', summary);
    return;
  }

  await supabasePost('market_prices', {
    version: version + 1,
    content: nextText,
    changes: applied,
    held: held,
    model: MODEL,
    note: result.note || null,
  });
  console.log(`v${version + 1} として登録しました`);
  await sendMail(`【建築ブースト】相場を更新しました v${version + 1}（${applied.length}件）`, summary);
}

main().catch(e => {
  console.error(e);
  // 失敗も知らせる。黙って止まると「更新されている」と思い込んだまま古い相場が使われ続ける。
  sendMail('【建築ブースト】相場の週次更新に失敗しました', String(e && e.stack || e)).finally(() => process.exit(1));
});
