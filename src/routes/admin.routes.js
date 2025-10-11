const router = require('express').Router();
const AdminCtrl = require('../controllers/admin.controller');

// DASHBOARD / MÉTRICAS
router.get('/admin/metrics', AdminCtrl.getDashboardMetrics);

// VENDAS
router.get('/admin/sales', AdminCtrl.listSales);              // filtros & paginação
router.get('/admin/sales/export.csv', AdminCtrl.exportSales); // CSV
router.post('/admin/orders/:id/cancel', AdminCtrl.cancelOrder);

// ASSENTOS
router.get('/admin/seats', AdminCtrl.listSeats);              // filtros
router.post('/admin/seats/release', AdminCtrl.forceRelease);  // liberar reservas expiradas/forçada

// USUÁRIOS
router.get('/admin/users/search', AdminCtrl.searchUsers);
router.get('/admin/users/:id', AdminCtrl.getUserDetails);

module.exports = router;
