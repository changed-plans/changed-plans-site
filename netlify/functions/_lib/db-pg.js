'use strict';
/**
 * db-pg.js — Postgres data layer for PRODUCTION (Neon — Scott's pick).
 *
 * Drop-in replacement for _lib/db.js with the same exported surface
 * ({ run, get, all, now, newId, audit }) plus init(). Two differences,
 * both forced by Postgres being a network database:
 *
 *   1. ASYNC: run/get/all return Promises. Every function handler is
 *      already `async`, so the production cutover is mechanical: swap
 *      this file in as db.js and add `await` at the db.* call sites
 *      (listed in DEPLOY.md). The local sqlite db.js stays synchronous.
 *
 *   2. TRANSPORT: no `pg` package (zero-dependency rule). This adapter
 *      speaks Neon's HTTPS SQL endpoint directly with Node's fetch —
 *      the same protocol the official @neondatabase/serverless driver
 *      uses: POST https://<host>/sql with the connection string in the
 *      Neon-Connection-String header and { query, params } as JSON.
 *      Point DATABASE_URL at the Neon pooled connection string.
 *
 * Placeholders: call sites write sqlite-style `?`; translate() rewrites
 * them to $1..$n in order. SQL dialect notes handled here or documented:
 *   - INSERT OR IGNORE (used by tools/seed.js) -> append
 *     "ON CONFLICT DO NOTHING" via translate() — seed is local-only
 *     tooling; production data is created through the API.
 *   - AUTOINCREMENT -> BIGSERIAL (audit_log.id, see DDL).
 *   - Booleans are stored as INTEGER 0/1 in both dialects by design
 *     (schema kept identical so rows mean the same thing everywhere).
 *
 * NOTHING here runs at require time and nothing connects until init()
 * or the first query — safe to keep in the tree while local dev uses
 * sqlite. No account is provisioned by this file; DATABASE_URL comes
 * from Scott at deploy time (see DEPLOY.md).
 */
const crypto = require('node:crypto');

const DATABASE_URL = process.env.DATABASE_URL || '';

/** Base HTTPS endpoint for the Neon SQL API, derived from DATABASE_URL. */
function neonSqlEndpoint(databaseUrl) {
  const u = new URL(databaseUrl);
  // The SQL-over-HTTP endpoint lives on the same host as the pooled
  // connection string (…-pooler.<region>.aws.neon.tech) at path /sql.
  return `${u.protocol}//${u.host}/sql`;
}

/** Rewrite sqlite `?` placeholders to Postgres $1..$n, in order. */
function translate(sql) {
  let n = 0;
  let out = sql.replace(/\?/g, () => `$${++n}`);
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(out)) {
    out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
  }
  return out;
}

async function query(sql, params = []) {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set (Neon connection string required).');
  const res = await fetch(neonSqlEndpoint(DATABASE_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Neon-Connection-String': DATABASE_URL,
    },
    body: JSON.stringify({ query: translate(sql), params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Neon query failed (${res.status}): ${(data && data.message) || 'unknown error'}`);
  }
  // Neon returns rows as arrays + a fields list; normalize to objects.
  const fields = (data.fields || []).map((f) => f.name);
  const rows = (data.rows || []).map((r) => Object.fromEntries(r.map((v, i) => [fields[i], v])));
  return { rows, rowCount: data.rowCount != null ? data.rowCount : rows.length };
}

async function run(sql, ...params) {
  const r = await query(sql, params);
  return { changes: r.rowCount };
}
async function get(sql, ...params) {
  const r = await query(sql, params);
  return r.rows[0];
}
async function all(sql, ...params) {
  const r = await query(sql, params);
  return r.rows;
}

function now() { return new Date().toISOString(); }

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

async function audit(entity, entityId, fromStatus, toStatus, actor, note) {
  await run(
    'INSERT INTO audit_log (entity, entity_id, from_status, to_status, actor, note, at) VALUES (?,?,?,?,?,?,?)',
    entity, entityId, fromStatus || null, toStatus, actor || null, note || null, now()
  );
}

/** The Postgres schema — column-for-column the sqlite schema in db.js,
 *  including the Phase 2 pricing columns, with Postgres types. */
const DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'fan',
    first_transaction_completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS magic_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES users(id),
    event_name TEXT NOT NULL,
    event_date TEXT NOT NULL,
    venue TEXT NOT NULL,
    location TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Concerts',
    seats TEXT NOT NULL,
    qty INTEGER NOT NULL,
    face_price_cents INTEGER NOT NULL CHECK (face_price_cents > 0),
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    restrictions TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    transfer_status TEXT NOT NULL DEFAULT 'not_transferred',
    transfer_ref TEXT,
    initial_price_cents INTEGER,
    pocket_floor_cents INTEGER,
    endgame_floor_cents INTEGER,
    endgame_authorized INTEGER NOT NULL DEFAULT 0,
    price_drops_enabled INTEGER NOT NULL DEFAULT 0,
    endgame_window_hours INTEGER NOT NULL DEFAULT 12,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (price_cents <= face_price_cents)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    buyer_id TEXT NOT NULL REFERENCES users(id),
    seller_id TEXT NOT NULL REFERENCES users(id),
    qty INTEGER NOT NULL,
    face_total_cents INTEGER NOT NULL,
    price_total_cents INTEGER NOT NULL,
    buyer_fee_cents INTEGER NOT NULL,
    fee_waived INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved',
    reserved_until TEXT,
    held_since TEXT,
    stripe_checkout_session_id TEXT,
    stripe_payment_intent_id TEXT,
    refund_reason TEXT,
    refunded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    listing_id TEXT REFERENCES listings(id),
    order_id TEXT REFERENCES orders(id),
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    handled_by TEXT REFERENCES users(id),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
    seller_id TEXT NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL,
    method TEXT NOT NULL DEFAULT 'manual_bank',
    status TEXT NOT NULL DEFAULT 'pending',
    external_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS disputes (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    opened_by TEXT NOT NULL REFERENCES users(id),
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    assigned_to TEXT REFERENCES users(id),
    due_at TEXT NOT NULL,
    resolution TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT,
    note TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status_reserved ON orders (status, reserved_until);
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings (status, transfer_status);
`;

/** Run once at deploy/bootstrap: create the schema if absent. */
async function init() {
  // The Neon HTTP endpoint takes one statement per call.
  for (const stmt of DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await query(stmt, []);
  }
}

module.exports = { run, get, all, now, newId, audit, init, translate, DDL };
