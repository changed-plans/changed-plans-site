'use strict';
/**
 * GET /api/orders/:id — order status for buyer or seller (sign-in required,
 * must be a party to the order; admins via token may view any).
 * Buyer-facing status text explains the hold in plain language (Code #5).
 */
const db = require('./_lib/db');
const { ok, unauthorized, forbidden, notFound, serverError } = require('./_lib/http');
const { formatCents } = require('./_lib/money');
const auth = require('./_lib/auth');

const STATUS_EXPLAINER = {
  reserved: 'Waiting for payment. Your tickets are held for 15 minutes.',
  paid: 'Paid. Your money is held by Changed Plans until your ticket transfer is verified — the seller is not paid before that.',
  transfer_pending: 'Paid and held. Your tickets are being transferred to you now.',
  verified: 'Tickets delivered and verified. The seller is being paid.',
  payout_ready: 'Tickets delivered and verified. The seller is being paid.',
  paid_out: 'Complete. Enjoy the show!',
  refund_pending: 'A refund is on its way back to your original payment method.',
  refunded: 'Refunded in full to your original payment method.',
  cancelled: 'This order was cancelled before payment.',
};

exports.handler = async (event) => {
  const id = (event.path || '').split('/').filter(Boolean).pop();
  const order = id ? await db.get('SELECT * FROM orders WHERE id = ?', id) : null;
  if (!order) return notFound('Order not found.');
  try {
    if (!(await auth.isAdmin(event))) {
      const user = await auth.userFromEvent(event);
      if (!user) return unauthorized('Sign in to view an order.');
      if (user.id !== order.buyer_id && user.id !== order.seller_id) {
        return forbidden('This order belongs to someone else.');
      }
    }
    const listing = await db.get('SELECT * FROM listings WHERE id = ?', order.listing_id);
    const transfer = await db.get(
      "SELECT * FROM transfers WHERE order_id = ? AND direction = 'outbound'", order.id);
    return ok({
      order: {
        id: order.id,
        status: order.status,
        status_explainer: STATUS_EXPLAINER[order.status] || '',
        qty: order.qty,
        face_total: formatCents(order.face_total_cents),
        price_total: formatCents(order.price_total_cents),
        buyer_fee: formatCents(order.buyer_fee_cents),
        fee_waived: !!order.fee_waived,
        total_paid: formatCents(order.total_cents),
        held_since: order.held_since,
        refund_reason: order.refund_reason,
        created_at: order.created_at,
      },
      listing: listing && {
        event_name: listing.event_name, event_date: listing.event_date,
        venue: listing.venue, location: listing.location, seats: listing.seats,
        restrictions: listing.restrictions,
      },
      transfer: transfer && { status: transfer.status, handled_by: transfer.handled_by },
    });
  } catch (err) { return serverError(err); }
};
