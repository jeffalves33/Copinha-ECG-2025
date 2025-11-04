// src/routes/webhooks.routes.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { getMerchantOrder, getPayment } = require('../services/mercadoPago.service');
const crypto = require('crypto');
const webpush = require('web-push');

webpush.setVapidDetails(
    process.env.PUSH_CONTACT || 'mailto:najuevents@gmail.com',
    process.env.VAPID_PUBLIC,
    process.env.VAPID_PRIVATE
);

// no topo já existe: const crypto = require('crypto');
async function ensureQrTokensForOrder(orderId) {
    try {
        console.log('[QR] ensureQrTokensForOrder start', { orderId });

        const { data: items, error: qErr } = await supabase
            .from('order_items')
            .select('id, qr_token')
            .eq('order_id', orderId);

        if (qErr) {
            console.error('[QR] select order_items error', qErr);
            return;
        }
        console.log('[QR] items found', items?.length || 0);

        if (!items?.length) return;

        let created = 0;
        for (const it of items) {
            if (it.qr_token) continue;

            const token = crypto.randomUUID(); // opaco e URL-safe o suficiente
            const { error: uErr } = await supabase
                .from('order_items')
                .update({ qr_token: token })
                .eq('id', it.id);

            if (uErr) console.error('[QR] update token error', { itemId: it.id, uErr });
            else {
                created++;
                console.log('[QR] token set for item', it.id);
            }
        }

        console.log('[QR] tokens created (update-by-id)', created);
    } catch (e) {
        console.error('[QR] unexpected error', e);
    }
}


// Util: soma pagamentos aprovados na merchant order
function merchantOrderIsPaid(mo) {
    const approved = (mo.payments || []).filter(p => p.status === 'approved');
    const totalApproved = approved.reduce((acc, p) => acc + (p.total_paid_amount || 0), 0);
    return totalApproved >= (mo.total_amount || 0);
}

async function notifyAll(payload) {
    const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth');

    for (const s of (subs || [])) {
        try {
            await webpush.sendNotification({
                endpoint: s.endpoint,
                keys: { p256dh: s.p256dh, auth: s.auth }
            }, JSON.stringify(payload));
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                await supabase.from('push_subscriptions').delete().eq('id', s.id);
            } else {
                console.error('[PUSH] send error', err);
            }
        }
    }
}

async function getFirstNameByUserId(userId) {
    try {
        if (!userId) return null;
        const { data: user, error } = await supabase
            .from('users')
            .select('name')
            .eq('id', userId)
            .maybeSingle();
        if (error) return null;
        const full = (user?.name || '').trim();
        if (!full) return null;
        return full.split(/\s+/)[0];
    } catch {
        return null;
    }
}



// Util: extrai (topic,type) e id de forma robusta (query ou body)
function parseNotification(req) {
    const q = req.query || {};
    const b = req.body || {};
    const topic = q.topic || q.type || b.type || b.action || (b.data && b.data.type) || null;
    const id = q.id || q['data.id'] || (b.data && b.data.id) || (b.resource && b.resource.id) || null;
    return { topic, id };
}

// POST /api/webhooks/mercado-pago
router.post('/webhooks/mercado-pago', express.json(), async (req, res) => {
    try {
        const { topic, id } = parseNotification(req);
        if (!topic || !id) return res.sendStatus(200);

        // Normaliza o nome do tópico (payment/merchant_order)
        const t = String(topic).toLowerCase();

        if (t.includes('payment')) {
            // 1) Buscar payment
            const pay = await getPayment(id);
            const isApproved = pay.status === 'approved';

            // external_reference -> orderId
            const orderId = String(pay.external_reference || '');
            if (!orderId) return res.sendStatus(200);

            // 2) Obter pedido
            const { data: order } = await supabase
                .from('orders')
                .select('id, status, user_id, total_amount, session_id, user_id')
                .eq('id', orderId)
                .single();
            if (!order) return res.sendStatus(200);
            if (order.status === 'paid') return res.sendStatus(200); // idempotente

            if (isApproved) {
                // 3) marcar pedido como pago e salvar payment id
                // Derivar método e parcelas a partir do Payment:
                const method = pay.payment_method_id === 'pix' || pay.payment_type_id === 'bank_transfer' ? 'pix' : 'card';
                const installments = Number(pay.installments || 1);

                // Atualiza status + provider_payment_id + método e parcelas
                const { data: upd1, error: upd1err } = await supabase.from('orders')
                    .update({
                        status: 'paid',
                        paid_at: new Date().toISOString(),
                        provider_payment_id: String(pay.id),
                        payment_method: method,
                        installments: installments
                    })
                    .eq('id', order.id)
                    .select('id');

                if (upd1err) console.error('[MP] update order error', upd1err);
                else console.log('[MP] order marked as paid', upd1);
                await ensureQrTokensForOrder(order.id);

                try {
                    const amount = Number(order.total_amount || 0).toLocaleString('pt-BR', {
                        style: 'currency', currency: 'BRL'
                    });
                    const firstName = (await getFirstNameByUserId(order.user_id)) || 'Cliente';
                    await notifyAll({
                        title: 'Nova venda 💸',
                        body: `${amount} - ${firstName}`,
                        data: { orderId: order.id }
                    });
                } catch (e) {
                    console.error('[PUSH] erro ao notificar', e);
                }

                // ==== CLAIM: garante que o e-mail será enviado apenas 1x por pedido ====
                try {
                    const nowIso = new Date().toISOString();
                    const { data: claimed, error: claimErr } = await supabase
                        .from('orders')
                        .update({ tickets_emailed_at: nowIso })
                        .is('tickets_emailed_at', null)   // só atualiza se ainda for null
                        .eq('id', order.id)
                        .select('id, tickets_emailed_at')
                        .single();

                    if (claimErr) {
                        console.error('[MAIL][claim] erro ao marcar tickets_emailed_at', { orderId: order.id, claimErr });
                    }

                    if (!claimed) {
                        console.log('[MAIL][skip] e-mail já enviado para este pedido — ignorando novo envio', { orderId: order.id });
                    } else {
                        console.log('[MAIL][claim] OK — este processo vai enviar o e-mail', { orderId: order.id, at: nowIso });

                        const { sendTicketsEmail } = require('../services/email.service');

                        // carrega comprador + itens (com tokens e códigos)
                        const { data: info, error: infoErr } = await supabase
                            .from('orders')
                            .select(`
                                id,
                                user:users!orders_user_id_fkey(name, email),
                                items:order_items(
                                qr_token,
                                seat:seat_id(row_label, seat_number)
                                )
                            `)
                            .eq('id', order.id)
                            .single();

                        if (infoErr) {
                            console.error('[MAIL][dbg] erro ao carregar info do pedido', infoErr);
                        } else {
                            const to = info?.user?.email || null;
                            if (!to) {
                                console.warn('[MAIL][skip] comprador sem e-mail; não envio', { orderId: order.id });
                            } else {
                                const tickets = (info.items || []).map(it => ({
                                    qr_token: it.qr_token,
                                    code: `${it.seat.row_label}-${String(it.seat.seat_number).padStart(2, '0')}`,
                                }));

                                console.log('[MAIL][dbg] preparando envio', { to, orderId: order.id, qty: tickets.length });

                                await sendTicketsEmail({
                                    to,
                                    name: info?.user?.name || 'Cliente',
                                    orderId: order.id,
                                    tickets,
                                });

                                console.log('[MAIL][ok] e-mail enviado', { to, orderId: order.id });
                            }
                        }
                    }
                } catch (e) {
                    console.error('[MAIL] erro no fluxo de envio/idempotência', e);
                }


                // 4) seats do pedido -> sold
                const { data: items } = await supabase
                    .from('order_items')
                    .select('seat_id')
                    .eq('order_id', order.id);

                if (items?.length) {
                    await supabase
                        .from('seats')
                        .update({ status: 'sold', reserve_token: null, reserve_expires: null })
                        .in('id', items.map(i => i.seat_id));
                }
            }

            return res.sendStatus(200);
        }

        if (t.includes('merchant_order')) {
            // 1) Buscar merchant order
            const mo = await getMerchantOrder(id);
            const prefId = mo.preference_id; // você gravou orders.provider_ref = preference_id
            if (!prefId) return res.sendStatus(200);

            // 2) Encontrar order pela provider_ref (preference_id)
            const { data: order } = await supabase
                .from('orders')
                .select('id, status, user_id, total_amount, session_id')
                .eq('provider_ref', prefId)
                .single();
            if (!order) return res.sendStatus(200);
            if (order.status === 'paid') return res.sendStatus(200);

            // 3) Pago se soma dos payments aprovados cobre total
            if (merchantOrderIsPaid(mo)) {
                // tenta pegar um payment aprovado para salvar o id (útil p/ estorno)
                const approved = (mo.payments || []).find(p => p.status === 'approved');
                let paymentId = approved ? String(approved.id) : null;
                // Tenta buscar o Payment para saber método e parcelas
                let method = null, installments = 1;
                if (paymentId) {
                    try {
                        const fullPay = await getPayment(paymentId);
                        method = fullPay.payment_method_id === 'pix' || fullPay.payment_type_id === 'bank_transfer' ? 'pix' : 'card';
                        installments = Number(fullPay.installments || 1);
                    } catch (e) {
                        // se falhar, seguimos com defaults
                    }
                }

                const { data: upd2, error: upd2err } = await supabase.from('orders')
                    .update({
                        status: 'paid',
                        paid_at: new Date().toISOString(),
                        provider_payment_id: paymentId,
                        payment_method: method || 'card',
                        installments: installments
                    })
                    .eq('id', order.id)
                    .select('id');

                if (upd2err) console.error('[MP] update order error', upd2err);
                else console.log('[MP] order marked as paid', upd2);
                await ensureQrTokensForOrder(order.id);

                try {
                    // pegue o total para exibir no push (se já tiver no select)
                    const amount = Number(order.total_amount || 0).toLocaleString('pt-BR', {
                        style: 'currency', currency: 'BRL'
                    });
                    await notifyAll({
                        title: 'Nova venda 💸',
                        body: `${amount} confirmados`,
                        data: { orderId: order.id }
                    });
                } catch (e) {
                    console.error('[PUSH] erro ao notificar', e);
                }

                // ==== CLAIM: garante que o e-mail será enviado apenas 1x por pedido ====
                try {
                    const nowIso = new Date().toISOString();
                    const { data: claimed, error: claimErr } = await supabase
                        .from('orders')
                        .update({ tickets_emailed_at: nowIso })
                        .is('tickets_emailed_at', null)   // só atualiza se ainda for null
                        .eq('id', order.id)
                        .select('id, tickets_emailed_at')
                        .single();

                    if (claimErr) {
                        console.error('[MAIL][claim] erro ao marcar tickets_emailed_at', { orderId: order.id, claimErr });
                    }

                    if (!claimed) {
                        console.log('[MAIL][skip] e-mail já enviado para este pedido — ignorando novo envio', { orderId: order.id });
                    } else {
                        console.log('[MAIL][claim] OK — este processo vai enviar o e-mail', { orderId: order.id, at: nowIso });

                        const { sendTicketsEmail } = require('../services/email.service');

                        // carrega comprador + itens (com tokens e códigos)
                        const { data: info, error: infoErr } = await supabase
                            .from('orders')
                            .select(`
                                id,
                                user:users!orders_user_id_fkey(name, email),
                                items:order_items(
                                qr_token,
                                seat:seat_id(row_label, seat_number)
                                )
                            `)
                            .eq('id', order.id)
                            .single();

                        if (infoErr) {
                            console.error('[MAIL][dbg] erro ao carregar info do pedido', infoErr);
                        } else {
                            const to = info?.user?.email || null;
                            if (!to) {
                                console.warn('[MAIL][skip] comprador sem e-mail; não envio', { orderId: order.id });
                            } else {
                                const tickets = (info.items || []).map(it => ({
                                    qr_token: it.qr_token,
                                    code: `${it.seat.row_label}-${String(it.seat.seat_number).padStart(2, '0')}`,
                                }));

                                console.log('[MAIL][dbg] preparando envio', { to, orderId: order.id, qty: tickets.length });

                                await sendTicketsEmail({
                                    to,
                                    name: info?.user?.name || 'Cliente',
                                    orderId: order.id,
                                    tickets,
                                });

                                console.log('[MAIL][ok] e-mail enviado', { to, orderId: order.id });
                            }
                        }
                    }
                } catch (e) {
                    console.error('[MAIL] erro no fluxo de envio/idempotência', e);
                }

                const { data: items } = await supabase
                    .from('order_items')
                    .select('seat_id')
                    .eq('order_id', order.id);

                if (items?.length) {
                    await supabase
                        .from('seats')
                        .update({ status: 'sold', reserve_token: null, reserve_expires: null })
                        .in('id', items.map(i => i.seat_id));
                }
            }

            return res.sendStatus(200);
        }

        // Outros tópicos ignorados
        return res.sendStatus(200);
    } catch (e) {
        console.error('MP webhook error:', e);
        // devolver 200 para evitar reenvio infinito; se preferir, logue para análise
        return res.sendStatus(200);
    }
});

module.exports = router;
