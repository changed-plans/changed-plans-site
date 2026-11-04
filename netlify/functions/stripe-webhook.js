'use strict';
/**
 * POST /api/stripe-webhook — the ONLY path into PAID.
 *
 * Events handled:
 *  - checkout.session.completed: order RESERVED -> PAID (funds now HELD),
 *    listing -> sold, outbound transfer queued, order -> TRANSFER_PENDING.
 *  - checkout.session.expired:   order RESERVED -> CANCELLED, listing released.
 *  - charge.refunded:            order REFUND_PENDING -> REFUNDED (audit trail
 *    completes when Stripe confirms the money actually went back).
 *
 * Signature verification lives in _lib/stripe.js constructEvent. Handlers are
 * idempotent: Stripe retries, so an event for an order already past the target
 * state is a 200 no-op.
 */
const db = require('./_lib/db');
const { ok, badRequest } = require('./_lib/http');
const { header } = require('./_lib/http');
const { transitionOrder, transitionListing } = require('./_lib/state');
const stripe = require('./_lib/stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  let stripeEvent;
  try {
    stripeEvent = stripe.constructEvent(rawBody, header(event, 'stripe-signature'));
  } catch (err) {
    console.error('[webhook] rejected:', err.message);
    return badRequest('Webhook signature verification failed.');
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const orderId = session.metadata && session.metadata.order_id;
        const order = orderId
          ? await db.get('SELECT * FROM orders WHERE id = ?', orderId)
          : await db.get('SELECT * FROM orders WHERE stripe_checkout_session_id = ?', session.id);
        if (!order) { console.warn('[webhook] no order for session', session.id); break; }
        if (order.status !== 'reserved') break; // duplicate delivery — no-op

        await db.run(
          'UPDATE orders SET stripe_payment_intent_id = ?, held_since = ?, updated_at = ? WHERE id = ?',
          session.payment_intent || null, db.now(), db.now(), order.id
        );
        await transitionOrder(order.id, 'paid', 'stripe-webhook', 'Payment succeeded — funds HELD by Changed Plans LLC');
        await transitionListing(order.listing_id, 'sold', 'stripe-webhook', `Sold via order ${order.id}`);

        // Queue the outbound transfer: the desk now owes the buyer a ticket.
        const ts = db.now();
        await db.run(
          `INSERT INTO transfers (id, listing_id, order_id, direction, status, created_at, updated_at)
           VALUES (?,?,?,'outbound','queued',?,?)`,
          db.newId('trn'), order.listing_id, order.id, ts, ts
        );
        await transitionOrder(order.id, 'transfer_pending', 'stripe-webhook', 'Outbound transfer queued for the desk');
        break;
      }

      case 'checkout.session.expired': {
        const session = stripeEvent.data.object;
        const order = await db.get('SELECT * FROM orders WHERE stripe_checkout_session_id = ?', session.id);
        if (!order || order.status !== 'reserved') break;
        await transitionOrder(order.id, 'cancelled', 'stripe-webhook', 'Checkout expired — hold released');
        const listing = await db.get('SELECT * FROM listings WHERE id = ?', order.listing_id);
        if (listing && listing.status === 'reserved') {
          await transitionListing(listing.id, 'active', 'stripe-webhook', 'Released after expired checkout');
        }
        break;
      }

      case 'charge.refunded': {
        const charge = stripeEvent.data.object;
        const order = await db.get('SELECT * FROM orders WHERE stripe_payment_intent_id = ?', charge.payment_intent);
        if (!order || order.status !== 'refund_pending') break;
        await db.run('UPDATE orders SET refunded_at = ?, updated_at = ? WHERE id = ?', db.now(), db.now(), order.id);
        await transitionOrder(order.id, 'refunded', 'stripe-webhook', `Refund confirmed (reason: ${order.refund_reason || 'n/a'})`);
        // A refunded order never relists: the ticket is dead to us.
        const payout = await db.get('SELECT * FROM payouts WHERE order_id = ?', order.id);
        if (payout && payout.status === 'pending') {
          await db.run("UPDATE payouts SET status = 'void', updated_at = ? WHERE id = ?", db.now(), payout.id);
        }
        // The buyer's first-transaction flag: a refunded first purchase never
        // completed, so leave the waiver available for their next try.
        break;
      }

      default:
        // Unhandled event types are fine — Stripe sends many.
        break;
    }
    return ok({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    // 500 makes Stripe retry, which is what we want for transient failures.
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'handler error' }) };
  }
};
