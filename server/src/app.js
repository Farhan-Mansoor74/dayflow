const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const routes = require('./routes');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet());

  // CORS — only the configured frontend origins may call the API.
  const origins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: origins.length ? origins : true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    })
  );

  app.use(express.json({ limit: '64kb' }));

  // Rate limiting — layered: a short burst window plus a sustained ceiling.
  // Returns 429 with a Retry-After header when exceeded.
  const burst = rateLimit({
    windowMs: 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' },
  });
  const sustained = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded.' },
  });
  app.use('/api', burst, sustained, routes);

  // 404 for anything else.
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  // Central error handler. Maps known Postgres errors to clean 4xx and never
  // leaks internals for unexpected failures.
  app.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
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
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
