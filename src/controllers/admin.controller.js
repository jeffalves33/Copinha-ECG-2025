const { supabase } = require('../services/supabase');
const { computeFees } = require('../services/fees');
const { computeFeesFromOrders } = require('../services/fees');
const { toCSV } = require('../services/csv');
const { refundPayment } = require('../services/mercadoPagoRefund.service');

// helpers
const fmtSeat = (s) => `${s.row_label}-${String(s.seat_number).padStart(2, '0')}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolveSessionId(sessionIdOrName) {
    if (!sessionIdOrName) return null;
    if (UUID_RE.test(sessionIdOrName)) return sessionIdOrName;

    const normalized = String(sessionIdOrName).toLowerCase().replace(':00', 'h').replace(':', 'h');

    const { data: s } = await supabase
        .from('sessions')
        .select('id, name')
        .ilike('name', normalized)
        .limit(1)
        .maybeSingle();

    return s?.id ?? null;
}

async function getDashboardMetrics(req, res, next) {
    try {
        const raw = req.query.sessionId || null;
        const sessionId = await resolveSessionId(raw);

        // 1) contagem por status (sem limite de 1000, usa count exato no header)
        const statuses = ['available', 'reserved', 'sold', 'blocked'];
        const counts = { available: 0, reserved: 0, sold: 0, blocked: 0 };

        for (const st of statuses) {
            let q = supabase.from('seats').select('id', { count: 'exact', head: true }).eq('status', st);
            if (sessionId) q = q.eq('session_id', sessionId);
            const { count, error } = await q;
            if (error) throw error;
            counts[st] = count || 0;
        }

        // 2) receita e quantidade de pagamentos via RPC (evita 'sum' no select)
        let oq = supabase
            .from('orders')
            .select('id,total_amount,payment_method,installments,status,session_id')
            .eq('status', 'paid');
        if (sessionId) oq = oq.eq('session_id', sessionId);

        const { data: ords, error: oerr } = await oq;
        if (oerr) throw oerr;

        const { gross, net, fees } = computeFeesFromOrders(ords || []);
        res.json({
            ok: true,
            seats: counts,
            revenue: {
                gross,
                net,
                fees: { total: fees.total },
                feesBreakdown: {
                    card_mdr: fees.card_mdr,
                    pix_mdr: fees.pix_mdr,
                    installment: fees.installment,
                    fixed: fees.fixed,
                    counts: fees.counts
                }
            }
        });

        res.json({ ok: true, seats: counts, revenue: { gross, fees, net } });
    } catch (e) { next(e); }
}

async function listSales(req, res, next) {
    try {
        const { sessionId: raw, floor, search, page = 1, pageSize = 50 } = req.query;
        const sessionId = await resolveSessionId(raw);

        let q = supabase.from('orders')
            .select('id,total_amount,paid_at,session_id,status,user_id,payment_method,installments, user:user_id(name,email,phone,cpf)')
            .eq('status', 'paid')
            .order('paid_at', { ascending: false });

        if (sessionId) q = q.eq('session_id', sessionId);

        // carregue pedidos
        const { data: orders, error } = await q;
        if (error) throw error;
        if (!orders?.length) return res.json({ ok: true, items: [], total: 0 });

        // itens dos pedidos
        const orderIds = orders.map(o => o.id);
        let qi = supabase.from('order_items')
            .select('order_id, seat_id, seats:seat_id(row_label,seat_number,floor)')
            .in('order_id', orderIds);
        if (floor) qi = qi.eq('seats.floor', String(floor));
        const { data: items, error: e2 } = await qi;
        if (e2) throw e2;

        // agrega por pedido
        const byOrder = {};
        for (const it of (items || [])) {
            (byOrder[it.order_id] ||= []).push({
                code: fmtSeat(it.seats),
                floor: it.seats.floor
            });
        }

        let rows = orders.map(o => ({
            id: o.id,
            buyer: o.user?.name || '—',
            contact: `${o.user?.email || ''} ${o.user?.phone || ''}`.trim(),
            userCpf: o.user?.cpf || null,
            seats: (byOrder[o.id] || []),
            total: Number(o.total_amount || 0),
            paidAt: o.paid_at,
            sessionId: o.session_id,
            method: (o.payment_method || '').toUpperCase() || 'CARD',
            installments: Number(o.installments || 1)
        }));

        if (search) {
            const s = search.toLowerCase();
            rows = rows.filter(r =>
                r.id.includes(s) ||
                (r.buyer || '').toLowerCase().includes(s) ||
                (r.contact || '').toLowerCase().includes(s) ||
                r.seats.some(se => se.code.toLowerCase().includes(s)));
        }

        // paginação simples em memória (dados são pequenos)
        const start = (Number(page) - 1) * Number(pageSize);
        const end = start + Number(pageSize);
        const pageRows = rows.slice(start, end);

        res.json({ ok: true, items: pageRows, total: rows.length });
    } catch (e) { next(e); }
}

async function exportSales(req, res, next) {
    try {
        // recicla listagem (sem paginação)
        req.query.pageSize = 100000;
        const { ok, items } = await (async () => {
            return new Promise((resolve, reject) => {
                const mRes = {
                    json: (obj) => resolve(obj)
                };
                listSales(req, mRes, reject);
            });
        })();
        if (!ok) return res.status(500).end();

        const rows = items.map(r => ({
            order_id: r.id,
            buyer: r.buyer,
            contact: r.contact,
            seats: r.seats.map(s => `${s.code} (andar ${s.floor})`).join(' | '),
            total: r.total,
            paid_at: r.paidAt
        }));

        const csv = toCSV(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="vendas.csv"');
        res.send(csv);
    } catch (e) { next(e); }
}

async function listSeats(req, res, next) {
    try {
        const raw = req.query.sessionId || null;
        const sessionId = await resolveSessionId(raw);
        const floor = req.query.floor || null;
        const q = req.query.q || '';

        let s = supabase.from('seats')
            .select('id, session_id, floor, row_label, seat_number, status, reserve_token, reserve_expires');

        if (sessionId) s = s.eq('session_id', sessionId);
        if (floor) s = s.eq('floor', String(floor));

        const { data: seats, error } = await s;
        if (error) throw error;

        // opcional: vincular pedido quando sold
        const soldSeatIds = seats.filter(x => x.status === 'sold').map(x => x.id);
        let bySeatOrder = {};
        if (soldSeatIds.length) {
            const { data: items } = await supabase
                .from('order_items')
                .select('order_id, seat_id')
                .in('seat_id', soldSeatIds);
            (items || []).forEach(i => { bySeatOrder[i.seat_id] = i.order_id; });
        }

        let rows = seats.map(s => ({
            id: s.id,
            seat: fmtSeat(s),
            floor: s.floor,
            status: s.status,
            reserveToken: s.reserve_token,
            reserveExpires: s.reserve_expires,
            orderId: bySeatOrder[s.id] || null
        }));

        if (q) {
            const needle = q.toLowerCase();
            rows = rows.filter(r => r.seat.toLowerCase().includes(needle));
        }

        res.json({ ok: true, items: rows });
    } catch (e) { next(e); }
}

async function forceRelease(req, res, next) {
    try {
        const { sessionId, floor, seats = [] } = req.body; // seats: ["A-03",...]
        if (!sessionId || !floor || !seats.length) return res.status(400).json({ ok: false, message: 'params' });

        const { error } = await supabase.rpc('seat_release', {
            p_session_id: sessionId,
            p_floor: String(floor),
            p_seat_codes: seats
        });
        if (error) throw error;

        res.json({ ok: true });
    } catch (e) { next(e); }
}

async function searchUsers(req, res, next) {
    try {
        const raw = (req.query.q || '').trim().toLowerCase();
        if (!raw) return res.json({ ok: true, items: [] });

        // busca por nome/email/phone
        const { data: users, error } = await supabase
            .from('users')
            .select('id,name,email,phone,cpf')
            .or(`email_canonical.ilike.%${raw}%,name.ilike.%${raw}%,phone_digits.ilike.%${raw}%,cpf_digits.ilike.%${raw}%`)
            .limit(50);

        if (error) throw error;

        res.json({ ok: true, items: users || [] });
    } catch (e) { next(e); }
}

async function getUserDetails(req, res, next) {
    try {
        const { id } = req.params;

        const { data: user, error: e1 } = await supabase
            .from('users')
            .select('id,name,email,phone')
            .eq('id', id)
            .single();
        if (e1) throw e1;
        if (!user) return res.status(404).json({ ok: false });

        const { data: orders } = await supabase
            .from('orders')
            .select('id,status,total_amount,paid_at')
            .eq('user_id', id)
            .order('paid_at', { ascending: false });

        const orderIds = (orders || []).map(o => o.id);
        let tickets = [];
        if (orderIds.length) {
            const { data: items } = await supabase
                .from('order_items')
                .select('order_id, seats:seat_id(row_label,seat_number,floor)')
                .in('order_id', orderIds);
            const byOrder = {};
            (items || []).forEach(i => (byOrder[i.order_id] ||= []).push(`${fmtSeat(i.seats)} (andar ${i.seats.floor})`));
            tickets = (orders || []).map(o => ({
                orderId: o.id,
                status: o.status,
                seats: byOrder[o.id] || [],
                total: o.total_amount,
                paidAt: o.paid_at
            }));
        }

        res.json({ ok: true, user, tickets });
    } catch (e) { next(e); }
}

async function cancelOrder(req, res, next) {
    try {
        const { id } = req.params;
        const reason = (req.body?.reason || '').slice(0, 500);

        const { data: order, error } = await supabase
            .from('orders').select('id,status,session_id, provider_payment_id')
            .eq('id', id).single();
        if (error || !order) return res.status(404).json({ ok: false, message: 'Pedido não encontrado' });

        if (order.status !== 'paid') {
            // apenas liberar assentos e cancelar
            await releaseSeatsByOrder(id);
            await supabase.from('orders').update({ status: 'canceled' }).eq('id', id);
            return res.json({ ok: true, refunded: false });
        }

        // pago: tentar estorno no MP (total)
        if (!order.provider_payment_id) {
            return res.status(409).json({ ok: false, message: 'Sem payment_id para estorno' });
        }
        await refundPayment(order.provider_payment_id); // estorno total
        await releaseSeatsByOrder(id);
        await supabase.from('orders').update({ status: 'refunded' }).eq('id', id);

        res.json({ ok: true, refunded: true });
    } catch (e) { next(e); }
}

// util: liberar assentos de um pedido
async function releaseSeatsByOrder(orderId) {
    // pega seats do pedido
    const { data: items } = await supabase
        .from('order_items')
        .select('seat_id, seats:seat_id(session_id,floor,row_label,seat_number)')
        .eq('order_id', orderId);

    if (!items?.length) return;

    // volta para available (se não houver outra trava de negócio)
    const updates = items.map(i => ({
        id: i.seat_id,
        status: 'available',
        reserve_token: null,
        reserve_expires: null
    }));
    await supabase.from('seats').upsert(updates);
}

module.exports = {
    getDashboardMetrics,
    listSales,
    exportSales,
    listSeats,
    forceRelease,
    searchUsers,
    getUserDetails,
    cancelOrder
};
