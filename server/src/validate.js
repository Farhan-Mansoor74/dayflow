// Strict, fail-closed validation for request bodies. Every public field is
// checked for type / length / range / enum. Unknown fields are ignored (not
// trusted). Throws HttpError(400) on the first problem.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const bad = (msg) => {
  throw new HttpError(400, msg);
};

function str(v, field, { required = false, max = 500, min = 0 } = {}) {
  if (v == null) {
    if (required) bad(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') bad(`${field} must be a string`);
  const s = v.trim();
  if (required && s.length < Math.max(min, 1)) bad(`${field} is required`);
  if (s.length < min) bad(`${field} must be at least ${min} characters`);
  if (s.length > max) bad(`${field} must be at most ${max} characters`);
  return s;
}

function enumVal(v, field, allowed, { required = false } = {}) {
  if (v == null) {
    if (required) bad(`${field} is required`);
    return undefined;
  }
  if (!allowed.includes(v)) bad(`${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

function bool(v, field) {
  if (v == null) return undefined;
  if (typeof v !== 'boolean') bad(`${field} must be a boolean`);
  return v;
}

function money(v, field, { required = false } = {}) {
  if (v == null || v === '') {
    if (required) bad(`${field} is required`);
    return undefined;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) bad(`${field} must be a number`);
  if (n < 0) bad(`${field} must be >= 0`);
  if (n > 1e12) bad(`${field} is too large`);
  return Math.round(n * 100) / 100;
}

// 'HH:MM' 24-hour, or '' / null to clear.
function timeOfDay(v, field) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
    bad(`${field} must be 'HH:MM' (24-hour)`);
  }
  return v;
}

// Array of integers 0..6.
function weekdays(v, field) {
  if (v == null) return undefined;
  if (!Array.isArray(v)) bad(`${field} must be an array`);
  const out = [];
  for (const d of v) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) bad(`${field} must contain integers 0..6`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// ISO date/datetime — returns a Date (Postgres will store it).
function dateVal(v, field, { required = false } = {}) {
  if (v == null || v === '') {
    if (required) bad(`${field} is required`);
    return undefined;
  }
  const d = new Date(v);
  if (isNaN(d.getTime())) bad(`${field} must be a valid date`);
  return d;
}

// 'YYYY-MM-DD' calendar date, returned as a string for a DATE column.
function ymd(v, field, { required = false } = {}) {
  if (v == null || v === '') {
    if (required) bad(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(`${field} must be 'YYYY-MM-DD'`);
  if (isNaN(new Date(v + 'T00:00:00').getTime())) bad(`${field} is not a real date`);
  return v;
}

// ---- Per-resource validators ----------------------------------------------
// Each returns an object whose keys are column names. `partial` (PATCH) only
// includes the fields that were actually present in the body.

// The account's own editable settings. email / picture / google_sub all come
// from Google and are never client-writable.
function userBody(b, partial = false) {
  const out = {};
  const name = str(b.name, 'name', { required: !partial, max: 60 });
  if (name !== undefined) out.name = name;
  const color = hexColor(b.color, 'color', { required: false });
  if (color !== undefined) out.color = color;
  if (b.cycleStartDay !== undefined) {
    const d = Number(b.cycleStartDay);
    if (!Number.isInteger(d) || d < 1 || d > 31) bad('cycleStartDay must be an integer 1..31');
    out.cycle_start_day = d;
  }
  // The browser reports this; reject anything Intl can't actually resolve, since
  // an unknown zone would throw inside the notification cron for every user.
  if (b.timezone !== undefined) {
    const tz = str(b.timezone, 'timezone', { max: 64 });
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    } catch {
      bad('timezone must be a valid IANA name like Asia/Dubai');
    }
    out.timezone = tz;
  }
  for (const [field, col] of [['digestHour', 'digest_hour'], ['wrapupHour', 'wrapup_hour']]) {
    if (b[field] === undefined) continue;
    const h = Number(b[field]);
    if (!Number.isInteger(h) || h < 0 || h > 23) bad(`${field} must be an integer 0..23`);
    out[col] = h;
  }
  for (const [field, col] of [['notifyDigest', 'notify_digest'], ['notifyHeadsUp', 'notify_headsup'], ['notifyWrapup', 'notify_wrapup']]) {
    const v = bool(b[field], field);
    if (v !== undefined) out[col] = v;
  }
  if (partial && Object.keys(out).length === 0) bad('no updatable fields provided');
  return out;
}

function taskBody(b, partial = false) {
  const out = {};
  const title = str(b.title, 'title', { required: !partial, max: 200 });
  if (title !== undefined) out.title = title;
  const type = enumVal(b.type, 'type', ['daily', 'weekly', 'onetime'], { required: !partial });
  if (type !== undefined) out.type = type;
  if (b.time !== undefined) out.time = timeOfDay(b.time, 'time') || null;
  const days = weekdays(b.days, 'days');
  if (days !== undefined) out.days = days;
  const completed = bool(b.completed, 'completed');
  if (completed !== undefined) out.completed = completed;
  if (partial && Object.keys(out).length === 0) bad('no updatable fields provided');
  return out;
}

function reminderBody(b, partial = false) {
  const out = {};
  const title = str(b.title, 'title', { required: !partial, max: 200 });
  if (title !== undefined) out.title = title;
  const dt = dateVal(b.datetime, 'datetime', { required: !partial });
  if (dt !== undefined) out.datetime = dt;
  const method = enumVal(b.method, 'method', ['notification', 'email'], { required: !partial });
  if (method !== undefined) out.method = method;
  if (b.email !== undefined) out.email = str(b.email, 'email', { max: 254 }) || '';
  const done = bool(b.done, 'done');
  if (done !== undefined) out.done = done;
  if (partial && Object.keys(out).length === 0) bad('no updatable fields provided');
  return out;
}

function expenseBody(b, partial = false) {
  const out = {};
  const title = str(b.title, 'title', { required: !partial, max: 200 });
  if (title !== undefined) out.title = title;
  const amount = money(b.amount, 'amount', { required: !partial });
  if (amount !== undefined) out.amount = amount;
  const type = enumVal(b.type, 'type', ['income', 'expense'], { required: !partial });
  if (type !== undefined) out.type = type;
  if (b.category !== undefined) out.category = str(b.category, 'category', { max: 40 }) || 'other';
  const date = ymd(b.date, 'date', { required: !partial });
  if (date !== undefined) out.date = date;
  if (b.note !== undefined) out.note = str(b.note, 'note', { max: 1000 }) || '';
  if (partial && Object.keys(out).length === 0) bad('no updatable fields provided');
  return out;
}

// Category colours get interpolated straight into inline `style` attributes on
// the client, so only a literal hex colour is accepted — never arbitrary CSS.
function hexColor(v, field, { required = false } = {}) {
  const s = str(v, field, { required, max: 7 });
  if (s === undefined) return undefined;
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) bad(`${field} must be a hex colour like #E8694A`);
  return s.toUpperCase();
}

// `key` is never client-supplied — the route slugifies it from the label.
// `parentKey` is accepted on create only; the route checks it exists and is
// itself top-level, then strips it on update so the tree can't be reshaped
// underneath existing expenses.
function categoryBody(b, partial = false) {
  const out = {};
  const label = str(b.label, 'label', { required: !partial, max: 40 });
  if (label !== undefined) out.label = label;
  const color = hexColor(b.color, 'color', { required: !partial });
  if (color !== undefined) out.color = color;
  if (b.parentKey !== undefined && b.parentKey !== null && b.parentKey !== '') {
    out.parent_key = str(b.parentKey, 'parentKey', { max: 40 });
  }
  if (partial && Object.keys(out).length === 0) bad('no updatable fields provided');
  return out;
}

// Vault keeps the plaintext password separate; the route encrypts it.
function vaultBody(b, partial = false) {
  const out = {};
  const label = str(b.label, 'label', { required: !partial, max: 120 });
  if (label !== undefined) out.label = label;
  if (b.username !== undefined) out.username = str(b.username, 'username', { max: 254 }) || '';
  if (b.notes !== undefined) out.notes = str(b.notes, 'notes', { max: 2000 }) || '';
  let password;
  if (b.password !== undefined) {
    if (b.password != null && typeof b.password !== 'string') bad('password must be a string');
    password = b.password == null ? '' : b.password;
    if (password.length > 1000) bad('password must be at most 1000 characters');
  }
  if (partial && label === undefined && b.username === undefined && b.notes === undefined && password === undefined) {
    bad('no updatable fields provided');
  }
  return { columns: out, password };
}

module.exports = {
  HttpError,
  userBody,
  taskBody,
  reminderBody,
  expenseBody,
  categoryBody,
  vaultBody,
};
