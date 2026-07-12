# 相対座標(x0,y0,x1,y1)でROIを切り出し、長辺1400pxまで拡大する（S6/S7用）
import sys
from PIL import Image
src, dst, x0, y0, x1, y1 = sys.argv[1], sys.argv[2], *map(float, sys.argv[3:7])
im = Image.open(src).convert('RGB')
W, H = im.size
# 少し余白(3%)を足す。輪郭が切れると coversWholeRoof の判定が壊れるため
pad = 0.03
x0, y0 = max(0.0, x0 - pad), max(0.0, y0 - pad)
x1, y1 = min(1.0, x1 + pad), min(1.0, y1 + pad)
box = (int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H))
if box[2] - box[0] < 20 or box[3] - box[1] < 20:
    box = (0, 0, W, H)   # 壊れたROIは全画像にフォールバック
im = im.crop(box)
w, h = im.size
if max(w, h) < 1400:
    k = 1400 / max(w, h)
    im = im.resize((int(w * k), int(h * k)), Image.LANCZOS)
im.save(dst)
print(f"{dst} box={box} -> {im.size}")
