/*
 * strip.js — lecture colorimétrique d'une bandelette de test à partir d'une photo.
 *
 * Principe : on échantillonne la couleur moyenne de chaque plage (le carré
 * réactif), on la compare à une échelle de référence par paramètre, et on
 * interpole entre les deux niveaux les plus proches. Tout se fait en local,
 * hors ligne — aucune image ne quitte le téléphone.
 *
 * Deux garde-fous, parce que la photo d'un carré coloré est un exercice
 * fragile (lumière, ombre, balance des blancs du capteur) :
 *   1. correction du point blanc : l'utilisateur peut toucher le plastique
 *      blanc de la bandelette, ce qui recale les trois canaux ;
 *   2. calibration maison : photographier le nuancier du tube et pointer les
 *      niveaux remplace l'échelle par défaut, bien plus fiable que nos valeurs
 *      génériques (les couleurs varient d'une marque à l'autre).
 * La valeur lue reste toujours modifiable à la main avant enregistrement.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Échelles de référence par défaut (bandelettes multi-paramètres FR)  */
  /* ------------------------------------------------------------------ */
  /* [valeur, [R, G, B]] — ordre de valeur croissante. */
  var SCALES = {
    cl: [
      [0,   [244, 240, 226]], [0.5, [240, 224, 224]], [1,   [236, 200, 214]],
      [3,   [226, 160, 196]], [5,   [206, 120, 178]], [10,  [166, 74, 152]],
    ],
    br: [
      [0,   [244, 240, 226]], [1,   [240, 220, 218]], [2,   [234, 196, 208]],
      [5,   [222, 152, 190]], [10,  [200, 110, 170]], [20,  [158, 68, 146]],
    ],
    ph: [
      [6.2, [246, 214, 136]], [6.8, [244, 190, 116]], [7.2, [238, 158, 102]],
      [7.6, [226, 118, 92]],  [8.0, [204, 84, 84]],   [8.4, [174, 58, 78]],
    ],
    tac: [
      [0,   [240, 226, 128]], [40,  [214, 220, 122]], [80,  [176, 210, 130]],
      [120, [130, 196, 150]], [180, [92, 178, 164]],  [240, [64, 156, 172]],
    ],
    th: [
      [0,   [226, 214, 178]], [100, [204, 196, 186]], [250, [176, 176, 194]],
      [500, [142, 146, 190]], [1000,[112, 118, 180]],
    ],
    cya: [
      [0,   [238, 232, 208]], [30,  [226, 214, 180]], [50,  [214, 192, 158]],
      [100, [196, 164, 132]], [150, [174, 134, 110]],
    ],
  };

  /* ------------------------------------------------------------------ */
  /* Couleur : sRGB → Lab, écart perceptuel                             */
  /* ------------------------------------------------------------------ */

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function rgbToLab(rgb) {
    var r = srgbToLinear(rgb[0]), g = srgbToLinear(rgb[1]), b = srgbToLinear(rgb[2]);
    var x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    var y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
    var z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    function f(t) { return t > 0.008856 ? Math.pow(t, 1 / 3) : (7.787 * t + 16 / 116); }
    var fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  /* CIE94 : suffisant ici, et bien plus stable que la distance RVB brute. */
  function deltaE(lab1, lab2) {
    var dL = lab1[0] - lab2[0];
    var c1 = Math.sqrt(lab1[1] * lab1[1] + lab1[2] * lab1[2]);
    var c2 = Math.sqrt(lab2[1] * lab2[1] + lab2[2] * lab2[2]);
    var dC = c1 - c2;
    var da = lab1[1] - lab2[1], db = lab1[2] - lab2[2];
    var dH2 = da * da + db * db - dC * dC;
    var dH = dH2 > 0 ? Math.sqrt(dH2) : 0;
    var sC = 1 + 0.045 * c1, sH = 1 + 0.015 * c1;
    return Math.sqrt(dL * dL + (dC / sC) * (dC / sC) + (dH / sH) * (dH / sH));
  }

  /* ------------------------------------------------------------------ */
  /* Échantillonnage dans le canvas                                     */
  /* ------------------------------------------------------------------ */

  /* Moyenne robuste : on écarte les 25 % de pixels les plus clairs et les
     25 % les plus sombres (reflets, ombre du doigt, bord du carré). */
  function sample(ctx, x, y, radius) {
    var r = Math.max(2, radius | 0);
    var d = ctx.getImageData(Math.max(0, x - r), Math.max(0, y - r), r * 2, r * 2).data;
    var px = [];
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      px.push([d[i], d[i + 1], d[i + 2], d[i] + d[i + 1] + d[i + 2]]);
    }
    if (!px.length) return null;
    px.sort(function (a, b) { return a[3] - b[3]; });
    var lo = Math.floor(px.length * 0.25), hi = Math.ceil(px.length * 0.75);
    var n = 0, sr = 0, sg = 0, sb = 0;
    for (var j = lo; j < hi; j++) { sr += px[j][0]; sg += px[j][1]; sb += px[j][2]; n++; }
    if (!n) return null;
    return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  }

  /* Recale les canaux d'après une référence censée être blanche. */
  function whiteBalance(rgb, white) {
    if (!white) return rgb.slice();
    var target = 235; // blanc plastique de bandelette, pas 255 (il est mat)
    return [0, 1, 2].map(function (i) {
      var k = white[i] > 8 ? target / white[i] : 1;
      return Math.max(0, Math.min(255, Math.round(rgb[i] * k)));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Correspondance couleur → valeur                                    */
  /* ------------------------------------------------------------------ */

  /*
   * match(param, rgb, customScale)
   * Retourne { value, confidence (0-1), best, second } ou null.
   * On interpole entre les deux niveaux les plus proches, pondérés par
   * l'inverse de l'écart perceptuel : une couleur pile entre « 1 » et « 3 »
   * donne ~2 plutôt que d'être forcée sur un cran du nuancier.
   */
  function match(param, rgb, customScale) {
    var scale = customScale && customScale.length >= 2 ? customScale : SCALES[param];
    if (!scale) return null;
    var lab = rgbToLab(rgb);
    var scored = scale.map(function (s) {
      return { value: s[0], rgb: s[1], d: deltaE(lab, rgbToLab(s[1])) };
    }).sort(function (a, b) { return a.d - b.d; });

    var b1 = scored[0], b2 = scored[1];
    var value = b1.value;
    if (b2 && b1.d + b2.d > 0) {
      var w = b2.d / (b1.d + b2.d); // proche de 1 si b1 domine
      value = b1.value * w + b2.value * (1 - w);
    }
    /* Confiance : un écart < 6 est une bonne correspondance, > 25 est douteux. */
    var conf = Math.max(0, Math.min(1, 1 - (b1.d - 6) / 25));
    return { value: value, confidence: conf, best: b1, second: b2, deltaE: b1.d };
  }

  /* Arrondi à un pas lisible pour le paramètre. */
  function snap(param, value) {
    var steps = { ph: 0.1, cl: 0.1, br: 0.5, tac: 10, th: 25, cya: 10 };
    var s = steps[param] || 0.1;
    return Math.round(value / s) * s;
  }

  /* ------------------------------------------------------------------ */
  /* Chargement / redimensionnement d'image                             */
  /* ------------------------------------------------------------------ */

  /* Réduit la photo (les capteurs sortent du 12 Mpx, inutile ici) et renvoie
     un dataURL JPEG léger, stockable tel quel dans l'historique. */
  function loadToCanvas(file, maxSide, cb) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cb(null, cv, ctx);
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(new Error('Image illisible')); };
    img.src = url;
  }

  global.Strip = {
    SCALES: SCALES,
    sample: sample, whiteBalance: whiteBalance, match: match, snap: snap,
    loadToCanvas: loadToCanvas, rgbToLab: rgbToLab, deltaE: deltaE,
    css: function (rgb) { return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')'; },
  };
})(window);
