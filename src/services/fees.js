// src/services/fees.js
const CARD_MDR = Number(process.env.MP_CARD_MDR_IMMEDIATE ?? process.env.MP_FEE_PERCENT ?? 0.0498);
const PIX_MDR = Number(process.env.MP_PIX_MDR_IMMEDIATE ?? 0.0099);
const MP_MDR = Number(process.env.MP_MP_MDR_IMMEDIATE ?? 0.0499);
const BANKSLIP_MDR = Number(process.env.MP_BANKSLIP_MDR_IMMEDIATE ?? 0.0349);
const FIXED = Number(process.env.MP_FEE_FIXED ?? 0);
const MODE = (process.env.MP_INSTALLMENT_MODE || 'buyer').toLowerCase(); // 'buyer' | 'seller'
const FEE_2X = Number(process.env.MP_INSTALLMENT_2X_SELLER_FEE ?? 0);

function computeFeesFromOrders(orders = []) {
    console.log("🚀 ~ computeFeesFromOrders ~ orders: ", orders)
    let gross = 0;
    const fees = {
        card_mdr: 0,
        pix_mdr: 0,
        mp_mdr: 0,
        bankslip_mdr: 0,
        installment: 0,
        fixed: 0,
        total: 0,
        counts: { card: 0, pix: 0, mp: 0, bankslip: 0 }
    };

    for (const o of orders) {
        const amount = Number(o.total_amount || 0);
        const method = (o.payment_method || '').toLowerCase();
        console.log("🚀 ~ computeFeesFromOrders ~ method: ", method)
        const installments = Number(o.installments || 1);
        gross += amount;

        switch (method) {
            case 'pix':
                fees.pix_mdr += amount * PIX_MDR;
                fees.counts.pix++;
                break;

            case 'boleto':
            case 'bankslip':
                fees.bankslip_mdr += amount * BANKSLIP_MDR;
                fees.counts.bankslip++;
                break;

            case 'mp':
            case 'mercadopago':
            case 'wallet':
                fees.mp_mdr += amount * MP_MDR;
                fees.counts.mp++;
                break;

            case 'card':
            case 'credit':
            case 'credit_card':
            default:
                fees.card_mdr += amount * CARD_MDR;
                fees.counts.card++;
                if (MODE === 'seller' && installments > 1 && installments === 2) {
                    fees.installment += amount * FEE_2X;
                }
                break;
        }
        fees.fixed += FIXED;
        console.log("🚀 ~ computeFeesFromOrders ~ fees: ", fees)
    }

    fees.total = fees.card_mdr + fees.pix_mdr + fees.mp_mdr + fees.bankslip_mdr + fees.installment + fees.fixed;
    console.log("🚀 ~ computeFeesFromOrders ~ fees.total: ", fees.total)
    const net = Math.max(gross - fees.total, 0);
    return { gross, net, fees };
}

module.exports = { computeFeesFromOrders };
