'use strict';
/**
 * auth.js — email magic-link sign-in + sessions + admin authorization.
 *
 * Flow: request-link (email) -> token row (hashed, single-use, 15 min) ->
 * verify (link click) -> HMAC-signed session cookie (30 days).
 *
 * Magic-link delivery goes through _lib/mailer.js (Resend). Without a
 * RESEND_API_KEY the mailer is in stub mode (logs only); in APP_ENV=local
 * the link is also returned in the API response so the scaffold stays
 * fully testable. NEVER return the link when APP_ENV=production.
 *
 * ADMIN (Phase 2 — production design): an admin is a signed-in user whose
 * row has role='admin'. Every /api/admin/* handler calls requireAdmin(),
 * which returns the admin's user row, so every admin action is recorded
 * under a NAMED HUMAN (Code #8) in the audit log and on transfer rows.
 *
 * LOCAL-DEV FALLBACK (clearly marked, dev only): when APP_ENV=local, the
 * old shared `Authorization: Bearer <ADMIN_TOKEN>` header is also accepted
 * and maps to a synthetic "Local Dev (token)" actor. Outside local mode
 * the token path is dead code — production refuses placeholder secrets at
 * boot (below) and requireAdmin ignores the header entirely.
 */
const crypto = require('node:crypto');
const db = require('./db');
const mailer = require('./mailer');
const { header } = require('./http');

const SESSION_SECRET = process.env.SESSION_SECRET || 'LOCAL-DEV-PLACEHOLDER-CHANGE-ME';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'LOCAL-DEV-ADMIN-TOKEN';
const IS_LOCAL = (process.env.APP_ENV || 'local') === 'local';

// ADMIN_TOKEN is intentionally UNSET in production (ENV-CHECKLIST: local-dev
// fallback only, "do not set it in Netlify"), so its unset fallback value must
// not trip this guard — only a token that is actually set to a placeholder
// does. SESSION_SECRET, by contrast, is required in production, so its unset
// fallback ('PLACEHOLDER…') correctly refuses boot.
const adminTokenPlaceholder = Boolean(process.env.ADMIN_TOKEN) && ADMIN_TOKEN.includes('LOCAL-DEV');
if (!IS_LOCAL && (SESSION_SECRET.includes('PLACEHOLDER') || adminTokenPlaceholder)) {
  throw new Error('Refusing to run outside local mode with placeholder secrets.');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Find-or-create a user by email (sign-in and first listing both start here). */
async function upsertUserByEmail(email, displayName) {
  const normalized = String(email || '').trim().toLowerCase();
  let user = await db.get('SELECT * FROM users WHERE email = ?', normalized);
  if (!user) {
    const id = db.newId('usr');
    await db.run(
      'INSERT INTO users (id, email, display_name, role, first_transaction_completed, created_at) VALUES (?,?,?,?,0,?)',
      id, normalized, displayName || null, 'fan', db.now()
    );
    user = await db.get('SELECT * FROM users WHERE id = ?', id);
  }
  return user;
}

async function createMagicToken(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await db.run('INSERT INTO magic_tokens (token_hash, user_id, expires_at) VALUES (?,?,?)',
    hashToken(token), userId, expires);
  return token;
}

/** Send the sign-in link via Resend (mailer stub-mode logs when keyless).
 *  Returns the link ONLY in local mode (dev/testing); null in production. */
function deliverMagicLink(email, token) {
  const base = process.env.APP_BASE_URL || 'http://localhost:8888';
  // APP_BASE_URL points at the app root (…/app in production); the API
  // routes live at the SITE root, so build the verify link from the
  // origin — otherwise the emailed link 404s under the /app/ layout.
  let origin = base;
  try { origin = new URL(base).origin; } catch { /* keep the raw base */ }
  const link = `${origin}/api/auth/verify?token=${token}`;
  // Fire-and-forget: a mail hiccup must not break the sign-in request.
  mailer.sendMail({
    to: email,
    subject: 'Your Changed Plans sign-in link',
    text:
      `Sign in to Changed Plans:\n\n${link}\n\n` +
      'This link works once and expires in 15 minutes. ' +
      'If you didn\'t ask for it, you can ignore this email.',
  }).catch((err) => console.error('[magic-link] mailer threw:', err));
  if (mailer.isStub()) console.log(`[magic-link] for ${email}: ${link}`);
  return IS_LOCAL ? link : null;
}

async function consumeMagicToken(token) {
  const row = await db.get('SELECT * FROM magic_tokens WHERE token_hash = ?', hashToken(token || ''));
  if (!row || row.used_at) return null;
  if (row.expires_at < db.now()) return null;
  await db.run('UPDATE magic_tokens SET used_at = ? WHERE token_hash = ?', db.now(), row.token_hash);
  return await db.get('SELECT * FROM users WHERE id = ?', row.user_id);
}

function signSession(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function sessionCookie(userId) {
  return `cp_session=${signSession(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
}

async function userFromEvent(event) {
  const cookie = header(event, 'cookie') || '';
  const m = cookie.match(/cp_session=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { uid } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return (await db.get('SELECT * FROM users WHERE id = ?', uid)) || null;
  } catch { return null; }
}

/**
 * Phase 2 admin authorization (production path): the session user with
 * role='admin', or null. Handlers use the returned row for the actor name
 * and for transfers.handled_by — admin work carries a named human.
 */
async function adminUser(event) {
  const user = await userFromEvent(event);
  if (user && user.role === 'admin') return user;
  // === LOCAL-DEV FALLBACK ONLY ==========================================
  // APP_ENV=local + the shared bearer token maps to a synthetic actor so
  // the desk APIs stay curl-able in development. `via_token` marks it: it
  // has no users row, so handlers must NOT write it into handled_by FKs.
  // In production this branch is unreachable (IS_LOCAL is false).
  if (IS_LOCAL) {
    const authz = header(event, 'authorization') || '';
    if (authz === `Bearer ${ADMIN_TOKEN}`) {
      return { id: null, email: 'local-dev@localhost', display_name: 'Local Dev (token)', role: 'admin', via_token: true };
    }
  }
  // ======================================================================
  return null;
}

/** True when the caller may use /api/admin/* (see adminUser). */
async function isAdmin(event) { return !!(await adminUser(event)); }

/** Public shape of a user — never leak internal flags beyond what the UI needs. */
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    firstTransactionCompleted: !!user.first_transaction_completed,
  };
}

module.exports = {
  upsertUserByEmail, createMagicToken, deliverMagicLink, consumeMagicToken,
  sessionCookie, userFromEvent, adminUser, isAdmin, publicUser, IS_LOCAL,
};
