const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { query } = require('./db');

// ---------------------------------------------------------------------------
// Google sign-in + server-side sessions.
//
// The browser gets an ID token from Google Identity Services and posts it to
// POST /api/auth/google. We verify it against Google's public keys, look up (or
// create) the matching row in `users`, and start a session.
//
// A session is a random 256-bit token sent to the browser in an HttpOnly,
// SameSite=Strict cookie (scripts on the page can't read it). Only its SHA-256
// hash is stored in `sessions`, so a database leak doesn't hand out live
// sessions. Deleting the row ends the session: that's what sign-out and "sign
// out everywhere" do. Sessions last SESSION_DAYS and slide forward while used.
// ---------------------------------------------------------------------------

const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 60 * 60 * 1000; // extend at most once an hour

// A vault "step-up" (face match or emailed code) mints a short-lived token tied
// to this user AND this session, so signing out also voids it.
const STEPUP_MIN = Number(process.env.STEPUP_TOKEN_MIN) || 10;
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

const authError = (msg, status = 401) => Object.assign(new Error(msg), { status, expose: true });

// Verify a Google ID token. Throws 401 if it is malformed, expired, signed by
// the wrong key, or issued for a different client. Returns the claims we use.
async function verifyGoogleCredential(credential) {
  if (typeof credential !== 'string' || credential.length < 20 || credential.length > 8192) {
    throw authError('invalid Google credential', 400);
  }
  let p;
  try {
    const ticket = await client().verifyIdToken({ idToken: credential, audience: googleClientId() });
    p = ticket.getPayload();
  } catch {
    // The library's messages can quote the token or its claims; never surface or log them.
    throw authError('invalid Google credential');
  }
  if (!p || !p.sub) throw authError('invalid Google credential');
  // An unverified email must never claim an existing backfilled account.
  if (!p.email || p.email_verified !== true) {
    throw authError('your Google account has no verified email address');
  }
  return { sub: p.sub, email: p.email, name: p.name || p.email.split('@')[0], picture: p.picture || '' };
}

// New accounts only for addresses in ALLOWED_EMAILS (comma-separated). Accounts
// that already exist can always sign in.
function signupAllowed(email) {
  const list = (process.env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(email).toLowerCase());
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Constant-time string compare that won't throw on length mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // keep timing flat
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// ---- session cookie ----------------------------------------------------------
// Over HTTPS the cookie uses the __Host- prefix, which the browser only accepts
// with Secure, Path=/ and no Domain. Plain-HTTP local development drops both.
const cookieName = (req) => (req.secure ? '__Host-dayflow_sid' : 'dayflow_sid');

function readSessionCookie(req) {
  const name = cookieName(req);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function setSessionCookie(req, res, token, expiresAt) {
  const attrs = [
    `${cookieName(req)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
  ];
  if (req.secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${cookieName(req)}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (req.secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

// ---- sessions ------------------------------------------------------------------
async function startSession(req, res, userId) {
  const token = b64url(crypto.randomBytes(32));
  const expiresAt = Date.now() + SESSION_MS;
  await query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, sha256(token), new Date(expiresAt)]
  );
  // Housekeeping: drop this user's expired sessions.
  await query('DELETE FROM sessions WHERE user_id = $1 AND expires_at < now()', [userId]);
  setSessionCookie(req, res, token, expiresAt);
  return expiresAt;
}

async function endSession(req, res) {
  const token = readSessionCookie(req);
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  clearSessionCookie(req, res);
}

async function endAllSessions(req, res, userId) {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  clearSessionCookie(req, res);
}

// Express middleware: requires a live session and puts the signed-in user's id
// (and the session id) on the request. Every route below it reads and writes
// exactly one user's data.
async function requireAuth(req, res, next) {
  try {
    const token = readSessionCookie(req);
    if (!token || token.length > 100) return res.status(401).json({ error: 'authentication required' });
    const { rows } = await query(
      'SELECT id, user_id, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > now()',
      [sha256(token)]
    );
    if (!rows[0]) {
      clearSessionCookie(req, res);
      return res.status(401).json({ error: 'authentication required' });
    }
    const s = rows[0];
    // Sliding expiry: keep an active session alive, at most one write an hour.
    if (new Date(s.expires_at).getTime() < Date.now() + SESSION_MS - RENEW_AFTER_MS) {
      const expiresAt = Date.now() + SESSION_MS;
      await query('UPDATE sessions SET expires_at = $1 WHERE id = $2', [new Date(expiresAt), s.id]);
      setSessionCookie(req, res, token, expiresAt);
    }
    req.userId = s.user_id;
    req.sessionId = s.id;
    return next();
  } catch (e) {
    return next(e);
  }
}

// ---- vault step-up tokens ------------------------------------------------------
function hmac(data) {
  return crypto.createHmac('sha256', process.env.AUTH_SECRET).update(data).digest();
}

function issueStepUpToken(userId, sessionId) {
  const payload = { uid: String(userId), sid: String(sessionId), exp: Date.now() + STEPUP_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmac('stepup:' + body));
  return { token: `${body}.${sig}`, expiresAt: payload.exp };
}

function verifyStepUpToken(token, userId, sessionId) {
  if (typeof token !== 'string' || token.length > 500 || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  if (!safeEqual(sig, b64url(hmac('stepup:' + body)))) return false;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    return !!payload && payload.uid === String(userId) && payload.sid === String(sessionId)
      && typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

module.exports = {
  SESSION_DAYS,
  googleClientId,
  googleEnabled,
  verifyGoogleCredential,
  signupAllowed,
  startSession,
  endSession,
  endAllSessions,
  requireAuth,
  issueStepUpToken,
  verifyStepUpToken,
};
