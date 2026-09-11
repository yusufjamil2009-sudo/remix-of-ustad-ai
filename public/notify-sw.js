/**
 * Click handling for REAL system notifications.
 *
 * This file is imported into the generated Workbox service worker
 * (`workbox.importScripts` in vite.config.ts), so USTAD AI keeps exactly ONE
 * service worker registration. It adds behaviour only — nothing about caching
 * or the existing PWA layer changes.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || "/";
  const url = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.focus();
          if ("navigate" in client) client.navigate(url).catch(() => {});
          return undefined;
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    }),
  );
});
