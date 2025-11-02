const router = require('express').Router();
const AdminCtrl = require('../controllers/admin.controller');

router.post('/admin/credentials', AdminCtrl.getCredentials);

// DASHBOARD / MÉTRICAS
router.get('/admin/metrics', AdminCtrl.getDashboardMetrics);

// VENDAS
router.get('/admin/sales/sold', AdminCtrl.getSessionsSoldCounts);
router.get('/admin/sales', AdminCtrl.listSales);
//router.post('/admin/orders/:id/cancel', AdminCtrl.cancelOrder);
router.delete('/admin/orders/:orderId/items/:orderItemId', AdminCtrl.cancelOrderItem);

// ASSENTOS
router.get('/admin/seats', AdminCtrl.listSeats);              // filtros
router.post('/admin/seats/release', AdminCtrl.forceRelease);  // liberar reservas expiradas/forçada

// USUÁRIOS
router.get('/admin/users/search', AdminCtrl.searchUsers);
router.get('/admin/users/:id', AdminCtrl.getUserDetails);

module.exports = router;
