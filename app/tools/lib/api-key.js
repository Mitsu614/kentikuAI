// アプリの api-config.json から Anthropic APIキーを取り出す（main.ts の decryptField と同じ手順）。
//
// 各ハーネスが同じ20行を写していたので1か所にまとめた。
// 鍵は「ホスト名＋ユーザー名＋固定ソルト」から作る。他の端末では復号できない（＝持ち出せない）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function configPath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'kenchiku-boost', 'api-config.json');
}

function apiKey() {
  const key = crypto.createHash('sha256')
    .update(os.hostname() + os.userInfo().username + 'kentiku-salt').digest();
  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  const d = cfg.anthropicKey;
  if (!d) throw new Error('anthropicKey が設定されていません: ' + configPath());
  if (!d.startsWith('enc:')) return d;
  const b = Buffer.from(d.slice(4), 'base64');
  const dc = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  dc.setAuthTag(b.subarray(12, 28));
  return dc.update(b.subarray(28)) + dc.final('utf8');
}

module.exports = { apiKey, configPath };
