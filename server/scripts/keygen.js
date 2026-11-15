// Prints fresh secrets for .env (and the host's environment settings).
// Each must be different: VAULT_KEY encrypts the vault, AUTH_SECRET signs vault
// unlock tokens, OTP_SECRET hashes emailed codes.
const crypto = require('crypto');
console.log('VAULT_KEY=' + crypto.randomBytes(32).toString('hex'));
console.log('AUTH_SECRET=' + crypto.randomBytes(32).toString('hex'));
console.log('OTP_SECRET=' + crypto.randomBytes(32).toString('hex'));
