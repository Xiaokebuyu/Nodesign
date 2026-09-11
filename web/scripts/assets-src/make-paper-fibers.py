# 从官网 paper-texture.webp 做一张透明纤维层 web/src/assets/paper/fibers.webp（paper.js 的 FIBERS）。
# 只取比纸平均暗的纤维，墨色带 alpha；无缝化：半幅错位后在四边交叉淡入。
# 用法（web/ 下）：python3 scripts/assets-src/make-paper-fibers.py src/assets/paper/fibers.webp 1.2
from PIL import Image
import numpy as np, sys, os
src = os.path.join(os.path.dirname(__file__), '../../public/welcome/assets/paper-texture.webp')
out = sys.argv[1]; gain = float(sys.argv[2]) if len(sys.argv) > 2 else 1.2
a = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
L = a.mean(2); n = L.shape[0]
# 无缝：原图与半幅错位图按到边缘的距离加权混合
s = np.roll(np.roll(L, n // 2, 0), n // 2, 1)
x = np.abs(np.arange(n) - (n - 1) / 2) / ((n - 1) / 2)       # 0 在中间，1 在边上
w = np.clip((np.maximum.outer(x, x) - 0.7) / 0.3, 0, 1)     # 边缘 30% 用错位图
L = L * (1 - w) + s * w
d = L - L.mean()
ink = np.array([43, 33, 23], np.float32)
bg = 236.0                                                   # 纸的平均明度
rgb = np.empty(L.shape + (3,), np.float32)
dd = np.minimum(d + 3.0, 0)                                  # 比平均暗 3 以内的当作纸本身，不上墨（压体积）
alpha = np.clip(gain * (-dd) / (bg - ink.mean()), 0, 1)
alpha = np.round(alpha * 40) / 40                            # 量化 40 级
rgb = np.broadcast_to(ink, rgb.shape)
img = np.dstack([rgb, alpha[..., None] * 255]).astype(np.uint8)
Image.fromarray(img, 'RGBA').save(out, 'WEBP', quality=80, alpha_quality=70, method=6)
print(out, 'alpha max', round(float(alpha.max()), 3), 'mean', round(float(alpha.mean()), 4))
