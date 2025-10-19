// src/routes/checkin.routes.js
const router = require('express').Router();
const { supabase } = require('../services/supabase');

function parseToken(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.trim();
    if (s.startsWith('TKT1:')) return s.slice(5);
    return s; // aceita sem prefixo também
}

// POST /api/admin/checkin/scan  { token }
router.post('/admin/checkin/scan', async (req, res, next) => {
    try {
        const token = parseToken(req.body?.token);
        if (!token) return res.status(400).json({ ok: false, message: 'token inválido' });

        // 1) localizar o ingresso pelo token
        const { data: item, error: ierr } = await supabase
            .from('order_items')
            .select(`
        id, qr_token, checked_in_at,
        order:order_id(id, status, paid_at, session_id, user_id),
        seat:seat_id(row_label, seat_number, floor),
        user:order_id!inner(user_id)  -- truque para pegar o user via order_id
      `)
            .eq('qr_token', token)
            .single();

        if (ierr && ierr.code === 'PGRST116') return res.json({ ok: false, reason: 'not_found' });
        if (ierr) throw ierr;

        // Busca o pedido e o comprador
        const { data: order } = await supabase
            .from('orders')
            .select('id, status, paid_at, session_id, user:users!orders_user_id_fkey(id,name,email,phone,cpf)')
            .eq('id', item.order.id)
            .single();

        if (!order) return res.json({ ok: false, reason: 'not_found' });
        if (order.status !== 'paid') return res.json({ ok: false, reason: 'unpaid' });

        // Pegar todos os itens do mesmo pedido para permitir selecionar vários
        const { data: items } = await supabase
            .from('order_items')
            .select('qr_token, checked_in_at, seat:seat_id(row_label, seat_number, floor)')
            .eq('order_id', order.id);

        const tickets = (items || []).map(x => ({
            token: x.qr_token,
            code: `${x.seat.row_label}-${String(x.seat.seat_number).padStart(2, '0')}`,
            floor: x.seat.floor,
            checkedInAt: x.checked_in_at
        }));

        // Ingresso do token atual
        const thisOne = tickets.find(t => t.token === token);

        res.json({
            ok: true,
            buyer: { name: order.user?.name || '—', email: order.user?.email || '—', phone: order.user?.phone || '—' },
            order: { id: order.id, paidAt: order.paid_at },
            tickets,                         // todos do pedido para aprovar 1..N
            current: thisOne || null
        });
    } catch (e) { next(e); }
});

// POST /api/admin/checkin/confirm  { tokens:[], by:"Portaria 1" }
router.post('/admin/checkin/confirm', async (req, res, next) => {
    try {
        const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens.map(parseToken).filter(Boolean) : [];
        const by = (req.body?.by || 'Portaria').toString().slice(0, 50);
        if (!tokens.length) return res.status(400).json({ ok: false, message: 'tokens obrigatórios' });

        // Marca como usado somente os que ainda não têm checked_in_at
        const { data, error } = await supabase
            .from('order_items')
            .update({ checked_in_at: new Date().toISOString(), checked_in_by: by })
            .is('checked_in_at', null)
            .in('qr_token', tokens)
            .select('qr_token');

        if (error) throw error;

        res.json({ ok: true, confirmed: data?.map(d => d.qr_token) || [] });
    } catch (e) { next(e); }
});

module.exports = router;
