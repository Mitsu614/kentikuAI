# 画像に10x10のグリッドと座標ラベルを重ねる（S4-grid 戦略用）
import sys
from PIL import Image, ImageDraw, ImageFont

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
W, H = im.size
# 小さすぎるとラベルが潰れるので拡大
if max(W, H) < 900:
    k = 900 / max(W, H)
    im = im.resize((int(W * k), int(H * k)), Image.LANCZOS)
    W, H = im.size

d = ImageDraw.Draw(im, 'RGBA')
N = 10
cw, ch = W / N, H / N
try:
    font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", max(12, int(min(cw, ch) * 0.22)))
except Exception:
    font = ImageFont.load_default()

for i in range(1, N):
    d.line([(i * cw, 0), (i * cw, H)], fill=(255, 0, 0, 160), width=2)
    d.line([(0, i * ch), (W, i * ch)], fill=(255, 0, 0, 160), width=2)

cols = "ABCDEFGHIJ"
for r in range(N):
    for c in range(N):
        label = f"{cols[c]}{r+1}"
        x, y = c * cw + 4, r * ch + 3
        d.rectangle([x - 2, y - 1, x + len(label) * 9 + 2, y + 15], fill=(0, 0, 0, 130))
        d.text((x, y), label, fill=(255, 255, 0), font=font)

im.save(dst)
print(f"{dst} ({W}x{H}, 1マス = {cw:.1f}x{ch:.1f}px)")
