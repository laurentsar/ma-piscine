/*
 * chem.js — modèle chimique de la piscine.
 * Cibles par mode de désinfection, catalogue produits, calcul des dosages.
 *
 * Les coefficients de dosage sont des ordres de grandeur usuels du traitement
 * d'eau de piscine privée. Ils dépendent de la concentration réelle du produit
 * (indiquée sur l'emballage) : chaque produit du stock peut surcharger sa
 * propre concentration, et les doses restent arrondies prudemment (on sous-dose
 * plutôt que l'inverse : on peut toujours en remettre, jamais en retirer).
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Paramètres mesurables                                              */
  /* ------------------------------------------------------------------ */

  var PARAMS = {
    ph:    { label: 'pH',              unit: '',     min: 6.2, max: 8.4, step: 0.1, dec: 1 },
    cl:    { label: 'Chlore libre',    unit: 'mg/L', min: 0,   max: 10,  step: 0.1, dec: 1 },
    clt:   { label: 'Chlore total',    unit: 'mg/L', min: 0,   max: 10,  step: 0.1, dec: 1 },
    br:    { label: 'Brome',           unit: 'mg/L', min: 0,   max: 20,  step: 0.5, dec: 1 },
    oa:    { label: 'Oxygène actif',   unit: 'mg/L', min: 0,   max: 20,  step: 0.5, dec: 1 },
    tac:   { label: 'TAC (alcalinité)',unit: 'mg/L', min: 0,   max: 240, step: 10,  dec: 0 },
    th:    { label: 'TH (dureté)',     unit: 'mg/L', min: 0,   max: 500, step: 25,  dec: 0 },
    cya:   { label: 'Stabilisant',     unit: 'mg/L', min: 0,   max: 150, step: 10,  dec: 0 },
    sel:   { label: 'Sel',             unit: 'g/L',  min: 0,   max: 8,   step: 0.1, dec: 1 },
    temp:  { label: 'Température eau', unit: '°C',   min: 0,   max: 40,  step: 0.5, dec: 1 },
  };

  /* Cibles : [min, idéal, max]. Le chlore dépend du stabilisant (voir clTarget). */
  var TARGETS = {
    chlore: { ph: [7.0, 7.3, 7.6], cl: [1, 2, 3],    tac: [80, 100, 140], th: [150, 250, 350], cya: [20, 40, 60] },
    sel:    { ph: [7.0, 7.3, 7.6], cl: [1, 2, 3],    tac: [80, 100, 140], th: [200, 250, 400], cya: [30, 50, 80], sel: [3.5, 4, 5] },
    brome:  { ph: [7.2, 7.5, 7.8], br: [2, 4, 6],    tac: [80, 100, 140], th: [150, 250, 350] },
    oxygene:{ ph: [7.0, 7.3, 7.6], oa: [5, 8, 10],   tac: [80, 100, 140], th: [150, 250, 350] },
  };

  var MODES = [
    { id: 'chlore',  label: 'Chlore',            params: ['ph', 'cl', 'tac', 'th', 'cya'] },
    { id: 'sel',     label: 'Sel / électrolyse', params: ['ph', 'cl', 'tac', 'th', 'cya', 'sel'] },
    { id: 'brome',   label: 'Brome',             params: ['ph', 'br', 'tac', 'th'] },
    { id: 'oxygene', label: 'Oxygène actif',     params: ['ph', 'oa', 'tac', 'th'] },
  ];

  /* ------------------------------------------------------------------ */
  /* Catalogue produits                                                 */
  /* ------------------------------------------------------------------ */

  /* dose : quantité de produit (unit) par m³ d'eau pour 1 « pas » d'effet.
     effect : ce qu'un pas fait bouger (dans l'unité du paramètre). */
  var PRODUCTS = [
    { id: 'chlore_choc',    label: 'Chlore choc (granulés)',   role: 'cl',  unit: 'g',  dose: 1.5,  effect: 1,   modes: ['chlore', 'sel', 'oxygene'],
      note: 'Hypochlorite de calcium ~65 %. Filtration en marche, pH réglé avant.' },
    { id: 'chlore_lent',    label: 'Chlore lent (galets 250 g)', role: 'cl', unit: 'galet', dose: 0.04, effect: 1, modes: ['chlore'],
      note: '≈ 1 galet / 25 m³ / semaine, en skimmer ou diffuseur. Apporte du stabilisant.' },
    { id: 'chlore_liquide', label: 'Chlore liquide (javel piscine)', role: 'cl', unit: 'mL', dose: 10, effect: 1, modes: ['chlore', 'sel'],
      note: '≈ 9,6 % de chlore actif. Ne stabilise pas, se dégrade au stockage.' },
    { id: 'brome_pastille', label: 'Brome (pastilles)',        role: 'br',  unit: 'g',  dose: 2,    effect: 1,   modes: ['brome'],
      note: 'En brominateur. Efficace jusqu\'à pH 8.' },
    { id: 'oxygene_actif',  label: 'Oxygène actif',            role: 'oa',  unit: 'g',  dose: 1.5,  effect: 1,   modes: ['oxygene'],
      note: 'Sans chlore ni odeur, mais rémanence courte : dosage régulier.' },
    { id: 'ph_moins',       label: 'pH moins (poudre)',        role: 'ph-', unit: 'g',  dose: 10,   effect: 0.1, modes: ['*'],
      note: 'Bisulfate de sodium. Diluer dans un seau, verser devant les refoulements.' },
    { id: 'ph_moins_liq',   label: 'pH moins (liquide)',       role: 'ph-', unit: 'mL', dose: 10,   effect: 0.1, modes: ['*'],
      note: 'Acide. Ne jamais mélanger à un autre produit.' },
    { id: 'ph_plus',        label: 'pH plus (poudre)',         role: 'ph+', unit: 'g',  dose: 10,   effect: 0.1, modes: ['*'],
      note: 'Carbonate de sodium. Monte aussi légèrement le TAC.' },
    { id: 'tac_plus',       label: 'TAC plus (bicarbonate)',   role: 'tac+',unit: 'g',  dose: 17,   effect: 10,  modes: ['*'],
      note: 'Corriger le TAC AVANT le pH : un TAC bas fait yoyoter le pH.' },
    { id: 'th_plus',        label: 'TH plus (chlorure de calcium)', role: 'th+', unit: 'g', dose: 15, effect: 10, modes: ['*'],
      note: 'Contre l\'eau agressive qui attaque liner et joints.' },
    { id: 'stabilisant',    label: 'Stabilisant (acide cyanurique)', role: 'cya+', unit: 'g', dose: 10, effect: 10, modes: ['chlore', 'sel'],
      note: 'Protège le chlore des UV. Ne s\'élimine QUE par vidange partielle.' },
    { id: 'sel_piscine',    label: 'Sel piscine (sac)',        role: 'sel+',unit: 'g',  dose: 1000, effect: 1,   modes: ['sel'],
      note: '1 kg/m³ pour monter de 1 g/L. Électrolyseur à l\'arrêt pendant la dissolution.' },
    { id: 'anti_algues',    label: 'Anti-algues',              role: 'algi',unit: 'mL', dose: 5,    effect: 1,   modes: ['*'],
      note: 'Préventif ≈ 5 mL/m³ tous les 15 j ; curatif : double dose + choc.' },
    { id: 'floculant',      label: 'Floculant / clarifiant',   role: 'floc',unit: 'mL', dose: 3,    effect: 1,   modes: ['*'],
      note: 'Filtration en continu 24-48 h puis contre-lavage. Pas avec une cartouche.' },
    { id: 'detartrant',     label: 'Détartrant cellule',       role: 'main',unit: 'mL', dose: 0,    effect: 0,   modes: ['sel'],
      note: 'Nettoyage des plaques d\'électrolyseur entourées de calcaire.' },
    { id: 'autre',          label: 'Autre produit',            role: 'none',unit: 'g',  dose: 0,    effect: 0,   modes: ['*'],
      note: '' },
  ];

  function product(id) {
    for (var i = 0; i < PRODUCTS.length; i++) if (PRODUCTS[i].id === id) return PRODUCTS[i];
    return null;
  }

  function productsForRole(role, mode) {
    return PRODUCTS.filter(function (p) {
      return p.role === role && (p.modes.indexOf('*') >= 0 || p.modes.indexOf(mode) >= 0);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Cibles dynamiques                                                  */
  /* ------------------------------------------------------------------ */

  /* Le chlore doit monter avec le stabilisant : au-delà de 50 mg/L de CYA,
     il faut ~7,5 % du CYA en chlore libre pour garder le même pouvoir. */
  function clTarget(mode, cya) {
    var base = TARGETS[mode] && TARGETS[mode].cl;
    if (!base) return null;
    if (cya == null || cya <= 50) return base.slice();
    var mini = Math.max(base[0], Math.round(cya * 0.05 * 10) / 10);
    var ideal = Math.max(base[1], Math.round(cya * 0.075 * 10) / 10);
    return [mini, ideal, Math.max(base[2], ideal + 1)];
  }

  function targetFor(mode, param, readings) {
    if (param === 'cl') return clTarget(mode, readings && readings.cya);
    var t = TARGETS[mode];
    return t && t[param] ? t[param].slice() : null;
  }

  /* Statut d'une mesure : ok / bas / haut / critique */
  function status(mode, param, value, readings) {
    var t = targetFor(mode, param, readings);
    if (t == null || value == null) return { level: 'unknown', target: t };
    var span = t[2] - t[0];
    if (value < t[0]) return { level: value < t[0] - span * 0.5 ? 'crit-low' : 'low', target: t };
    if (value > t[2]) return { level: value > t[2] + span * 0.5 ? 'crit-high' : 'high', target: t };
    return { level: 'ok', target: t };
  }

  /* ------------------------------------------------------------------ */
  /* Moteur de recommandation                                           */
  /* ------------------------------------------------------------------ */

  /* Quantité de produit pour amener `from` à `to` sur `volume` m³. */
  function qtyFor(prod, delta, volume) {
    if (!prod || !prod.effect) return 0;
    return (Math.abs(delta) / prod.effect) * prod.dose * volume;
  }

  function roundQty(q, unit) {
    if (unit === 'galet') return Math.max(1, Math.round(q));
    if (q >= 1000) return Math.round(q / 50) * 50;
    if (q >= 100) return Math.round(q / 10) * 10;
    if (q >= 10) return Math.round(q);
    return Math.round(q * 10) / 10;
  }

  function fmtQty(q, unit) {
    if (unit === 'galet') return q + (q > 1 ? ' galets' : ' galet');
    if (unit === 'g' && q >= 1000) return (Math.round(q / 100) / 10) + ' kg';
    if (unit === 'mL' && q >= 1000) return (Math.round(q / 100) / 10) + ' L';
    return q + ' ' + unit;
  }

  /*
   * recommend({ mode, volume, readings, stock, prevReadings })
   *   readings : { ph, cl, clt, tac, th, cya, sel, temp }
   *   stock    : [ { id, name, productId, qty, unit, concentration? } ]
   * Retourne une liste d'actions triées par priorité (1 = à faire d'abord).
   */
  function recommend(opts) {
    var mode = opts.mode || 'chlore';
    var vol = opts.volume || 0;
    var r = opts.readings || {};
    var stock = opts.stock || [];
    var out = [];

    function stockFor(role) {
      return stock.filter(function (s) {
        var p = product(s.productId);
        return p && p.role === role && s.qty > 0;
      });
    }

    /* Choisit l'article de stock le plus adapté (le plus fourni) pour un rôle. */
    function pick(role) {
      var items = stockFor(role);
      if (!items.length) return null;
      items.sort(function (a, b) { return (b.qty || 0) - (a.qty || 0); });
      return items[0];
    }

    function push(a) { out.push(a); }

    function dosing(role, delta, opt) {
      opt = opt || {};
      var item = pick(role);
      var prod = item ? product(item.productId) : (productsForRole(role, mode)[0] || null);
      if (!prod) return null;
      /* Concentration personnalisée : un produit 2× plus concentré = 2× moins de dose. */
      var factor = item && item.strength ? (prod.refStrength || 100) / item.strength : 1;
      var q = roundQty(qtyFor(prod, delta, vol) * factor, prod.unit);
      var have = item ? item.qty : 0;
      return {
        product: prod, item: item, qty: q, unit: prod.unit,
        text: fmtQty(q, prod.unit) + ' de ' + (item ? item.name : prod.label),
        inStock: !!item, enough: item ? have >= q : false,
        missing: item && have < q ? roundQty(q - have, prod.unit) : 0,
        note: prod.note,
      };
    }

    /* --- 1. TAC : à corriger en premier, il stabilise le pH --------- */
    var tacT = targetFor(mode, 'tac', r);
    if (r.tac != null && tacT) {
      if (r.tac < tacT[0]) {
        var d = dosing('tac+', tacT[1] - r.tac);
        push({ prio: 1, param: 'tac', title: 'Remonter le TAC', dose: d,
          why: 'TAC à ' + r.tac + ' mg/L (cible ' + tacT[0] + '-' + tacT[2] + '). Trop bas, le pH devient instable et l\'eau agressive.' });
      } else if (r.tac > tacT[2]) {
        push({ prio: 2, param: 'tac', title: 'Faire baisser le TAC', dose: null,
          why: 'TAC à ' + r.tac + ' mg/L (max ' + tacT[2] + '). Se baisse en acidifiant par petites doses de pH moins, répétées sur plusieurs jours, ou par apport d\'eau neuve.' });
      }
    }

    /* --- 2. pH : conditionne l'efficacité du désinfectant ----------- */
    var phT = targetFor(mode, 'ph', r);
    if (r.ph != null && phT) {
      if (r.ph > phT[2]) {
        var dm = dosing('ph-', r.ph - phT[1]);
        push({ prio: 1, param: 'ph', title: 'Faire baisser le pH', dose: dm,
          why: 'pH à ' + r.ph + ' (cible ' + phT[1] + '). Au-dessus de ' + phT[2] + ', le chlore perd une grande partie de son pouvoir désinfectant et le calcaire précipite.',
          tip: 'Verser en 2 fois, tester 4 h après. Ne jamais dépasser la dose calculée d\'un coup.' });
      } else if (r.ph < phT[0]) {
        var dp = dosing('ph+', phT[1] - r.ph);
        push({ prio: 1, param: 'ph', title: 'Remonter le pH', dose: dp,
          why: 'pH à ' + r.ph + ' (cible ' + phT[1] + '). Une eau acide corrode le liner, les joints et l\'échangeur de la pompe à chaleur.' });
      }
    }

    /* --- 3. Désinfectant ------------------------------------------- */
    var dis = mode === 'brome' ? 'br' : (mode === 'oxygene' ? 'oa' : 'cl');
    var disRole = dis;
    var disT = targetFor(mode, dis, r);
    var disV = r[dis];
    var disLowAction = null;
    if (disV != null && disT) {
      if (disV < disT[0]) {
        var dd = dosing(disRole, disT[1] - disV);
        var urgent = disV < disT[0] * 0.4;
        disLowAction = { prio: urgent ? 1 : 2, param: dis,
          title: (urgent ? 'Rechlorer d\'urgence' : 'Remonter ' + PARAMS[dis].label.toLowerCase()), dose: dd,
          why: PARAMS[dis].label + ' à ' + disV + ' mg/L (cible ' + disT[1] + ')' +
               (urgent ? '. Niveau trop faible : l\'eau n\'est plus protégée, les algues peuvent démarrer en 24-48 h.' : '.'),
          tip: r.ph != null && phT && r.ph > phT[2] ? 'Corriger le pH d\'abord, sinon le chlore ajouté sera peu actif.' : null };
        push(disLowAction);
      } else if (disV > disT[2]) {
        push({ prio: 3, param: dis, title: PARAMS[dis].label + ' trop haut', dose: null,
          why: 'À ' + disV + ' mg/L (max ' + disT[2] + '). Baignade déconseillée au-dessus de 3 mg/L de chlore libre.',
          tip: 'Suspendre l\'apport, laisser filtrer bâche ouverte : les UV le feront redescendre en 1 à 2 jours.' });
      }
    }

    /* Chloramines : chlore combiné = total - libre. Au-delà de 0,6 → choc. */
    if (mode !== 'brome' && mode !== 'oxygene' && r.clt != null && r.cl != null) {
      var comb = Math.round((r.clt - r.cl) * 10) / 10;
      if (comb >= 0.6) {
        var dc = dosing('cl', Math.max(5, comb * 10));
        /* Si le chlore est déjà signalé bas, on ne fait pas deux ajouts : on
           garde la dose choc, qui englobe la remise à niveau. */
        if (disLowAction) {
          if (!disLowAction.dose || !dc || dc.qty >= disLowAction.dose.qty) {
            out.splice(out.indexOf(disLowAction), 1);
            disLowAction = null;
          }
        }
        if (!disLowAction || !disLowAction.dose || (dc && dc.qty >= disLowAction.dose.qty))
        push({ prio: 1, param: 'clt', title: 'Chloration choc (chloramines)', dose: dc,
          why: 'Chlore combiné à ' + comb + ' mg/L (max 0,6). C\'est lui qui donne l\'odeur de « chlore » et pique les yeux — signe que le chlore est saturé, pas qu\'il y en a trop.',
          tip: 'Le soir, bâche ouverte, filtration en continu jusqu\'au lendemain.' });
      }
    }

    /* --- 4. Stabilisant -------------------------------------------- */
    var cyaT = targetFor(mode, 'cya', r);
    if (r.cya != null && cyaT) {
      if (r.cya < cyaT[0]) {
        var dcy = dosing('cya+', cyaT[1] - r.cya);
        push({ prio: 3, param: 'cya', title: 'Ajouter du stabilisant', dose: dcy,
          why: 'Stabilisant à ' + r.cya + ' mg/L (cible ' + cyaT[1] + '). Sans lui, les UV détruisent le chlore en quelques heures.' });
      } else if (r.cya > 75) {
        push({ prio: 2, param: 'cya', title: 'Stabilisant trop élevé', dose: null,
          why: 'À ' + r.cya + ' mg/L, le chlore est « bloqué » : il est présent mais n\'agit plus (surstabilisation).',
          tip: 'Seule solution : renouveler l\'eau. Vidanger ~' + Math.round((1 - 50 / r.cya) * 100) + ' % du bassin et compléter en eau neuve, puis passer au chlore non stabilisé (liquide ou choc).' });
      }
    }

    /* --- 5. TH ------------------------------------------------------ */
    var thT = targetFor(mode, 'th', r);
    if (r.th != null && thT) {
      if (r.th < thT[0]) {
        var dth = dosing('th+', thT[1] - r.th);
        push({ prio: 4, param: 'th', title: 'Remonter le TH', dose: dth,
          why: 'Eau douce (TH ' + r.th + ' mg/L) : elle « cherche » du calcium et attaque les surfaces.' });
      } else if (r.th > thT[2]) {
        push({ prio: 4, param: 'th', title: 'TH élevé — risque de calcaire', dose: null,
          why: 'TH à ' + r.th + ' mg/L. Risque de dépôt blanc sur la ligne d\'eau et d\'entartrage' + (mode === 'sel' ? ' des plaques de l\'électrolyseur.' : '.'),
          tip: 'Maintenir le pH plutôt bas (7,0-7,2) et utiliser un séquestrant calcaire.' });
      }
    }

    /* --- 6. Sel ----------------------------------------------------- */
    var selT = targetFor(mode, 'sel', r);
    if (mode === 'sel' && r.sel != null && selT) {
      if (r.sel < selT[0]) {
        var ds = dosing('sel+', selT[1] - r.sel);
        push({ prio: 2, param: 'sel', title: 'Ajouter du sel', dose: ds,
          why: 'Sel à ' + r.sel + ' g/L (cible ' + selT[1] + '). En dessous, l\'électrolyseur produit peu ou se met en défaut.',
          tip: 'Verser dans le bassin (pas dans les skimmers), pompe en route, électrolyseur coupé 24 h.' });
      } else if (r.sel > selT[2]) {
        push({ prio: 4, param: 'sel', title: 'Sel trop concentré', dose: null,
          why: 'À ' + r.sel + ' g/L, risque de corrosion des pièces métalliques.',
          tip: 'Vidanger partiellement et compléter en eau claire.' });
      }
    }

    out.sort(function (a, b) { return a.prio - b.prio; });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Filtration                                                         */
  /* ------------------------------------------------------------------ */

  /* Règle usuelle : durée de filtration ≈ température de l'eau / 2 (heures/jour). */
  function filtrationHours(tempC) {
    if (tempC == null) return null;
    if (tempC < 10) return 2;
    return Math.min(24, Math.max(2, Math.round(tempC / 2)));
  }

  global.Chem = {
    PARAMS: PARAMS, TARGETS: TARGETS, MODES: MODES, PRODUCTS: PRODUCTS,
    product: product, productsForRole: productsForRole,
    targetFor: targetFor, status: status, recommend: recommend,
    filtrationHours: filtrationHours, fmtQty: fmtQty, roundQty: roundQty,
  };
})(window);
