<?php
/**
 * 現場リンク（固定URL）— 建築ブースト
 *
 * 外出先アクセスのトンネルURLは接続のたびに変わるため、そのままでは
 * 職人さんに毎回LINEでURLを送り直すことになる。
 * ここが「会社ごとに変わらない入口」になって、いま生きているURLへ転送する。
 *
 *   https://nakanokoumuten.com/genba/nakano  →  https://xxxx.trycloudflare.com
 *
 * 職人さん側はこのアドレスをブックマークするだけでよい。
 */

// トンネルURLが更新されないまま何時間も経っていたら、PCが落ちていると判断して
// 転送しない（死んだリンクに飛ばして「壊れている」と思われるのを防ぐ）
const MAX_AGE_SEC = 6 * 3600;

$id = isset($_GET['c']) ? (string)$_GET['c'] : '';

function show_page($title, $body, $status = 200) {
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">'
       . '<meta name="viewport" content="width=device-width,initial-scale=1">'
       . '<title>' . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . ' - 建築ブースト</title>'
       . '<style>body{font-family:"Hiragino Sans","Yu Gothic UI",sans-serif;background:#f0f2f5;margin:0;'
       . 'display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}'
       . '.box{background:#fff;border-radius:16px;padding:32px 28px;max-width:420px;width:100%;'
       . 'box-shadow:0 4px 24px rgba(0,0,0,.1);text-align:center}'
       . 'h1{font-size:18px;color:#1a2332;margin:0 0 12px}'
       . 'p{font-size:14px;color:#555;line-height:1.8;margin:0}'
       . '.icon{font-size:44px;margin-bottom:8px}</style></head><body><div class="box">'
       . $body . '</div></body></html>';
    exit;
}

// IDは半角英数とハイフンのみ。ここを緩めるとディレクトリを遡られる
if (!preg_match('/^[a-zA-Z0-9-]{2,32}$/', $id)) {
    show_page('リンクが正しくありません',
        '<div class="icon">🔍</div><h1>リンクが正しくありません</h1>'
      . '<p>アドレスが途中で切れていないかご確認ください。<br>ご不明な場合は担当者にお問い合わせください。</p>', 404);
}

$file = __DIR__ . '/data/' . strtolower($id) . '.json';
if (!is_file($file)) {
    show_page('まだ準備されていません',
        '<div class="icon">📭</div><h1>まだ準備されていません</h1>'
      . '<p>このリンクはまだ使える状態になっていません。<br>事務所のパソコンで建築ブーストを起動し、'
      . '設定の「外出先からアクセス」をONにしてください。</p>', 404);
}

$rec = json_decode((string)file_get_contents($file), true);
$url = isset($rec['url']) ? (string)$rec['url'] : '';
$at  = isset($rec['at']) ? (int)$rec['at'] : 0;

// 保存されている値も必ず検証する（書き込み側だけを信用しない）
$allowed = preg_match('#^https://[a-z0-9-]+\.(trycloudflare\.com|loca\.lt)$#i', $url);

if (!$allowed || $at <= 0 || (time() - $at) > MAX_AGE_SEC) {
    $ago = $at > 0 ? floor((time() - $at) / 60) : 0;
    show_page('いまは接続できません',
        '<div class="icon">💤</div><h1>いまは接続できません</h1>'
      . '<p>事務所のパソコンの電源が入っていないか、建築ブーストが終了しているようです。'
      . ($ago > 0 ? '<br><small>最後に接続できたのは約' . ($ago >= 60 ? floor($ago / 60) . '時間' : $ago . '分') . '前です</small>' : '')
      . '</p>', 503);
}

header('Cache-Control: no-store, no-cache, must-revalidate');
header('Location: ' . $url, true, 302);
exit;
