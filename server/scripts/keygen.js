// Prints a fresh 32-byte vault key as 64 hex chars. Paste it into .env as VAULT_KEY.
const crypto = require('crypto');
console.log(crypto.randomBytes(32).toString('hex'));
