// S9: 遠近法を幾何で外す（平面メトリック整流）
//
// 合成データでの検証結果:
//   ・幾何そのものは誤差0.00%（傾き10〜70°すべて）
//   ・ただし座標に6.4px(画像幅0.5%)のノイズが乗ると、参照矩形が小さいほど破綻する
//       参照が屋根の 1.7% → 1.25倍以内 10%
//                    15%  → 72%
//                    25%  → 92%
//                    56%  → 99%
//   → 参照矩形は屋根の25%以上を占めさせる。下回ったら従来法(寸法直接)にフォールバック。
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const APP = 'C:/Users/mitsu/OneDrive/Desktop/kentikuAI/app';
const Anthropic = require(path.join(APP, 'node_modules/@anthropic-ai/sdk'));

function apiKey() {
  const k = crypto.createHash('sha256').update(os.hostname() + os.userInfo().username + 'kentiku-salt').digest();
  const c = JSON.parse(fs.readFileSync(process.env.APPDATA + '/kenchiku-boost/api-config.json', 'utf8'));
  const d = c.anthropicKey;
  if (!d.startsWith('enc:')) return d;
  const b = Buffer.from(d.slice(4), 'base64');
  const dc = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
  dc.setAuthTag(b.subarray(12, 28));
  return dc.update(b.subarray(28)) + dc.final('utf8');
}
const client = new Anthropic({ apiKey: apiKey() });
const SYSTEM = 'あなたは建築の積算担当者です。写真から工事対象の面積・数量だけを推定します。金額は一切出しません。';

const PROMPT = (item) => `${item.comment ? `依頼内容: ${item.comment}\n\n` : ''}この屋根の面積を、遠近法の歪みを幾何で取り除いて求めます。あなたは**画像上の座標だけ**を答えてください。計算はこちらでやります。

## やること
1. **屋根平面の上にある「実寸がわかる大きな長方形」を1つ決める。**
   ・その長方形は屋根の面の上に載っていなければならない（地面のものは不可）。
   ・**できるだけ大きく取れ。屋根の1/4以上を覆う長方形が望ましい。**
     小さい長方形を基準にすると、遠近の復元誤差が屋根全体に拡大されて壊れる。
   ・作り方の例:
     - 太陽光パネルが縦m枚×横n枚並んでいる → その配列全体を1つの長方形とみなす
       （実寸は 横 = n×1.65m または n×0.99m、縦も同様。並べ方を見て決める）
     - 折板屋根 → 「山ピッチ0.5m × k本ぶんの幅」×「軒から棟までの長さ」の矩形
       （k は数えるのではなく、屋根幅に対する見かけの比から出してよい）
     - 化粧スレート → 「働き長0.182m × 段数」の矩形
   ・長方形は屋根平面上で**実際に長方形**でなければならない（写真では台形に見える）。
2. その長方形の4隅の画像座標を、左上→右上→右下→左下の順に答える。
3. その長方形の実寸（横 refWm メートル、縦 refHm メートル）を答える。
4. **屋根の輪郭**（この長方形と同じ平面に載っている屋根面）の頂点を、時計回りに答える。
   ・屋根が複数の面に分かれている（寄棟・入母屋）なら、**その長方形が載っている1面だけ**の輪郭を答える。
   ・そして roofFaceFraction に「屋根全体のうちこの1面が占める割合」を書く（例: 切妻の片面なら0.5）。

座標は画像の左上を(0,0)、右下を(1,1)とする相対座標。小数第3位まで。

## 出力（JSONのみ）
{
  "usable": true/false,   // 屋根平面上に実寸のわかる大きな長方形が取れたか
  "reason": "usable=falseの理由。trueならnull",
  "refRect": [[x,y],[x,y],[x,y],[x,y]],   // 左上→右上→右下→左下
  "refWm": 数値,  "refHm": 数値,          // その長方形の実寸(m)
  "refBasis": "その実寸をどう決めたか（例: パネル4枚×2列 = 6.6m × 1.98m）",
  "roofPoly": [[x,y],...],                // 同一平面上の屋根面の輪郭（3点以上）
  "roofFaceFraction": 数値,               // その面が屋根全体に占める割合（1面だけなら 0.5 等）
  "developFactor": 数値,                  // 折板88mm=1.41 / 150mm=1.69 / 大波1.1 / 平葺き・瓦1.0
  "confidence": "高/中/低"
}`;

const py = (payload) => {
  const r = execFileSync('python', [path.join(__dirname, 'homography.py')], { input: JSON.stringify(payload), encoding: 'utf8' });
  return JSON.parse(r);
};

// 画像の実サイズ（アスペクト比を戻さないとホモグラフィが歪む）
function imgSize(file) {
  const out = execFileSync('python', ['-c',
    `from PIL import Image;import sys;im=Image.open(sys.argv[1]);print(im.size[0],im.size[1])`, file], { encoding: 'utf8' });
  const [w, h] = out.trim().split(/\s+/).map(Number);
  return { w, h };
}
function shoelace(p) { let s = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(s) / 2; }

(async () => {
  const ds = JSON.parse(fs.readFileSync('ds_truth.json', 'utf8'));
  const MIN_REF_FRACTION = 0.25;   // 合成実験で決めた閾値
  const out = [];
  for (const it of ds) {
    try {
      const buf = fs.readFileSync(it.file);
      const r = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 1200, temperature: 0, system: SYSTEM,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } },
          { type: 'text', text: PROMPT(it) },
        ]}],
      });
      const j = JSON.parse(r.content[0].text.match(/\{[\s\S]*\}/)[0]);
      if (!j.usable) { console.log(`${it.id.padEnd(24)} SKIP ${String(j.reason).slice(0, 50)}`); out.push({ id: it.id, skipped: true }); continue; }

      // 参照矩形が屋根面に対して十分大きいか（画像上の面積比で判定）
      const refFrac = shoelace(j.refRect) / shoelace(j.roofPoly);
      const { w, h } = imgSize(it.file);
      const res = py({ imgW: w, imgH: h, refRect: j.refRect, refWm: j.refWm, refHm: j.refHm, roofPoly: j.roofPoly });
      if (res.error) { console.log(`${it.id.padEnd(24)} ERR  ${res.error}`); out.push({ id: it.id, error: res.error }); continue; }

      const faceFrac = Number(j.roofFaceFraction) > 0 ? Number(j.roofFaceFraction) : 1;
      const df = Number(j.developFactor) > 0 ? Number(j.developFactor) : 1;
      const area = res.roofSurfaceAreaM2 / faceFrac * df;
      const ratio = area / it.statedAreaM2;
      const flag = refFrac < MIN_REF_FRACTION ? 'ref小' : '     ';
      const mark = ratio >= 0.8 && ratio <= 1.25 ? 'OK' : ratio >= 0.67 && ratio <= 1.5 ? '△ ' : 'NG';
      console.log(`${it.id.padEnd(24)} ${mark} 正解${String(it.statedAreaM2).padStart(5)} 予測${String(Math.round(area)).padStart(6)} 比${ratio.toFixed(2)} 参照/屋根${(refFrac * 100).toFixed(0).padStart(3)}% ${flag} ${String(j.refBasis).slice(0, 34)}`);
      out.push({ id: it.id, truth: it.statedAreaM2, got: area, ratio, refFrac, usable: true, view: it.viewType });
    } catch (e) {
      console.log(`${it.id.padEnd(24)} FAIL ${String(e.message).slice(0, 60)}`);
      out.push({ id: it.id, error: String(e.message).slice(0, 60) });
    }
  }
  const ok = out.filter(r => r.ratio);
  const big = ok.filter(r => r.refFrac >= MIN_REF_FRACTION);
  const rep = (rs, label) => {
    if (!rs.length) { console.log(`\n${label}: 0件`); return; }
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const w = f => rs.filter(r => r.ratio >= 1 / f && r.ratio <= f).length;
    const gm = Math.exp(rs.reduce((s, r) => s + Math.log(r.ratio), 0) / rs.length);
    const worst = rs.reduce((m, r) => Math.max(m, Math.max(r.ratio, 1 / r.ratio)), 0);
    console.log(`\n${label} (n=${rs.length})  ≤1.25倍 ${w(1.25)} / ≤1.5倍 ${w(1.5)} / ≤2倍 ${w(2)}   |log比|中央 ${med(rs.map(r => Math.abs(Math.log(r.ratio)))).toFixed(3)}  幾何平均比 ${gm.toFixed(2)}  最悪 ${worst.toFixed(2)}倍`);
  };
  rep(ok, '■ S9-homography 全件');
  rep(big, `■ うち参照矩形が屋根の${MIN_REF_FRACTION * 100}%以上`);
  console.log(`\nスキップ ${out.filter(r => r.skipped).length}件 / エラー ${out.filter(r => r.error).length}件`);
  fs.writeFileSync('res_homography.json', JSON.stringify(out, null, 1));
})();
