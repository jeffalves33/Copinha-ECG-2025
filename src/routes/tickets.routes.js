// src/routes/tickets.routes.js
const router = require('express').Router();
const { supabase } = require('../services/supabase');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const QRCode = require('qrcode');

// helper: aceita "TKT1:xxxx" ou "xxxx"
function parseTicketToken(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    return s.startsWith('TKT1:') ? s.slice(5) : s;
}

router.get('/tickets/:token/pdf', async (req, res, next) => {
    try {
        const bare = parseTicketToken(req.params.token);
        if (!bare) return res.status(400).send('token inválido');

        // carrega o ingresso (order_item) com contexto
        const { data: item, error: ierr } = await supabase
            .from('order_items')
            .select(`
                id, qr_token, checked_in_at,
                seat:seat_id(row_label, seat_number, floor),
                order:order_id(id, total_amount, paid_at, session_id, status, user_id),
                user:order_id!inner(user_id)
            `)
            .eq('qr_token', bare)
            .single();

        if (ierr && ierr.code === 'PGRST116') return res.status(404).send('Ingresso não encontrado');
        if (ierr) throw ierr;
        if (!item?.order || item.order.status !== 'paid') {
            return res.status(400).send('Pedido não pago');
        }

        // buscar dados da sessão e comprador
        const [{ data: order }, { data: session }] = await Promise.all([
            supabase.from('orders')
                .select('id, paid_at, total_amount, user:users!orders_user_id_fkey(id,name,email,phone)')
                .eq('id', item.order.id).single(),
            supabase.from('sessions')
                .select('id, name, starts_at, ends_at, venue_name, venue_address')
                .eq('id', item.order.session_id).single()
        ]);

        const buyer = order?.user || {};
        const seat = item.seat;
        const seatCode = `${seat.row_label}-${String(seat.seat_number).padStart(2, '0')}`;
        const sessionLabel =
            session?.name === '16h' ? 'Sessão da Tarde (16:00)' :
                session?.name === '19h' ? 'Sessão da Noite (19:00)' : (session?.name || 'Sessão');

        // ====== monta o PDF ======
        const pdf = await PDFDocument.create();
        const page = pdf.addPage([595.28, 420.94]); // A5 landscape (pts)
        const { width, height } = page.getSize();

        // fontes
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

        // QR como PNG buffer
        const payload = `TKT1:${item.qr_token}`;
        const qrPng = await QRCode.toBuffer(payload, { width: 520, margin: 0 });
        const qr = await pdf.embedPng(qrPng);
        const qrW = 170, qrH = 170;
        const qrX = width - qrW - 40;
        const qrY = height - qrH - 40;

        // fundo sutil
        page.drawRectangle({ x: 20, y: 20, width: width - 40, height: height - 40, color: rgb(0.07, 0.08, 0.1), borderColor: rgb(0.15, 0.18, 0.26), borderWidth: 1, opacity: 0.95, borderOpacity: 0.8, });
        page.drawRectangle({ x: 28, y: 28, width: width - 56, height: height - 56, color: rgb(0.12, 0.14, 0.18), opacity: 0.92 });

        // cabeçalho
        const title = 'Copinha ECG • Ingresso';
        page.drawText(title, { x: 40, y: height - 60, size: 18, font: fontBold, color: rgb(0.93, 0.96, 1) });

        // sessão / local / data
        const leftY = height - 100;
        const venue = session?.venue_name ? `${session.venue_name}${session.venue_address ? ' • ' + session.venue_address : ''}` : '';
        const when = session?.starts_at ? new Date(session.starts_at).toLocaleString('pt-BR') : (sessionLabel || '');
        page.drawText(sessionLabel, { x: 40, y: leftY, size: 12, font, color: rgb(0.80, 0.85, 0.95) });
        if (venue) page.drawText(venue, { x: 40, y: leftY - 18, size: 10, font, color: rgb(0.65, 0.7, 0.82) });
        page.drawText(`Data/Hora: ${when}`, { x: 40, y: leftY - 36, size: 10, font, color: rgb(0.65, 0.7, 0.82) });

        // bloco do assento
        const blockY = leftY - 80;
        page.drawText('Assento', { x: 40, y: blockY, size: 11, font, color: rgb(0.70, 0.75, 0.88) });
        page.drawText(`${seatCode} • Andar ${seat.floor}`, { x: 40, y: blockY - 18, size: 22, font: fontBold, color: rgb(1, 1, 1) });

        // comprador
        const buyerY = blockY - 60;
        page.drawText('Titular', { x: 40, y: buyerY, size: 11, font, color: rgb(0.70, 0.75, 0.88) });
        page.drawText(`${buyer.name || '—'}`, { x: 40, y: buyerY - 18, size: 14, font: fontBold, color: rgb(1, 1, 1) });

        // pedido
        const ordY = buyerY - 50;
        page.drawText('Pedido', { x: 40, y: ordY, size: 11, font, color: rgb(0.70, 0.75, 0.88) });
        page.drawText(`${item.order.id}`, { x: 40, y: ordY - 18, size: 10, font, color: rgb(0.85, 0.9, 1) });

        // QR
        page.drawText('Apresente este QR no acesso', { x: qrX, y: qrY + qrH + 6, size: 9, font, color: rgb(0.65, 0.7, 0.82) });
        page.drawImage(qr, { x: qrX, y: qrY, width: qrW, height: qrH });

        // rodapé
        page.drawText('Válido para 1 entrada • Não compartilhe este código', { x: 40, y: 34, size: 9, font, color: rgb(0.65, 0.7, 0.82) });

        const bytes = await pdf.save();
        const fname = `Ingresso_${session?.name || 'Sessao'}_${seatCode}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        res.send(Buffer.from(bytes));
    } catch (e) { next(e); }
});

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
            .maybeSingle();

        if (uerr) throw uerr;
        if (!user) return res.json({ ok: true, tickets: [] });

        // 2) pedidos pagos do usuário
        const { data: orders, error: oerr } = await supabase
            .from('orders')
            .select('id, total_amount, paid_at, session_id, payment_method, installments')
            .eq('user_id', user.id)
            .eq('status', 'paid')
            .order('paid_at', { ascending: false });

        if (oerr) throw oerr;
        if (!orders?.length) return res.json({ ok: true, tickets: [] });

        // 3) itens dos pedidos (cada item = 1 ingresso) + dados do assento
        const orderIds = orders.map(o => o.id);
        const { data: items, error: ierr } = await supabase
            .from('order_items')
            .select('order_id, qr_token, checked_in_at, seat_id, seats:seat_id(row_label, seat_number, floor)')
            .in('order_id', orderIds);

        if (ierr) throw ierr;

        // agrega por pedido
        const byOrder = {};
        for (const it of (items || [])) {
            const seat = it.seats;
            const code = `${seat.row_label}-${String(seat.seat_number).padStart(2, '0')}`;
            (byOrder[it.order_id] ||= []).push({
                code,
                floor: seat.floor,
                qrToken: it.qr_token || null,
                checkedInAt: it.checked_in_at || null,
                downloadUrl: it.qr_token ? `/api/tickets/TKT1:${it.qr_token}/pdf` : null
            });
        }

        const tickets = orders.map(o => ({
            orderId: o.id,
            seats: (byOrder[o.id] || []),
            paidAt: o.paid_at,
            total: o.total_amount,
            paymentMethod: o.payment_method || 'card',
            installments: o.installments || 1
        }));

        res.json({ ok: true, tickets, buyer: { id: user.id, name: user.name, email: user.email } });
    } catch (e) { next(e); }
});

module.exports = router;
