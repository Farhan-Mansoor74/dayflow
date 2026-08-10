const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

// ---------------------------------------------------------------------------
// Google sign-in + signed device sessions.
//
// The browser gets an ID token from Google Identity Services and posts it to
// POST /api/auth/google. We verify it against Google's public keys, look up (or
// create) the matching row in `users`, and issue a session token carrying that
// user's id. Every other route requires that token and serves only that user's
// rows.
//
// The session token is a tiny JWT-style value: base64url(payload).base64url(HMAC),
// signed with AUTH_SECRET (falls back to VAULT_KEY).
// ---------------------------------------------------------------------------

const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

// A vault "step-up" (face match or emailed code) mints a short-lived token
// scoped to that one user. The vault routes require it server-side, so being
// signed in is not on its own enough to read stored passwords.
const STEPUP_MIN = Number(process.env.STEPUP_TOKEN_MIN) || Number(process.env.PROFILE_TOKEN_MIN) || 30;
const STEPUP_MS = STEPUP_MIN * 60 * 1000;

function googleClientId() {
  return process.env.GOOGLE_CLIENT_ID || '';
}

function googleEnabled() {
  return googleClientId().length > 0;
}

let oauthClient = null;
function client() {
  if (!oauthClient) oauthClient = new OAuth2Client(googleClientId());
  return oauthClient;
}

// Verify a Google ID token. Throws if it is malformed, expired, signed by the
// wrong key, or issued for a different client. Returns the claims we use.
async function verifyGoogleCredential(credential) {
  if (typeof credential !== 'string' || credential.length < 20 || credential.length > 8192) {
    throw Object.assign(new Error('invalid Google credential'), { status: 400, expose: true });
  }
  const ticket = await client().verifyIdToken({ idToken: credential, audience: googleClientId() });
  const p = ticket.getPayload();
  if (!p || !p.sub) throw Object.assign(new Error('invalid Google credential'), { status: 401, expose: true });
  // An unverified email must never claim an existing backfilled account.
  if (!p.email || p.email_verified !== true) {
    throw Object.assign(new Error('your Google account has no verified email address'), { status: 401, expose: true });
  }
  return { sub: p.sub, email: p.email, name: p.name || p.email.split('@')[0], picture: p.picture || '' };
}

function signingSecret() {
  return process.env.AUTH_SECRET || process.env.VAULT_KEY || 'dayflow-auth';
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

function issueToken(userId) {
  const payload = { uid: String(userId), exp: Date.now() + SESSION_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmac(body));
  return { token: `${body}.${sig}`, expiresAt: payload.exp };
}

// Returns the payload ({ uid, exp }) when the token is valid, else null.
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (!safeEqual(sig, b64url(hmac(body)))) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    if (!payload || typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

// ---- Vault step-up tokens (domain-separated from session tokens) -----------
function issueStepUpToken(userId) {
  const payload = { uid: String(userId), exp: Date.now() + STEPUP_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmac('stepup:' + body)); // prefix keeps these distinct from session tokens
  return { token: `${body}.${sig}`, expiresAt: payload.exp };
}

function verifyStepUpToken(token, userId) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  if (!safeEqual(sig, b64url(hmac('stepup:' + body)))) return false;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    return !!payload && payload.uid === String(userId)
      && typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

// Express middleware — requires a valid Bearer session token and puts the
// signed-in user's id on the request. There is no "gate off" mode: every route
// below it reads and writes exactly one user's data.
function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'authentication required' });
  req.userId = payload.uid;
  return next();
}

module.exports = {
  SESSION_DAYS,
  googleClientId,
  googleEnabled,
  verifyGoogleCredential,
  issueToken,
  verifyToken,
  requireAuth,
  issueStepUpToken,
  verifyStepUpToken,
};
