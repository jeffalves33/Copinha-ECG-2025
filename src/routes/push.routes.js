const router = require('express').Router();
const webpush = require('web-push');
const { supabase } = require('../services/supabase');

webpush.setVapidDetails(
    process.env.PUSH_CONTACT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC,
    process.env.VAPID_PRIVATE
);

// Salvar/atualizar inscrição
router.post('/push/subscribe', async (req, res, next) => {
    try {
        const sub = req.body || {};
        const endpoint = sub?.endpoint;
        const p256dh = sub?.keys?.p256dh;
        const auth = sub?.keys?.auth;
        if (!endpoint || !p256dh || !auth) return res.status(400).json({ ok: false, error: 'invalid subscription' });

        const { data, error } = await supabase
            .from('push_subscriptions')
            .upsert({ endpoint, p256dh, auth }, { onConflict: 'endpoint' })
            .select('id').single();

        if (error) throw error;
        res.json({ ok: true, id: data.id });
    } catch (e) { next(e); }
});

// Disparo de teste manual
router.post('/push/test', async (req, res, next) => {
    try {
        const payload = req.body?.payload || { title: 'Teste', body: 'Push ok ✅' };
        const { data: subs } = await supabase
            .from('push_subscriptions')
            .select('id, endpoint, p256dh, auth');

        let sent = 0;
        for (const s of (subs || [])) {
            try {
                await webpush.sendNotification({
                    endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth }
                }, JSON.stringify(payload));
                sent++;
            } catch (err) {
                // Limpa inscrições expiradas
                if (err.statusCode === 404 || err.statusCode === 410) {
                    await supabase.from('push_subscriptions').delete().eq('id', s.id);
                } else {
                    console.error('[PUSH] send error', err);
                }
            }
        }
        res.json({ ok: true, sent });
    } catch (e) { next(e); }
});

module.exports = router;
