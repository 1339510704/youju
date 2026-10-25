# -*- coding: utf-8 -*-
"""生成 tabBar 选中态图标：品牌色 + 略微加粗，和未选中（墨色细线）拉开区别"""
from PIL import Image, ImageFilter

OUT = "E:/Desktop/Ai/workbuddy/home-space-mp/images/ic"
BRAND = (200, 68, 47, 255)   # --brand-btn

for name in ["order", "home"]:
    im = Image.open(f"{OUT}/{name}.png").convert("RGBA")
    a = im.getchannel("A").filter(ImageFilter.MaxFilter(5))   # 轻微加粗，视觉更"实"
    out = Image.new("RGBA", im.size, BRAND)
    out.putalpha(a)
    out.save(f"{OUT}/{name}_on.png")
    print("saved", name + "_on")
