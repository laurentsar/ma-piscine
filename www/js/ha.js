/*
 * ha.js — pont Home Assistant.
 *
 * Sortant : après chaque test, l'app publie les valeurs utiles comme entités
 *   sensor.piscine_* via l'API REST (POST /api/states/<entity_id>). Elles
 *   apparaissent immédiatement dans HA, historisées par le recorder, et sont
 *   utilisables en dashboard / automatisation / notification.
 * Entrant : l'app peut lire un capteur de température d'eau et l'état de la
 *   filtration déjà présents dans HA, pour pré-remplir le test et ajuster les
 *   conseils (inutile de traiter si la pompe est à l'arrêt).
 *
 * Attention côté HA : une entité créée par l'API vit en mémoire. Elle survit
 * aux redémarrages tant qu'on republie (ce que fait l'app à chaque test), mais
 * pour l'historiser il faut l'autoriser dans le recorder si celui-ci est en
 * liste blanche.
 */
(function (global) {
  'use strict';

  var PREFIX = 'sensor.piscine_';

  function cfg() {
    try { return JSON.parse(localStorage.getItem('piscine.ha') || '{}'); } catch (e) { return {}; }
  }
  function saveCfg(c) { localStorage.setItem('piscine.ha', JSON.stringify(c)); }
  function enabled() { var c = cfg(); return !!(c.url && c.token); }

  function baseUrl() {
    var u = (cfg().url || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u;
  }

  function req(path, opts) {
    opts = opts || {};
    var c = cfg();
    if (!c.url || !c.token) return Promise.reject(new Error('Home Assistant non configuré'));
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 8000) : null;
    return fetch(baseUrl() + path, {
      method: opts.method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + c.token,
        'Content-Type': 'application/json',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (r.status === 401) throw new Error('Jeton refusé (401) — régénère un jeton longue durée');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? 'Home Assistant ne répond pas' : (e.message || 'Réseau indisponible'));
    });
  }

  function ping() {
    return req('/api/').then(function (j) { return j && j.message ? j.message : 'OK'; });
  }

  function states() { return req('/api/states'); }

  /* Capteurs candidats pour la température de l'eau (device_class temperature). */
  function temperatureSensors() {
    return states().then(function (all) {
      return all.filter(function (s) {
        var a = s.attributes || {};
        /* input_number accepté : une sonde qui décroche laisse souvent la valeur
           utile dans un input_number entretenu par une automatisation. */
        return /^(sensor|input_number)\./.test(s.entity_id) &&
               (a.device_class === 'temperature' || /temp/i.test(s.entity_id)) &&
               !isNaN(parseFloat(s.state));
      }).map(function (s) {
        return { id: s.entity_id, name: (s.attributes || {}).friendly_name || s.entity_id,
                 value: parseFloat(s.state), unit: (s.attributes || {}).unit_of_measurement || '' };
      });
    });
  }

  /* Entités pouvant représenter la pompe de filtration. */
  function pumpEntities() {
    return states().then(function (all) {
      return all.filter(function (s) {
        return /^(switch|input_boolean|fan|light)\./.test(s.entity_id) &&
               /(filtr|pompe|pump|piscine|pool)/i.test(s.entity_id + ' ' + ((s.attributes || {}).friendly_name || ''));
      }).map(function (s) {
        return { id: s.entity_id, name: (s.attributes || {}).friendly_name || s.entity_id, state: s.state };
      });
    });
  }

  function getState(entityId) {
    if (!entityId) return Promise.resolve(null);
    return req('/api/states/' + encodeURIComponent(entityId)).catch(function () { return null; });
  }

  function setState(entityId, state, attributes) {
    return req('/api/states/' + encodeURIComponent(entityId), {
      method: 'POST',
      body: { state: String(state), attributes: attributes || {} },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Publication des valeurs                                            */
  /* ------------------------------------------------------------------ */

  /* Indice de saturation de Langelier : < -0,3 eau agressive (attaque le
     liner et les joints), > +0,3 eau entartrante. C'est la synthèse la plus
     parlante des quatre paramètres, et une bonne entité à surveiller dans HA. */
  function lsi(r) {
    if (r.ph == null || r.tac == null || r.th == null) return null;
    var t = r.temp == null ? 25 : r.temp;
    var tf = 0.0117 * t - 0.00067 * t * t + 0.0246; // facteur température
    var cf = Math.log(Math.max(1, r.th)) / Math.LN10 - 0.4;
    var af = Math.log(Math.max(1, r.tac)) / Math.LN10;
    return Math.round((r.ph + tf + cf + af - 12.1) * 100) / 100;
  }

  var SENSOR_DEFS = {
    ph:   { name: 'Piscine pH',              icon: 'mdi:ph',                unit: '' },
    cl:   { name: 'Piscine chlore libre',    icon: 'mdi:water-opacity',     unit: 'mg/L' },
    clt:  { name: 'Piscine chlore total',    icon: 'mdi:water-opacity',     unit: 'mg/L' },
    br:   { name: 'Piscine brome',           icon: 'mdi:water-opacity',     unit: 'mg/L' },
    oa:   { name: 'Piscine oxygène actif',   icon: 'mdi:water-opacity',     unit: 'mg/L' },
    tac:  { name: 'Piscine TAC',             icon: 'mdi:beaker-outline',    unit: 'mg/L' },
    th:   { name: 'Piscine TH',              icon: 'mdi:water-percent',     unit: 'mg/L' },
    cya:  { name: 'Piscine stabilisant',     icon: 'mdi:shield-sun-outline',unit: 'mg/L' },
    sel:  { name: 'Piscine sel',             icon: 'mdi:shaker-outline',    unit: 'g/L' },
    temp: { name: 'Piscine température eau', icon: 'mdi:pool-thermometer',  unit: '°C', device_class: 'temperature' },
  };

  /*
   * publish(snapshot) — envoie l'état complet de la piscine à HA.
   *   snapshot : { readings, mode, volume, actions, stock, nextTest, filtrationH }
   * Renvoie { ok, sent, errors }. Les échecs par entité ne bloquent pas le reste.
   */
  function publish(snap) {
    if (!enabled()) return Promise.resolve({ ok: false, sent: 0, errors: ['non configuré'] });
    var r = snap.readings || {};
    var jobs = [];
    var stamp = new Date().toISOString();

    Object.keys(SENSOR_DEFS).forEach(function (k) {
      if (r[k] == null || isNaN(r[k])) return;
      var d = SENSOR_DEFS[k];
      var attrs = {
        friendly_name: d.name, icon: d.icon, unit_of_measurement: d.unit,
        state_class: 'measurement', source: 'Ma Piscine (app)', last_test: stamp,
      };
      if (d.device_class) attrs.device_class = d.device_class;
      var st = Chem.status(snap.mode, k, r[k], r);
      if (st.target) { attrs.cible = st.target[1]; attrs.plage = st.target[0] + ' – ' + st.target[2]; attrs.statut = st.level; }
      jobs.push(setState(PREFIX + k, r[k], attrs));
    });

    /* Équilibre de l'eau (Langelier) */
    var li = lsi(r);
    if (li != null) {
      jobs.push(setState(PREFIX + 'equilibre', li, {
        friendly_name: 'Piscine équilibre (Langelier)', icon: 'mdi:scale-balance',
        state_class: 'measurement', source: 'Ma Piscine (app)',
        interpretation: li < -0.3 ? 'Eau agressive' : (li > 0.3 ? 'Eau entartrante' : 'Eau équilibrée'),
      }));
    }

    /* Synthèse : combien d'actions à faire, et laquelle est prioritaire. */
    var acts = snap.actions || [];
    jobs.push(setState(PREFIX + 'actions', acts.length, {
      friendly_name: 'Piscine actions à faire', icon: 'mdi:clipboard-check-outline',
      source: 'Ma Piscine (app)',
      prioritaire: acts.length ? acts[0].title : 'Rien à faire',
      detail: acts.map(function (a) {
        return a.title + (a.dose ? ' : ' + a.dose.text : '');
      }),
      last_test: stamp,
    }));

    /* État global, pour un badge ou une automatisation « alerte piscine ». */
    var worst = 'ok';
    Object.keys(SENSOR_DEFS).forEach(function (k) {
      if (r[k] == null) return;
      var lv = Chem.status(snap.mode, k, r[k], r).level;
      if (lv.indexOf('crit') === 0) worst = 'critique';
      else if (lv !== 'ok' && lv !== 'unknown' && worst === 'ok') worst = 'à corriger';
    });
    jobs.push(setState(PREFIX + 'etat', worst, {
      friendly_name: 'Piscine état de l\'eau', source: 'Ma Piscine (app)',
      icon: worst === 'ok' ? 'mdi:pool' : (worst === 'critique' ? 'mdi:alert-octagon' : 'mdi:alert'),
      last_test: stamp,
    }));

    if (snap.filtrationH != null) {
      jobs.push(setState(PREFIX + 'filtration_conseillee', snap.filtrationH, {
        friendly_name: 'Piscine filtration conseillée', icon: 'mdi:timer-cog-outline',
        unit_of_measurement: 'h', state_class: 'measurement', source: 'Ma Piscine (app)',
      }));
    }

    /* Remplissage en cours : utile pour couper une électrovanne ou alerter. */
    if (snap.fill) {
      jobs.push(setState(PREFIX + 'remplissage', snap.fill.paused ? 'pause' : snap.fill.remainingMin, {
        friendly_name: 'Piscine remplissage restant', icon: 'mdi:water-plus-outline',
        unit_of_measurement: 'min', source: 'Ma Piscine (app)',
        volume_prevu_m3: snap.fill.volumeM3, en_pause: !!snap.fill.paused,
      }));
    } else {
      jobs.push(setState(PREFIX + 'remplissage', 'inactif', {
        friendly_name: 'Piscine remplissage restant', icon: 'mdi:water-outline',
        source: 'Ma Piscine (app)',
      }));
    }

    if (snap.nextTest) {
      jobs.push(setState(PREFIX + 'prochain_test', snap.nextTest, {
        friendly_name: 'Piscine prochain test', icon: 'mdi:calendar-clock',
        device_class: 'timestamp', source: 'Ma Piscine (app)',
      }));
    }

    /* Stock : quantité restante par produit, pour alerter avant la rupture. */
    (snap.stock || []).forEach(function (s) {
      var slug = (s.name || 'produit').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
      if (!slug) return;
      jobs.push(setState(PREFIX + 'stock_' + slug, s.qty, {
        friendly_name: 'Piscine stock ' + s.name, icon: 'mdi:package-variant',
        unit_of_measurement: s.unit, state_class: 'measurement', source: 'Ma Piscine (app)',
        seuil_bas: s.low || null, sous_le_seuil: s.low ? s.qty <= s.low : false,
      }));
    });

    var errors = [];
    return Promise.all(jobs.map(function (p) {
      return p.then(function () { return true; }, function (e) { errors.push(e.message); return false; });
    })).then(function (res) {
      var sent = res.filter(Boolean).length;
      return { ok: sent > 0, sent: sent, errors: errors };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Sauvegarde                                                         */
  /* ------------------------------------------------------------------ */
  /*
   * Le stockage du téléphone disparaît à la moindre désinstallation, et
   * l'APK se réinstalle à chaque version. Home Assistant, lui, est déjà
   * sauvegardé vers le NAS : on y dépose l'état sous forme d'attribut.
   *
   * L'état d'un capteur est limité à 255 caractères, pas ses attributs :
   * c'est donc l'attribut `data` qui porte le JSON. Les photos restent sur
   * le téléphone (trop lourdes), et l'historique est tronqué aux 100
   * derniers tests pour ne pas gonfler indéfiniment la base HA.
   */
  var BACKUP_ENT = 'sensor.piscine_sauvegarde';

  function backupPayload(state) {
    var s = JSON.parse(JSON.stringify(state));
    (s.tests || []).forEach(function (t) { delete t.photoId; });
    s.tests = (s.tests || []).slice(-100);
    return s;
  }

  function backup(state) {
    if (!enabled()) return Promise.reject(new Error('Home Assistant non configuré'));
    var data = JSON.stringify(backupPayload(state));
    return setState(BACKUP_ENT, new Date().toISOString().slice(0, 19).replace('T', ' '), {
      friendly_name: 'Piscine sauvegarde', icon: 'mdi:cloud-upload-outline',
      taille_ko: Math.round(data.length / 102.4) / 10,
      produits: (state.stock || []).length,
      tests: (state.tests || []).length,
      data: data,
    }).then(function () { return { size: data.length }; });
  }

  function restore() {
    if (!enabled()) return Promise.reject(new Error('Home Assistant non configuré'));
    return getState(BACKUP_ENT).then(function (st) {
      var raw = st && st.attributes && st.attributes.data;
      if (!raw) throw new Error('Aucune sauvegarde trouvée');
      return { state: JSON.parse(raw), date: st.state };
    });
  }

  global.HA = {
    cfg: cfg, saveCfg: saveCfg, enabled: enabled, ping: ping,
    states: states, getState: getState, setState: setState,
    temperatureSensors: temperatureSensors, pumpEntities: pumpEntities,
    publish: publish, lsi: lsi, PREFIX: PREFIX,
    backup: backup, restore: restore, BACKUP_ENT: BACKUP_ENT,
  };
})(window);
