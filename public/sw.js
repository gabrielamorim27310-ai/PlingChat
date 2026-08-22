/**
 * Service worker do PlingChat — só existe pra receber push. Não faz cache
 * nem funciona offline de propósito: o app depende de WebSocket ao vivo,
 * então uma versão "offline" seria enganosa.
 */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* payload nao era JSON */ }

  const title = data.title || 'PlingChat';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%235865f2'/><text x='50' y='68' font-size='60' text-anchor='middle' fill='white'>⬢</text></svg>",
    tag: data.tag || undefined,
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) {
        client.postMessage({ type: 'notification-click', url });
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
