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
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%239b4dff'/><stop offset='1' stop-color='%23d94fc0'/></linearGradient></defs><rect width='24' height='24' rx='6.7' fill='url(%23g)'/><path d='M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-2.8-.4L4 21l1.4-4.1A8.2 8.2 0 0 1 3.6 11.5C3.6 6.9 7.6 3.2 12.5 3.2S21 6.9 21 11.5Z' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
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
