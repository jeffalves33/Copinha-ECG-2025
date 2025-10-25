// src/routes/webhooks.routes.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { getMerchantOrder, getPayment } = require('../services/mercadoPago.service');
const crypto = require('crypto');

// no topo já existe: const crypto = require('crypto');

async function ensureQrTokensForOrder(orderId) {
    try {
        console.log('[QR] ensureQrTokensForOrder start', { orderId });

        // busca todos os itens do pedido
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

        // gera tokens apenas para os que estão sem
        const updates = [];
        for (const it of items) {
            if (!it.qr_token) {
                // pode usar randomUUID (suficientemente aleatório e URL-safe)
                updates.push({ id: it.id, qr_token: crypto.randomUUID() });
            }
        }

        if (!updates.length) {
            console.log('[QR] no missing tokens — all good');
            return;
        }

        const { data: up, error: uErr } = await supabase
            .from('order_items')
            .upsert(updates)
            .select('id, qr_token');

        if (uErr) {
            console.error('[QR] upsert tokens error', uErr);
        } else {
            console.log('[QR] tokens created', up?.length || 0);
        }
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
                .select('id, status')
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

                console.log('[MP] payment approved → generating qr tokens', { orderId: order.id });
                await ensureQrTokensForOrder(order.id);


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
                .select('id, status')
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

                console.log('[MP] merchant_order paid → generating qr tokens', { orderId: order.id });
                await ensureQrTokensForOrder(order.id);


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
