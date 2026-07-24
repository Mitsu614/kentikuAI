// 機密設定の保存ロジックの回帰テスト。
// main.ts の該当部分を「ソースから切り出して」実行するため、書き写しによるズレが起きない。
// 検証対象: 保存の度に機密が消えないこと / 空欄＝維持 / null＝削除 / ディスク上は暗号化。
//   実行: node app/tools/test-config-secrets.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const MAIN_TS = path.join(__dirname, '..', 'src', 'main', 'main.ts');
const src = fs.readFileSync(MAIN_TS, 'utf-8');

// ── main.ts から「APIキー暗号化〜saveApiConfig」までを切り出す ──
const START = '// ── API キー暗号化 ──';
const END = '// ── ライセンストークン管理（STEP3） ──';
const s = src.indexOf(START);
const e = src.indexOf(END);
if (s < 0 || e < 0 || e < s) {
  console.error('✗ main.ts から対象範囲を切り出せませんでした（目印のコメントが変わった可能性）');
  process.exit(1);
}
let block = src.slice(s, e);

// TSの型注釈だけ落とす（ロジックには触らない）
block = block
  .replace(/: Record<string, any>/g, '')
  .replace(/: string \| null \| undefined/g, '')
  .replace(/\): string \{/g, ') {')
  .replace(/\): any \{/g, ') {')
  .replace(/: any\b/g, '')
  .replace(/: string\b/g, '');

// ── スタブ環境で評価 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cfgtest-'));
const app = { getPath: () => TMP };
const TRIAL_KEYS = { anthropic: '', openai: '' };
const decryptTrialKey = () => ''; // トライアルキーのフォールバックは今回の検証対象外
const scope = {};
// eslint-disable-next-line no-new-func
new Function('fs', 'path', 'crypto', 'app', 'TRIAL_KEYS', 'decryptTrialKey', 'require', 'exportsOut',
  block + '\nObject.assign(exportsOut, { SENSITIVE_FIELDS, SENSITIVE_JSON_FIELDS, getConfigPath, loadApiConfig, loadStoredSecrets, mergeIncomingConfig, saveApiConfig });'
)(fs, path, crypto, app, TRIAL_KEYS, decryptTrialKey, require, scope);

const { SENSITIVE_FIELDS, SENSITIVE_JSON_FIELDS, getConfigPath, loadStoredSecrets, mergeIncomingConfig, saveApiConfig } = scope;

// config:load のレンダラー向け加工（IPCハンドラ内の処理と同じ手順）
function rendererView(fullCfg) {
  const safe = { ...fullCfg };
  const stored = loadStoredSecrets();
  const secretsSet = {};
  for (const f of [...SENSITIVE_FIELDS, ...SENSITIVE_JSON_FIELDS]) {
    const v = stored[f];
    secretsSet[f] = !!v && (typeof v !== 'object' || Object.keys(v).length > 0);
    delete safe[f];
  }
  safe.secretsSet = secretsSet;
  return safe;
}

let failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); failed++; }
}

console.log('\n[1] 初回保存：機密がディスクに書かれる');
saveApiConfig({
  companyName: '有限会社中野工務店',
  anthropicKey: 'sk-ant-REAL',
  adminSecret: 'ADMIN-S1',
  licenseToken: 'TOKEN-1',
  serverPassword: 'pw1',
  webSessions: { tok1: { expiry: 9999999999999 } },
});
let stored = loadStoredSecrets();
check('anthropicKey が保存された', stored.anthropicKey === 'sk-ant-REAL', stored.anthropicKey);
check('adminSecret が保存された', stored.adminSecret === 'ADMIN-S1', stored.adminSecret);
check('webSessions が保存された', !!stored.webSessions && !!stored.webSessions.tok1);
const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
check('ディスク上は暗号化されている', String(raw.adminSecret).startsWith('enc:') && String(raw.anthropicKey).startsWith('enc:'));
check('平文が残っていない', !fs.readFileSync(getConfigPath(), 'utf-8').includes('ADMIN-S1'));

console.log('\n[2] config:load はレンダラーへ機密を渡さない');
const view = rendererView(scope.loadApiConfig());
const leaked = [...SENSITIVE_FIELDS, ...SENSITIVE_JSON_FIELDS].filter(f => view[f] !== undefined);
check('機密フィールドが1つも含まれない', leaked.length === 0, '漏れ: ' + leaked.join(','));
check('設定済みフラグは立っている', view.secretsSet.adminSecret === true && view.secretsSet.anthropicKey === true);
check('会社名など通常の値は返る', view.companyName === '有限会社中野工務店');

console.log('\n[3] 設定画面から保存（機密は空欄のまま）→ 消えない ★元のバグ');
const fromRenderer = { ...view, companyTel: '03-0000-0000' }; // 画面で電話番号だけ変えた想定
saveApiConfig(mergeIncomingConfig(fromRenderer));
stored = loadStoredSecrets();
check('anthropicKey が維持された', stored.anthropicKey === 'sk-ant-REAL', String(stored.anthropicKey));
check('adminSecret が維持された', stored.adminSecret === 'ADMIN-S1', String(stored.adminSecret));
check('licenseToken が維持された', stored.licenseToken === 'TOKEN-1', String(stored.licenseToken));
check('serverPassword が維持された', stored.serverPassword === 'pw1', String(stored.serverPassword));
check('webSessions が維持された', !!(stored.webSessions && stored.webSessions.tok1));
check('変更した値は反映された', JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')).companyTel === '03-0000-0000');
check('secretsSet は保存されない', JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')).secretsSet === undefined);

console.log('\n[4] 新しい値を入力 → 上書きされる');
saveApiConfig(mergeIncomingConfig({ ...view, adminSecret: 'ADMIN-S2' }));
stored = loadStoredSecrets();
check('adminSecret が更新された', stored.adminSecret === 'ADMIN-S2', String(stored.adminSecret));
check('他の機密は無傷', stored.anthropicKey === 'sk-ant-REAL' && stored.licenseToken === 'TOKEN-1');

console.log('\n[5] 「解除」（null）→ その1件だけ削除される');
saveApiConfig(mergeIncomingConfig({ ...view, adminSecret: null }));
stored = loadStoredSecrets();
check('adminSecret が削除された', stored.adminSecret === undefined, String(stored.adminSecret));
check('他の機密は無傷', stored.anthropicKey === 'sk-ant-REAL' && stored.serverPassword === 'pw1');
check('設定済みフラグが false になる', rendererView(scope.loadApiConfig()).secretsSet.adminSecret === false);

console.log('\n[6] スマホ用セッション保存（server.ts の経路）→ 機密を壊さない');
const full = scope.loadApiConfig(); // server.ts は復号済みのフル設定を回す
full.webSessions = { tok2: { expiry: 9999999999999 } };
saveApiConfig(full);
stored = loadStoredSecrets();
check('セッションが差し替わった', !!(stored.webSessions && stored.webSessions.tok2));
check('licenseToken が無傷', stored.licenseToken === 'TOKEN-1', String(stored.licenseToken));

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (failed === 0 ? '✅ 全項目 合格' : `❌ ${failed} 件 失敗`) + '\n');
process.exit(failed === 0 ? 0 : 1);
