// 見積書の「様式の写し取り」を試すハーネス。
//
// なぜ要るか: 様式PDFからHTMLテンプレートを作らせる工程は、出来がプロンプト次第で大きく変わる。
//   アプリから試すとAIストックを1単位使うし、崩れても原因が見えない。
//   ここでは本番と同じプロンプト（src/main/estimate-template.ts）を使い、
//   生成 → 差し込み → PDF/PNG まで一気に出して、目で確かめられるようにする。
//
//   node app/tools/harness-estimate-template/run.js "<様式PDFのパス>"
//   node app/tools/harness-estimate-template/run.js "<様式PDF>" --render-only   … 直前の結果を描き直すだけ（無料）
//
// ★本番と同じものを使うために、estimate-template.ts をその場でJSに変換して読み込む。
//   プロンプトをここに書き写すと、必ず本番とズレる（拾い出しハーネスで実際に起きた）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const APP = path.resolve(DIR, '../..');
const OUT = path.join(DIR, 'out');

function loadTemplateModule() {
  const tmp = path.join(os.tmpdir(), 'kb-estimate-template-' + process.pid);
  execFileSync(process.execPath, [
    path.join(APP, 'node_modules', 'typescript', 'lib', 'tsc.js'),
    path.join(APP, 'src', 'main', 'estimate-template.ts'),
    '--outDir', tmp, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck', '--ignoreConfig',
  ], { cwd: APP, stdio: 'inherit' });
  return require(path.join(tmp, 'estimate-template.js'));
}

// APIキー（main.ts の decryptField と同じ）
function getEncKey() {
  return crypto.createHash('sha256').update(os.hostname() + os.userInfo().username + 'kentiku-salt').digest();
}
function decryptField(data) {
  if (!data || !data.startsWith('enc:')) return data;
  const buf = Buffer.from(data.slice(4), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', getEncKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return d.update(buf.subarray(28)) + d.final('utf8');
}
function loadKey() {
  const p = path.join(os.homedir(), 'AppData', 'Roaming', 'kenchiku-boost', 'api-config.json');
  const k = decryptField(JSON.parse(fs.readFileSync(p, 'utf-8')).anthropicKey || '');
  if (!k) throw new Error('anthropicKey が取れませんでした: ' + p);
  return k;
}

const SAMPLE = (T) => T.buildTemplateData({
  invoice: {
    id: 1,
    client_name: '株式会社サンプル建設',
    client_address: '大阪府大阪市中央区1-2-3',
    issue_date: new Date().toISOString().slice(0, 10),
    construction_title: '○○ビル 改修工事',
    property_name: '○○ビル',
    notes_clean: '・本見積の有効期限は発行日より30日間です。\n・別途工事がある場合はご相談ください。',
  },
  items: [
    { name: '仮設工事', qty: 1, unit: '式', unitPrice: 180000, amount: 180000 },
    { name: '内装仕上工事（クロス張替）', qty: 320, unit: '㎡', unitPrice: 1250, amount: 400000 },
    { name: '電気設備工事（照明器具取替）', qty: 24, unit: '台', unitPrice: 17000, amount: 408000 },
    { name: '施工費', qty: 1, unit: '式', unitPrice: 260000, amount: 260000 },
    { name: '諸経費', qty: 1, unit: '式', unitPrice: 152000, amount: 152000 },
  ],
  cfg: {
    companyName: '有限会社サンプル工務店',
    companyAddress: '大阪府◯◯市◯◯町1-1-1',
    companyTel: '06-0000-0000',
  },
  subtotal: 1400000, tax: 140000, taxRate: 0.1, totalWithTax: 1540000,
  subject: '○○ビル 改修工事 / ○○ビル',
});

(async () => {
  const src = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!src) { console.error('使い方: node run.js "<様式PDFのパス>"'); process.exit(1); }
  if (!fs.existsSync(src)) { console.error('ファイルがありません: ' + src); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const T = loadTemplateModule();
  const base = path.basename(src).replace(/\.[^.]+$/, '');
  const tplPath = path.join(OUT, base + '.template.html');

  let html;
  if (process.argv.includes('--render-only')) {
    html = fs.readFileSync(tplPath, 'utf-8');
    console.log('前回のテンプレートを使います: ' + tplPath);
  } else {
    const Anthropic = require(path.join(APP, 'node_modules', '@anthropic-ai', 'sdk'));
    const client = new Anthropic({ apiKey: loadKey() });
    const b64 = fs.readFileSync(src).toString('base64');
    const isPdf = path.extname(src).toLowerCase() === '.pdf';

    console.log('様式を読み取り中… ' + path.basename(src));
    const res = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      temperature: 0,
      system: 'あなたは日本の建設業の帳票をHTMLで再現するエンジニアです。渡された様式の見た目を、罫線の位置まで含めてそのまま再現します。返すのはHTMLだけです。',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '【この会社の見積書の様式：' + path.basename(src) + '】' },
          isPdf
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
            : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: T.templatePrompt() },
        ],
      }],
    }).finalMessage();

    let out = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    const fenced = out.match(/```(?:html)?\s*([\s\S]*?)```/);
    if (fenced) out = fenced[1];
    const start = out.indexOf('<');
    if (start > 0) out = out.slice(start);
    html = T.sanitizeTemplate(out.trim());
    fs.writeFileSync(tplPath, html, 'utf8');
    console.log('テンプレート: ' + tplPath + '（' + html.length + '字・停止理由 ' + res.stop_reason + '）');
  }

  const check = T.validateTemplate(html);
  console.log('検査: ' + (check.ok ? 'OK' : 'NG'));
  check.problems.forEach((p) => console.log('  ⚠ ' + p));
  console.log('差し込み口: ' + T.usedPlaceholders(html).join(', '));

  const filled = T.renderTemplate(html, SAMPLE(T), 12);
  const filledPath = path.join(OUT, base + '.filled.html');
  fs.writeFileSync(filledPath, filled, 'utf8');
  console.log('差し込み後: ' + filledPath);
  console.log('→ PDF/PNG にするには: npx electron tools/harness-estimate-template/render.js "' + filledPath + '"');
})();
