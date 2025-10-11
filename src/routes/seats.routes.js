const router = require('express').Router();
const { getSeats, postHold, postRelease } = require('../controllers/seats.controller');
router.get('/seats', getSeats);
router.post('/seats/hold', postHold);
router.post('/seats/release', postRelease);
module.exports = router;