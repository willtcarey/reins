// Minimal service worker for PWA installability.
// Network-only — all requests go straight to the server.
// This exists solely so the app meets the PWA install criteria.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
