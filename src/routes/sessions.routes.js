//routes/sessions.routes.js
const router = require('express').Router();
const { listSessions } = require('../controllers/sessions.controller');
router.get('/sessions', listSessions);
module.exports = router;