# -*- coding: utf-8 -*-
import math, os
from PIL import Image, ImageDraw

OUT = "E:/Desktop/Ai/workbuddy/home-space-mp/images/ic"
os.makedirs(OUT, exist_ok=True)

S = 480          # 高分辨率画布
F = 240          # 输出尺寸
INK = (58, 52, 46, 255)   # 暖黑墨色
W = 30           # 高分辨率下描边宽度
BRAND = (238, 106, 85, 255)  # 小红花花瓣（品牌色实心）
GOLD = (243, 184, 58, 255)   # 花心（暖黄）

def new_img():
    return Image.new("RGBA", (S, S), (0, 0, 0, 0))

def stroke(d, pts, w=W, c=INK, closed=False, cap=True):
    if closed:
        pts = pts + [pts[0]]
    for i in range(len(pts) - 1):
        d.line([pts[i], pts[i + 1]], fill=c, width=w, joint="curve")
    if cap:
        for p in (pts[0], pts[-1]):
            d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=c)
        for p in pts[1:-1]:
            d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=c)

CX, CY = 240, 240

def draw_order(img):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([158, 215, 322, 388], radius=26, outline=INK, width=W)
    d.arc([176, 140, 304, 250], 180, 360, fill=INK, width=W)  # 提手

def draw_menu(img):
    d = ImageDraw.Draw(img)
    d.arc([150, 165, 330, 345], 0, 180, fill=INK, width=W)     # 碗（下半）
    d.line([210, 345, 270, 345], fill=INK, width=W)            # 碗底
    # 蒸汽
    d.arc([195, 120, 235, 165], 180, 360, fill=INK, width=14)
    d.arc([245, 120, 285, 165], 180, 360, fill=INK, width=14)

def draw_todo(img):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([150, 150, 330, 330], radius=26, outline=INK, width=W)
    stroke(d, [(188, 248), (224, 286), (296, 200)], w=W)       # 对勾
    d.line([188, 188, 300, 188], fill=INK, width=16)
    d.line([188, 312, 300, 312], fill=INK, width=16)

def draw_finance(img):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([140, 215, 340, 350], radius=26, outline=INK, width=W)
    d.line([150, 270, 330, 270], fill=INK, width=W)            # 钱包中缝
    d.ellipse([292, 168, 360, 236], outline=INK, width=W)       # 硬币
    d.line([300, 202, 352, 202], fill=INK, width=12)

def draw_plan(img):
    d = ImageDraw.Draw(img)
    bars = [(158, 268), (212, 210), (266, 158)]
    for (x, top) in bars:
        d.rounded_rectangle([x, top, x + 40, 350], radius=12, outline=INK, width=W)
    d.line([150, 350, 330, 350], fill=INK, width=W)

def draw_festival(img):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([158, 235, 322, 360], radius=18, outline=INK, width=W)  # 盒
    d.line([240, 150, 240, 360], fill=INK, width=W)            # 竖丝带
    d.line([158, 280, 322, 280], fill=INK, width=W)            # 横丝带
    d.ellipse([210, 150, 244, 196], outline=INK, width=W)      # 蝴蝶结左
    d.ellipse([236, 150, 270, 196], outline=INK, width=W)      # 蝴蝶结右

def draw_reminder(img):
    d = ImageDraw.Draw(img)
    d.arc([160, 170, 320, 330], 180, 360, fill=INK, width=W)  # 铃身（∩）
    d.line([170, 320, 310, 320], fill=INK, width=W)            # 铃底
    d.ellipse([224, 330, 256, 362], outline=INK, width=W)      # 铃舌
    d.ellipse([226, 150, 254, 178], fill=INK)                  # 顶钮

def draw_home(img):
    d = ImageDraw.Draw(img)
    stroke(d, [(150, 235), (240, 150), (330, 235)], w=W)       # 屋顶
    d.rounded_rectangle([168, 232, 312, 360], radius=12, outline=INK, width=W)
    d.rounded_rectangle([218, 292, 262, 360], radius=10, outline=INK, width=W)  # 门

def draw_key(img):
    d = ImageDraw.Draw(img)
    d.ellipse([170, 175, 262, 267], outline=INK, width=W)      # 环
    d.line([213, 222, 345, 354], fill=INK, width=W)            # 杆
    d.line([300, 309, 300, 348], fill=INK, width=W)
    d.line([326, 335, 326, 354], fill=INK, width=W)

def draw_gear(img):
    d = ImageDraw.Draw(img)
    d.ellipse([162, 162, 318, 318], outline=INK, width=W)      # 外圈
    d.ellipse([206, 206, 274, 274], outline=INK, width=W)      # 内圈
    for a in range(0, 360, 45):
        r = math.radians(a)
        x1, y1 = CX + 78 * math.cos(r), CY + 78 * math.sin(r)
        x2, y2 = CX + 104 * math.cos(r), CY + 104 * math.sin(r)
        d.line([(x1, y1), (x2, y2)], fill=INK, width=W)
        d.ellipse([x2 - W / 2, y2 - W / 2, x2 + W / 2, y2 + W / 2], fill=INK)

def draw_flower(img):
    d = ImageDraw.Draw(img)
    for a in range(0, 360, 72):
        r = math.radians(a)
        cx, cy = CX + 62 * math.cos(r), CY + 62 * math.sin(r)
        d.ellipse([cx - 38, cy - 38, cx + 38, cy + 38], outline=INK, width=W)
    d.ellipse([212, 212, 268, 268], outline=INK, width=W)

def draw_flower_red(img):
    """实心小红花：5 片花瓣 + 暖黄花心（用于余额/徽标，比红圆点更像花）"""
    d = ImageDraw.Draw(img)
    for a in range(0, 360, 72):
        r = math.radians(a - 90)
        cx, cy = CX + 70 * math.cos(r), CY + 70 * math.sin(r)
        d.ellipse([cx - 44, cy - 44, cx + 44, cy + 44], fill=BRAND)
    d.ellipse([CX - 52, CY - 52, CX + 52, CY + 52], fill=BRAND)   # 花瓣之间补实
    d.ellipse([CX - 34, CY - 34, CX + 34, CY + 34], fill=GOLD)    # 花心

def draw_trophy(img):
    d = ImageDraw.Draw(img)
    d.arc([150, 185, 210, 295], 90, 270, fill=INK, width=W)    # 左耳
    d.arc([270, 185, 330, 295], -90, 90, fill=INK, width=W)    # 右耳
    d.rounded_rectangle([180, 178, 300, 300], radius=18, outline=INK, width=W)  # 杯
    d.line([240, 300, 240, 332], fill=INK, width=W)
    d.rounded_rectangle([195, 332, 285, 358], radius=12, outline=INK, width=W)  # 底座

def draw_person(img):
    d = ImageDraw.Draw(img)
    d.ellipse([198, 160, 282, 244], outline=INK, width=W)      # 头
    d.arc([165, 255, 315, 415], 0, 180, fill=INK, width=W)     # 肩（∪）

def draw_ai(img):
    d = ImageDraw.Draw(img)
    pts = [(240, 150), (266, 214), (330, 240), (266, 266),
           (240, 330), (214, 266), (150, 240), (214, 214)]
    stroke(d, pts, w=W, closed=True)

def draw_class(img):
    d = ImageDraw.Draw(img)
    stroke(d, [(150, 240), (240, 278), (330, 240)], w=W)       # 帽顶V
    d.line([150, 240, 150, 280], fill=INK, width=W)
    d.line([330, 240, 330, 280], fill=INK, width=W)
    d.line([150, 280, 330, 280], fill=INK, width=W)
    d.line([240, 278, 240, 340], fill=INK, width=W)            # 流苏
    d.ellipse([232, 340, 248, 356], outline=INK, width=W)

# ---------------- 首页 dock 专用：白色填充图标（放在彩色圆角背景上更醒目）----------------
WHITE = (255, 255, 255, 255)
CUTOUT = (255, 255, 255, 0)

def draw_menu_dock(img):
    d = ImageDraw.Draw(img)
    d.chord([150, 175, 330, 355], 0, 180, fill=WHITE)          # 碗身
    d.rectangle([150, 265, 330, 355], fill=WHITE)              # 碗底
    d.arc([150, 175, 330, 355], 0, 180, fill=WHITE, width=12)  # 碗沿高光
    d.arc([195, 110, 235, 160], 180, 360, fill=WHITE, width=20)
    d.arc([245, 110, 285, 160], 180, 360, fill=WHITE, width=20)

def draw_todo_dock(img):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([150, 150, 330, 330], radius=32, fill=WHITE)
    d.rounded_rectangle([180, 186, 300, 214], radius=10, fill=CUTOUT)
    d.line([(190, 248), (226, 286), (298, 200)], fill=CUTOUT, width=36, joint='curve')

def draw_finance_dock(img):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([140, 200, 340, 350], radius=28, fill=WHITE)
    d.line([150, 270, 330, 270], fill=CUTOUT, width=18)
    d.ellipse([216, 252, 264, 300], fill=CUTOUT)
    d.ellipse([292, 158, 360, 226], fill=WHITE)
    d.ellipse([308, 174, 344, 210], fill=CUTOUT)

def draw_festival_dock(img):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([158, 235, 322, 360], radius=22, fill=WHITE)
    d.line([240, 235, 240, 360], fill=CUTOUT, width=24)
    d.line([158, 298, 322, 298], fill=CUTOUT, width=24)
    d.ellipse([200, 156, 244, 200], fill=WHITE)
    d.ellipse([236, 156, 280, 200], fill=WHITE)
    d.ellipse([226, 176, 254, 204], fill=WHITE)

# ---------------- 小红花等级图标（累计攒够就升级，用户要求有肉眼可见的区别）----------------
BRAND_DEEP = (200, 68, 47, 255)  # 更深一档的品牌红（大红花的"重"感）

def _heart_shape(d, cx, cy, s, color):
    """用「两个圆 + 一个三角」拼一颗实心红心（s 约等于整体视觉宽度的一半）"""
    r = s * 0.30
    lx, ly = cx - r * 0.92, cy - r * 0.55
    rx, ry = cx + r * 0.92, cy - r * 0.55
    d.ellipse([lx - r, ly - r, lx + r, ly + r], fill=color)
    d.ellipse([rx - r, ry - r, rx + r, ry + r], fill=color)
    d.polygon([(cx - r * 1.86, cy - r * 0.30),
               (cx + r * 1.86, cy - r * 0.30),
               (cx, cy + r * 1.75)], fill=color)

def draw_flower_big(img):
    """大红花：6 片花瓣 + 双层花心，比小红花更饱满（等级更高一眼看得出）"""
    d = ImageDraw.Draw(img)
    for a in range(0, 360, 60):
        r = math.radians(a - 90)
        cx, cy = CX + 72 * math.cos(r), CY + 72 * math.sin(r)
        d.ellipse([cx - 50, cy - 50, cx + 50, cy + 50], fill=BRAND_DEEP)
    d.ellipse([CX - 62, CY - 62, CX + 62, CY + 62], fill=BRAND_DEEP)
    d.ellipse([CX - 42, CY - 42, CX + 42, CY + 42], fill=BRAND)
    d.ellipse([CX - 24, CY - 24, CX + 24, CY + 24], fill=GOLD)

def draw_heart(img):
    """♥：一颗实心红心"""
    d = ImageDraw.Draw(img)
    _heart_shape(d, CX, CY - 4, 152, BRAND_DEEP)

def draw_hearts(img):
    """心连心：两颗心并肩"""
    d = ImageDraw.Draw(img)
    _heart_shape(d, CX - 64, CY, 116, BRAND)
    _heart_shape(d, CX + 64, CY, 116, BRAND_DEEP)

def draw_house(img):
    """小屋子：家的最终象征（红顶 + 红墙 + 白门）"""
    d = ImageDraw.Draw(img)
    d.polygon([(CX - 130, CY + 8), (CX + 130, CY + 8), (CX, CY - 116)], fill=BRAND_DEEP)
    d.rounded_rectangle([CX - 92, CY + 8, CX + 92, CY + 118], radius=16, fill=BRAND)
    d.rounded_rectangle([CX - 26, CY + 48, CX + 26, CY + 118], radius=10, fill=(255, 255, 255, 255))

ICONS = {
    "order": draw_order, "menu": draw_menu, "todo": draw_todo,
    "menu_dock": draw_menu_dock, "todo_dock": draw_todo_dock,
    "finance": draw_finance, "finance_dock": draw_finance_dock,
    "plan": draw_plan, "festival": draw_festival,
    "festival_dock": draw_festival_dock,
    "reminder": draw_reminder, "home": draw_home, "key": draw_key,
    "gear": draw_gear, "flower": draw_flower, "flower_red": draw_flower_red,
    "trophy": draw_trophy,
    "person": draw_person, "ai": draw_ai, "class": draw_class,
    "flower_big": draw_flower_big, "heart": draw_heart,
    "hearts": draw_hearts, "house": draw_house,
}

# 生成单图标
for name, fn in ICONS.items():
    im = new_img()
    fn(im)
    im = im.resize((F, F), Image.LANCZOS)
    im.save(os.path.join(OUT, name + ".png"))
    print("saved", name)

# 渲染对照图自检
cols = 4
rows = (len(ICONS) + cols - 1) // cols
cell = 120
sheet = Image.new("RGBA", (cols * cell + 20, rows * cell + 20), (245, 243, 240, 255))
sd = ImageDraw.Draw(sheet)
i = 0
for name in ICONS:
    r, c = divmod(i, cols)
    x, y = 10 + c * cell, 10 + r * cell
    ic = Image.open(os.path.join(OUT, name + ".png")).resize((96, 96), Image.LANCZOS)
    sheet.paste(ic, (x + 12, y + 12), ic)
    sd.text((x + 4, y + cell - 18), name, fill=(120, 110, 100, 255))
    i += 1
sheet.convert("RGB").save("E:/Desktop/Ai/workbuddy/home-space-mp/_icons_preview.png")
print("preview saved")
