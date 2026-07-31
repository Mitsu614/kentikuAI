<?php
/**
 * 現場リンクの登録・更新 — 建築ブースト（アプリから自動で叩かれる）
 *
 * POST { id, url, token }
 *
 * 認証の考え方:
 *   共有パスワードは使わない。アプリは公開リポジトリからビルドされるので、
 *   埋め込んだ合言葉は必ず読まれる。
 *   代わりに「先に登録した端末がそのIDの持ち主」とする。初回登録で受け取った token を保存し、
 *   2回目以降は同じ token を出せた端末だけが上書きできる。token はアプリが端末内で生成し、
 *   外に出るのはこのAPIへの登録時だけ。
 *
 * さらに、転送先は Cloudflare / localtunnel のトンネルURLだけを受け付ける。
 * 万一 token が漏れても、任意の詐欺サイトへ飛ばすことはできない。
 */

header('Content-Type: application/json; charset=utf-8');

function out($arr, $status = 200) {
    http_response_code($status);
    echo json_encode($arr, JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(['ok' => false, 'error' => 'POST only'], 405);

$raw = file_get_contents('php://input');
$in = json_decode((string)$raw, true);
if (!is_array($in)) $in = $_POST;

$id    = isset($in['id']) ? strtolower(trim((string)$in['id'])) : '';
$url   = isset($in['url']) ? trim((string)$in['url']) : '';
$token = isset($in['token']) ? trim((string)$in['token']) : '';

if (!preg_match('/^[a-z0-9-]{2,32}$/', $id))            out(['ok' => false, 'error' => 'bad id'], 400);
if (!preg_match('/^[a-f0-9]{32,64}$/i', $token))        out(['ok' => false, 'error' => 'bad token'], 400);
// 転送先はトンネルURLのみ。任意のURLを登録させない
if (!preg_match('#^https://[a-z0-9-]+\.(trycloudflare\.com|loca\.lt)$#i', $url)) {
    out(['ok' => false, 'error' => 'bad url'], 400);
}

$dir = __DIR__ . '/data';
if (!is_dir($dir)) @mkdir($dir, 0755, true);
$file = $dir . '/' . $id . '.json';

if (is_file($file)) {
    $cur = json_decode((string)file_get_contents($file), true);
    $owner = isset($cur['token']) ? (string)$cur['token'] : '';
    // 先に登録した端末以外は上書きできない
    if ($owner !== '' && !hash_equals($owner, $token)) {
        out(['ok' => false, 'error' => 'このIDは既に別の端末で使われています。設定で別のIDにしてください。'], 409);
    }
}

$ok = file_put_contents($file, json_encode([
    'url'   => $url,
    'at'    => time(),
    'token' => $token,
], JSON_UNESCAPED_UNICODE), LOCK_EX);

if ($ok === false) out(['ok' => false, 'error' => 'write failed'], 500);
out(['ok' => true, 'id' => $id]);
