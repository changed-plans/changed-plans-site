'use strict';
/**
 * POST /api/checkout  { listing_id } — start a purchase (requires sign-in).
 *
 * Flow: verify the listing is buyable (active + transfer verified, Code #4)
 * -> quote with the FULL price up front (Code #2; fee waived on the buyer's
 * first transaction) -> create order RESERVED and hold the listing for
 * 15 minutes -> create the Stripe Checkout Session -> return its URL.
 * The order only becomes PAID via the Stripe webhook — never via the
 * buyer's browser coming back.
 */
const db = require('./_lib/db');
const { created, badRequest, unauthorized, forbidden, notFound, conflict, parseBody, serverError } = require('./_lib/http');
const { quoteOrder } = require('./_lib/money');
const { transitionOrder, transitionListing } = require('./_lib/state');
const auth = require('./_lib/auth');
const stripe = require('./_lib/stripe');

const HOLD_MINUTES = 15;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const buyer = await auth.userFromEvent(event);
  if (!buyer) return unauthorized('Sign in to buy.');
  const body = parseBody(event);
  if (!body || !body.listing_id) return badRequest('listing_id is required.');

  const listing = await db.get('SELECT * FROM listings WHERE id = ?', body.listing_id);
  if (!listing) return notFound('Listing not found.');
  if (listing.seller_id === buyer.id) return forbidden('You cannot buy your own listing.');
  if (listing.status !== 'active' || listing.transfer_status !== 'verified') {
    return conflict('This listing is not available for purchase.');
  }

  try {
    const quote = quoteOrder({
      priceCentsPerTicket: listing.price_cents,
      qty: listing.qty,
      firstTransaction: !buyer.first_transaction_completed,
    });

    const orderId = db.newId('ord');
    const ts = db.now();
    const reservedUntil = new Date(Date.now() + HOLD_MINUTES * 60 * 1000).toISOString();
    await db.run(
      `INSERT INTO orders (id, listing_id, buyer_id, seller_id, qty, face_total_cents,
         price_total_cents, buyer_fee_cents, fee_waived, total_cents, status,
         reserved_until, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'reserved', ?, ?, ?)`,
      orderId, listing.id, buyer.id, listing.seller_id, listing.qty,
      listing.face_price_cents * listing.qty, quote.priceTotalCents,
      quote.buyerFeeCents, quote.feeWaived ? 1 : 0, quote.totalCents,
      reservedUntil, ts, ts
    );
    await db.audit('order', orderId, null, 'reserved', buyer.id, 'Order created; listing held');
    await transitionListing(listing.id, 'reserved', buyer.id, `Held for order ${orderId}`);

    const session = await stripe.createCheckoutSession({
      order: { id: orderId, total_cents: quote.totalCents, buyer_email: buyer.email },
      listing,
    });
    await db.run('UPDATE orders SET stripe_checkout_session_id = ?, updated_at = ? WHERE id = ?',
      session.id, db.now(), orderId);

    return created({
      order_id: orderId,
      checkout_url: session.url,
      reserved_until: reservedUntil,
      quote: {
        face_value_total_cents: listing.face_price_cents * listing.qty,
        price_total_cents: quote.priceTotalCents,
        buyer_fee_cents: quote.buyerFeeCents,
        fee_waived: quote.feeWaived,
        total_cents: quote.totalCents,
      },
      fee_line: 'Face value or less, never above. The only extra cost is a 14% buyer fee, and your first transaction is free.',
    });
  } catch (err) { return serverError(err); }
};
