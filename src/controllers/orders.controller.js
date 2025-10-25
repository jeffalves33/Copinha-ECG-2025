const { supabase } = require('../services/supabase');
const { createCheckoutPreference } = require('../services/mercadoPago.service');
const { getOrCreateUser } = require('../services/user.service');

async function checkout(req, res, next) {
    const clientIp = req.ip; // opcional p/ logs
    try {
        const { sessionId, buyer, reserveToken, seats, price } = req.body;

        // 1) validação simples
        if (!buyer?.name || !buyer?.cpf || !buyer?.phone) {
            return res.status(400).json({ ok: false, message: 'Informe nome, CPF e telefone.' });
        }

        // 2) Achar ou criar usuário com regras de unicidade
        let userId;
        try {
            const u = await getOrCreateUser(buyer); // { name, email?, phone, cpf }
            userId = u.id;
        } catch (e) {
            if (e.status === 409 || e.status === 400) {
                return res.status(e.status).json({ ok: false, message: e.message });
            }
            throw e;
        }

        // 3) upsert do usuário
        const { data: user, error: uerr } = await supabase
            .from('users')
            .update({ name: buyer.name, email: buyer.email, phone: buyer.phone })
            .eq('id', userId);

        if (uerr) throw uerr;

        // 2) validar assentos pertencem ao token e não expiraram
        const { data: seatRows, error: serr } = await supabase
            .from('seats')
            .select('id, row_label, seat_number, reserve_expires')
            .eq('session_id', sessionId)
            .eq('status', 'reserved')
            .eq('reserve_token', reserveToken)
            .gt('reserve_expires', new Date().toISOString());
        if (serr) throw serr;

        const wanted = new Set(seats);
        const found = new Set((seatRows || []).map(s => `${s.row_label}-${String(s.seat_number).padStart(2, '0')}`));
        const allOk = seats.every(c => found.has(c));
        if (!allOk) {
            return res.status(409).json({
                ok: false,
                message: 'Algum assento expirou ou não está reservado por este token.'
            });
        }

        // 3) criar pedido
        const total = Number(price) * seats.length;
        const { data: order, error: oerr } = await supabase
            .from('orders')
            .insert([{
                user_id: userId,
                session_id: sessionId,
                status: 'awaiting_payment',
                total_amount: total,
                currency: 'BRL',
                provider: 'mercado_pago'
            }])
            .select('id')
            .single();

        if (oerr) throw oerr;

        // 4) criar itens + (opcional) sombra do TTL
        const seatIdMap = new Map(
            seatRows.map(s => [`${s.row_label}-${String(s.seat_number).padStart(2, '0')}`, s.id])
        );
        const itemsPayload = seats.map(code => ({
            order_id: order.id,
            seat_id: seatIdMap.get(code),
            price: Number(price),
            status: 'reserved',
            reserve_expires: seatRows[0].reserve_expires
        }));
        const { error: ierr } = await supabase.from('order_items').insert(itemsPayload);
        if (ierr) throw ierr;

        // 5) gerar checkout do MP
        const mpItems = seats.map(code => ({ code, price: Number(price) }));
        const pref = await createCheckoutPreference({ orderId: order.id, buyer, items: mpItems });

        // 6) salvar provider_ref e link
        const { error: uperr } = await supabase
            .from('orders')
            .update({ provider_ref: pref.id, checkout_url: pref.init_point })
            .eq('id', order.id);
        if (uperr) throw uperr;

        res.json({ ok: true, orderId: order.id, checkoutUrl: pref.init_point });
    } catch (e) { next(e); }
}

async function getOrder(req, res, next) {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('orders')
            .select('id,status,total_amount,checkout_url')
            .eq('id', id)
            .single();
        if (error) return res.status(404).json({ ok: false, message: 'Pedido não encontrado' });
        res.json(data);
    } catch (e) { next(e); }
}

async function getOrderSummary(req, res, next) {
    try {
        const { id } = req.params;

        // pedido + comprador
        const { data: order, error: oerr } = await supabase
            .from('orders')
            .select('id,status,total_amount,paid_at,session_id, user:user_id(name,email)')
            .eq('id', id)
            .single();
        if (oerr || !order) return res.status(404).json({ ok: false, message: 'Pedido não encontrado' });

        // itens com assento + qr_token + checkin
        const { data: items, error: ierr } = await supabase
            .from('order_items')
            .select('qr_token, checked_in_at, seats:seat_id(row_label, seat_number, floor)')
            .eq('order_id', id);
        if (ierr) throw ierr;

        // sessão
        const { data: session } = await supabase
            .from('sessions')
            .select('id, name, starts_at, ends_at, venue_name, venue_address')
            .eq('id', order.session_id)
            .single();

        const tickets = (items || []).map(it => ({
            code: `${it.seats.row_label}-${String(it.seats.seat_number).padStart(2, '0')}`,
            floor: it.seats.floor,
            qrToken: it.qr_token || null,
            checkedInAt: it.checked_in_at || null
        }));

        res.json({
            ok: true,
            order: {
                id: order.id,
                status: order.status,
                total: order.total_amount,
                paidAt: order.paid_at,
                buyer: order.user,
                session
            },
            tickets
        });
    } catch (e) { next(e); }
}

module.exports = { checkout, getOrder, getOrderSummary };