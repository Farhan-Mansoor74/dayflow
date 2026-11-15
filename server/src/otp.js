const crypto = require('crypto');
const { sendMail } = require('./mail');

const TTL_MS = (Number(process.env.OTP_TTL_MIN) || 5) * 60 * 1000;
const MAX_ATTEMPTS = 5;

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// HMAC so the plaintext code is never stored. OTP_SECRET is required at startup
// (config.js); there is deliberately no fallback.
function hashCode(code) {
  return crypto.createHmac('sha256', process.env.OTP_SECRET).update(String(code)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function maskEmail(e) {
  const [u, d] = String(e).split('@');
  if (!d) return e;
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d;
}

async function emailCode(to, name, code) {
  const mins = Math.round(TTL_MS / 60000);
  await sendMail({
    to,
    subject: 'Your Dayflow code: ' + code,
    text: `Hi ${name},\n\nYour Dayflow unlock code is ${code}\nIt expires in ${mins} minutes.\n\nIf you didn't request this, you can ignore it.`,
    html: `<p>Hi ${escapeHtml(name)},</p><p>Your Dayflow unlock code is:</p>`
      + `<p style="font-size:30px;font-weight:800;letter-spacing:6px;margin:8px 0">${escapeHtml(code)}</p>`
      + `<p style="color:#777">Expires in ${mins} minutes. If you didn't request this, you can ignore it.</p>`,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { TTL_MS, MAX_ATTEMPTS, generateCode, hashCode, safeEqual, maskEmail, emailCode };
