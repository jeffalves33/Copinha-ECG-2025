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
        const page = pdf.addPage([320, 680]); // Mobile otimizado - mais alto para respirar
        const { width, height } = page.getSize();

        // fontes
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

        // QR
        const payload = `${item.qr_token}`;

        const qrPng = await QRCode.toBuffer(payload, { width: 520, margin: 0 });
        const qr = await pdf.embedPng(qrPng);

        // ===== CORES ELEGANTES =====
        const darkBg = rgb(0.05, 0.05, 0.05);        // #0d0d0d - quase preto
        const cardBg = rgb(0.08, 0.08, 0.08);        // #141414 - cinza muito escuro
        const accentGreen = rgb(0.42, 1.0, 0.45)     // #6bff72 - verde elegante
        const textWhite = rgb(0.98, 0.98, 0.98);     // #fafafa - branco suave
        const textGray = rgb(0.6, 0.6, 0.6);         // #999999 - cinza médio
        const textMuted = rgb(0.45, 0.45, 0.45);     // #737373 - cinza escuro

        // ===== BACKGROUND PRINCIPAL =====
        page.drawRectangle({
            x: 0,
            y: 0,
            width: width,
            height: height,
            color: darkBg
        });

        // ===== HEADER COM GRADIENTE SIMULADO =====
        // Barra superior verde
        page.drawRectangle({
            x: 0,
            y: height - 4,
            width: width,
            height: 4,
            color: accentGreen
        });

        // Logo/Título
        let yPos = height - 45;
        page.drawText('Espetáculo ECG', {
            x: 25,
            y: yPos,
            size: 22,
            font: fontBold,
            color: textWhite
        });

        yPos -= 18;
        page.drawText('INGRESSO DIGITAL', {
            x: 25,
            y: yPos,
            size: 8,
            font,
            color: accentGreen,
            opacity: 0.9
        });

        // ===== LINHA DECORATIVA =====
        yPos -= 20;
        page.drawRectangle({
            x: 25,
            y: yPos,
            width: 60,
            height: 2,
            color: accentGreen
        });

        // ===== CARD PRINCIPAL DE INFORMAÇÕES =====
        yPos -= 35;
        const cardStartY = yPos;

        // SESSÃO
        page.drawText('SESSÃO', {
            x: 25,
            y: yPos,
            size: 8,
            font,
            color: accentGreen
        });

        yPos -= 18;
        page.drawText(sessionLabel, {
            x: 25,
            y: yPos,
            size: 16,
            font: fontBold,
            color: textWhite
        });

        // DATA/HORA
        yPos -= 26;
        const when = session?.starts_at ? new Date(session.starts_at).toLocaleDateString('pt-BR') : '';
        page.drawText('DATA', {
            x: 25,
            y: yPos,
            size: 8,
            font,
            color: accentGreen
        });

        yPos -= 16;
        page.drawText(when, {
            x: 25,
            y: yPos,
            size: 11,
            font,
            color: textGray
        });

        // LOCAL
        yPos -= 26;
        const venue = session?.venue_name || '';
        const address = session?.venue_address || '';

        page.drawText('LOCAL', {
            x: 25,
            y: yPos,
            size: 8,
            font,
            color: accentGreen
        });

        yPos -= 16;
        if (venue) {
            page.drawText(venue, {
                x: 25,
                y: yPos,
                size: 12,
                font: fontBold,
                color: textWhite
            });

            yPos -= 14;
            if (address) {
                const maxLen = 60;
                const addr = address.length > maxLen ? address.substring(0, maxLen) + '...' : address;
                page.drawText(addr, {
                    x: 25,
                    y: yPos,
                    size: 9,
                    font,
                    color: textMuted
                });
            }
        }

        // ===== CARD DO ASSENTO - DESTAQUE =====
        yPos -= 40;
        const seatBoxY = yPos;
        const seatBoxHeight = 70;

        // Card com borda verde elegante
        page.drawRectangle({
            x: 20,
            y: seatBoxY - seatBoxHeight,
            width: width - 40,
            height: seatBoxHeight,
            color: cardBg,
            borderColor: accentGreen,
            borderWidth: 1.5
        });

        // Conteúdo do card de assento
        page.drawText('ASSENTO', {
            x: 35,
            y: seatBoxY - 22,
            size: 8,
            font,
            color: accentGreen
        });

        page.drawText(seatCode, {
            x: 35,
            y: seatBoxY - 48,
            size: 28,
            font: fontBold,
            color: textWhite
        });

        page.drawText(`ANDAR ${seat.floor}`, {
            x: 35,
            y: seatBoxY - 62,
            size: 10,
            font,
            color: textGray
        });

        // ===== QR CODE - CENTRALIZADO E GRANDE =====
        yPos = seatBoxY - seatBoxHeight - 35;
        const qrSize = 160;
        const qrX = width / 2 - qrSize / 2;
        const qrY = yPos - qrSize - 30;

        // Card do QR
        page.drawRectangle({
            x: qrX - 12,
            y: qrY - 12,
            width: qrSize + 24,
            height: qrSize + 50,
            color: cardBg,
            borderColor: accentGreen,
            borderWidth: 1.5
        });

        // Texto acima do QR
        page.drawText('APRESENTE ESTE QR CODE', {
            x: qrX + qrSize / 2 - 65,
            y: qrY + qrSize + 18,
            size: 9,
            font: fontBold,
            color: accentGreen
        });

        // QR Code
        page.drawImage(qr, {
            x: qrX,
            y: qrY,
            width: qrSize,
            height: qrSize
        });

        // ===== INFORMAÇÕES DO TITULAR =====
        yPos = qrY - 35;

        page.drawText('TITULAR DO INGRESSO', {
            x: 25,
            y: yPos,
            size: 8,
            font,
            color: accentGreen
        });

        yPos -= 16;
        const buyerName = buyer.name || '—';
        const maxNameLen = 32;
        const displayName = buyerName.length > maxNameLen ? buyerName.substring(0, maxNameLen) + '...' : buyerName;

        page.drawText(displayName, {
            x: 25,
            y: yPos,
            size: 11,
            font: fontBold,
            color: textWhite
        });

        // ===== RODAPÉ =====
        yPos -= 30;

        // Linha decorativa
        page.drawRectangle({
            x: 25,
            y: yPos,
            width: width - 50,
            height: 1,
            color: rgb(0.2, 0.2, 0.2)
        });

        yPos -= 20;

        // Número do pedido
        page.drawText('Nº DO PEDIDO', {
            x: 25,
            y: yPos,
            size: 7,
            font,
            color: textMuted
        });

        page.drawText(`#${item.order.id.slice(0, 8)}`, {
            x: width - 95,
            y: yPos,
            size: 8,
            font: fontBold,
            color: textGray
        });

        yPos -= 20;

        // Avisos
        page.drawText('Válido para 1 entrada', {
            x: 25,
            y: yPos,
            size: 7,
            font,
            color: textMuted
        });

        page.drawText('Não compartilhe este código', {
            x: width - 145,
            y: yPos,
            size: 7,
            font,
            color: textMuted
        });

        const bytes = await pdf.save();
        const fname = `Ingresso_${session?.name || 'Sessao'}_${seatCode}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        res.send(Buffer.from(bytes));


    } catch (e) { next(e); }
});

router.get('/tickets', async (req, res, next) => {
    try {
        const raw = (req.query.cpf || '').trim().toLowerCase();
        if (!raw) return res.status(400).json({ ok: false, message: 'cpf é obrigatório' });

        // 1) localizar usuário por cpf canônico
        const { data: user, error: uerr } = await supabase
            .from('users')
            .select('id, name, email')
            .eq('cpf', raw)
            .maybeSingle();

        if (uerr) throw uerr;
        if (!user) return res.json({ ok: true, tickets: [] });

        // 2) pedidos pagos do usuário
        const { data: orders, error: oerr } = await supabase
            .from('orders')
            .select('id, total_amount, paid_at, session_id, payment_method, installments, session: sessions(name)')
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
            session: o.session ? { name: o.session.name } : { id: o.session_id },
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
