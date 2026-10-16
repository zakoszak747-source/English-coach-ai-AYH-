
// Service worker de My English AI Coach.
// - L'interface s'ouvre même sans réseau (le chat, lui, a besoin d'internet).
// - Réseau d'abord : vous avez toujours la dernière version quand vous êtes en ligne.
// - Les appels vers le Worker (autre domaine) ne sont jamais interceptés ni mis en cache.
//
// Après une modification de l'appli (nouvelle photo de couverture, logo, code...),
// changez le numéro de version ci-dessous pour forcer la mise à jour chez les utilisateurs.
const VERSION = 'v6';
const CACHE = 'english-coach-' + VERSION;

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './assets/cover.jpg',
  './assets/logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  // Chaque fichier est ajouté séparément : s'il en manque un (ex. cover.png au lieu de cover.jpg),
  // l'installation ne plante pas.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(ASSETS.map((asset) => cache.add(asset).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('english-coach-') && key !== CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // On ne touche qu'aux pages et fichiers de l'appli elle-même.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
