'use strict';
/**
 * POST /api/admin/verify-transfer — the desk's core action.
 * Admin-gated (role='admin' session; the actor is the signed-in admin —
 * a named human on every action, Code #8). Body: { transfer_id, action, notes? }
 *
 * INBOUND transfers (seller -> Changed Plans), actions:
 *   mark_received : requested -> received   (ticket seen in our TM account)
 *   verify        : received  -> verified   — THE Code #4 GATE: the listing's
 *                   transfer_status becomes 'verified' and the listing goes
 *                   ACTIVE (buyable) in the same step. Not before.
 *
 * OUTBOUND transfers (Changed Plans -> buyer), actions:
 *   mark_sent     : queued -> sent          (transfer initiated to buyer)
 *   confirm       : sent   -> confirmed     — delivery verified; the order
 *                   advances TRANSFER_PENDING -> VERIFIED -> PAYOUT_READY and
 *                   the seller's payout row is created. Code #5: payout can
 *                   only exist after this moment.
 */
const db = require('./_lib/db');
const { ok, badRequest, forbidden, notFound, parseBody, serverError } = require('./_lib/http');
const { transitionOrder, transitionListing } = require('./_lib/state');
const auth = require('./_lib/auth');

const INBOUND_FLOW = { mark_received: ['requested', 'received'], verify: ['received', 'verified'] };
const OUTBOUND_FLOW = { mark_sent: ['queued', 'sent'], confirm: ['sent', 'confirmed'] };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const admin = await auth.adminUser(event);
  if (!admin) return forbidden('Admin only.');
  const b = parseBody(event);
  if (!b || !b.transfer_id || !b.action) return badRequest('transfer_id and action are required.');
  const actor = admin.display_name || admin.email;
  const transfer = await db.get('SELECT * FROM transfers WHERE id = ?', b.transfer_id);
  if (!transfer) return notFound('Transfer not found.');

  const flow = transfer.direction === 'inbound' ? INBOUND_FLOW : OUTBOUND_FLOW;
  const step = flow[b.action];
  if (!step) return badRequest(`Action '${b.action}' is not valid for a ${transfer.direction} transfer.`);
  if (transfer.status !== step[0]) {
    return badRequest(`Transfer is '${transfer.status}', but '${b.action}' needs '${step[0]}'.`);
  }

  try {
    // handled_by takes the admin's user id (Code #8: a named human on the
    // work). The local-dev token actor has no users row — skip the FK then.
    await db.run('UPDATE transfers SET status = ?, handled_by = COALESCE(?, handled_by), notes = COALESCE(?, notes), updated_at = ? WHERE id = ?',
      step[1], admin.id || null, b.notes || null, db.now(), transfer.id);
    await db.audit('transfer', transfer.id, step[0], step[1], actor, b.notes || b.action);

    const result = { transfer_id: transfer.id, direction: transfer.direction, status: step[1] };

    if (transfer.direction === 'inbound' && b.action === 'verify') {
      // Code #4 gate opens: listing becomes buyable now, and only now.
      await db.run("UPDATE listings SET transfer_status = 'verified', transfer_ref = ?, updated_at = ? WHERE id = ?",
        b.notes || 'Verified in Changed Plans Ticketmaster account', db.now(), transfer.listing_id);
      await transitionListing(transfer.listing_id, 'active', actor, 'Inbound transfer verified — listing is live');
      result.listing_status = 'active';
    }

    if (transfer.direction === 'outbound' && b.action === 'confirm') {
      // Code #5: verification is what makes the seller's money payable.
      const order = await db.get('SELECT * FROM orders WHERE id = ?', transfer.order_id);
      await transitionOrder(order.id, 'verified', actor, 'Outbound transfer confirmed delivered to buyer');
      await transitionOrder(order.id, 'payout_ready', actor, 'Seller payout is now payable');
      const payoutId = db.newId('pay');
      const ts = db.now();
      await db.run(
        `INSERT INTO payouts (id, order_id, seller_id, amount_cents, method, status, created_at, updated_at)
         VALUES (?,?,?,?,'manual_bank','pending',?,?)`,
        payoutId, order.id, order.seller_id, order.price_total_cents, ts, ts
      );
      await db.audit('payout', payoutId, null, 'pending', actor, `Payable to seller for order ${order.id}`);
      result.order_status = 'payout_ready';
      result.payout_id = payoutId;
    }

    return ok(result);
  } catch (err) { return serverError(err); }
};
