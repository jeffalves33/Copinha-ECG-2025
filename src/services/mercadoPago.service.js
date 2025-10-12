// services/mercadoPago.service.js
require('dotenv').config();
const { MercadoPagoConfig, Preference, Payment, MerchantOrder } = require('mercadopago');
const mercadopago = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN });

// Cria uma preferência de checkout do Mercado Pago
async function createCheckoutPreference({ orderId, buyer, items }) {
    try {
        const response = await new Preference(mercadopago).create({
            body: {
                items: items.map((it) => ({
                    title: `Ingresso Copinha ECG`,
                    quantity: 1,
                    currency_id: 'BRL',
                    unit_price: Number(it.price),
                    category_id: "services",
                    description: "Quantidade de ingressos para evento Copinha ECG"
                })),
                payer: {
                    name: buyer.name,
                    email: buyer.email,
                },
                external_reference: String(orderId),
                payment_methods: {
                    excluded_payment_types: [],
                    excluded_payment_methods: [],
                    installments: 2
                },
                back_urls: {
                    success: `${process.env.FRONTEND_URL}/sucesso.html?order_id=${orderId}`,
                    pending: `${process.env.FRONTEND_URL}/sucesso.html?order_id=${orderId}`,
                    failure: `${process.env.FRONTEND_URL}/checkout.html?order_id=${orderId}`,
                },
                auto_return: 'approved',
                notification_url: `${process.env.BASE_URL}/api/webhooks/mercado-pago`,
                metadata: {
                    order_id: orderId,
                    buyer_email: buyer.email,
                },
            },
        });

        const pref = response;
        return {
            id: pref.id,
            init_point: pref.init_point,
            sandbox_init_point: pref.sandbox_init_point,
        };
    } catch (error) {
        console.error('❌ Erro ao criar preferência do Mercado Pago:', error.message || error);
        throw error;
    }
}

// Busca detalhes de uma ordem (merchant order)
async function getPayment(id) {
    return await new Payment(mercadopago).get({ id });
}

async function getMerchantOrder(id) {
    // v2: merchant order é outro recurso
    return await new MerchantOrder(mercadopago).get({ merchantOrderId: id });
}

module.exports = { createCheckoutPreference, getMerchantOrder, getPayment };
