#!/usr/bin/env python3
"""Génère les icônes de Ma Piscine (PWA + launcher Android), sans dépendance.

Dessine la même goutte d'eau que le logo SVG de l'entête : dégradé cyan,
reflet, et un bandeau de vagues. Anticrénelage par suréchantillonnage 3×,
encodeur PNG en Python pur (zlib seulement).
"""
import math
import struct
import zlib

BG_TOP = (11, 36, 56)      # #0b2438
BG_BOT = (6, 19, 31)       # #06131f
D_TOP = (126, 232, 255)    # #7ee8ff
D_MID = (34, 184, 240)     # #22b8f0
D_BOT = (11, 127, 196)     # #0b7fc4
WAVE = (56, 232, 200)      # #38e8c8

SS = 3                     # facteur de suréchantillonnage


def lerp(a, b, t):
    t = min(1.0, max(0.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def in_drop(x, y):
    """Vrai si (x, y) normalisés sont dans la goutte."""
    cx, cy, r, top = 0.5, 0.615, 0.30, 0.085
    if y >= cy:
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    if y < top:
        return False
    # Au-dessus du centre : la largeur se resserre jusqu'à la pointe.
    w = r * (((y - top) / (cy - top)) ** 0.78)
    return abs(x - cx) <= w


def in_wave(x, y):
    """Bandeau de vagues dans le bas de la goutte."""
    if not (0.60 <= y <= 0.82):
        return False
    base = 0.695 + 0.028 * math.sin((x - 0.18) * 2 * math.pi / 0.30)
    return base <= y <= base + 0.075


def shade(x, y):
    """Couleur (r, g, b) du point normalisé."""
    if not in_drop(x, y):
        return lerp(BG_TOP, BG_BOT, y)

    t = (y - 0.085) / 0.83
    col = lerp(D_TOP, D_MID, t / 0.55) if t < 0.55 else lerp(D_MID, D_BOT, (t - 0.55) / 0.45)

    # Reflet clair en haut à gauche.
    if (x - 0.375) ** 2 + (y - 0.345) ** 2 <= 0.066 ** 2:
        col = lerp(col, (255, 255, 255), 0.45)

    if in_wave(x, y):
        col = lerp(col, WAVE, 0.85)
    return col


def render(size):
    """Rend l'icône en RGB, suréchantillonnée puis moyennée."""
    rows = []
    n = SS * SS
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0
            for sy in range(SS):
                y = (py + (sy + 0.5) / SS) / size
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    c = shade(x, y)
                    r += c[0]
                    g += c[1]
                    b += c[2]
            row += bytes((r // n, g // n, b // n))
        rows.append(row)
    return rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + bytes(r) for r in rows)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)
    print(path, size, 'px')


if __name__ == '__main__':
    for s in (192, 512):
        write_png('www/img/icon-%d.png' % s, s, render(s))
