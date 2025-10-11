// src/routes/webhooks.routes.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { getMerchantOrder, getPayment } = require('../services/mercadoPago.service');

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
        if (!topic || !id) return res.sendStatus(200); // evita loops

        // Normaliza o nome do tópico (payment/merchant_order)
        const t = String(topic).toLowerCase();

        if (t.includes('payment')) {
            // 1) Buscar payment
            const pay = await getPayment(id);
            const isApproved = pay.status === 'approved';

            // Usamos external_reference para encontrar seu pedido (você setou external_reference = orderId na preference)
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
                await supabase.from('orders')
                    .update({ status: 'paid', paid_at: new Date().toISOString(), provider_payment_id: String(pay.id) })
                    .eq('id', order.id);

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
                const paymentId = approved ? String(approved.id) : null;

                await supabase.from('orders')
                    .update({
                        status: 'paid',
                        paid_at: new Date().toISOString(),
                        provider_payment_id: paymentId
                    })
                    .eq('id', order.id);

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
