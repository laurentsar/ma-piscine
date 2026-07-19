/*
 * app.js — Ma Piscine.
 * État local (localStorage + IndexedDB pour les photos), interface, flux de
 * test, stock par code-barres, moteur proactif et pont Home Assistant.
 */
(function () {
  'use strict';

  var APP_VERSION = '1.4.1';
  window.APP_VERSION = APP_VERSION;

  /* ================================================================== */
  /* État                                                               */
  /* ================================================================== */

  var KEY = 'piscine.state';
  var DEFAULTS = {
    settings: {
      /* Bassin 6,82 × 4,05 × 1,40 m — volume et surface mesurés, pas des valeurs d'exemple. */
      mode: 'chlore', volume: 38.7, freq: 'auto',
      notif: false, notifHour: '09:00', weather: false, lat: null, lon: null,
      haAuto: true,
      haTempEnt: 'input_number.piscine_temperature',
      haPumpEnt: 'switch.prise_piscine_commutateur_2',
      flow: 15, surface: 27.6, filter: 'aqualoon',
      pumpW: 1140, kwhPrice: 0.15,
    },
    tests: [], stock: [], barcodes: {}, treatments: [], calib: {},
    fill: null, dilutionNotice: null,
  };

  var S = load();

  function load() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    var s = raw || {};
    var out = JSON.parse(JSON.stringify(DEFAULTS));
    Object.keys(out).forEach(function (k) {
      if (s[k] == null) return;
      if (k === 'settings') Object.keys(s.settings || {}).forEach(function (n) { out.settings[n] = s.settings[n]; });
      else out[k] = s[k];
    });
    return out;
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(S)); }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* --- Photos : IndexedDB, trop volumineuses pour localStorage ------- */
  var DB = null;
  function db() {
    if (DB) return Promise.resolve(DB);
    return new Promise(function (res, rej) {
      var rq = indexedDB.open('piscine', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('photos'); };
      rq.onsuccess = function () { DB = rq.result; res(DB); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function putPhoto(id, dataUrl) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction('photos', 'readwrite');
        tx.objectStore('photos').put(dataUrl, id);
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () { /* pas de photo, pas de drame */ });
  }
  function getPhoto(id) {
    if (!id) return Promise.resolve(null);
    return db().then(function (d) {
      return new Promise(function (res) {
        var rq = d.transaction('photos').objectStore('photos').get(id);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }
  function delPhoto(id) {
    if (!id) return Promise.resolve();
    return db().then(function (d) { d.transaction('photos', 'readwrite').objectStore('photos').delete(id); }).catch(function () {});
  }

  /* ================================================================== */
  /* Utilitaires UI                                                     */
  /* ================================================================== */

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600);
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + ' ' +
           d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  function daysBetween(a, b) { return (new Date(b) - new Date(a)) / 86400000; }
  function round(v, d) { var f = Math.pow(10, d || 0); return Math.round(v * f) / f; }

  /* Modale générique : renvoie une promesse (valeur ou null si annulé). */
  function modal(title, buildBody, collect) {
    return new Promise(function (res) {
      $('modalTitle').textContent = title;
      var body = $('modalBody');
      body.innerHTML = '';
      buildBody(body);
      $('modal').classList.remove('hidden');
      function close(v) {
        $('modal').classList.add('hidden');
        $('modalOk').onclick = null; $('modalCancel').onclick = null;
        res(v);
      }
      $('modalOk').onclick = function () {
        var v = collect ? collect(body) : true;
        if (v === undefined) return; // validation refusée
        close(v);
      };
      $('modalCancel').onclick = function () { close(null); };
    });
  }

  /* ================================================================== */
  /* Onglets                                                            */
  /* ================================================================== */

  function showTab(name) {
    [].forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    [].forEach.call(document.querySelectorAll('.tab-panel'), function (p) {
      p.classList.toggle('active', p.id === 'tab-' + name);
    });
    window.scrollTo(0, 0);
    if (name === 'home') renderHome();
    if (name === 'stock') renderStock();
    if (name === 'hist') renderHist();
    if (name === 'test') renderTestTab();
  }

  /* ================================================================== */
  /* Accueil : état de l'eau, actions, proactif                         */
  /* ================================================================== */

  function lastTest() { return S.tests.length ? S.tests[S.tests.length - 1] : null; }

  function currentActions() {
    var t = lastTest();
    if (!t) return [];
    return Chem.recommend({
      mode: S.settings.mode, volume: S.settings.volume,
      readings: t.readings, stock: S.stock,
    });
  }

  var LEVEL_LABEL = {
    ok: 'correct', low: 'bas', high: 'haut',
    'crit-low': 'très bas', 'crit-high': 'très haut', unknown: '—',
  };

  function renderHome() {
    var t = lastTest();
    var host = $('waterState');
    host.innerHTML = '';

    if (!t) {
      host.appendChild(el('div', 'card empty',
        '<p><strong>Bienvenue.</strong></p>' +
        '<p class="muted small">Renseigne d\'abord le volume du bassin dans les réglages, puis fais un premier test : ' +
        'l\'app en déduit les doses à verser, avec ce que tu as réellement en stock.</p>'));
      $('actions').innerHTML = '';
      $('lastTestInfo').textContent = '';
      renderFill();
      renderProactive();
      return;
    }

    var mode = S.settings.mode;
    var params = (Chem.MODES.filter(function (m) { return m.id === mode; })[0] || {}).params || [];
    var grid = el('div', 'params');
    params.forEach(function (p) {
      var v = t.readings[p];
      if (v == null) return;
      var st = Chem.status(mode, p, v, t.readings);
      var d = Chem.PARAMS[p];
      var card = el('div', 'param ' + st.level);
      card.innerHTML =
        '<div class="param-name">' + esc(d.label) + '</div>' +
        '<div class="param-val">' + round(v, d.dec) + '<span>' + esc(d.unit) + '</span></div>' +
        '<div class="param-tgt">' + (st.target ? 'cible ' + st.target[1] : '') +
        ' <em>' + LEVEL_LABEL[st.level] + '</em></div>';
      grid.appendChild(card);
    });
    host.appendChild(grid);

    /* Équilibre de l'eau + filtration : deux chiffres qu'on ne lit nulle part ailleurs. */
    var extra = [];
    var li = HA.lsi(t.readings);
    if (li != null) {
      var interp = li < -0.3 ? 'eau agressive (attaque liner et joints)'
                 : (li > 0.3 ? 'eau entartrante (dépôt calcaire)' : 'eau équilibrée');
      extra.push('<strong>Équilibre :</strong> ' + li + ' — ' + interp);
    }
    var fh = Chem.filtrationHours(t.readings.temp);
    if (fh != null) {
      var line = '<strong>Filtration conseillée :</strong> ' + fh + ' h/jour';
      var cost = filtrationCost(fh);
      if (cost) line += ' <span class="muted">— ' + cost + '</span>';
      extra.push(line);
    }
    if (extra.length) host.appendChild(el('div', 'card info-card small', extra.join('<br>')));

    $('lastTestInfo').textContent = 'Dernier test : ' + fmtDate(t.date) +
      (t.method === 'photo' ? ' (photo)' : ' (saisie)') + (t.note ? ' — ' + t.note : '');

    renderActions();
    renderFill();
    renderProactive();
  }

  /* Coût électrique de la filtration conseillée : la durée vient de la
     température, la puissance de la pompe et le prix du kWh des réglages. */
  function filtrationCost(hours) {
    var w = S.settings.pumpW || 0, p = S.settings.kwhPrice || 0;
    if (!hours || !w || !p) return null;
    var day = hours * w / 1000 * p;
    return day.toFixed(2).replace('.', ',') + ' € / jour · ' +
           (day * 30).toFixed(0) + ' € / mois';
  }

  /* Incompatibilité produit / média filtrant : ça n'a rien à voir avec une
     analyse d'eau, donc ça ne passe pas par le moteur de dosage, mais il faut
     le voir — un colmatage de balles filtrantes est irréversible. */
  function renderFilterWarning(host) {
    var conflicts = Chem.filterConflicts(S.settings.filter, S.stock);
    if (!conflicts.length) return;
    var f = conflicts[0].filter;
    var names = conflicts.map(function (c) { return c.item.name; }).join(', ');
    host.appendChild(el('div', 'card warn-card',
      '⚠️ <strong>Floculant et ' + esc(f.label.split(' (')[0].toLowerCase()) + ' ne vont pas ensemble.</strong><br>' +
      '<span class="small">' + esc(names) + ' libère du floculant à chaque usage. ' +
      'Il agglomère les impuretés et colle les fibres entre elles : le colmatage est irréversible. ' +
      'Surveille la pression du filtre, lave le média à 30 °C en filet dès qu\'elle grimpe, ' +
      'et passe à un chlore lent simple (sans « multifonction ») quand ce lot sera fini.</span>'));
  }

  function renderActions() {
    var host = $('actions');
    host.innerHTML = '';
    renderFilterWarning(host);
    var acts = currentActions();
    if (!acts.length) {
      host.appendChild(el('div', 'card ok-card', '✅ <strong>Rien à corriger.</strong><br>' +
        '<span class="muted small">Les paramètres mesurés sont dans les plages. Continue la filtration normalement.</span>'));
      return;
    }
    acts.forEach(function (a, i) {
      var c = el('div', 'card action prio' + a.prio);
      var h = '<div class="action-head"><span class="prio-badge">' +
        (a.prio === 1 ? 'À faire maintenant' : a.prio === 2 ? 'Bientôt' : 'Quand tu peux') +
        '</span><h3>' + esc(a.title) + '</h3></div>';
      if (a.dose) {
        h += '<div class="dose">💧 ' + esc(a.dose.text) + '</div>';
        if (a.dose.split) {
          h += '<div class="warn-txt small">⚠️ À fractionner : ' + a.dose.split.times +
               ' apports de ' + esc(Chem.fmtQty(a.dose.split.each, a.dose.unit)) +
               ', espacés de quelques heures. Au-delà de ' + a.dose.split.rate +
               ' g/m³ en une fois, l\'eau se trouble.</div>';
        }
        if (!a.dose.inStock) {
          h += '<div class="warn-line">⚠️ Ce produit n\'est pas dans ton stock. ' +
               'Ajoute-le après achat en scannant son code-barres.</div>';
        } else if (!a.dose.enough) {
          h += '<div class="warn-line">⚠️ Stock insuffisant : il te manque environ ' +
               esc(Chem.fmtQty(a.dose.missing, a.dose.unit)) + '.</div>';
        }
      }
      h += '<p class="why">' + esc(a.why) + '</p>';
      if (a.tip) h += '<p class="tip">💡 ' + esc(a.tip) + '</p>';
      if (a.dose && a.dose.note) h += '<p class="muted small">' + esc(a.dose.note) + '</p>';
      c.innerHTML = h;

      if (a.dose && a.dose.inStock) {
        var btn = el('button', 'ghost done-btn', '✅ C\'est versé');
        btn.onclick = function () { applyTreatment(a); };
        c.appendChild(btn);
      }
      host.appendChild(c);
      void i;
    });
  }

  /* Marque une action comme réalisée : décrémente le stock et journalise. */
  function applyTreatment(a) {
    var item = a.dose && a.dose.item;
    if (item) {
      var s = S.stock.filter(function (x) { return x.id === item.id; })[0];
      if (s) s.qty = Math.max(0, round(s.qty - a.dose.qty, 2));
    }
    S.treatments.push({
      id: uid(), date: new Date().toISOString(), title: a.title, param: a.param,
      product: item ? item.name : (a.dose ? a.dose.product.label : ''),
      qty: a.dose ? a.dose.qty : 0, unit: a.dose ? a.dose.unit : '',
    });
    save();
    toast('Traitement noté, stock mis à jour');
    renderHome();
    pushHA(true);
  }

  /* ================================================================== */
  /* Moteur proactif                                                    */
  /* ================================================================== */

  /* Intervalle entre deux tests : plus l'eau est chaude, plus elle bouge. */
  function testInterval() {
    var f = S.settings.freq;
    if (f !== 'auto') return parseInt(f, 10);
    var t = lastTest();
    var temp = t && t.readings.temp != null ? t.readings.temp : (WEATHER.tmax || 22);
    if (temp >= 28) return 2;
    if (temp >= 24) return 3;
    if (temp >= 18) return 4;
    if (temp >= 12) return 7;
    return 14;
  }

  function nextTestDate() {
    var t = lastTest();
    var base = t ? new Date(t.date) : new Date();
    return new Date(base.getTime() + testInterval() * 86400000);
  }

  /* Tendance d'un paramètre : variation par jour sur les 4 derniers tests. */
  function trend(param) {
    var pts = S.tests.filter(function (t) { return t.readings[param] != null; }).slice(-4);
    if (pts.length < 2) return null;
    var a = pts[0], b = pts[pts.length - 1];
    var days = daysBetween(a.date, b.date);
    if (days < 0.5) return null;
    return { perDay: (b.readings[param] - a.readings[param]) / days, from: a, to: b, n: pts.length };
  }

  var WEATHER = { tmax: null, rain: null, uv: null, fetchedAt: 0, days: [] };

  function loadWeather() {
    var s = S.settings;
    if (!s.weather || s.lat == null || s.lon == null) return Promise.resolve(null);
    if (Date.now() - WEATHER.fetchedAt < 3 * 3600 * 1000) return Promise.resolve(WEATHER);
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + round(s.lat, 2) +
      '&longitude=' + round(s.lon, 2) +
      '&daily=temperature_2m_max,precipitation_sum,uv_index_max,wind_speed_10m_max' +
      '&forecast_days=4&timezone=auto';
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var d = j.daily || {};
      WEATHER.days = (d.time || []).map(function (day, i) {
        return {
          date: day, tmax: d.temperature_2m_max[i], rain: d.precipitation_sum[i],
          uv: d.uv_index_max[i], wind: d.wind_speed_10m_max[i],
        };
      });
      WEATHER.tmax = WEATHER.days.length ? WEATHER.days[0].tmax : null;
      WEATHER.rain = WEATHER.days.reduce(function (a, x) { return a + (x.rain || 0); }, 0);
      WEATHER.uv = WEATHER.days.length ? WEATHER.days[0].uv : null;
      WEATHER.fetchedAt = Date.now();
      return WEATHER;
    }).catch(function () { return null; });
  }

  /*
   * Alertes proactives : ce que l'app remarque sans qu'on lui demande.
   * Chacune renvoie { level, icon, title, text }.
   */
  function computeProactive() {
    var out = [];
    var t = lastTest();
    var now = new Date();

    /* 1. Test en retard */
    if (!t) {
      out.push({ level: 'info', icon: '🧪', title: 'Aucun test enregistré',
        text: 'Fais un premier relevé pour que l\'app puisse calculer tes dosages.' });
    } else {
      var due = nextTestDate();
      var late = Math.floor((now - due) / 86400000);
      if (late >= 0) {
        out.push({ level: late >= 3 ? 'warn' : 'info', icon: '⏰',
          title: late === 0 ? 'Test à faire aujourd\'hui' : 'Test en retard de ' + (late + 1) + ' jour' + (late ? 's' : ''),
          text: 'Dernier relevé il y a ' + Math.round(daysBetween(t.date, now)) + ' jours. ' +
                'À cette température, l\'eau doit être contrôlée tous les ' + testInterval() + ' jours.' });
      }
    }

    /* 2. Baignade */
    if (t) {
      var cl = t.readings.cl;
      if (cl != null && cl > 3) {
        out.push({ level: 'warn', icon: '🚫', title: 'Baignade déconseillée',
          text: 'Chlore libre à ' + cl + ' mg/L. Attendre de repasser sous 3 mg/L (bâche ouverte, les UV font le travail).' });
      } else if (cl != null && cl < 0.5) {
        out.push({ level: 'warn', icon: '🦠', title: 'Eau non protégée',
          text: 'Chlore à ' + cl + ' mg/L : plus de barrière contre les bactéries. Rechlorer avant de se baigner.' });
      }
    }

    /* 3. Tendance : anticiper la chute du désinfectant */
    var dis = S.settings.mode === 'brome' ? 'br' : (S.settings.mode === 'oxygene' ? 'oa' : 'cl');
    var tr = trend(dis);
    if (t && tr && tr.perDay < -0.15) {
      var target = Chem.targetFor(S.settings.mode, dis, t.readings);
      var cur = t.readings[dis];
      if (cur != null && target) {
        var days = (cur - target[0]) / -tr.perDay;
        if (days > 0 && days < 6) {
          out.push({ level: 'info', icon: '📉',
            title: 'Le ' + Chem.PARAMS[dis].label.toLowerCase() + ' baisse vite',
            text: '−' + round(-tr.perDay, 2) + ' mg/L par jour sur les derniers relevés. Au rythme actuel, ' +
                  'tu passes sous le minimum dans ~' + Math.round(days) + ' jour' + (days >= 2 ? 's' : '') + '. ' +
                  'Souvent un signe de stabilisant insuffisant ou de filtration trop courte.' });
        }
      }
    }
    var trPh = trend('ph');
    if (t && trPh && Math.abs(trPh.perDay) > 0.08) {
      out.push({ level: 'info', icon: trPh.perDay > 0 ? '📈' : '📉', title: 'Le pH dérive',
        text: (trPh.perDay > 0 ? '+' : '') + round(trPh.perDay, 2) + ' par jour. Un pH qui bouge sans arrêt vient ' +
              'presque toujours d\'un TAC hors plage : corrige le TAC en premier, le pH se tiendra tout seul.' });
    }

    /* 4. Stock */
    S.stock.forEach(function (s) {
      if (s.low != null && s.qty <= s.low) {
        out.push({ level: s.qty <= 0 ? 'warn' : 'info', icon: '📦',
          title: (s.qty <= 0 ? 'Rupture : ' : 'Stock bas : ') + s.name,
          text: 'Il reste ' + Chem.fmtQty(s.qty, s.unit) + (s.low ? ' (seuil ' + Chem.fmtQty(s.low, s.unit) + ')' : '') + '.' });
      }
    });
    /* Le produit dont on a besoin tout de suite mais qu'on n'a pas */
    currentActions().forEach(function (a) {
      if (a.dose && !a.dose.inStock && a.prio <= 2) {
        out.push({ level: 'warn', icon: '🛒', title: 'Produit manquant : ' + a.dose.product.label,
          text: 'Nécessaire pour « ' + a.title.toLowerCase() +' ». Prévois-en ' + Chem.fmtQty(a.dose.qty, a.dose.unit) + '.' });
      }
    });

    /* 5. Remplissage */
    if (S.fill) {
      var rem = fillRemaining();
      out.push({ level: rem <= 0 ? 'warn' : 'info', icon: '🚰',
        title: rem <= 0 ? 'Remplissage terminé — coupe l\'eau' : 'Remplissage en cours',
        text: rem <= 0 ? 'Les ' + S.fill.volumeM3 + ' m³ prévus sont passés.'
                       : 'Encore ' + fmtDur(rem) + ' au débit de ' + S.fill.flow + ' L/min.' });
    }
    if (S.dilutionNotice) {
      var dn = S.dilutionNotice;
      var since = daysBetween(dn.date, now);
      if (since <= 4) {
        out.push({ level: 'warn', icon: '💧', title: 'Eau neuve : refaire un test',
          text: 'Tu as renouvelé environ ' + dn.share + ' % du bassin. Stabilisant, TAC et désinfectant ' +
                'ont été dilués d\'autant : contrôle-les avant de doser quoi que ce soit.' });
      } else {
        S.dilutionNotice = null;
        save();
      }
    }

    /* 6. Météo */
    if (WEATHER.days.length) {
      var hot = WEATHER.days.filter(function (d) { return d.tmax >= 30; });
      if (hot.length) {
        out.push({ level: 'info', icon: '🌡️', title: 'Chaleur annoncée (' + Math.round(hot[0].tmax) + ' °C)',
          text: 'Consommation de désinfectant en hausse et algues plus rapides. Allonge la filtration ' +
                '(≈ température de l\'eau ÷ 2, en heures) et contrôle le chlore un jour plus tôt que prévu.' });
      }
      var wet = WEATHER.days.filter(function (d) { return (d.rain || 0) >= 10; });
      if (wet.length) {
        out.push({ level: 'info', icon: '🌧️', title: 'Pluie soutenue prévue',
          text: 'Une grosse pluie dilue le TAC et fait chuter le pH, et l\'orage apporte des poussières. ' +
                'Prévois un contrôle pH/TAC après l\'épisode plutôt qu\'avant.' });
      }
      var uv = WEATHER.days[0] && WEATHER.days[0].uv;
      if (uv >= 8 && t && t.readings.cya != null && t.readings.cya < 20 && S.settings.mode !== 'brome') {
        out.push({ level: 'warn', icon: '☀️', title: 'UV forts, chlore non protégé',
          text: 'Indice UV ' + Math.round(uv) + ' avec seulement ' + t.readings.cya + ' mg/L de stabilisant : ' +
                'le chlore peut perdre la moitié de sa concentration dans la journée.' });
      }
    }

    /* 7. Saison */
    if (t && t.readings.temp != null) {
      if (t.readings.temp < 12) {
        out.push({ level: 'info', icon: '❄️', title: 'Température d\'hivernage',
          text: 'Sous 12 °C, l\'activité biologique s\'arrête : espace les tests et passe en hivernage ' +
                '(actif avec filtration réduite, ou passif bassin protégé).' });
      } else if (t.readings.temp >= 15 && t.readings.temp < 18 && S.tests.length < 3) {
        out.push({ level: 'info', icon: '🌱', title: 'Remise en route',
          text: 'C\'est la période où les algues démarrent. Un traitement choc puis une filtration continue ' +
                '24-48 h évitent l\'eau verte.' });
      }
    }

    return out;
  }

  function renderProactive() {
    var host = $('proactive');
    host.innerHTML = '';
    var list = computeProactive();
    if (!list.length) return;
    var box = el('div', 'proactive');
    list.forEach(function (a) {
      box.appendChild(el('div', 'alert ' + a.level,
        '<span class="alert-ico">' + a.icon + '</span>' +
        '<div><strong>' + esc(a.title) + '</strong><p>' + esc(a.text) + '</p></div>'));
    });
    host.appendChild(box);
  }

  /* ================================================================== */
  /* Minuteur de remplissage                                            */
  /* ================================================================== */
  /*
   * On ne mesure pas un débit, on le calcule : volume à ajouter ÷ débit du
   * tuyau. L'échéance est stockée en horodatage absolu, donc le minuteur reste
   * juste même si l'app est fermée ou le téléphone en veille — et la
   * notification de fin est programmée côté système, pas côté page.
   */

  var fillTick = 0;

  /* Millisecondes restantes, en tenant compte des pauses. */
  function fillRemaining() {
    var f = S.fill;
    if (!f) return 0;
    if (f.paused) return Math.max(0, f.durationMs - f.elapsedMs);
    return Math.max(0, f.durationMs - (f.elapsedMs + (Date.now() - f.resumedAt)));
  }

  function fmtDur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h) return h + ' h ' + (m < 10 ? '0' : '') + m + ' min';
    if (m) return m + ' min ' + (ss < 10 ? '0' : '') + ss + ' s';
    return ss + ' s';
  }

  /* Volume déjà entré dans le bassin, en m³. */
  function fillDone(f) {
    var frac = f.durationMs ? 1 - fillRemaining() / f.durationMs : 1;
    return round(f.volumeM3 * Math.min(1, Math.max(0, frac)), 2);
  }

  function renderFill() {
    var host = $('fillCard');
    host.innerHTML = '';
    var f = S.fill;

    if (!f) {
      var start = el('button', 'ghost wide', '🚰 Minuteur de remplissage');
      start.onclick = configureFill;
      host.appendChild(start);
      return;
    }

    var rem = fillRemaining();
    var done = rem <= 0;
    var card = el('div', 'card fill-card' + (done ? ' done' : ''));
    var pct = f.durationMs ? Math.min(100, Math.round((1 - rem / f.durationMs) * 100)) : 100;

    card.innerHTML =
      '<div class="fill-head"><h3>🚰 ' + (done ? 'Remplissage terminé' : (f.paused ? 'Remplissage en pause' : 'Remplissage en cours')) + '</h3>' +
      '<span class="fill-time">' + (done ? '✅' : fmtDur(rem)) + '</span></div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="muted small">' + fillDone(f) + ' / ' + f.volumeM3 + ' m³ · débit ' + f.flow + ' L/min' +
      (f.cm ? ' · +' + f.cm + ' cm' : '') + '</div>' +
      (done ? '<p class="tip">💧 Coupe l\'eau. Pense à refaire un test : l\'eau neuve dilue le stabilisant, ' +
              'le TAC et le désinfectant.</p>'
            : '<p class="muted small">Fin prévue vers ' +
              new Date(Date.now() + rem).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) +
              '. Ne laisse jamais un remplissage sans surveillance.</p>');

    var row = el('div', 'row-btns');
    if (!done) {
      var pb = el('button', 'ghost', f.paused ? '▶︎ Reprendre' : '⏸ Pause');
      pb.onclick = function () { f.paused ? resumeFill() : pauseFill(); };
      row.appendChild(pb);
    }
    var sb = el('button', 'ghost' + (done ? ' primary' : ''), done ? '✔︎ Terminé' : '⏹ Arrêter');
    sb.onclick = function () { stopFill(done); };
    row.appendChild(sb);
    card.appendChild(row);
    host.appendChild(card);

    /* Un seul intervalle, uniquement quand il y a quelque chose à décompter. */
    clearInterval(fillTick);
    if (!done && !f.paused) {
      fillTick = setInterval(function () {
        if (document.visibilityState !== 'visible') return;
        if (fillRemaining() <= 0) { onFillDone(); return; }
        renderFill();
      }, 1000);
    }
  }

  function onFillDone() {
    clearInterval(fillTick);
    renderFill();
    renderProactive();
  }

  function configureFill() {
    var refs = {};
    var s = S.settings;
    modal('Remplissage', function (body) {
      body.appendChild(el('p', 'muted small',
        'Le minuteur calcule la durée à partir du débit du tuyau et du volume à ajouter. ' +
        'Il continue de tourner app fermée, et te prévient à la fin.'));

      var f1 = el('label', 'fld', '<span>Débit du tuyau (L/min)</span>');
      refs.flow = el('input'); refs.flow.type = 'number'; refs.flow.step = '0.5';
      refs.flow.inputMode = 'decimal'; refs.flow.value = s.flow || 15;
      f1.appendChild(refs.flow); body.appendChild(f1);
      body.appendChild(el('p', 'muted small',
        'Pour le mesurer : remplis un seau de 10 L en chronométrant. 10 L en 40 s = 15 L/min.'));

      var f2 = el('label', 'fld', '<span>Ce que tu veux ajouter</span>');
      refs.kind = el('select');
      [['cm', 'Remonter le niveau de … cm'], ['m3', 'Ajouter … m³'], ['full', 'Remplir le bassin entier']]
        .forEach(function (o) { var e = el('option', null, o[1]); e.value = o[0]; refs.kind.appendChild(e); });
      f2.appendChild(refs.kind); body.appendChild(f2);

      var f3 = el('label', 'fld', '<span>Quantité</span>');
      refs.amount = el('input'); refs.amount.type = 'number'; refs.amount.step = '0.5';
      refs.amount.inputMode = 'decimal'; refs.amount.value = 3;
      f3.appendChild(refs.amount); body.appendChild(f3);

      var f4 = el('label', 'fld', '<span>Surface du bassin (m²)</span>');
      refs.surface = el('input'); refs.surface.type = 'number'; refs.surface.step = '0.5';
      refs.surface.inputMode = 'decimal';
      refs.surface.value = s.surface || '';
      refs.surface.placeholder = 'ex. 32';
      f4.appendChild(refs.surface); body.appendChild(f4);

      var est = el('p', 'msg', '');
      body.appendChild(est);

      function m3Wanted() {
        var k = refs.kind.value;
        var a = parseFloat(refs.amount.value) || 0;
        if (k === 'full') return s.volume || 0;
        if (k === 'm3') return a;
        var surf = parseFloat(refs.surface.value) || 0;
        return round(surf * a / 100, 2); // cm → m
      }
      function refresh() {
        var isCm = refs.kind.value === 'cm';
        f3.classList.toggle('hidden', refs.kind.value === 'full');
        f4.classList.toggle('hidden', !isCm);
        var v = m3Wanted();
        var fl = parseFloat(refs.flow.value) || 0;
        if (!v || !fl) { est.textContent = ''; return; }
        est.textContent = v + ' m³ à ' + fl + ' L/min → ' + fmtDur(v * 1000 / fl * 60000);
        est.className = 'msg good';
      }
      refs.kind.onchange = refresh;
      refs.amount.oninput = refresh;
      refs.flow.oninput = refresh;
      refs.surface.oninput = refresh;
      refresh();
      refs._m3 = m3Wanted;
    }, function () {
      var flow = parseFloat(refs.flow.value);
      var v = refs._m3();
      if (!flow || flow <= 0) { toast('Indique le débit du tuyau'); return undefined; }
      if (!v || v <= 0) { toast('Indique la quantité à ajouter'); return undefined; }
      return { flow: flow, volumeM3: v, kind: refs.kind.value,
               cm: refs.kind.value === 'cm' ? parseFloat(refs.amount.value) : null,
               surface: parseFloat(refs.surface.value) || null };
    }).then(function (res) {
      if (!res) return;
      S.settings.flow = res.flow;
      if (res.surface) S.settings.surface = res.surface;
      startFill(res);
    });
  }

  function startFill(res) {
    var durationMs = res.volumeM3 * 1000 / res.flow * 60000; // L ÷ (L/min) → min
    S.fill = {
      startedAt: Date.now(), resumedAt: Date.now(), elapsedMs: 0,
      durationMs: durationMs, paused: false,
      volumeM3: res.volumeM3, flow: res.flow, cm: res.cm,
    };
    save();
    scheduleFillNotif();
    renderFill();
    toast('Minuteur lancé — ' + fmtDur(durationMs));
    pushHA(true);
  }

  function pauseFill() {
    var f = S.fill;
    if (!f || f.paused) return;
    f.elapsedMs += Date.now() - f.resumedAt;
    f.paused = true;
    save();
    cancelFillNotif();
    renderFill();
  }

  function resumeFill() {
    var f = S.fill;
    if (!f || !f.paused) return;
    f.resumedAt = Date.now();
    f.paused = false;
    save();
    scheduleFillNotif();
    renderFill();
  }

  function stopFill(completed) {
    var f = S.fill;
    if (f) {
      var added = fillDone(f);
      if (added > 0) {
        S.treatments.push({
          id: uid(), date: new Date().toISOString(),
          title: 'Remplissage', param: 'eau',
          product: 'Eau neuve', qty: added, unit: 'm³',
        });
      }
      /* Un apport notable dilue tout : on le signale au prochain écran. */
      if (S.settings.volume && added / S.settings.volume >= 0.1) {
        S.dilutionNotice = { date: new Date().toISOString(), share: round(added / S.settings.volume * 100, 0) };
      }
    }
    S.fill = null;
    save();
    clearInterval(fillTick);
    cancelFillNotif();
    renderFill();
    renderProactive();
    if (completed) toast('Remplissage enregistré');
    pushHA(true);
  }

  function scheduleFillNotif() {
    var p = LN();
    var f = S.fill;
    if (!f || f.paused) return;
    var at = new Date(Date.now() + fillRemaining());
    if (!p) {
      /* Sans plugin natif (PWA) : minuterie en page, valable app ouverte. */
      clearTimeout(scheduleFillNotif._t);
      scheduleFillNotif._t = setTimeout(function () {
        notifyNow('Ma Piscine', 'Remplissage terminé — coupe l\'eau.');
      }, Math.max(1000, fillRemaining()));
      return;
    }
    p.schedule({ notifications: [{
      id: 1003, title: 'Ma Piscine — remplissage terminé',
      body: 'Les ' + f.volumeM3 + ' m³ sont passés. Coupe l\'eau, puis refais un test : l\'eau neuve dilue tout.',
      schedule: { at: at },
    }] }).catch(function () {});
  }

  function cancelFillNotif() {
    clearTimeout(scheduleFillNotif._t);
    var p = LN();
    if (p) p.cancel({ notifications: [{ id: 1003 }] }).catch(function () {});
  }

  /* ================================================================== */
  /* Notifications                                                      */
  /* ================================================================== */

  function LN() {
    var c = window.Capacitor;
    return c && c.Plugins && c.Plugins.LocalNotifications ? c.Plugins.LocalNotifications : null;
  }
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  function ensureNotifPerm() {
    var p = LN();
    if (p) return p.requestPermissions().then(function (r) { return r.display === 'granted'; });
    if (!('Notification' in window)) return Promise.resolve(false);
    if (Notification.permission === 'granted') return Promise.resolve(true);
    return Notification.requestPermission().then(function (r) { return r === 'granted'; });
  }

  function notifyNow(title, body) {
    var p = LN();
    if (p) {
      return p.schedule({ notifications: [{ id: Date.now() % 100000, title: title, body: body, schedule: { at: new Date(Date.now() + 1000) } }] });
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body: body, icon: 'img/icon-192.png' });
    } else {
      toast(title + ' — ' + body, 4000);
    }
    return Promise.resolve();
  }

  /* Programme le rappel du prochain test + les alertes qui ont une date. */
  function scheduleReminders() {
    var p = LN();
    if (!S.settings.notif || !p) return Promise.resolve();
    return p.getPending().then(function (pend) {
      var ids = (pend.notifications || []).map(function (n) { return { id: n.id }; });
      return ids.length ? p.cancel({ notifications: ids }) : null;
    }).then(function () {
      var hh = (S.settings.notifHour || '09:00').split(':');
      var when = nextTestDate();
      when.setHours(parseInt(hh[0], 10) || 9, parseInt(hh[1], 10) || 0, 0, 0);
      if (when < new Date()) when = new Date(Date.now() + 3600000);

      var notifs = [{
        id: 1001, title: 'Ma Piscine — test à faire',
        body: 'Dernier relevé il y a ' + testInterval() + ' jours. Un contrôle pH / désinfectant s\'impose.',
        schedule: { at: when },
      }];

      /* Rappel de rupture de stock, la veille du test. */
      var short = S.stock.filter(function (s) { return s.low != null && s.qty <= s.low; });
      if (short.length) {
        var w2 = new Date(when.getTime() - 86400000);
        if (w2 > new Date()) {
          notifs.push({
            id: 1002, title: 'Ma Piscine — stock bas',
            body: short.map(function (s) { return s.name; }).slice(0, 3).join(', ') +
                  ' : à racheter avant le prochain traitement.',
            schedule: { at: w2 },
          });
        }
      }
      return p.schedule({ notifications: notifs });
    }).catch(function () {});
  }

  /* ================================================================== */
  /* Onglet Test                                                        */
  /* ================================================================== */

  var testState = { method: 'photo', readings: {}, white: null, canvas: null, ctx: null,
                    queue: [], idx: 0, photoData: null, samples: {} };

  function modeParams() {
    var m = Chem.MODES.filter(function (x) { return x.id === S.settings.mode; })[0];
    return m ? m.params.slice() : ['ph', 'cl'];
  }
  /* Paramètres lisibles sur une bandelette (le sel se mesure autrement).
     Le chlore total ne sert à aucun dosage, mais les bandelettes 6-en-1 le
     portent : lu, il donne le chlore combiné (total − libre), qui est ce qui
     pique les yeux et sent fort. */
  function stripParams() {
    var ps = modeParams().filter(function (p) { return Strip.SCALES[p]; });
    if (/^(chlore|sel)$/.test(S.settings.mode) && ps.indexOf('clt') < 0) ps.push('clt');
    return ps;
  }

  function renderTestTab() {
    $('tempFromHA').classList.toggle('hidden', !(HA.enabled() && S.settings.haTempEnt));
    if (testState.method === 'manual') renderManualFields();
  }

  function renderManualFields() {
    var host = $('manualFields');
    host.innerHTML = '';
    var ps = modeParams().concat(['clt']);
    ps.forEach(function (p) {
      var d = Chem.PARAMS[p];
      if (!d) return;
      var t = Chem.targetFor(S.settings.mode, p, testState.readings);
      var lbl = el('label', 'fld');
      lbl.innerHTML = '<span>' + esc(d.label) + (d.unit ? ' (' + esc(d.unit) + ')' : '') +
        (t ? ' <em class="muted">cible ' + t[1] + '</em>' : '') + '</span>';
      var inp = el('input');
      inp.type = 'number'; inp.step = d.step; inp.inputMode = 'decimal';
      inp.placeholder = t ? String(t[1]) : '—';
      if (testState.readings[p] != null) inp.value = testState.readings[p];
      inp.oninput = function () {
        var v = parseFloat(inp.value);
        if (isNaN(v)) delete testState.readings[p]; else testState.readings[p] = v;
      };
      lbl.appendChild(inp);
      host.appendChild(lbl);
    });
  }

  /* --- Flux photo --------------------------------------------------- */

  function startPhoto(file) {
    Strip.loadToCanvas(file, 1000, function (err, cv, ctx) {
      if (err) { toast('Photo illisible'); return; }
      var out = $('stripCanvas');
      out.width = cv.width; out.height = cv.height;
      var octx = out.getContext('2d', { willReadFrequently: true });
      octx.drawImage(cv, 0, 0);
      testState.canvas = out; testState.ctx = octx;
      testState.photoData = cv.toDataURL('image/jpeg', 0.72);
      testState.samples = {}; testState.white = null;
      testState.queue = stripParams(); testState.idx = 0;
      $('marks').innerHTML = '';
      $('photoStart').classList.add('hidden');
      $('photoWork').classList.remove('hidden');
      updateTapHint();
      renderPads();
    });
  }

  function updateTapHint() {
    var h = $('tapHint');
    if (testState.whiteMode) {
      h.innerHTML = '⚪ Touche une <strong>zone blanche</strong> de la bandelette (le plastique, pas un carré coloré).';
      return;
    }
    var p = testState.queue[testState.idx];
    if (!p) {
      h.innerHTML = '✅ Toutes les plages sont lues. Corrige au besoin, puis enregistre.';
      return;
    }
    h.innerHTML = 'Touche la plage <strong>' + esc(Chem.PARAMS[p].label) + '</strong> sur la photo (' +
      (testState.idx + 1) + '/' + testState.queue.length + ').';
  }

  function canvasTap(ev) {
    var cv = testState.canvas;
    if (!cv) return;
    var rect = cv.getBoundingClientRect();
    var pt = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    var x = Math.round((pt.clientX - rect.left) * (cv.width / rect.width));
    var y = Math.round((pt.clientY - rect.top) * (cv.height / rect.height));
    var radius = Math.max(4, Math.round(Math.min(cv.width, cv.height) * 0.02));
    var rgb = Strip.sample(testState.ctx, x, y, radius);
    if (!rgb) return;

    if (testState.whiteMode) {
      testState.white = rgb;
      testState.whiteMode = false;
      recomputeAll();
      toast('Point blanc réglé — lectures recalculées');
      updateTapHint();
      return;
    }
    var p = testState.queue[testState.idx];
    if (!p) return;
    testState.samples[p] = { rgb: rgb, x: x / cv.width, y: y / cv.height };
    computeParam(p);
    addMark(p, x / cv.width, y / cv.height);
    testState.idx = Math.min(testState.queue.length, testState.idx + 1);
    updateTapHint();
    renderPads();
  }

  function addMark(param, rx, ry) {
    var wrap = $('marks');
    var old = wrap.querySelector('[data-p="' + param + '"]');
    if (old) old.remove();
    var m = el('span', 'mark');
    m.dataset.p = param;
    m.style.left = (rx * 100) + '%';
    m.style.top = (ry * 100) + '%';
    m.textContent = Chem.PARAMS[param].label.slice(0, 2);
    wrap.appendChild(m);
  }

  function computeParam(p) {
    var s = testState.samples[p];
    if (!s) return;
    var rgb = Strip.whiteBalance(s.rgb, testState.white);
    var m = Strip.match(p, rgb, S.calib[p]);
    if (!m) return;
    s.balanced = rgb;
    s.confidence = m.confidence;
    s.auto = Strip.snap(p, m.value);
    if (!s.edited) testState.readings[p] = s.auto;
  }

  function recomputeAll() {
    Object.keys(testState.samples).forEach(computeParam);
    renderPads();
  }

  function renderPads() {
    var host = $('padList');
    host.innerHTML = '';
    stripParams().forEach(function (p) {
      var d = Chem.PARAMS[p];
      var s = testState.samples[p];
      var card = el('div', 'pad' + (s ? '' : ' pending'));
      var sw = el('span', 'swatch');
      if (s) sw.style.background = Strip.css(s.balanced || s.rgb);
      card.appendChild(sw);

      var body = el('div', 'pad-body');
      var conf = s ? (s.confidence > 0.65 ? 'lecture sûre' : s.confidence > 0.35 ? 'lecture moyenne — vérifie' : 'lecture douteuse — corrige à la main') : 'pas encore lue';
      body.innerHTML = '<div class="pad-name">' + esc(d.label) + '</div>' +
        '<div class="pad-conf ' + (s ? (s.confidence > 0.65 ? 'good' : s.confidence > 0.35 ? 'mid' : 'bad') : '') + '">' + conf + '</div>';

      var inp = el('input', 'pad-input');
      inp.type = 'number'; inp.step = d.step; inp.inputMode = 'decimal';
      inp.value = testState.readings[p] != null ? testState.readings[p] : '';
      inp.placeholder = '—';
      inp.oninput = function () {
        var v = parseFloat(inp.value);
        if (isNaN(v)) { delete testState.readings[p]; }
        else { testState.readings[p] = v; if (s) s.edited = true; }
      };
      body.appendChild(inp);
      if (d.unit) body.appendChild(el('span', 'pad-unit', esc(d.unit)));
      card.appendChild(body);

      var re = el('button', 'ghost small-btn', s ? '↻' : '◎');
      re.title = 'Re-pointer cette plage';
      re.onclick = function () {
        testState.idx = testState.queue.indexOf(p);
        testState.whiteMode = false;
        updateTapHint();
        $('stripCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      card.appendChild(re);
      host.appendChild(card);
    });
  }

  /* --- Enregistrement ----------------------------------------------- */

  function saveTest() {
    var r = {};
    Object.keys(testState.readings).forEach(function (k) {
      if (testState.readings[k] != null && !isNaN(testState.readings[k])) r[k] = testState.readings[k];
    });
    var temp = parseFloat($('tempIn').value);
    if (!isNaN(temp)) r.temp = temp;

    if (!Object.keys(r).length) { $('testMsg').textContent = 'Aucune valeur saisie.'; return; }

    var test = {
      id: uid(), date: new Date().toISOString(), readings: r,
      note: $('noteIn').value.trim(), method: testState.method,
      photoId: null,
    };
    var chain = Promise.resolve();
    if (testState.method === 'photo' && testState.photoData) {
      test.photoId = 'ph_' + test.id;
      chain = putPhoto(test.photoId, testState.photoData);
    }
    chain.then(function () {
      S.tests.push(test);
      if (S.tests.length > 400) S.tests.splice(0, S.tests.length - 400);
      save();
      resetTestForm();
      toast('Test enregistré');
      showTab('home');
      scheduleReminders();
      pushHA(true);
    });
  }

  function resetTestForm() {
    testState.readings = {}; testState.samples = {}; testState.white = null;
    testState.photoData = null; testState.idx = 0; testState.whiteMode = false;
    $('photoStart').classList.remove('hidden');
    $('photoWork').classList.add('hidden');
    $('marks').innerHTML = '';
    $('padList').innerHTML = '';
    $('noteIn').value = '';
    $('testMsg').textContent = '';
    $('stripPhoto').value = '';
    renderManualFields();
  }

  /* ================================================================== */
  /* Stock + code-barres                                                */
  /* ================================================================== */

  function renderStock() {
    var host = $('stockList');
    host.innerHTML = '';
    if (!S.stock.length) {
      host.appendChild(el('div', 'card empty',
        '<p><strong>Stock vide.</strong></p><p class="muted small">Scanne le code-barres de tes bidons et boîtes : ' +
        'l\'app retiendra le produit et calculera ensuite les doses avec ce que tu as vraiment sous la main.</p>'));
    }
    S.stock.forEach(function (s) {
      var p = Chem.product(s.productId);
      var low = s.low != null && s.qty <= s.low;
      var card = el('div', 'card stock-item' + (low ? ' low' : ''));
      card.innerHTML =
        '<div class="stock-head"><h3>' + esc(s.name) + '</h3>' +
        '<span class="qty">' + esc(Chem.fmtQty(s.qty, s.unit)) + '</span></div>' +
        '<div class="muted small">' + esc(p ? p.label : 'Produit') +
        (s.strength ? ' · ' + s.strength + ' %' : '') +
        (s.barcode ? ' · code ' + esc(s.barcode) : '') +
        (low ? ' · <strong class="warn-txt">stock bas</strong>' : '') + '</div>';

      if (s.photoId) {
        var th = el('img', 'stock-thumb');
        th.alt = '';
        getPhoto(s.photoId).then(function (d) { if (d) th.src = d; });
        card.insertBefore(th, card.firstChild);
        card.classList.add('has-thumb');
      }
      var row = el('div', 'row-btns');
      [['−', -1], ['＋', 1]].forEach(function (b) {
        var btn = el('button', 'ghost small-btn', b[0]);
        btn.onclick = function () {
          var step = s.unit === 'galet' ? 1 : (s.qty >= 1000 ? 500 : 100);
          s.qty = Math.max(0, round(s.qty + b[1] * step, 2));
          save(); renderStock();
        };
        row.appendChild(btn);
      });
      var ed = el('button', 'ghost small-btn', '✏️');
      ed.onclick = function () { editStock(s); };
      row.appendChild(ed);
      var rm = el('button', 'ghost small-btn danger', '🗑');
      rm.onclick = function () {
        S.stock = S.stock.filter(function (x) { return x.id !== s.id; });
        save(); renderStock(); renderHome();
      };
      row.appendChild(rm);
      card.appendChild(row);
      host.appendChild(card);
    });
    $('stockHint').textContent = S.stock.length
      ? 'Les quantités se décrémentent automatiquement quand tu valides un traitement depuis l\'accueil.'
      : '';
  }

  /* ================================================================== */
  /* Recherche d'une référence sur internet                             */
  /* ================================================================== */
  /*
   * Aucune base ouverte ne couvre sérieusement les produits de piscine
   * français : Open Products Facts ne renvoie rien sur la catégorie, et
   * UPCitemdb est un catalogue américain. On interroge quand même les deux
   * (c'est gratuit, sans compte, et ça dépanne sur les marques distribuées
   * à l'international), et à défaut on renvoie l'utilisateur vers une
   * recherche web sur le code-barres : lire l'étiquette reste le moyen le
   * plus fiable de connaître la concentration réelle.
   */
  var LOOKUP_SOURCES = [
    { name: 'Open Products Facts',
      url: function (c) { return 'https://world.openproductsfacts.org/api/v2/product/' + c + '.json'; },
      parse: function (j) {
        var p = j && j.product;
        if (!p || j.status === 0) return null;
        return { name: [p.brands, p.product_name, p.quantity].filter(Boolean).join(' ') };
      } },
    { name: 'Open Food Facts',
      url: function (c) { return 'https://world.openfoodfacts.org/api/v2/product/' + c + '.json'; },
      parse: function (j) {
        var p = j && j.product;
        if (!p || j.status === 0) return null;
        return { name: [p.brands, p.product_name, p.quantity].filter(Boolean).join(' ') };
      } },
    { name: 'UPCitemdb',
      url: function (c) { return 'https://api.upcitemdb.com/prod/trial/lookup?upc=' + c; },
      parse: function (j) {
        var it = j && j.items && j.items[0];
        if (!it) return null;
        return { name: [it.brand, it.title].filter(Boolean).join(' ') };
      } },
  ];

  function lookupBarcode(code) {
    var i = 0;
    function next() {
      if (i >= LOOKUP_SOURCES.length) return Promise.resolve(null);
      var src = LOOKUP_SOURCES[i++];
      return fetch(src.url(code))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var hit = src.parse(j);
          if (hit && hit.name) { hit.source = src.name; return hit; }
          return next();
        })
        .catch(function () { return next(); });
    }
    return next();
  }

  function webSearchUrl(code, name) {
    var q = (name ? name + ' ' : '') + code + ' piscine concentration';
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(q.trim());
  }

  /* Formulaire produit, partagé par l'ajout et l'édition. */
  function editStock(existing, barcode) {
    var s = existing || { id: uid(), name: '', productId: 'chlore_choc', qty: 0, unit: 'g', low: null, barcode: barcode || null };
    var refs = {};
    return modal(existing ? 'Modifier le produit' : 'Nouveau produit', function (body) {
      var f1 = el('label', 'fld', '<span>Nom (tel qu\'écrit sur l\'emballage)</span>');
      var nameRow = el('span', 'fld-row');
      refs.name = el('input'); refs.name.type = 'text'; refs.name.value = s.name;
      refs.name.placeholder = 'ex. HTH chlore choc 5 kg';
      nameRow.appendChild(refs.name);

      /* Recherche en ligne : utile surtout pour retrouver le nom exact d'un
         bidon dont on n'a plus l'étiquette lisible. */
      var btnNet = el('button', 'ghost small-btn', '🌐');
      btnNet.type = 'button';
      btnNet.title = 'Chercher cette référence sur internet';
      btnNet.onclick = function () {
        var code = s.barcode;
        var typed = refs.name.value.trim();
        if (!code && !typed) { toast('Scanne le code-barres ou tape un nom'); return; }
        if (!code) { window.open(webSearchUrl('', typed), '_blank'); return; }
        btnNet.textContent = '…'; btnNet.disabled = true;
        lookupBarcode(code).then(function (hit) {
          btnNet.textContent = '🌐'; btnNet.disabled = false;
          if (hit) {
            refs.name.value = hit.name;
            toast('Trouvé via ' + hit.source + ' — vérifie la concentration');
          } else {
            toast('Introuvable dans les bases ouvertes — recherche web');
            window.open(webSearchUrl(code, typed), '_blank');
          }
        });
      };
      nameRow.appendChild(btnNet);
      f1.appendChild(nameRow); body.appendChild(f1);

      var f2 = el('label', 'fld', '<span>Type de produit</span>');
      refs.pid = el('select');
      Chem.PRODUCTS.forEach(function (p) {
        var o = el('option', null, esc(p.label));
        o.value = p.id;
        if (p.id === s.productId) o.selected = true;
        refs.pid.appendChild(o);
      });
      f2.appendChild(refs.pid); body.appendChild(f2);

      var f3 = el('label', 'fld', '<span>Quantité restante</span>');
      var row = el('span', 'fld-row');
      refs.qty = el('input'); refs.qty.type = 'number'; refs.qty.step = '1'; refs.qty.inputMode = 'decimal'; refs.qty.value = s.qty || '';
      refs.unit = el('select');
      ['g', 'mL', 'galet'].forEach(function (u) {
        var o = el('option', null, u === 'galet' ? 'galets' : u);
        o.value = u; if (u === s.unit) o.selected = true;
        refs.unit.appendChild(o);
      });
      row.appendChild(refs.qty); row.appendChild(refs.unit);
      f3.appendChild(row); body.appendChild(f3);

      /* Concentration réelle : sans elle, on dose au titre générique du
         catalogue, qui peut être 20 % à côté du bidon qu'on a en main. */
      var fc = el('label', 'fld', '<span>Concentration <span id="strLbl" class="muted"></span></span>');
      refs.strength = el('input'); refs.strength.type = 'number';
      refs.strength.step = '0.1'; refs.strength.inputMode = 'decimal';
      refs.strength.value = s.strength != null ? s.strength : '';
      fc.appendChild(refs.strength); body.appendChild(fc);

      /* Photo de l'emballage : bien plus fiable qu'un nom pour retrouver la
         concentration ou le dosage six mois plus tard, et ça évite d'aller
         chercher une image de catalogue sur internet. */
      var fp = el('label', 'fld', '<span>Photo de l\'emballage</span>');
      var pRow = el('span', 'fld-row');
      var pPrev = el('img', 'stock-thumb');
      pPrev.alt = '';
      if (!s.photoId) pPrev.classList.add('hidden');
      else getPhoto(s.photoId).then(function (d) { if (d) pPrev.src = d; });
      var pBtn = el('label', 'ghost small-btn file-btn', '📷');
      pBtn.title = 'Photographier l\'étiquette';
      var pIn = el('input'); pIn.type = 'file'; pIn.accept = 'image/*';
      pIn.capture = 'environment'; pIn.hidden = true;
      pIn.onchange = function () {
        var f = this.files && this.files[0];
        if (!f) return;
        Strip.loadToCanvas(f, 480, function (err, cv) {
          if (err) { toast('Image illisible'); return; }
          refs.photoData = cv.toDataURL('image/jpeg', 0.7);
          pPrev.src = refs.photoData;
          pPrev.classList.remove('hidden');
        });
      };
      pBtn.appendChild(pIn);
      pRow.appendChild(pPrev); pRow.appendChild(pBtn);
      fp.appendChild(pRow); body.appendChild(fp);

      var f4 = el('label', 'fld', '<span>Alerte quand il reste moins de</span>');
      refs.low = el('input'); refs.low.type = 'number'; refs.low.step = '1'; refs.low.inputMode = 'decimal';
      refs.low.value = s.low != null ? s.low : '';
      refs.low.placeholder = 'ex. 500';
      f4.appendChild(refs.low); body.appendChild(f4);

      var note = el('p', 'muted small', '');
      function syncNote() {
        var p = Chem.product(refs.pid.value);
        note.textContent = p && p.note ? p.note : '';
        if (p && !existing) refs.unit.value = p.unit;
        /* Le libellé et le repère de concentration dépendent du type choisi. */
        var lbl = body.querySelector('#strLbl');
        if (lbl) lbl.textContent = p && p.strengthLabel ? '— ' + p.strengthLabel : '';
        fc.classList.toggle('hidden', !(p && p.refStrength));
        refs.strength.placeholder = p && p.refStrength ? 'défaut ' + p.refStrength : '';
      }
      refs.pid.onchange = syncNote; syncNote();
      body.appendChild(note);
      if (s.barcode) body.appendChild(el('p', 'muted small', 'Code-barres : ' + esc(s.barcode)));
    }, function () {
      var name = refs.name.value.trim();
      if (!name) { toast('Donne un nom au produit'); return undefined; }
      s.name = name;
      s.productId = refs.pid.value;
      s.qty = parseFloat(refs.qty.value) || 0;
      s.unit = refs.unit.value;
      var str = parseFloat(refs.strength.value);
      s.strength = isNaN(str) || str <= 0 ? null : str;
      var low = parseFloat(refs.low.value);
      s.low = isNaN(low) ? null : low;
      return s;
    }).then(function (res) {
      if (!res) return null;
      if (!existing) S.stock.push(res);
      if (refs.photoData) {
        res.photoId = res.photoId || ('st_' + res.id);
        putPhoto(res.photoId, refs.photoData);
      }
      if (res.barcode) {
        /* Mémorisation : ce code-barres désignera ce produit la prochaine fois. */
        S.barcodes[res.barcode] = { name: res.name, productId: res.productId, unit: res.unit, low: res.low, strength: res.strength };
      }
      save(); renderStock(); renderHome();
      return res;
    });
  }

  /* --- Scanner ------------------------------------------------------ */

  var scan = { stream: null, det: null, raf: 0, running: false };

  function startScan() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      manualBarcode(); return;
    }
    $('scanner').classList.remove('hidden');
    $('scanMsg').textContent = 'Vise le code-barres du bidon…';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (stream) {
        scan.stream = stream;
        var v = $('scanVideo');
        v.srcObject = stream;
        v.play();
        scan.running = true;
        if ('BarcodeDetector' in window) {
          scan.det = new window.BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'],
          });
          tickScan();
        } else {
          $('scanMsg').innerHTML = 'Ce téléphone ne sait pas décoder les codes-barres depuis le navigateur. ' +
            'Utilise « Saisir le code » (les chiffres sous les barres).';
        }
      })
      .catch(function () {
        $('scanMsg').textContent = 'Caméra indisponible — saisis le code à la main.';
      });
  }

  function tickScan() {
    if (!scan.running || !scan.det) return;
    var v = $('scanVideo');
    scan.det.detect(v).then(function (codes) {
      if (codes && codes.length) {
        var code = codes[0].rawValue;
        stopScan();
        handleBarcode(code);
        return;
      }
      scan.raf = requestAnimationFrame(tickScan);
    }).catch(function () {
      scan.raf = requestAnimationFrame(tickScan);
    });
  }

  function stopScan() {
    scan.running = false;
    cancelAnimationFrame(scan.raf);
    if (scan.stream) { scan.stream.getTracks().forEach(function (t) { t.stop(); }); scan.stream = null; }
    $('scanVideo').srcObject = null;
    $('scanner').classList.add('hidden');
  }

  function manualBarcode() {
    var inp;
    modal('Code-barres', function (body) {
      body.appendChild(el('p', 'muted small', 'Saisis les chiffres imprimés sous les barres.'));
      inp = el('input'); inp.type = 'number'; inp.inputMode = 'numeric'; inp.placeholder = '3401560123456';
      body.appendChild(inp);
    }, function () {
      var v = (inp.value || '').trim();
      if (!v) return undefined;
      return v;
    }).then(function (code) { if (code) handleBarcode(code); });
  }

  /* Base locale qui apprend : un code inconnu est nommé une fois, puis reconnu. */
  function handleBarcode(code) {
    var known = S.barcodes[code];
    var inStock = S.stock.filter(function (s) { return s.barcode === code; })[0];

    if (inStock) {
      toast('Déjà en stock : ' + inStock.name);
      editStock(inStock);
      return;
    }
    if (known) {
      var item = { id: uid(), name: known.name, productId: known.productId,
                   qty: 0, unit: known.unit || 'g', low: known.low != null ? known.low : null,
                   strength: known.strength != null ? known.strength : null, barcode: code };
      S.stock.push(item);
      save();
      toast('Produit reconnu : ' + known.name);
      editStock(item);
      return;
    }
    toast('Code inconnu — dis-moi ce que c\'est');
    editStock(null, code);
  }

  /* ================================================================== */
  /* Suivi                                                              */
  /* ================================================================== */

  function renderHist() {
    renderHistTests();
    renderHistTreat();
    renderChart();
  }

  function renderHistTests() {
    var host = $('histTests');
    host.innerHTML = '';
    if (!S.tests.length) { host.appendChild(el('div', 'card empty', '<p class="muted">Aucun test enregistré.</p>')); return; }
    S.tests.slice().reverse().slice(0, 60).forEach(function (t) {
      var card = el('div', 'card test-row');
      var ps = Object.keys(t.readings).filter(function (k) { return k !== 'temp'; });
      var chips = ps.map(function (p) {
        var st = Chem.status(S.settings.mode, p, t.readings[p], t.readings);
        return '<span class="chip ' + st.level + '">' + esc(Chem.PARAMS[p] ? Chem.PARAMS[p].label : p) +
               ' ' + round(t.readings[p], Chem.PARAMS[p] ? Chem.PARAMS[p].dec : 1) + '</span>';
      }).join('');
      card.innerHTML = '<div class="test-date">' + fmtDate(t.date) +
        (t.readings.temp != null ? ' · ' + t.readings.temp + ' °C' : '') + '</div>' +
        '<div class="chips">' + chips + '</div>' +
        (t.note ? '<p class="muted small">' + esc(t.note) + '</p>' : '');
      if (t.photoId) {
        var b = el('button', 'ghost small-btn', '🖼 Photo');
        b.onclick = function () {
          getPhoto(t.photoId).then(function (d) {
            if (!d) { toast('Photo introuvable'); return; }
            modal('Photo du ' + fmtDate(t.date), function (body) {
              var im = el('img', 'modal-img'); im.src = d; body.appendChild(im);
            });
          });
        };
        card.appendChild(b);
      }
      var del = el('button', 'ghost small-btn danger', '🗑');
      del.onclick = function () {
        S.tests = S.tests.filter(function (x) { return x.id !== t.id; });
        delPhoto(t.photoId); save(); renderHist(); renderHome();
      };
      card.appendChild(del);
      host.appendChild(card);
    });
  }

  function renderHistTreat() {
    var host = $('histTreat');
    host.innerHTML = '';
    if (!S.treatments.length) {
      host.appendChild(el('div', 'card empty', '<p class="muted">Aucun traitement enregistré. ' +
        'Valide une action depuis l\'accueil pour la voir apparaître ici.</p>'));
      return;
    }
    S.treatments.slice().reverse().slice(0, 80).forEach(function (t) {
      host.appendChild(el('div', 'card treat-row',
        '<div class="test-date">' + fmtDate(t.date) + '</div>' +
        '<div><strong>' + esc(t.title) + '</strong></div>' +
        '<div class="muted small">' + esc(t.product) +
        (t.qty ? ' · ' + esc(Chem.fmtQty(t.qty, t.unit)) : '') + '</div>'));
    });
  }

  /* Courbes : une par paramètre, tracées à la main sur canvas (pas de lib). */
  function renderChart() {
    var host = $('histChart');
    host.innerHTML = '';
    var params = modeParams().filter(function (p) {
      return S.tests.filter(function (t) { return t.readings[p] != null; }).length >= 2;
    });
    if (!params.length) {
      host.appendChild(el('div', 'card empty', '<p class="muted">Il faut au moins deux tests pour tracer une courbe.</p>'));
      return;
    }
    params.forEach(function (p) {
      var d = Chem.PARAMS[p];
      var pts = S.tests.filter(function (t) { return t.readings[p] != null; }).slice(-30);
      var card = el('div', 'card chart-card');
      card.appendChild(el('h3', null, esc(d.label) + (d.unit ? ' <span class="muted small">' + esc(d.unit) + '</span>' : '')));
      var cv = el('canvas', 'chart');
      var W = 600, H = 180;
      cv.width = W; cv.height = H;
      card.appendChild(cv);
      host.appendChild(card);

      var ctx = cv.getContext('2d');
      var vals = pts.map(function (t) { return t.readings[p]; });
      var tgt = Chem.targetFor(S.settings.mode, p, pts[pts.length - 1].readings);
      var lo = Math.min.apply(null, vals.concat(tgt ? [tgt[0]] : []));
      var hi = Math.max.apply(null, vals.concat(tgt ? [tgt[2]] : []));
      var pad = (hi - lo) * 0.15 || 1;
      lo -= pad; hi += pad;
      var x = function (i) { return 34 + i * (W - 46) / Math.max(1, pts.length - 1); };
      var y = function (v) { return H - 22 - (v - lo) / (hi - lo) * (H - 40); };

      /* Bande de la plage cible */
      if (tgt) {
        ctx.fillStyle = 'rgba(56,232,200,.13)';
        ctx.fillRect(34, y(tgt[2]), W - 46, Math.max(2, y(tgt[0]) - y(tgt[2])));
      }
      /* Axes */
      ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(34, 8); ctx.lineTo(34, H - 20); ctx.lineTo(W - 8, H - 20); ctx.stroke();
      ctx.fillStyle = 'rgba(210,230,245,.65)'; ctx.font = '12px system-ui';
      ctx.fillText(round(hi, d.dec), 2, 16);
      ctx.fillText(round(lo, d.dec), 2, H - 24);
      /* Courbe */
      ctx.strokeStyle = '#38e8c8'; ctx.lineWidth = 2.2;
      ctx.beginPath();
      pts.forEach(function (t, i) {
        var px = x(i), py = y(t.readings[p]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      pts.forEach(function (t, i) {
        var st = Chem.status(S.settings.mode, p, t.readings[p], t.readings);
        ctx.fillStyle = st.level === 'ok' ? '#38e8c8' : (st.level.indexOf('crit') === 0 ? '#ff6b6b' : '#ffb648');
        ctx.beginPath(); ctx.arc(x(i), y(t.readings[p]), 3.4, 0, 6.3); ctx.fill();
      });
      /* Dates extrêmes */
      ctx.fillStyle = 'rgba(210,230,245,.55)';
      var f = function (iso) { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }); };
      ctx.fillText(f(pts[0].date), 34, H - 6);
      var lastLbl = f(pts[pts.length - 1].date);
      ctx.fillText(lastLbl, W - 8 - ctx.measureText(lastLbl).width, H - 6);
    });
  }

  /* ================================================================== */
  /* Home Assistant                                                     */
  /* ================================================================== */

  function pushHA(auto) {
    if (!HA.enabled()) return Promise.resolve(null);
    if (auto && !S.settings.haAuto) return Promise.resolve(null);
    var t = lastTest();
    if (!t && !S.fill) return Promise.resolve(null);
    return HA.publish({
      mode: S.settings.mode, volume: S.settings.volume, readings: t ? t.readings : {},
      actions: currentActions(), stock: S.stock,
      nextTest: t ? nextTestDate().toISOString() : null,
      filtrationH: t ? Chem.filtrationHours(t.readings.temp) : null,
      fill: S.fill ? { remainingMin: Math.round(fillRemaining() / 60000),
                       volumeM3: S.fill.volumeM3, paused: !!S.fill.paused } : null,
    }).then(function (res) {
      setHaDot(res.ok ? 'ok' : 'err');
      if (!auto) {
        $('haMsg').textContent = res.ok
          ? res.sent + ' entité(s) publiée(s) dans Home Assistant.'
          : 'Échec : ' + (res.errors[0] || 'inconnu');
        $('haMsg').className = 'msg ' + (res.ok ? 'good' : 'bad');
      }
      return res;
    }, function (e) {
      setHaDot('err');
      if (!auto) { $('haMsg').textContent = e.message; $('haMsg').className = 'msg bad'; }
      return null;
    });
  }

  function setHaDot(state) {
    var d = $('haDot');
    d.className = 'ha-dot ' + (state || '');
    d.title = state === 'ok' ? 'Home Assistant : connecté' :
              state === 'err' ? 'Home Assistant : erreur' : 'Home Assistant : non configuré';
  }

  function loadHaEntities() {
    if (!HA.enabled()) return;
    HA.temperatureSensors().then(function (list) {
      fillSelect($('haTempEnt'), list.map(function (s) {
        return { v: s.id, t: s.name + ' (' + s.value + s.unit + ')' };
      }), S.settings.haTempEnt);
    }).catch(function () {});
    HA.pumpEntities().then(function (list) {
      fillSelect($('haPumpEnt'), list.map(function (s) { return { v: s.id, t: s.name }; }), S.settings.haPumpEnt);
    }).catch(function () {});
  }

  function fillSelect(sel, items, current) {
    sel.innerHTML = '<option value="">— aucune —</option>';
    items.forEach(function (i) {
      var o = el('option', null, esc(i.t));
      o.value = i.v;
      if (i.v === current) o.selected = true;
      sel.appendChild(o);
    });
  }

  /* ================================================================== */
  /* Calibration des bandelettes                                        */
  /* ================================================================== */

  function renderCalib() {
    var host = $('calibList');
    host.innerHTML = '';
    stripParams().forEach(function (p) {
      var d = Chem.PARAMS[p];
      var custom = S.calib[p];
      var row = el('div', 'calib-row');
      row.innerHTML = '<span>' + esc(d.label) + '</span>' +
        '<em class="muted small">' + (custom ? custom.length + ' niveaux calibrés' : 'échelle par défaut') + '</em>';
      var b = el('button', 'ghost small-btn', custom ? '↻' : '🎯');
      b.onclick = function () { calibrate(p); };
      row.appendChild(b);
      if (custom) {
        var r = el('button', 'ghost small-btn danger', '🗑');
        r.onclick = function () { delete S.calib[p]; save(); renderCalib(); };
        row.appendChild(r);
      }
      host.appendChild(row);
    });
  }

  /* Calibration : on photographie le nuancier du tube, puis on pointe chaque
     niveau dans l'ordre croissant. Les couleurs relevées remplacent l'échelle. */
  function calibrate(param) {
    var levels = (Strip.SCALES[param] || []).map(function (s) { return s[0]; });
    var picked = [];
    var input = el('input');
    input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (!f) return;
      Strip.loadToCanvas(f, 900, function (err, cv) {
        if (err) { toast('Photo illisible'); return; }
        modal('Calibrer : ' + Chem.PARAMS[param].label, function (body) {
          body.appendChild(el('p', 'muted small',
            'Touche successivement chaque case du nuancier, de la plus faible à la plus forte : ' +
            levels.join(', ') + '.'));
          var wrap = el('div', 'canvas-wrap');
          var out = el('canvas');
          out.width = cv.width; out.height = cv.height;
          var ctx = out.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(cv, 0, 0);
          wrap.appendChild(out);
          body.appendChild(wrap);
          var status = el('p', 'msg', 'Niveau à pointer : ' + levels[0]);
          body.appendChild(status);
          var strip = el('div', 'calib-swatches');
          body.appendChild(strip);

          out.onclick = function (ev) {
            if (picked.length >= levels.length) return;
            var rect = out.getBoundingClientRect();
            var x = Math.round((ev.clientX - rect.left) * (out.width / rect.width));
            var y = Math.round((ev.clientY - rect.top) * (out.height / rect.height));
            var rgb = Strip.sample(ctx, x, y, Math.max(4, Math.round(out.width * 0.015)));
            if (!rgb) return;
            picked.push([levels[picked.length], rgb]);
            var sw = el('span', 'swatch small');
            sw.style.background = Strip.css(rgb);
            sw.title = String(picked[picked.length - 1][0]);
            strip.appendChild(sw);
            status.textContent = picked.length >= levels.length
              ? 'Tous les niveaux sont pointés — valide pour enregistrer.'
              : 'Niveau à pointer : ' + levels[picked.length];
          };
        }, function () {
          if (picked.length < 3) { toast('Pointe au moins 3 niveaux'); return undefined; }
          return picked;
        }).then(function (res) {
          if (!res) return;
          S.calib[param] = res;
          save();
          renderCalib();
          $('calibMsg').textContent = Chem.PARAMS[param].label + ' : ' + res.length + ' niveaux enregistrés.';
          $('calibMsg').className = 'msg good';
        });
      });
    };
    input.click();
  }

  /* ================================================================== */
  /* Réglages                                                           */
  /* ================================================================== */

  function renderSettings() {
    var s = S.settings;
    var sel = $('setMode');
    sel.innerHTML = '';
    Chem.MODES.forEach(function (m) {
      var o = el('option', null, esc(m.label));
      o.value = m.id;
      if (m.id === s.mode) o.selected = true;
      sel.appendChild(o);
    });
    $('setVolume').value = s.volume;
    $('setFreq').value = s.freq;
    var fsel = $('setFilter');
    fsel.innerHTML = '';
    Chem.FILTERS.forEach(function (f) {
      var o = el('option', null, esc(f.label + ' — ' + f.microns + ' µm'));
      o.value = f.id;
      if (f.id === s.filter) o.selected = true;
      fsel.appendChild(o);
    });
    $('setPumpW').value = s.pumpW || '';
    $('setKwhPrice').value = s.kwhPrice || '';
    $('setNotif').checked = !!s.notif;
    $('setWeather').checked = !!s.weather;
    $('setNotifHour').value = s.notifHour;
    $('haUrl').value = (HA.cfg().url || '');
    $('haToken').value = (HA.cfg().token || '');
    $('haAuto').checked = !!s.haAuto;
    $('aboutVer').textContent = 'Version ' + APP_VERSION;
    $('geoMsg').textContent = s.lat != null ? 'Position enregistrée (' + round(s.lat, 2) + ', ' + round(s.lon, 2) + ')' : '';
    renderCalib();
    loadHaEntities();
  }

  function bindSettings() {
    $('setMode').onchange = function () { S.settings.mode = this.value; save(); renderManualFields(); renderHome(); renderCalib(); };
    $('setVolume').oninput = function () { S.settings.volume = parseFloat(this.value) || 0; save(); };
    $('setFreq').onchange = function () { S.settings.freq = this.value; save(); scheduleReminders(); renderHome(); };
    $('setFilter').onchange = function () { S.settings.filter = this.value; save(); renderHome(); renderStock(); };
    $('setPumpW').oninput = function () { S.settings.pumpW = parseFloat(this.value) || 0; save(); renderHome(); };
    $('setKwhPrice').oninput = function () { S.settings.kwhPrice = parseFloat(this.value) || 0; save(); renderHome(); };
    $('pumpFromHA').onclick = function () {
      HA.getState('input_number.piscine_puissance_w').then(function (st) {
        var w = st && parseFloat(st.state);
        if (!w) return toast('Puissance introuvable dans Home Assistant');
        S.settings.pumpW = w; save(); renderSettings(); renderHome();
        toast('Puissance pompe : ' + w + ' W');
      });
    };
    $('setNotifHour').onchange = function () { S.settings.notifHour = this.value; save(); scheduleReminders(); };
    $('setWeather').onchange = function () {
      S.settings.weather = this.checked; save();
      if (this.checked && S.settings.lat == null) askGeo();
      else loadWeather().then(renderProactive);
    };
    $('setNotif').onchange = function () {
      var on = this.checked;
      var cb = this;
      if (!on) { S.settings.notif = false; save(); return; }
      ensureNotifPerm().then(function (ok) {
        S.settings.notif = ok; cb.checked = ok; save();
        if (ok) { scheduleReminders(); toast('Rappels activés'); }
        else toast('Autorisation refusée');
      });
    };
    $('btnGeo').onclick = askGeo;
    $('btnTestNotif').onclick = function () {
      ensureNotifPerm().then(function (ok) {
        if (!ok) { toast('Autorisation refusée'); return; }
        notifyNow('Ma Piscine', 'Voilà à quoi ressembleront les rappels.');
      });
    };

    $('volHelper').onclick = function () { $('volCalc').classList.toggle('hidden'); };
    $('vcApply').onclick = function () {
      var L = parseFloat($('vcL').value) || 0, W = parseFloat($('vcW').value) || 0, D = parseFloat($('vcD').value) || 0;
      var shape = $('vcShape').value;
      var v = shape === 'round' ? Math.PI * Math.pow(L / 2, 2) * D
            : shape === 'oval' ? Math.PI * (L / 2) * (W / 2) * D
            : L * W * D;
      v = Math.round(v * 10) / 10;
      if (!v) { toast('Renseigne les dimensions'); return; }
      S.settings.volume = v;
      S.settings.surface = round(shape === 'round' ? Math.PI * Math.pow(L / 2, 2)
                               : shape === 'oval' ? Math.PI * (L / 2) * (W / 2) : L * W, 1);
      save();
      $('setVolume').value = v;
      $('volCalc').classList.add('hidden');
      toast('Volume : ' + v + ' m³');
    };

    function saveHa() {
      HA.saveCfg({ url: $('haUrl').value.trim(), token: $('haToken').value.trim() });
      setHaDot(HA.enabled() ? '' : null);
    }
    $('haUrl').onchange = saveHa;
    $('haToken').onchange = saveHa;
    $('haAuto').onchange = function () { S.settings.haAuto = this.checked; save(); };
    $('haTempEnt').onchange = function () { S.settings.haTempEnt = this.value; save(); renderTestTab(); };
    $('haPumpEnt').onchange = function () { S.settings.haPumpEnt = this.value; save(); };
    $('haTest').onclick = function () {
      saveHa();
      $('haMsg').textContent = 'Connexion…'; $('haMsg').className = 'msg';
      HA.ping().then(function (m) {
        $('haMsg').textContent = 'Connecté ✅ (' + m + ')'; $('haMsg').className = 'msg good';
        setHaDot('ok'); loadHaEntities();
      }, function (e) {
        $('haMsg').textContent = 'Échec : ' + e.message; $('haMsg').className = 'msg bad';
        setHaDot('err');
      });
    };
    $('haPush').onclick = function () { saveHa(); pushHA(false); };

    $('btnExport').onclick = exportData;
    $('fileImport').onchange = function () { if (this.files[0]) importData(this.files[0]); };
    $('btnWipe').onclick = function () {
      modal('Tout effacer ?', function (b) {
        b.appendChild(el('p', null, 'Tests, photos, stock et traitements seront supprimés du téléphone. ' +
          'Les capteurs déjà publiés dans Home Assistant, eux, resteront.'));
        b.appendChild(el('p', 'muted small', 'Pense à exporter avant si tu veux garder une trace.'));
      }, function () { return true; }).then(function (ok) {
        if (!ok) return;
        localStorage.removeItem(KEY);
        indexedDB.deleteDatabase('piscine');
        S = load();
        save(); renderSettings(); renderHome(); renderStock(); renderHist();
        toast('Données effacées');
      });
    };
  }

  function askGeo() {
    if (!navigator.geolocation) { $('geoMsg').textContent = 'Géolocalisation indisponible.'; return; }
    $('geoMsg').textContent = 'Localisation…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      S.settings.lat = pos.coords.latitude;
      S.settings.lon = pos.coords.longitude;
      S.settings.weather = true;
      $('setWeather').checked = true;
      save();
      $('geoMsg').textContent = 'Position enregistrée (' + round(S.settings.lat, 2) + ', ' + round(S.settings.lon, 2) + ')';
      WEATHER.fetchedAt = 0;
      loadWeather().then(renderProactive);
    }, function () {
      $('geoMsg').textContent = 'Position refusée ou indisponible.';
    }, { timeout: 10000, maximumAge: 600000 });
  }

  function exportData() {
    var blob = new Blob([JSON.stringify({ app: 'ma-piscine', version: APP_VERSION, data: S }, null, 2)],
      { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ma-piscine-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function importData(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var j = JSON.parse(fr.result);
        var d = j.data || j;
        if (!d.settings || !d.tests) throw new Error('format');
        S = d;
        save();
        renderSettings(); renderHome(); renderStock(); renderHist();
        toast('Données importées');
      } catch (e) {
        toast('Fichier illisible');
      }
    };
    fr.readAsText(file);
  }

  /* ================================================================== */
  /* Démarrage                                                          */
  /* ================================================================== */

  function bind() {
    [].forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.onclick = function () { showTab(t.dataset.tab); };
    });
    $('goTest').onclick = function () { showTab('test'); };
    $('haDot').onclick = function () { showTab('set'); setTimeout(function () { $('haUrl').scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60); };

    [].forEach.call(document.querySelectorAll('#testMode .seg-btn'), function (b) {
      b.onclick = function () {
        [].forEach.call(document.querySelectorAll('#testMode .seg-btn'), function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        testState.method = b.dataset.m;
        $('photoFlow').classList.toggle('hidden', b.dataset.m !== 'photo');
        $('manualFlow').classList.toggle('hidden', b.dataset.m !== 'manual');
        if (b.dataset.m === 'manual') renderManualFields();
      };
    });
    [].forEach.call(document.querySelectorAll('#histMode .seg-btn'), function (b) {
      b.onclick = function () {
        [].forEach.call(document.querySelectorAll('#histMode .seg-btn'), function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        $('histTests').classList.toggle('hidden', b.dataset.h !== 'tests');
        $('histChart').classList.toggle('hidden', b.dataset.h !== 'chart');
        $('histTreat').classList.toggle('hidden', b.dataset.h !== 'treat');
        if (b.dataset.h === 'chart') renderChart();
      };
    });

    $('stripPhoto').onchange = function () { if (this.files[0]) startPhoto(this.files[0]); };
    $('stripCanvas').onclick = canvasTap;
    $('btnWhite').onclick = function () { testState.whiteMode = true; updateTapHint(); };
    $('btnRetake').onclick = function () { resetTestForm(); };
    $('btnZoomInfo').onclick = function () {
      modal('Bien lire une bandelette', function (b) {
        b.innerHTML =
          '<p>Le résultat dépend surtout de la photo :</p>' +
          '<ul class="tips">' +
          '<li>Trempe la bandelette 1 s, secoue une fois, attends le temps indiqué (souvent 15 à 30 s).</li>' +
          '<li>Photographie <strong>à l\'ombre</strong>, jamais au soleil direct ni sous une lampe jaune.</li>' +
          '<li>Pose-la sur un fond neutre (le tube blanc fait très bien l\'affaire).</li>' +
          '<li>Cadre serré, téléphone parallèle à la bandelette, sans ombre portée.</li>' +
          '<li>Touche « Point blanc » sur le plastique blanc : ça corrige la teinte de la lumière.</li>' +
          '<li>Une lecture annoncée « douteuse » doit être corrigée à la main — la valeur saisie fait foi.</li>' +
          '</ul>' +
          '<p class="muted small">Pour gagner encore en précision, calibre l\'échelle avec le nuancier de ton tube ' +
          '(Réglages → Calibration).</p>';
      });
    };
    $('saveTest').onclick = saveTest;
    $('tempFromHA').onclick = function () {
      HA.getState(S.settings.haTempEnt).then(function (st) {
        if (!st) { toast('Capteur illisible'); return; }
        var v = parseFloat(st.state);
        if (isNaN(v)) { toast('Valeur non numérique'); return; }
        $('tempIn').value = v;
        toast('Température lue : ' + v + ' °C');
      });
    };

    $('btnScan').onclick = startScan;
    $('scanStop').onclick = stopScan;
    $('scanManual').onclick = function () { stopScan(); manualBarcode(); };
    $('btnAddManual').onclick = function () { editStock(null); };

    bindSettings();
  }

  function init() {
    $('verChip').textContent = 'v' + APP_VERSION;
    bind();
    renderSettings();
    resetTestForm();
    showTab('home');
    setHaDot(HA.enabled() ? '' : null);
    if (HA.enabled()) HA.ping().then(function () { setHaDot('ok'); }, function () { setHaDot('err'); });
    loadWeather().then(function (w) { if (w) renderProactive(); });
    if (S.settings.notif) scheduleReminders();
    if (S.fill && !S.fill.paused) scheduleFillNotif();

    /* Au retour dans l'app : réévaluer, l'eau a pu bouger depuis. */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        loadWeather().then(function () { renderProactive(); });
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
