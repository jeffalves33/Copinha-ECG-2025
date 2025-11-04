// Notificação recebida
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data?.json() || {}; } catch (e) { }
    event.waitUntil(
        self.registration.showNotification(data.title || 'Nova venda 💸', {
            body: data.body || '',
            icon: '../assets/img/icon-192.png',
            badge: '../assets/img/icon-192.png',
            data: data.data || {}
        })
    );
});

// Clique na notificação -> focar/abrir admin
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = '/admin/index.html';
    event.waitUntil((async () => {
        const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = all.find(c => c.url.includes('/admin'));
        if (existing) return existing.focus();
        return clients.openWindow(url);
    })());
});
