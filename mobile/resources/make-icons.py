#!/usr/bin/env python3
"""Draws the NullChat phone-app icons and launch screens into this folder (needs: pip install pillow).

You don't need to run this - the finished pictures are already in android/ and ios/ next to it and the build copies them into
the generated phone projects. Run it only if you change the logo: edit the colours or the shape below, then `python make-icons.py`.
The shape is the same ring-and-slash as client/public/icon.svg.
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
INK = (6, 6, 8)          # icon background  #060608
SPLASH = (4, 4, 5)       # launch screen    #040405 (the web app's own background)
LIME = (194, 255, 61)    # logo             #c2ff3d
SS = 4                   # supersampling for smooth edges


def glyph_layer(size, unit, bg=None):
    """RGBA layer (size x size) holding only the logo, with the ring's hole punched out."""
    big = size * SS
    ring = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(ring)
    c = big / 2
    k = 0.86 * unit * SS
    r, w = 14 * k, 4.5 * k
    d.ellipse([c - r - w / 2, c - r - w / 2, c + r + w / 2, c + r + w / 2], fill=255)
    d.ellipse([c - r + w / 2, c - r + w / 2, c + r - w / 2, c + r - w / 2], fill=0)
    off = 14 * k
    x1, y1, x2, y2 = c - off, c + off, c + off, c - off
    d.line([x1, y1, x2, y2], fill=255, width=int(round(w)))
    for (x, y) in ((x1, y1), (x2, y2)):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=255)
    mask = ring.resize((size, size), Image.LANCZOS)
    layer = Image.new('RGBA', (size, size), LIME + (0,))
    layer.putalpha(mask)
    return layer


def glow(size):
    """The soft lime glow behind the logo in icon.svg: lime at 20% in the middle fading to nothing."""
    g = Image.new('RGBA', (size, size), INK + (255,))
    px = g.load()
    cx, cy, rad = size / 2, size * 0.46, size * 0.55
    for y in range(size):
        for x in range(size):
            t = (((x - cx) ** 2 + (y - cy) ** 2) ** 0.5) / rad
            a = max(0.0, 1 - t) * 0.20
            if a:
                px[x, y] = tuple(round(INK[i] * (1 - a) + LIME[i] * a) for i in range(3)) + (255,)
    return g


def full_icon(size, shape):
    """The whole icon. shape: 'square' (iPhone: opaque, the phone rounds it), 'rounded' or 'circle' (older Android launchers)."""
    base = glow(min(size, 256)).resize((size, size), Image.LANCZOS) if size > 256 else glow(size)
    base.alpha_composite(glyph_layer(size, size / 48))
    if shape == 'square':
        return base.convert('RGB')  # Apple rejects icons with a transparent channel
    m = Image.new('L', (size * SS, size * SS), 0)
    d = ImageDraw.Draw(m)
    if shape == 'circle':
        d.ellipse([0, 0, size * SS - 1, size * SS - 1], fill=255)
    else:
        d.rounded_rectangle([0, 0, size * SS - 1, size * SS - 1], radius=int(size * SS * 0.23), fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(base, (0, 0), m.resize((size, size), Image.LANCZOS))
    return out


def foreground(size):
    """Android adaptive-icon foreground: just the logo, kept inside the 66dp safe circle of the 108dp canvas."""
    unit = size / 108 * (34 / 19)  # the logo's farthest point is 19 units from its centre; keep that within 34dp
    return glyph_layer(size, unit)


def status_icon(size):
    """Android's small notification icon: white shape on transparent (Android colours it itself)."""
    lay = glyph_layer(size, size / 48 * 1.4)
    white = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    white.putalpha(lay.getchannel('A'))
    return white


def splash(w, h):
    img = Image.new('RGB', (w, h), SPLASH)
    s = int(min(w, h) * 0.30)
    lay = glyph_layer(s, s / 48 * 1.15)
    img = img.convert('RGBA')
    img.alpha_composite(lay, ((w - s) // 2, (h - s) // 2))
    return img.convert('RGB')


def save(img, *parts):
    p = os.path.join(HERE, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p, optimize=True)
    print(os.path.relpath(p, HERE), img.size)


if __name__ == '__main__':
    for dpi, px in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
        save(full_icon(px, 'rounded'), 'android', f'mipmap-{dpi}', 'ic_launcher.png')
        save(full_icon(px, 'circle'), 'android', f'mipmap-{dpi}', 'ic_launcher_round.png')
        save(foreground(round(px * 108 / 48)), 'android', f'mipmap-{dpi}', 'ic_launcher_foreground.png')
    for dpi, px in (('mdpi', 24), ('hdpi', 36), ('xhdpi', 48), ('xxhdpi', 72), ('xxxhdpi', 96)):
        save(status_icon(px), 'android', f'drawable-{dpi}', 'ic_stat_nullchat.png')
    for dpi, (w, h) in (('mdpi', (320, 480)), ('hdpi', (480, 800)), ('xhdpi', (720, 1280)), ('xxhdpi', (960, 1600)), ('xxxhdpi', (1280, 1920))):
        save(splash(w, h), 'android', f'drawable-port-{dpi}', 'splash.png')
        save(splash(h, w), 'android', f'drawable-land-{dpi}', 'splash.png')
    save(splash(480, 320), 'android', 'drawable', 'splash.png')
    save(full_icon(1024, 'square'), 'ios', 'AppIcon-512@2x.png')
    s = splash(2732, 2732)
    for n in ('splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'):
        save(s, 'ios', n)
