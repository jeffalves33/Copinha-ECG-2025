const router = require('express').Router();
const { checkout, getOrder } = require('../controllers/orders.controller');
const { getOrderSummary } = require('../controllers/orders.controller');

router.post('/orders/checkout', checkout);
router.get('/orders/:id', getOrder);
router.get('/orders/:id/summary', getOrderSummary);
router.get('/orders/by-provider/:prefId', async (req, res, next) => {
    try {
        const { supabase } = require('../services/supabase');
        const { prefId } = req.params;
        const { data, error } = await supabase
            .from('orders')
            .select('id,status,checkout_url')
            .eq('provider_ref', prefId)
            .single();
        if (error || !data) return res.status(404).json({ ok: false });
        res.json({ ok: true, order: data });
    } catch (e) { next(e); }
});

module.exports = router;
