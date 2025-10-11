const cors = require('cors');
module.exports = cors({
    origin: true, credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
});