require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const cors = require('./middlewares/cors');
const error = require('./middlewares/error');

const admin = require('./routes/admin.routes');
const health = require('./routes/health.routes');
const orders = require('./routes/orders.routes');
const sessions = require('./routes/sessions.routes');
const seats = require('./routes/seats.routes');
const tickets = require('./routes/tickets.routes');
const webhooks = require('./routes/webhooks.routes');

const app = express();

//app.use(helmet());
app.use(cors);
//app.use(pinoHttp());
app.use(express.json());

// servir seus HTMLs (pasta pública do seu projeto)
app.use('/', express.static(path.join(__dirname, '..', 'public')));  // a pasta onde estão index.html, etc.

app.use('/api', admin, health, orders, sessions, seats, tickets, webhooks);
app.use(error);

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API on http://localhost:${port}`));
