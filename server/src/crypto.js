const crypto = require('crypto');

// Vault passwords are encrypted at rest with AES-256-GCM. The key comes from
// the VAULT_KEY env var (64 hex chars = 32 bytes). Stored format is three
// base64 parts joined by ':'  ->  iv:authTag:ciphertext

function getKey() {
  const hex = process.env.VAULT_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const e = new Error(
      'VAULT_KEY missing or invalid. It must be 64 hex chars (32 bytes). Generate one with: npm run keygen'
    );
    e.status = 500;
    e.expose = true;
    throw e;
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString('base64')).join(':');
}

function decrypt(blob) {
  if (!blob) return '';
  const [ivB64, tagB64, ctB64] = String(blob).split(':');
  if (!ivB64 || !tagB64 || ctB64 == null) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// True only when a usable key is configured (used to gate vault endpoints).
function vaultEnabled() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

module.exports = { encrypt, decrypt, vaultEnabled };
