// Refuse to start without strong, distinct secrets. A missing secret used to
// fall back to a hardcoded default, which would let anyone forge tokens.
function checkSecrets() {
  const problems = [];
  const vault = process.env.VAULT_KEY || '';
  const auth = process.env.AUTH_SECRET || '';
  const otp = process.env.OTP_SECRET || '';
  if (!/^[0-9a-fA-F]{64}$/.test(vault)) problems.push('VAULT_KEY must be 64 hex characters');
  if (auth.length < 32) problems.push('AUTH_SECRET must be at least 32 characters');
  if (otp.length < 32) problems.push('OTP_SECRET must be at least 32 characters');
  if (new Set([vault, auth, otp]).size !== 3) problems.push('VAULT_KEY, AUTH_SECRET and OTP_SECRET must all be different');
  if (problems.length) {
    throw new Error('Server secrets are not configured: ' + problems.join('; ') + '. Generate them with: npm run keygen');
  }
}

module.exports = { checkSecrets };
