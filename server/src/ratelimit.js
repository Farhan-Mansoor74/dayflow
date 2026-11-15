const rateLimit = require('express-rate-limit');
const { query } = require('./db');

// Rate-limit counters kept in Postgres (table rate_limits), so every serverless
// instance shares them. In-memory counters reset on each cold start and are
// per-instance, which is what made the security-critical limits bypassable.
class PgStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.localKeys = false; // counts are shared across instances
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const { rows } = await query(
      `INSERT INTO rate_limits (key, hits, reset_at)
       VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE SET
         hits     = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [this.prefix + key, String(this.windowMs)]
    );
    // Occasional cleanup of long-expired counters.
    if (Math.random() < 0.01) query("DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'").catch(() => {});
    return { totalHits: rows[0].hits, resetTime: new Date(rows[0].reset_at) };
  }

  async decrement(key) {
    await query('UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1', [this.prefix + key]);
  }

  async resetKey(key) {
    await query('DELETE FROM rate_limits WHERE key = $1', [this.prefix + key]);
  }
}

// A limiter that answers 429 with Retry-After (standard headers) and logs the
// hit. `byUser` keys on the signed-in user (route must sit after requireAuth);
// otherwise on the client IP. `shared` puts the counter in Postgres.
function limiter({ name, windowMs, limit, message, byUser = false, shared = true }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: shared ? new PgStore(name + ':') : undefined,
    keyGenerator: byUser ? (req) => 'u:' + req.userId : undefined,
    handler: (req, res, _next, options) => {
      console.warn(`[ratelimit] ${name} exceeded by ${byUser ? 'user ' + req.userId : 'ip ' + req.ip}`);
      res.status(options.statusCode).json({ error: message });
    },
  });
}

module.exports = { limiter };
