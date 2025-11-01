const { supabase } = require('../services/supabase');
const { createCheckoutPreference } = require('../services/mercadoPago.service');
const { getOrCreateUser } = require('../services/user.service');

const PRE_SALE_ENABLED = process.env.PRE_SALE_ENABLED === 'true';
const PRE_SALE_DEFAULT_MAX = Number(process.env.PRE_SALE_MAX_PER_CPF || 3);
const onlyDigits = (s) => (s || '').replace(/\D/g, '');

async function checkout(req, res, next) {
    try {
        const { sessionId, buyer, reserveToken, seats, price } = req.body;
        const studentCpf = onlyDigits(req.body.studentCpf || buyer?.studentCpf);

        // ===== PRE-SALE (temporário, removível) =====
        if (PRE_SALE_ENABLED) {
            // CPF de aluna obrigatório e válido
            if (!studentCpf || studentCpf.length !== 11) {
                return res.status(400).json({ ok: false, message: 'Informe um CPF de aluna válido.' });
            }

            // Precisa estar na lista branca
            const { data: stu, error: stuErr } = await supabase
                .from('pre_sale_students')
                .select('student_cpf, max_tickets')
                .eq('student_cpf', studentCpf)
                .single();

            if (stuErr || !stu) {
                return res.status(403).json({
                    ok: false,
                    message: 'Pré-venda exclusiva para pais. CPF de aluna não encontrado na lista.'
                });
            }

            // Quantos ingressos já foram usados por este CPF de aluna?
            const { data: pso, error: psoErr } = await supabase
                .from('pre_sale_orders')
                .select('order_id')
                .eq('student_cpf', studentCpf);

            if (psoErr) throw psoErr;

            const prevOrderIds = (pso || []).map(r => r.order_id);

            let activeOrderIds = [];
            if (prevOrderIds.length) {
                const { data: act, error: actErr } = await supabase
                    .from('orders')
                    .select('id')
                    .in('id', prevOrderIds)
                    .in('status', ['awaiting_payment', 'paid']);
                if (actErr) throw actErr;
                activeOrderIds = (act || []).map(o => o.id);
            }

            let used = 0;
            if (activeOrderIds.length) {
                const { data: items, error: itemsErr } = await supabase
                    .from('order_items')
                    .select('id, status')
                    .in('order_id', activeOrderIds)
                    .neq('status', 'void');

                if (itemsErr) throw itemsErr;
                used = (items || []).length;
            }

            const maxAllowed = Number(stu.max_tickets ?? PRE_SALE_DEFAULT_MAX);
            const intended = Array.isArray(seats) ? seats.length : 0;

            if (used + intended > maxAllowed) {
                return res.status(403).json({
                    ok: false,
                    message: `Limite de ${maxAllowed} ingressos por CPF de aluna. Já utilizados: ${used}.`
                });
            }
        }
        // ===== /PRE-SALE =====

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

        // ===== PRE-SALE: vincular pedido ao CPF da aluna (temporário) =====
        // Este bloco pressupõe que você já validou studentCpf e o limite ANTES.
        // Mesmo assim, para robustez, normalizamos aqui também.
        if (process.env.PRE_SALE_ENABLED === 'true') {
            const studentCpf = String((req.body.studentCpf || (req.body.buyer?.studentCpf) || '')).replace(/\D/g, '');
            if (!studentCpf) {
                // Segurança defensiva: se por algum motivo faltou no body, recusa o checkout
                return res.status(400).json({ ok: false, message: 'Informe o CPF da aluna.' });
            }

            const { error: linkErr } = await supabase
                .from('pre_sale_orders')
                .insert([{ order_id: order.id, student_cpf: studentCpf }]);

            if (linkErr) throw linkErr;
        }
        // ===== /PRE-SALE =====

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