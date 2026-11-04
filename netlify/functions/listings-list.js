'use strict';
/**
 * GET /api/listings — the public marketplace feed.
 *
 * THE GATE (Code #4): only listings that are BOTH status='active' AND
 * transfer_status='verified' are returned. A listing the seller hasn't
 * transferred — or that we haven't verified in our account — is invisible
 * here and cannot be checked out. No speculative listings.
 *
 * Face value is always included (Code #1) and restrictions are always
 * included (Code #3) so the buyer sees them before paying.
 */
const db = require('./_lib/db');
const { ok, serverError } = require('./_lib/http');
const { formatCents } = require('./_lib/money');

exports.handler = async () => {
  try {
    const rows = await db.all(
      `SELECT * FROM listings
        WHERE status = 'active' AND transfer_status = 'verified'
        ORDER BY event_date ASC`
    );
    return ok({
      listings: rows.map((l) => ({
        id: l.id,
        event_name: l.event_name,
        event_date: l.event_date,
        venue: l.venue,
        location: l.location,
        category: l.category,
        seats: l.seats,
        qty: l.qty,
        face_value_cents: l.face_price_cents,
        face_value: formatCents(l.face_price_cents),
        price_cents: l.price_cents,
        price: formatCents(l.price_cents),
        restrictions: l.restrictions,
        // The locked line, verbatim, for the page to display (Code #2):
        fee_line: 'Face value or less, never above. The only extra cost is a 14% buyer fee — and your first transaction is free.',
      })),
    });
  } catch (err) { return serverError(err); }
};
