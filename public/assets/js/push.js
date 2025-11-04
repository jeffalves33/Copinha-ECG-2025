const VAPID_PUBLIC = 'BBotbX2nGq5sd4gHItt1O4dOs76kDZwm67GNCiLK5Qh_yk_BXY810ADKzVdu3qixjfOX4EIXFErH5HgXNWBANNY'; // (passo 3.2)

function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
}

// Só mostra o botão se estiver instalado como app (standalone)
function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function ensureSW() {
    if (!('serviceWorker' in navigator)) return null;
    await navigator.serviceWorker.register('/sw.js');
    return navigator.serviceWorker.ready;
}

async function enablePush() {
    try {
        const reg = await ensureSW();
        if (!reg) return alert('Seu navegador não suporta Service Worker');
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return alert('Permissão negada para notificações');

        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC)
        });

        await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sub)
        });

        alert('Notificações ativadas neste aparelho!');
    } catch (e) {
        console.error('enablePush error', e);
        alert('Falha ao ativar notificações');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('enablePush');
    if (!btn) return;
    if (!isStandalone()) {
        btn.style.display = 'none'; // só aparece no app instalado
        return;
    }
    btn.addEventListener('click', enablePush);
});
