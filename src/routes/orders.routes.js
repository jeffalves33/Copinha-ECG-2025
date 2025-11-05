const router = require('express').Router();
const { checkout, getOrder } = require('../controllers/orders.controller');
const { getOrderSummary } = require('../controllers/orders.controller');
const SALES_START_AT = process.env.SALES_START_AT || '2025-11-05T14:00:00-03:00';

function salesWindowGuard(req, res, next) {
  const now = new Date();
  const start = new Date(SALES_START_AT);
  if (Number.isNaN(start.getTime())) {
    // se a data estiver mal configurada, por segurança bloqueia
    return res.status(503).json({ ok: false, reason: 'sales_config_error' });
  }
  if (now < start) {
    return res.status(403).json({
      ok: false,
      reason: 'sales_closed',
      startsAt: start.toISOString()
    });
  }
  next();
}

router.post('/orders/checkout', salesWindowGuard, checkout);
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
