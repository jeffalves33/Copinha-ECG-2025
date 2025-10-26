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
    } catch (e) { next(e); }
}

async function getSessionsSoldCounts(req, res, next) {
    const ID_16H = '9c3c87cb-4107-4d8e-a4ea-c1e8b0084e34';
    const ID_19H = '9882e22d-d089-4b06-82f5-0a838378ba62';
    const TOTAL_BY_SESSION = 652;
    const PRICE = 70;
    try {
        const { data, error } = await supabase
            .from('order_items')
            .select(`
                seats:seat_id ( session_id ),
                orders:order_id ( status )
            `)
            .eq('orders.status', 'paid');

        if (error) throw error;

        // conta vendidos só das duas sessões desejadas
        let sold16 = 0, sold19 = 0;

        for (const it of data || []) {
            const sess = it?.seats?.session_id;
            if (!sess) continue;
            if (sess === ID_16H) sold16++;
            else if (sess === ID_19H) sold19++;
        }

        const available16 = Math.max(TOTAL_BY_SESSION - sold16, 0);
        const available19 = Math.max(TOTAL_BY_SESSION - sold19, 0);

        const revenue16 = sold16 * PRICE;
        const revenue19 = sold19 * PRICE;

        return res.json({
            ok: true,
            sessions: [
                {
                    session: '16h',
                    sold: sold16,
                    available: available16,
                    revenue: revenue16
                },
                {
                    session: '19h',
                    sold: sold19,
                    available: available19,
                    revenue: revenue19
                }
            ]
        });
    } catch (err) {
        return next(err);
    }
}

async function listSales(req, res, next) {
    try {
        const { sessionId: raw, floor, search, page = 1, pageSize = 50 } = req.query;
        const sessionId = await resolveSessionId(raw);

        let q = supabase.from('orders')
            .select('id,total_amount,paid_at,session_id,status,user_id,payment_method,installments, user:user_id(name,email,phone,cpf), order_items(id,order_id,seat_id,price,status,ticket_image_url,created_at,seat:seat_id (row_label, seat_number, floor))')
            .eq('status', 'paid')
            .order('paid_at', { ascending: false });

        if (sessionId) q = q.eq('session_id', sessionId);

        // carregue pedidos
        const { data: orders, error } = await q;
        if (error) throw error;
        if (!orders?.length) return res.json({ ok: true, items: [], total: 0 });

        let rows = [];
        for (const o of orders) {
            for (const it of (o.order_items || [])) {
                // filtro por andar (opcional): se vier "floor" no query, aplica aqui
                if (floor && String(it?.seat?.floor) !== String(floor)) continue;

                rows.push({
                    orderId: o.id,
                    orderItemId: it.id,
                    seatId: it.seat_id,
                    buyer: o.user?.name || '—',
                    email: o.user?.email || '',
                    phone: (o.user?.phone || '').trim(),
                    cpf: o.user?.cpf || null,
                    seatCode: fmtSeat(it.seat),
                    floor: it.seat?.floor || null,
                    method: (o.payment_method || '').toUpperCase() || 'CARD',
                    installments: Number(o.installments || 1),
                    total: Number(it.price || 0),
                    paidAt: o.paid_at,
                    sessionId: o.session_id,
                });
            }
        }

        if (search) {
            const s = search.toLowerCase();
            rows = rows.filter(r =>
                (r.orderId || '').toLowerCase().includes(s) ||
                (r.orderItemId || '').toLowerCase().includes(s) ||
                (r.buyer || '').toLowerCase().includes(s) ||
                (r.email || '').toLowerCase().includes(s) ||
                (r.seatCode || '').toLowerCase().includes(s)
            );
        }

        const start = (Number(page) - 1) * Number(pageSize);
        const end = start + Number(pageSize);
        const pageRows = rows.slice(start, end);

        return res.json({ ok: true, items: pageRows, total: rows.length });
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

async function cancelOrderItem (req, res, next) {
  try {
    const { orderId, orderItemId } = req.params;
    const seatId = req.query.seatId;

    if (!orderId || !orderItemId || !seatId) {
      return res.status(400).json({ ok: false, error: 'orderId, orderItemId e seatId são obrigatórios.' });
    }

    // opcional: pegue o usuário autenticado p/ auditoria
    const actor = req.user?.id || null;
    const { data, error } = await supabase.rpc('admin_cancel_order_item', {
      p_order_id: orderId,
      p_order_item_id: orderItemId,
      p_seat_id: seatId,
      p_actor: actor
    });

    if (error) throw error;

    // data: { removed: true, order_deleted: boolean, new_order_total: number|null }
    return res.json({ ok: true, ...data });
  } catch (e) { next(e); }
};

module.exports = {
    getDashboardMetrics,
    listSales,
    exportSales,
    listSeats,
    forceRelease,
    searchUsers,
    getUserDetails,
    cancelOrderItem,
    getSessionsSoldCounts
};
