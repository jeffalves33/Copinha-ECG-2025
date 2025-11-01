const router = require('express').Router();

router.get('/pre-sale/config', (req, res) => {
    const enabled = process.env.PRE_SALE_ENABLED === 'true';
    const max = Number(process.env.PRE_SALE_MAX_PER_CPF || 3);
    res.json({ enabled, max });
});

module.exports = router;