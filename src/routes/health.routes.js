const router = require('express').Router();
router.get('/health', (req, res) => res.json({ ok: true }));
// status público de vendas (usa hora do servidor)
router.get('/sales/status', (req, res) => {
  const SALES_START_AT = process.env.SALES_START_AT || '2025-11-05T14:00:00-03:00';
  const start = new Date(SALES_START_AT);
  const now = new Date();
  const open = now >= start && !Number.isNaN(start.getTime());

  res.json({
    ok: true,
    open,
    startsAt: start.toISOString(),
    now: now.toISOString()
  });
});

module.exports = router;