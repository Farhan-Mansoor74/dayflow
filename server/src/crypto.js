const crypto = require('crypto');

// Vault secrets (label, username, password, notes) and face descriptors are
// encrypted at rest with AES-256-GCM.
//
// Current format, "v2":  v2:ivB64:tagB64:ciphertextB64
//   The key is per user: HKDF-SHA256(VAULT_KEY, salt = user id). One user's
//   ciphertext can't be decrypted or swapped into another user's row.
// Legacy format (no prefix):  ivB64:tagB64:ciphertextB64
//   Encrypted with VAULT_KEY directly. Still readable; scripts/migrate-vault-v2.js
//   rewrites old rows into v2.

function masterKey() {
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

function userKey(userId) {
  if (!userId) throw new Error('user id required for vault encryption');
  return Buffer.from(crypto.hkdfSync('sha256', masterKey(), Buffer.from(String(userId)), 'dayflow-vault-v2', 32));
}

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join(':');
}

function open(key, parts) {
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

function encrypt(plain, userId) {
  if (plain == null || plain === '') return '';
  return 'v2:' + seal(userKey(userId), plain);
}

// Throws if the ciphertext was tampered with or belongs to another user.
function decrypt(blob, userId) {
  if (!blob) return '';
  const parts = String(blob).split(':');
  if (parts[0] === 'v2' && parts.length === 4) return open(userKey(userId), parts.slice(1));
  if (parts.length === 3) return open(masterKey(), parts); // legacy
  throw new Error('unrecognised ciphertext format');
}

// For columns that held plaintext before encryption was added (vault label,
// username, notes): a value without the v2 prefix is returned as-is until the
// migration script has rewritten it.
function decryptField(value, userId) {
  return String(value || '').startsWith('v2:') ? decrypt(value, userId) : (value || '');
}

const isV2 = (value) => String(value || '').startsWith('v2:');

// True only when a usable key is configured (used to gate vault endpoints).
function vaultEnabled() {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

module.exports = { encrypt, decrypt, decryptField, isV2, vaultEnabled };
