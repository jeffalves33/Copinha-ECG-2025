// src/routes/tickets.routes.js
const router = require('express').Router();
const { supabase } = require('../services/supabase');

// GET /api/tickets?email=...
router.get('/tickets', async (req, res, next) => {
    try {
        const raw = (req.query.email || '').trim().toLowerCase();
        if (!raw) return res.status(400).json({ ok: false, message: 'email é obrigatório' });

        // 1) localizar usuário por email canônico
        const { data: user, error: uerr } = await supabase
            .from('users')
            .select('id, name, email')
            .eq('email_canonical', raw)
            .single();

        if (uerr && uerr.code !== 'PGRST116') throw uerr; // PGRST116 = no rows
        if (!user) return res.json({ ok: true, tickets: [] }); // sem usuário => sem ingressos

        // 2) pedidos pagos do usuário
        const { data: orders, error: oerr } = await supabase
            .from('orders')
            .select('id, total_amount, paid_at, session_id')
            .eq('user_id', user.id)
            .eq('status', 'paid')
            .order('paid_at', { ascending: false });

        if (oerr) throw oerr;
        if (!orders?.length) return res.json({ ok: true, tickets: [] });

        // 3) itens dos pedidos + dados dos assentos
        const orderIds = orders.map(o => o.id);
        const { data: items, error: ierr } = await supabase
            .from('order_items')
            .select('order_id, seat_id, seats:seat_id(row_label, seat_number, floor)')
            .in('order_id', orderIds);

        if (ierr) throw ierr;

        // agrega assentos por pedido
        const byOrder = {};
        for (const it of items || []) {
            const code = `${it.seats.row_label}-${String(it.seats.seat_number).padStart(2, '0')} (andar ${it.seats.floor})`;
            (byOrder[it.order_id] ||= []).push(code);
        }

        const tickets = orders.map(o => ({
            orderId: o.id,
            seats: byOrder[o.id] || [],
            paidAt: o.paid_at,
            total: o.total_amount
        }));

        res.json({ ok: true, tickets });
    } catch (e) { next(e); }
});

module.exports = router;
