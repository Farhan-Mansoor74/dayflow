const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Household access key + signed device sessions.
//
// One shared secret (APP_ACCESS_KEY) protects the whole API. A device proves it
// knows the key once via POST /api/auth and receives a signed, time-limited
// session token (default 30 days). Every other route requires that token.
//
// The token is a tiny JWT-style value: base64url(payload).base64url(HMAC).
// We sign with AUTH_SECRET (falls back to VAULT_KEY) so the key itself is never
// embedded in the token.
// ---------------------------------------------------------------------------

const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

// A profile "unlock" (face match or emailed code) mints a short-lived token
// scoped to that one profile. Sensitive profile operations (vault, profile
// edit/delete, face enrollment) require it server-side, so a locked profile
// cannot be read or changed with the household key alone.
const PROFILE_TOKEN_MIN = Number(process.env.PROFILE_TOKEN_MIN) || 30;
const PROFILE_TOKEN_MS = PROFILE_TOKEN_MIN * 60 * 1000;

function accessKey() {
  return process.env.APP_ACCESS_KEY || '';
}

// When no key is configured the gate is OFF (open) — same opt-in pattern as the
// vault/push features. Production MUST set APP_ACCESS_KEY (see DEPLOY.md).
function authEnabled() {
  return accessKey().length > 0;
}

function signingSecret() {
  return process.env.AUTH_SECRET || process.env.VAULT_KEY || accessKey() || 'dayflow-auth';
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function hmac(data) {
  return crypto.createHmac('sha256', signingSecret()).update(data).digest();
}

// Constant-time string compare that won't throw on length mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still do a compare against self to keep timing flat
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function checkKey(provided) {
  if (!authEnabled()) return false;
  return safeEqual(provided || '', accessKey());
}

function issueToken() {
  const payload = { exp: Date.now() + SESSION_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmac(body));
  return { token: `${body}.${sig}`, expiresAt: payload.exp };
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expected = b64url(hmac(body));
  if (!safeEqual(sig, expected)) return false;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    return payload && typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

// ---- Per-profile unlock tokens (domain-separated from session tokens) ------
function issueProfileToken(profileId) {
  const payload = { pid: String(profileId), exp: Date.now() + PROFILE_TOKEN_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmac('profile:' + body)); // prefix keeps these distinct from session tokens
  return { token: `${body}.${sig}`, expiresAt: payload.exp };
}

function verifyProfileToken(token, profileId) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  if (!safeEqual(sig, b64url(hmac('profile:' + body)))) return false;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    return !!payload && payload.pid === String(profileId)
      && typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

// Express middleware — requires a valid Bearer session token. No-op when the
// gate is disabled (no key configured).
function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (verifyToken(token)) return next();
  return res.status(401).json({ error: 'authentication required' });
}

module.exports = { SESSION_DAYS, authEnabled, checkKey, issueToken, verifyToken, requireAuth, issueProfileToken, verifyProfileToken };
