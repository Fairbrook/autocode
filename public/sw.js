// Service worker for autocode's Web Push channel. Must be served from the
// origin root (not a subpath) for its push scope to cover the whole app.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "autocode", body: event.data.text() };
  }

  const title = payload.title || "autocode";
  const options = {
    body: payload.body || "",
    tag: payload.runId ? `run-${payload.runId}` : undefined,
    renotify: true,
    data: { runId: payload.runId },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const runId = event.notification.data?.runId;
  const url = runId ? `/#/runs/${runId}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
