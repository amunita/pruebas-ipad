// Service worker: deja la app y todas las pruebas disponibles sin conexión.
importScripts("sw-archivos.js");
const VERSION_APP = "2026-11-11.1";
const CACHE = `pruebas-${VERSION_APP}-${self.VERSION_DATOS}`;
const BASE = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "sw-archivos.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...BASE, ...self.ARCHIVOS_DATOS])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith("pruebas-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r ||
    fetch(e.request).catch(() => (e.request.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});
