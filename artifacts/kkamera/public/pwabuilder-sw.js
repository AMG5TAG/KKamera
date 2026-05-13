// KKamera Progressive Web App Service Worker
// Supports: Background Sync, Periodic Background Sync, Web Push Notifications, Offline Cache

const CACHE_NAME = "kkamera-v2";
const OFFLINE_URL = "/";

// Assets to cache immediately on install
const PRECACHE_ASSETS = [
  "/",
  "/camera",
  "/manifest.json",
  "/favicon.ico",
  "/icons/icon-72.png",
  "/icons/icon-144.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
];

// --- INSTALL ---
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch(() => {
        // Ignore individual asset failures during precache
      });
    })
  );
  self.skipWaiting();
});

// --- ACTIVATE ---
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// --- FETCH (Cache First with Network Fallback) ---
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // Skip API requests — always go to network
  if (request.url.includes("/api/")) return;

  // Skip cross-origin requests
  if (!request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline fallback for navigation requests
          if (request.destination === "document") {
            return caches.match(OFFLINE_URL);
          }
        });
    })
  );
});

// --- BACKGROUND SYNC (upload queue retry) ---
// Fires when connectivity is restored after a failed upload attempt
self.addEventListener("sync", (event) => {
  if (event.tag === "kkamera-upload-sync") {
    event.waitUntil(retryPendingUploads());
  }
});

async function retryPendingUploads() {
  try {
    // Notify all clients to retry their upload queue
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((client) => {
      client.postMessage({ type: "RETRY_UPLOADS" });
    });
  } catch (err) {
    console.error("[KKamera SW] Background sync failed:", err);
  }
}

// --- PERIODIC BACKGROUND SYNC (keep uploads fresh) ---
// Runs periodically to check for queued uploads and re-attempt them
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "kkamera-periodic-upload") {
    event.waitUntil(periodicUploadCheck());
  }
});

async function periodicUploadCheck() {
  try {
    const clients = await self.clients.matchAll({ type: "window" });
    if (clients.length > 0) {
      // App is open — let the app handle it
      clients.forEach((client) =>
        client.postMessage({ type: "PERIODIC_SYNC" })
      );
    }
    // If no clients are open, uploads remain queued for when the app opens
  } catch (err) {
    console.error("[KKamera SW] Periodic sync failed:", err);
  }
}

// --- PUSH NOTIFICATIONS ---
// Receives push events from the KKamera server (e.g., trial expiry, upload failed)
self.addEventListener("push", (event) => {
  let data = {
    title: "KKamera",
    body: "You have a new notification.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "kkamera-notification",
    data: {},
  };

  try {
    const payload = event.data?.json();
    if (payload) {
      data = {
        ...data,
        title: payload.title || data.title,
        body: payload.body || data.body,
        tag: payload.tag || data.tag,
        data: payload.data || {},
      };
    }
  } catch {
    const text = event.data?.text();
    if (text) data.body = text;
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      tag: data.tag,
      data: data.data,
      actions: [
        { action: "open", title: "Open KKamera" },
        { action: "dismiss", title: "Dismiss" },
      ],
    })
  );
});

// --- NOTIFICATION CLICK ---
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus existing window if available
      const existing = clients.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.navigate(url);
      } else {
        self.clients.openWindow(url);
      }
    })
  );
});

// --- MESSAGE HANDLER ---
// Handle messages from the app (e.g., register background sync)
self.addEventListener("message", (event) => {
  if (event.data?.type === "REGISTER_SYNC") {
    self.registration.sync?.register("kkamera-upload-sync").catch(() => {});
  }
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
