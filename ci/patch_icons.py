#!/usr/bin/env python3
"""Remplace les icônes de lanceur Android par la goutte d'eau de l'app.

`npx cap add android` régénère la plateforme à chaque build et y remet les
icônes par défaut de Capacitor. Sans ce script, l'APK s'installe avec le
logo Capacitor alors que la PWA affiche le bon logo — c'est exactement ce
qui s'est passé jusqu'à la v1.4.1.

On réutilise le rendu de tools_gen_icon.py (Python pur, pas de Pillow sur
le runner) et on écrit :
  - ic_launcher.png et ic_launcher_round.png dans chaque densité ;
  - ic_launcher_foreground.png, la goutte réduite à 60 % et centrée, parce
    qu'Android rogne agressivement le premier plan d'une icône adaptative ;
  - la couleur de fond adaptative, sinon Android met du blanc derrière.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tools_gen_icon as gen  # noqa: E402

RES = 'android/app/src/main/res'

# Tailles de lanceur par densité, et 108 dp pour le premier plan adaptatif.
DENSITIES = {
    'mdpi':    (48, 108),
    'hdpi':    (72, 162),
    'xhdpi':   (96, 216),
    'xxhdpi':  (144, 324),
    'xxxhdpi': (192, 432),
}

BG = '#0b2438'  # même fond que l'icône PWA


def foreground(size):
    """Goutte centrée sur 60 % de la surface (zone sûre d'Android).

    Le rendu normal peint un fond en dégradé ; collé au centre d'un fond uni,
    ça dessine un carré visible. On aplatit donc le dégradé de fond le temps
    du rendu, pour que la vignette se fonde dans la couche de fond.
    """
    top, bot = gen.BG_TOP, gen.BG_BOT
    flat = tuple(int(BG[i:i + 2], 16) for i in (1, 3, 5))
    gen.BG_TOP = gen.BG_BOT = flat
    try:
        inner = int(size * 0.6)
        rows = gen.render(inner)
    finally:
        gen.BG_TOP, gen.BG_BOT = top, bot

    pad = (size - inner) // 2
    out = [bytearray(bytes(flat) * size) for _ in range(size)]
    for y, row in enumerate(rows):
        out[pad + y][pad * 3:(pad + inner) * 3] = row
    return out


def main():
    if not os.path.isdir(RES):
        print('res/ introuvable — plateforme Android non générée ?')
        return 1

    for dens, (icon_px, fg_px) in DENSITIES.items():
        d = os.path.join(RES, 'mipmap-' + dens)
        os.makedirs(d, exist_ok=True)
        rows = gen.render(icon_px)
        gen.write_png(os.path.join(d, 'ic_launcher.png'), icon_px, rows)
        gen.write_png(os.path.join(d, 'ic_launcher_round.png'), icon_px, rows)
        gen.write_png(os.path.join(d, 'ic_launcher_foreground.png'), fg_px,
                      foreground(fg_px))

    # Fond de l'icône adaptative : Capacitor pose un blanc par défaut.
    vals = os.path.join(RES, 'values')
    os.makedirs(vals, exist_ok=True)
    with open(os.path.join(vals, 'ic_launcher_background.xml'), 'w') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                '<resources>\n'
                '    <color name="ic_launcher_background">%s</color>\n'
                '</resources>\n' % BG)

    # Certaines versions du template referencent une couleur inexistante.
    for name in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        p = os.path.join(RES, 'mipmap-anydpi-v26', name)
        if os.path.exists(p):
            with open(p, 'w') as f:
                f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                        '<adaptive-icon xmlns:android='
                        '"http://schemas.android.com/apk/res/android">\n'
                        '    <background android:drawable='
                        '"@color/ic_launcher_background"/>\n'
                        '    <foreground android:drawable='
                        '"@mipmap/ic_launcher_foreground"/>\n'
                        '</adaptive-icon>\n')
            print(p, 'réécrit')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
