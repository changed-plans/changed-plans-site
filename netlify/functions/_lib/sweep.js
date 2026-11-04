'use strict';
/**
 * sweep.js — reservation-expiry sweeper (Phase 2).
 *
 * An order in `reserved` holds its listing for 15 minutes (checkout-create
 * sets reserved_until). If the buyer never pays, the hold must die: the
 * order is cancelled and the listing returns to `active` so another fan
 * can buy it. Stripe's `checkout.session.expired` webhook covers the
 * session-expiry path, but a session can also simply be abandoned in ways
 * that never produce a timely event — this sweep is the guarantee.
 *
 * Every release goes through the state machine (transitionOrder /
 * transitionListing), so each one writes audit_log rows — the release is
 * visible history, not a silent cleanup.
 *
 * Entry points: netlify/functions/admin-sweep.js (POST /api/admin/sweep,
 * admin-gated, for manual/local runs) and netlify/functions/
 * scheduled-sweep.js (Netlify scheduled function in production).
 */
const db = require('./db');
const { transitionOrder, transitionListing } = require('./state');

async function sweepExpiredReservations(actor = 'sweep') {
  const nowIso = db.now();
  const expired = await db.all(
    "SELECT * FROM orders WHERE status = 'reserved' AND reserved_until IS NOT NULL AND reserved_until < ?",
    nowIso
  );
  const released = [];
  for (const order of expired) {
    await transitionOrder(order.id, 'cancelled', actor, 'Reservation expired — 15-minute hold lapsed, never paid');
    const listing = await db.get('SELECT * FROM listings WHERE id = ?', order.listing_id);
    if (listing && listing.status === 'reserved') {
      await transitionListing(listing.id, 'active', actor, `Released — order ${order.id} expired unpaid`);
    }
    released.push({ order_id: order.id, listing_id: order.listing_id });
  }
  return { checked_at: nowIso, released_count: released.length, released };
}

module.exports = { sweepExpiredReservations };
