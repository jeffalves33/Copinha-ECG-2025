const fetch = require('node-fetch');

async function refundPayment(paymentId, amount = null) {
    const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    const url = `https://api.mercadopago.com/v1/payments/${paymentId}/refunds`;
    const body = amount ? { amount: Number(amount) } : {};
    const r = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    const json = await r.json();
    if (!r.ok) {
        const msg = json?.message || r.statusText;
        throw new Error(`Refund failed: ${msg}`);
    }
    return json;
}

module.exports = { refundPayment };
