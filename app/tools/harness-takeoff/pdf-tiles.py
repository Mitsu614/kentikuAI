# 大判（A2以上）の図面PDFのページを、高い解像度で縦横2×2に切り分けたPNGにする（実験用）。
#   AIはPDFを1ページ1枚の画像に縮めて読むので、A1の1/50詳細図だと室名・寸法の小さな文字がつぶれる。
#   python pdf-tiles.py <pdf> <出力フォルダ>   … 書き出したPNGのパスを1行ずつ「ページ番号<TAB>位置<TAB>パス」で出す
import sys, os, fitz
pdf, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
d = fitz.open(pdf)
POS = ['左上', '右上', '左下', '右下']
for i, p in enumerate(d):
    r = p.rect
    if max(r.width, r.height) < 1500:      # A3（1191pt）以下はそのまま（PDFで十分読めている）
        continue
    w, h = r.width / 2, r.height / 2
    ov = 0.04 * max(r.width, r.height)       # 境目の文字が切れないよう少し重ねる
    for k, (cx, cy) in enumerate([(0, 0), (1, 0), (0, 1), (1, 1)]):
        clip = fitz.Rect(max(0, cx * w - ov), max(0, cy * h - ov), min(r.width, (cx + 1) * w + ov), min(r.height, (cy + 1) * h + ov))
        zoom = 1568 / max(clip.width, clip.height)   # AIが縮めずに受け取る長辺 1568px に合わせる
        f = os.path.join(out, f'p{i + 1}_{k}.jpg')
        if not os.path.exists(f):
            p.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip).save(f, jpg_quality=85)
        print(f'{i + 1}ページ目・{POS[k]}\t{f}')
