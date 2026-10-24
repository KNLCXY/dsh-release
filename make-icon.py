"""生成 dsh-release 的插件图标（256×256 PNG）。

图案：一个向上的箭头 + 底下的包裹箱 = 「打包发出去」。
"""
from PIL import Image, ImageDraw
import os

S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 渐变底：左上靛蓝 → 右下青蓝
grad = Image.new("RGB", (S, S), (79, 70, 229))
d = ImageDraw.Draw(grad)
for i in range(S * 2):
    t = i / (S * 2 - 1)
    r = int(79 + (14 - 79) * t)
    g = int(70 + (165 - 70) * t)
    b = int(229 + (233 - 229) * t)
    d.line([(0, i), (i, 0)], fill=(r, g, b), width=1)

# 圆角遮罩
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=56, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
WHITE = (255, 255, 255)

# 向上箭头：杆 + 头
d.rounded_rectangle([116, 62, 140, 134], radius=10, fill=WHITE)
d.polygon([(128, 26), (92, 82), (164, 82)], fill=WHITE)

# 包裹箱：底下一个圆角矩形，加一条箱盖线
d.rounded_rectangle([56, 150, 200, 214], radius=14, fill=WHITE)
d.rectangle([56, 150, 200, 168], fill=(219, 226, 255))
# 箱盖缝
d.rectangle([118, 150, 138, 214], fill=(219, 226, 255))
# 箱盖上的小提手
d.rounded_rectangle([104, 140, 152, 162], radius=8, fill=(219, 226, 255))
d.rounded_rectangle([112, 146, 144, 158], radius=6, fill=(79, 70, 229))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "icon.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG")
print("ok", img.size, out)