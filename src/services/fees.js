// src/services/fees.js
const CARD_MDR = Number(process.env.MP_CARD_MDR_IMMEDIATE ?? process.env.MP_FEE_PERCENT ?? 0.0498);
const PIX_MDR = Number(process.env.MP_PIX_MDR_IMMEDIATE ?? 0.0099);
const FIXED = Number(process.env.MP_FEE_FIXED ?? 0);
const MODE = (process.env.MP_INSTALLMENT_MODE || 'buyer').toLowerCase(); // 'buyer' | 'seller'
const FEE_2X = Number(process.env.MP_INSTALLMENT_2X_SELLER_FEE ?? 0);

function computeFeesFromOrders(orders = []) {
    let gross = 0;
    const fees = { card_mdr: 0, pix_mdr: 0, installment: 0, fixed: 0, total: 0, counts: { card: 0, pix: 0 } };

    for (const o of orders) {
        const amount = Number(o.total_amount || 0);
        const method = (o.payment_method || '').toLowerCase();
        const installments = Number(o.installments || 1);
        gross += amount;

        if (method === 'pix') {
            fees.pix_mdr += amount * PIX_MDR;
            fees.counts.pix++;
        } else { // default assume cartão
            fees.card_mdr += amount * CARD_MDR;
            fees.counts.card++;
            if (MODE === 'seller' && installments > 1) {
                // você disse até 2x — aplica custo extra se configurado
                if (installments === 2) fees.installment += amount * FEE_2X;
            }
        }
        fees.fixed += FIXED;
    }

    fees.total = fees.card_mdr + fees.pix_mdr + fees.installment + fees.fixed;
    const net = Math.max(gross - fees.total, 0);
    return { gross, net, fees };
}

module.exports = { computeFeesFromOrders };
