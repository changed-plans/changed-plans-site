'use strict';
/**
 * POST /api/admin/mark-paid-out — record a manual seller payout.
 * Admin-gated (role='admin'; the paying admin's name goes in the audit
 * log). Body: { order_id, external_ref }
 *
 * Launch model (Scott's decision): seller payout is MANUAL — paid from the
 * LLC business bank account (Zelle/ACH/check) after verification, and the
 * bank reference is recorded here as the audit trail. Only an order in
 * PAYOUT_READY with a pending payout row can be marked paid out.
 * Completing an order also completes the buyer's "first transaction"
 * (relevant to the first-transaction-free fee waiver on their NEXT order —
 * a completed first purchase means the waiver has been used).
 */
const db = require('./_lib/db');
const { ok, badRequest, forbidden, notFound, conflict, parseBody, serverError } = require('./_lib/http');
const { transitionOrder, transitionListing } = require('./_lib/state');
const auth = require('./_lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const admin = await auth.adminUser(event);
  if (!admin) return forbidden('Admin only.');
  const b = parseBody(event);
  if (!b || !b.order_id || !b.external_ref) {
    return badRequest('order_id and external_ref (the bank/Zelle reference) are required.');
  }
  const actor = admin.display_name || admin.email;
  const order = await db.get('SELECT * FROM orders WHERE id = ?', b.order_id);
  if (!order) return notFound('Order not found.');
  if (order.status !== 'payout_ready') {
    return conflict(`Order is '${order.status}', not 'payout_ready'. Verify the transfer first.`);
  }
  const payout = await db.get("SELECT * FROM payouts WHERE order_id = ? AND status = 'pending'", order.id);
  if (!payout) return conflict('No pending payout row for this order.');

  try {
    await db.run("UPDATE payouts SET status = 'sent', external_ref = ?, updated_at = ? WHERE id = ?",
      b.external_ref, db.now(), payout.id);
    await db.audit('payout', payout.id, 'pending', 'sent', actor, `Manual bank payout, ref ${b.external_ref}`);
    await transitionOrder(order.id, 'paid_out', actor, `Seller paid manually (ref ${b.external_ref})`);
    await transitionListing(order.listing_id, 'closed', actor, 'Order complete');
    await db.run('UPDATE users SET first_transaction_completed = 1 WHERE id = ?', order.buyer_id);
    return ok({ order_id: order.id, status: 'paid_out', payout_id: payout.id, external_ref: b.external_ref });
  } catch (err) { return serverError(err); }
};
