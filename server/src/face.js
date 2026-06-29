const { encrypt, decrypt } = require('./crypto');

// Distance below which two 128-d face descriptors are considered the same person.
// face-api.js convention: ~0.6 is loose, ~0.5 is stricter. Configurable.
const THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD) || 0.5;

function validDescriptor(arr) {
  return Array.isArray(arr) && arr.length === 128 && arr.every((n) => typeof n === 'number' && isFinite(n));
}

// Encrypt a descriptor for storage (rounded to 6 dp to keep it compact).
function encodeDescriptor(arr) {
  if (!validDescriptor(arr)) {
    const e = new Error('descriptor must be an array of 128 finite numbers');
    e.status = 400; e.expose = true; throw e;
  }
  return encrypt(JSON.stringify(arr.map((n) => Math.round(n * 1e6) / 1e6)));
}

function decodeDescriptor(blob) {
  try {
    const a = JSON.parse(decrypt(blob));
    return validDescriptor(a) ? a : null;
  } catch {
    return null;
  }
}

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

module.exports = { THRESHOLD, validDescriptor, encodeDescriptor, decodeDescriptor, distance };
