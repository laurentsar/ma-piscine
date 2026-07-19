/* Ma Piscine — service worker. Cache l'app shell : elle doit fonctionner au
   bord du bassin, sans réseau. Météo, Home Assistant et GitHub : réseau seul. */
const CACHE = 'ma-piscine-v1.3.0';
const SHELL = [
  'index.html', 'styles.css', 'app.js', 'update-check.js',
  'js/chem.js', 'js/strip.js', 'js/ha.js',
  'manifest.webmanifest', 'img/icon-192.png', 'img/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('open-meteo.com') || url.hostname.includes('api.github.com')) return;
  if (url.port === '8123' || /\/api\/states/.test(url.pathname)) return; // Home Assistant
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
