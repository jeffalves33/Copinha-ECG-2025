// src/services/email.service.js
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.SMTP_USER,      // seu Gmail ex: marketing@hokocomunicacao.com.br
        pass: process.env.SMTP_PASS_APP,  // senha de app
    },
});

async function sendTicketsEmail({ to, name, orderId, tickets }) {
    try {
        // monta corpo
        const subject = `🎟️ Seus ingressos do Espetáculo ECG`;
        const html = `
            <p>Olá, <b>${name}</b>!</p>
            <p>Seu pagamento foi confirmado. Aqui estão seus ingressos para o Espetáculo ECG.</p>
            <p>Você também pode baixá-los a qualquer momento acessando <a href="${process.env.FRONTEND_URL}/ingressos.html">Meus Ingressos</a>.</p>
            <p>Obrigado e bom evento!</p>
        `;

        // baixa e anexa cada PDF
        const attachments = [];
        for (const t of tickets) {
            if (!t.qr_token) continue;
            const url = `${process.env.FRONTEND_URL}/api/tickets/TKT1:${t.qr_token}/pdf`;
            const res = await fetch(url);
            const buffer = await res.buffer();
            attachments.push({
                filename: `Ingresso_${t.code}.pdf`,
                content: buffer,
            });
        }

        await transporter.sendMail({
            from: `"Espetáculo ECG" <${process.env.SMTP_USER}>`,
            to,
            subject,
            html,
            attachments,
        });

        console.log(`[MAIL] ingressos enviados para ${to}`);
    } catch (e) {
        console.error('[MAIL] erro ao enviar ingressos', e);
    }
}

module.exports = { sendTicketsEmail };
