'use strict';
/**
 * proof-scheduler.js — TEMPORARY, SELF-CLEANING proof endpoint.
 * POST /api/proof-scheduler  { action: 'setup' | 'status' | 'cleanup' }
 *
 * Purpose (2026-11-05): run the POPULATED scheduler proof against the
 * real production site without touching live Stripe keys, real listings,
 * or any real person's account. `setup` plants ONE synthetic listing +
 * ONE synthetic order whose 15-minute hold has ALREADY expired, in
 * exactly the state checkout-create would have left them — then the
 * unattended Netlify scheduled-sweep (every 5 min) either releases them
 * (order -> cancelled, listing -> active, audit actor 'scheduled-sweep')
 * or it doesn't, and `status` shows which. `cleanup` deletes every proof
 * record. The proof buyer is a dedicated synthetic account; the seller is
 * Scott's existing row, looked up SELECT-only and never created/modified.
 *
 * This function NEVER calls Stripe and NEVER sends email. Every query is
 * scoped to the proof records (proof buyer email / proof event name) —
 * it is incapable of touching any other listing, order, or user.
 *
 * AUTH GATE: the `x-proof-secret` header must equal the PROOF_SECRET env
 * var. If PROOF_SECRET is unset/empty the function refuses EVERYTHING —
 * that is the self-disabling mechanism.
 *
 * REMOVAL (do all three when the proof is done):
 *   1. Delete this file (netlify/functions/proof-scheduler.js).
 *   2. Remove the /api/proof-scheduler [[redirects]] block in netlify.toml.
 *   3. Remove the PROOF_SECRET env var in Netlify (site env settings).
 * Removing #3 alone disables the endpoint even if the file still deploys.
 */
const crypto = require('node:crypto');
const db = require('./_lib/db');
const { ok, badRequest, forbidden, notFound, serverError, parseBody, header } = require('./_lib/http');
const { transitionListing } = require('./_lib/state');

const ACTOR = 'proof-scheduler';
const PROOF_BUYER_EMAIL = 'proof-buyer@myplanschanged.com';
const PROOF_BUYER_NAME = 'Scheduler Proof (automated test)';
const PROOF_EVENT_NAME = 'SCHEDULER PROOF — NOT A REAL EVENT (auto-test, do not buy)';
const SELLER_EMAIL = 'seugeneb@comcast.net';
const PROOF_RESTRICTIONS = 'Automated scheduler proof record. Not a real event.';

function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function inClause(ids) { return ids.map(() => '?').join(','); }

/** Locate every proof record id (buyer, listings by event name, their orders). */
async function findProofRecords() {
  const buyer = await db.get('SELECT * FROM users WHERE email = ?', PROOF_BUYER_EMAIL);
  const listings = await db.all('SELECT * FROM listings WHERE event_name = ?', PROOF_EVENT_NAME);
  const listingIds = listings.map((l) => l.id);
  const orderIdSet = new Set();
  if (listingIds.length) {
    const byListing = await db.all(
      `SELECT id FROM orders WHERE listing_id IN (${inClause(listingIds)})`, ...listingIds
    );
    byListing.forEach((o) => orderIdSet.add(o.id));
  }
  if (buyer) {
    const byBuyer = await db.all('SELECT id FROM orders WHERE buyer_id = ?', buyer.id);
    byBuyer.forEach((o) => orderIdSet.add(o.id));
  }
  return { buyer, listings, listingIds, orderIds: [...orderIdSet] };
}

/**
 * Delete ALL proof records (and only proof records), FK-safe order:
 * disputes/payouts/transfers -> orders -> listings -> magic_tokens ->
 * audit rows -> the proof buyer. Scott's seller row is never touched.
 * Returns per-table delete counts.
 */
async function deleteProofRecords() {
  const { buyer, listingIds, orderIds } = await findProofRecords();
  const counts = { disputes: 0, payouts: 0, transfers: 0, orders: 0, listings: 0, magic_tokens: 0, audit_log: 0, users: 0 };

  if (orderIds.length) {
    counts.disputes += (await db.run(`DELETE FROM disputes WHERE order_id IN (${inClause(orderIds)})`, ...orderIds)).changes;
    counts.payouts += (await db.run(`DELETE FROM payouts WHERE order_id IN (${inClause(orderIds)})`, ...orderIds)).changes;
    counts.transfers += (await db.run(`DELETE FROM transfers WHERE order_id IN (${inClause(orderIds)})`, ...orderIds)).changes;
  }
  if (listingIds.length) {
    counts.transfers += (await db.run(`DELETE FROM transfers WHERE listing_id IN (${inClause(listingIds)})`, ...listingIds)).changes;
  }
  if (buyer) {
    counts.transfers += (await db.run('DELETE FROM transfers WHERE handled_by = ?', buyer.id)).changes;
    counts.magic_tokens += (await db.run('DELETE FROM magic_tokens WHERE user_id = ?', buyer.id)).changes;
  }
  if (orderIds.length) {
    counts.orders += (await db.run(`DELETE FROM orders WHERE id IN (${inClause(orderIds)})`, ...orderIds)).changes;
    counts.audit_log += (await db.run(
      `DELETE FROM audit_log WHERE entity = 'order' AND entity_id IN (${inClause(orderIds)})`, ...orderIds
    )).changes;
  }
  if (listingIds.length) {
    counts.listings += (await db.run(`DELETE FROM listings WHERE id IN (${inClause(listingIds)})`, ...listingIds)).changes;
    counts.audit_log += (await db.run(
      `DELETE FROM audit_log WHERE entity = 'listing' AND entity_id IN (${inClause(listingIds)})`, ...listingIds
    )).changes;
  }
  if (buyer) {
    counts.audit_log += (await db.run(
      "DELETE FROM audit_log WHERE entity = 'user' AND entity_id = ?", buyer.id
    )).changes;
    // Double-scoped: the proof buyer's id AND the proof email must both match.
    counts.users += (await db.run(
      'DELETE FROM users WHERE id = ? AND email = ?', buyer.id, PROOF_BUYER_EMAIL
    )).changes;
  }
  return counts;
}

async function setup() {
  // Seller: SELECT only. If Scott's row is somehow absent, fail loudly —
  // NEVER create a seller for a proof.
  const seller = await db.get('SELECT * FROM users WHERE email = ?', SELLER_EMAIL);
  if (!seller) {
    throw new Error(`Scheduler proof aborted: seller row for ${SELLER_EMAIL} not found; refusing to create one.`);
  }

  // Idempotency: wipe any prior proof records, then plant fresh ones.
  await deleteProofRecords();

  // Proof buyer: find-or-create. first_transaction_completed = 1 keeps the
  // account clearly out of first-transaction semantics.
  let buyer = await db.get('SELECT * FROM users WHERE email = ?', PROOF_BUYER_EMAIL);
  if (!buyer) {
    const buyerId = db.newId('usr');
    const ts = db.now();
    await db.run(
      'INSERT INTO users (id, email, display_name, role, first_transaction_completed, created_at) VALUES (?,?,?,?,1,?)',
      buyerId, PROOF_BUYER_EMAIL, PROOF_BUYER_NAME, 'fan', ts
    );
    buyer = await db.get('SELECT * FROM users WHERE id = ?', buyerId);
    await db.audit('user', buyer.id, null, 'created', ACTOR,
      'Scheduler proof: dedicated synthetic proof buyer created (not a real person)');
  } else if (!buyer.first_transaction_completed) {
    await db.run('UPDATE users SET first_transaction_completed = 1 WHERE id = ?', buyer.id);
    buyer.first_transaction_completed = 1;
  }

  // Proof listing: created DIRECTLY at active + transfer verified — a
  // synthetic record that bypasses intake on purpose (mirrors the column
  // set listings-create writes). price_drops_enabled = 0 keeps the pricing
  // sweep away from it; floors sit at the $1 price regardless.
  const listingId = db.newId('lst');
  const ts = db.now();
  await db.run(
    `INSERT INTO listings (id, seller_id, event_name, event_date, venue, location, category,
       seats, qty, face_price_cents, price_cents, restrictions, status, transfer_status,
       initial_price_cents, pocket_floor_cents, endgame_floor_cents, endgame_authorized,
       price_drops_enabled, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    listingId, seller.id, PROOF_EVENT_NAME, '2027-01-01', 'Proof Venue', 'Test City', 'Concerts',
    'GA 1', 1, 100, 100, PROOF_RESTRICTIONS, 'active', 'verified',
    100, 100, 100, 0, 0, ts, ts
  );
  await db.audit('listing', listingId, null, 'active', ACTOR,
    'Scheduler proof: synthetic listing created directly at active/verified (bypasses intake) — NOT A REAL EVENT');

  // Proof order: created DIRECTLY in 'reserved' with the hold ALREADY
  // expired (reserved_until = now - 60s), mirroring checkout-create's
  // insert — except stripe_checkout_session_id stays NULL: no Stripe
  // session exists for this order, ever. $1 ticket: price 100, fee 0
  // (fee_waived = 1), total 100. The amounts are irrelevant to the sweep;
  // only status + reserved_until drive it.
  const orderId = db.newId('ord');
  const ots = db.now();
  const reservedUntil = new Date(Date.now() - 60 * 1000).toISOString();
  await db.run(
    `INSERT INTO orders (id, listing_id, buyer_id, seller_id, qty, face_total_cents,
       price_total_cents, buyer_fee_cents, fee_waived, total_cents, status,
       reserved_until, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'reserved', ?, ?, ?)`,
    orderId, listingId, buyer.id, seller.id, 1,
    100, 100, 0, 1, 100,
    reservedUntil, ots, ots
  );
  await db.audit('order', orderId, null, 'reserved', ACTOR,
    'Scheduler proof: synthetic order created directly in reserved with an already-expired hold — no Stripe session, no payment');

  // Leave the listing in the state a real checkout would have left it in:
  // active -> reserved, through the state machine, exactly like checkout.
  await transitionListing(listingId, 'reserved', ACTOR,
    `Held for proof order ${orderId} (scheduler proof — hold already expired; awaiting scheduled-sweep)`);

  const orderRow = await db.get('SELECT * FROM orders WHERE id = ?', orderId);
  const listingRow = await db.get('SELECT * FROM listings WHERE id = ?', listingId);
  return ok({
    listing_id: listingId,
    order_id: orderId,
    reserved_until: reservedUntil,
    state_before: {
      order_status: orderRow.status,
      listing_status: listingRow.status,
      listing_transfer_status: listingRow.transfer_status,
      reserved_until: orderRow.reserved_until,
    },
  });
}

async function status() {
  const listing = await db.get(
    'SELECT * FROM listings WHERE event_name = ? ORDER BY created_at DESC LIMIT 1', PROOF_EVENT_NAME
  );
  if (!listing) {
    return ok({ found: false, proof_event_name: PROOF_EVENT_NAME, proof_buyer_email: PROOF_BUYER_EMAIL });
  }
  const order = await db.get(
    'SELECT * FROM orders WHERE listing_id = ? ORDER BY created_at DESC LIMIT 1', listing.id
  );
  if (!order) {
    return ok({ found: false, listing_id: listing.id, proof_event_name: PROOF_EVENT_NAME });
  }
  const auditRows = await db.all(
    `SELECT entity, entity_id, from_status, to_status, actor, note, at FROM audit_log
      WHERE (entity = 'order' AND entity_id = ?) OR (entity = 'listing' AND entity_id = ?)
      ORDER BY id ASC`,
    order.id, listing.id
  );
  const cancelRow = auditRows.find((r) => r.entity === 'order' && r.to_status === 'cancelled');
  return ok({
    found: true,
    order: {
      id: order.id, status: order.status, listing_id: order.listing_id,
      buyer_id: order.buyer_id, seller_id: order.seller_id,
      reserved_until: order.reserved_until,
      stripe_checkout_session_id: order.stripe_checkout_session_id,
      total_cents: order.total_cents, buyer_fee_cents: order.buyer_fee_cents,
      created_at: order.created_at, updated_at: order.updated_at,
    },
    listing: {
      id: listing.id, status: listing.status,
      transfer_status: listing.transfer_status, event_name: listing.event_name,
    },
    // audit_log's timestamp column is `at`; created_at is aliased for readers.
    audit: auditRows.map((r) => ({ ...r, created_at: r.at })),
    released_by_scheduled_sweep: Boolean(
      order.status === 'cancelled' && cancelRow && cancelRow.actor === 'scheduled-sweep'
    ),
    releasing_actor: cancelRow ? cancelRow.actor : null,
  });
}

async function cleanup() {
  const before = await findProofRecords();
  const deleted = await deleteProofRecords();

  // Verify zero, by the exact ids/emails/names that defined the proof set.
  const usersLeft = await db.get('SELECT COUNT(*) AS n FROM users WHERE email = ?', PROOF_BUYER_EMAIL);
  const listingsLeft = await db.get('SELECT COUNT(*) AS n FROM listings WHERE event_name = ?', PROOF_EVENT_NAME);
  let ordersLeft = 0;
  let auditLeft = 0;
  let transfersLeft = 0;
  if (before.orderIds.length) {
    ordersLeft = (await db.get(
      `SELECT COUNT(*) AS n FROM orders WHERE id IN (${inClause(before.orderIds)})`, ...before.orderIds
    )).n;
    transfersLeft += (await db.get(
      `SELECT COUNT(*) AS n FROM transfers WHERE order_id IN (${inClause(before.orderIds)})`, ...before.orderIds
    )).n;
  }
  const entityIds = [...before.orderIds, ...before.listingIds, ...(before.buyer ? [before.buyer.id] : [])];
  if (entityIds.length) {
    auditLeft = (await db.get(
      `SELECT COUNT(*) AS n FROM audit_log WHERE entity_id IN (${inClause(entityIds)})`, ...entityIds
    )).n;
  }
  const verifiedZero = {
    users: Number(usersLeft.n), listings: Number(listingsLeft.n),
    orders: Number(ordersLeft), audit_log: Number(auditLeft), transfers: Number(transfersLeft),
  };
  const allZero = Object.values(verifiedZero).every((n) => n === 0);
  return ok({ deleted, verified_zero: verifiedZero, all_zero: allZero });
}

exports.handler = async (event) => {
  // AUTH GATE — runs before any parsing or DB work; no writes on refusal.
  if (event.httpMethod !== 'POST') return notFound();
  const expected = process.env.PROOF_SECRET || '';
  if (!expected) return notFound(); // PROOF_SECRET unset: endpoint is disabled.
  if (!secretMatches(header(event, 'x-proof-secret'), expected)) return forbidden('Forbidden.');

  const body = parseBody(event);
  if (!body || !body.action) return badRequest('action is required: setup | status | cleanup.');

  try {
    if (body.action === 'setup') return await setup();
    if (body.action === 'status') return await status();
    if (body.action === 'cleanup') return await cleanup();
    return badRequest('Unknown action: setup | status | cleanup.');
  } catch (err) { return serverError(err); }
};
