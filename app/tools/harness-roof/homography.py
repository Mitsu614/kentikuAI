# 屋根平面のメトリック整流（Criminisi et al., Single View Metrology, IJCV 2000）
#
# 入力: 画像上の「実寸がわかっている矩形」の4隅と、屋根輪郭のポリゴン（いずれも相対座標）
# 出力: 屋根の実面積(m²)
#
# 原理: 参照矩形の4点対応から平面ホモグラフィ H を一意に決められる（8自由度、4点で8式）。
# 参照矩形が屋根平面上にあるなら、H は「その屋根平面 → メトリック平面」の写像になる。
# 屋根輪郭を H で写せば、遠近による縮みが完全に外れた実寸ポリゴンが得られる。
# 面積は靴ひも公式で出す。勾配補正は不要（参照が屋根面上にあるので既に斜面上の実面積）。
import sys, json
import numpy as np

def homography(src, dst):
    """src(4x2) → dst(4x2) の射影変換を DLT + SVD で解く"""
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        A.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, Vt = np.linalg.svd(np.asarray(A, dtype=float))
    H = Vt[-1].reshape(3, 3)
    return H / H[2, 2]

def apply_H(H, pts):
    p = np.hstack([np.asarray(pts, float), np.ones((len(pts), 1))])
    q = (H @ p.T).T
    return q[:, :2] / q[:, 2:3]

def shoelace(pts):
    p = np.asarray(pts, float)
    x, y = p[:, 0], p[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))

def main():
    data = json.load(sys.stdin)
    W, H_px = data.get("imgW", 1000), data.get("imgH", 1000)
    # 相対座標 → ピクセル座標（アスペクト比を戻さないとホモグラフィが歪む）
    ref = [[p[0] * W, p[1] * H_px] for p in data["refRect"]]
    roof = [[p[0] * W, p[1] * H_px] for p in data["roofPoly"]]
    w_m, h_m = float(data["refWm"]), float(data["refHm"])

    # 参照矩形の頂点順（左上→右上→右下→左下）に合わせた実寸座標
    dst = [[0, 0], [w_m, 0], [w_m, h_m], [0, h_m]]
    Hm = homography(ref, dst)

    # 数値的な健全性: 参照矩形を写し戻して面積が w*h に一致するか
    back = shoelace(apply_H(Hm, ref))
    if abs(back - w_m * h_m) > 0.02 * w_m * h_m:
        print(json.dumps({"error": f"参照矩形の整合性NG: {back:.3f} vs {w_m*h_m:.3f}"}))
        return

    metric = apply_H(Hm, roof)
    area = shoelace(metric)

    # 退化チェック: 参照矩形が小さすぎる/細長すぎると誤差が爆発する
    ref_px_area = shoelace(ref)
    img_area = W * H_px
    warn = []
    if ref_px_area / img_area < 0.002:
        warn.append("参照矩形が画像の0.2%未満。誤差が大きい可能性")
    if area <= 0 or not np.isfinite(area):
        print(json.dumps({"error": "面積が不正"}))
        return

    print(json.dumps({
        "roofSurfaceAreaM2": round(float(area), 1),
        "refCheckM2": round(float(back), 3),
        "refPxFraction": round(float(ref_px_area / img_area), 4),
        "warnings": warn,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
