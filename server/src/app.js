const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const routes = require('./routes');
const { limiter } = require('./ratelimit');
const { checkSecrets } = require('./config');

function createApp() {
  checkSecrets();
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet());

  // CORS — only the configured frontend origins may call the API, with the
  // session cookie. Unset means same-origin only (the deployed setup).
  const origins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: origins.length ? origins : false,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Dayflow', 'X-StepUp-Token'],
    })
  );

  // CSRF defence on top of the SameSite=Strict cookie: every state-changing
  // request must carry a custom header. Another site can't add one without a
  // CORS preflight, which the allow-list above refuses. The two endpoints called
  // server-to-server (cron, QStash) authenticate with CRON_SECRET instead.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.path === '/cron/run' || /^\/reminders\/[^/]+\/fire$/.test(req.path)) return next();
    if (req.get('x-dayflow') === '1') return next();
    return res.status(403).json({ error: 'missing request header' });
  });

  app.use(express.json({ limit: '64kb' }));

  // Rate limiting per IP — layered: a short burst window (in memory, it only
  // needs to blunt floods) plus a sustained ceiling shared across instances.
  // Per-user limits are applied in routes.js after sign-in. 429 + Retry-After.
  const burst = limiter({ name: 'burst', windowMs: 1000, limit: 20, message: 'Too many requests, slow down.', shared: false });
  const sustained = limiter({ name: 'ip', windowMs: 15 * 60 * 1000, limit: 5000, message: 'Rate limit exceeded.' });
  app.use('/api', burst, sustained, routes);

  // 404 for anything else.
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  // Central error handler. Maps known Postgres errors to clean 4xx and never
  // leaks internals for unexpected failures.
  app.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body too large' });
    }
    if (err && err.code) {
      switch (err.code) {
        case '23503': // foreign key violation
          return res.status(404).json({ error: 'referenced record not found' });
        case '23505': // unique violation
          return res.status(409).json({ error: 'that record already exists' });
        case '23514': // check constraint violation
          return res.status(400).json({ error: 'value violates a field constraint' });
        case '22P02': // invalid text representation (e.g. malformed uuid)
          return res.status(400).json({ error: 'invalid id or value format' });
      }
    }
    const status = err && err.status ? err.status : 500;
    const message = err && err.expose ? err.message : 'internal server error';
    // Log the kind of failure, not the whole object: error objects from client
    // libraries can carry tokens, request bodies or personal data.
    if (status >= 500) console.error('[error]', (err && err.name) || 'Error', (err && err.code) || '', (err && err.message) || '');
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
