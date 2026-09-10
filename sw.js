/* This service worker intentionally does NOT cache the app itself (index.html, the main
   script, supabase-client.js, etc). Every request is passed straight through to the
   network so the device always runs the latest deployed code and never falls back to an
   old cached copy -- the previous cache-first behavior here was a way a stale build could
   keep running (and, since sales now write directly to Supabase with no local fallback,
   an old copy of the app is also the one place staleness could actually cost data).
   The service worker still exists (rather than being removed) purely so the app remains
   installable as a PWA / "Add to Home Screen". If any old cached files exist from a
   previous version of this app, activate() below clears them out once. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // No caches.match, no cache.put -- always go to the network.
  event.respondWith(fetch(event.request));
});
