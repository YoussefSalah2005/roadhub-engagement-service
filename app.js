// Engagement Service (S2): its own Express app (independent from the other two services).
// server.js starts it. Order of middleware = order every request passes through.
const express = require('express');
const cors = require('cors');
const { http } = require('./shared');
const config = require('./config');
require('./services/auditLog'); // sends AUDIT and SECURITY_ALERT lines to CloudWatch Logs (Lab 8)
const publicRoutes = require('./routes/public');
const internalRoutes = require('./routes/internal');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // the gateway on this PC forwards the real client address

app.use(http.requestId);        // X-Request-Id for tracing across services
app.use(http.requestLogger);    // one JSON log line per request
app.use(http.securityHeaders);  // nosniff, DENY frames, CSP for JSON answers
app.use((req, res, next) => {   // which copy answered (Lab 8: watch the load balancer take turns)
  res.set('X-Instance-Id', config.instanceId);
  next();
});

// Health check used by the gateway (load balancer) every few seconds
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok', service: 'engagement', instanceId: config.instanceId,
    pid: process.pid, port: Number(process.env.PORT), uptime: Math.round(process.uptime())
  });
});

// Internal routes: called by the other services only (service token required, no CORS)
app.use('/internal/engagement', express.json({ limit: '32kb' }), internalRoutes);

// Public API: browser calls through the gateway
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:4566,http://localhost:8080')
  .split(',').map((o) => o.trim()).filter(Boolean);
app.use('/api', cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Turnstile-Token', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'X-Served-By', 'X-Instance-Id']
}));
app.use('/api', http.requireJson, express.json({ limit: '10kb' }), publicRoutes);

app.use(http.notFound);
app.use(http.errorHandler);

module.exports = app;
